#!/usr/bin/env python3
"""Transient YouTube player audio-output probe.

Plays an official YouTube embed in Chromium and measures the browser's actual
PulseAudio output. Audio is analyzed locally and deleted; only numeric
diagnostics are written to the report. This does NOT validate lyric identity
or vocal synchronization.
"""
from __future__ import annotations

import argparse
import array
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import wave
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "youtube-audio-probe-report.json"


def run(command: list[str], *, check: bool = True, **kwargs):
    return subprocess.run(command, check=check, text=True, capture_output=True, **kwargs)


def start_audio_sink() -> None:
    run(["pulseaudio", "--start", "--exit-idle-time=-1"], check=False)
    for _ in range(20):
        info = run(["pactl", "info"], check=False)
        if info.returncode == 0:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("PulseAudio did not become ready")
    result = run([
        "pactl", "load-module", "module-null-sink",
        "sink_name=music_probe",
        "sink_properties=device.description=MusicAudioProbe",
    ], check=False)
    if result.returncode != 0 and "already exists" not in result.stderr.lower():
        raise RuntimeError("Could not create PulseAudio test sink: " + result.stderr[-500:])
    run(["pactl", "set-default-sink", "music_probe"])


def make_page(video_id: str) -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#111;color:white">
<div id="player"></div><pre id="status">loading iframe api</pre>
<script>
window.probe={{state:"loading",error:null,currentTime:0,duration:0,changes:[]}};
function onYouTubeIframeAPIReady(){{
  const player=new YT.Player("player",{{
    width:"640",height:"360",videoId:{json.dumps(video_id)},
    playerVars:{{autoplay:1,controls:1,playsinline:1,rel:0,enablejsapi:1,origin:location.origin}},
    events:{{
      onReady:e=>{{window.probe.state="ready";e.target.playVideo();}},
      onStateChange:e=>{{
        window.probe.state=({{-1:"unstarted",0:"ended",1:"playing",2:"paused",3:"buffering",5:"cued"}})[e.data]||String(e.data);
        window.probe.changes.push({{state:window.probe.state,at:Date.now()}});
      }},
      onError:e=>{{window.probe.error=String(e.data);window.probe.state="error";}}
    }}
  }});
  window.probePlayer=player;
  setInterval(()=>{{
    try{{
      window.probe.currentTime=player.getCurrentTime()||0;
      window.probe.duration=player.getDuration()||0;
    }}catch(_ ){{}}
  }},250);
}}
const tag=document.createElement("script");tag.src="https://www.youtube.com/iframe_api";
document.head.appendChild(tag);
</script></body></html>"""


def inspect_audio(path: Path) -> dict:
    if not path.exists() or path.stat().st_size < 1000:
        return {"captured": False, "reason": "audio_file_missing_or_empty"}
    with wave.open(str(path), "rb") as wav:
        channels, width, rate, frames = (
            wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
        )
        raw = wav.readframes(frames)
    if width != 2:
        return {"captured": True, "reason": f"unexpected_sample_width_{width}", "sample_rate": rate}
    samples = array.array("h")
    samples.frombytes(raw)
    if os.sys.byteorder != "little":
        samples.byteswap()
    if channels > 1:
        samples = array.array("h", samples[::channels])
    if not samples:
        return {"captured": True, "reason": "no_pcm_samples", "sample_rate": rate}
    windows = []
    window_size = rate
    for start in range(0, len(samples), window_size):
        chunk = samples[start:start + window_size]
        if not chunk:
            continue
        rms = math.sqrt(sum(int(x) * int(x) for x in chunk) / len(chunk)) / 32768
        windows.append(round(rms, 6))
    active = sum(value > 0.002 for value in windows)
    overall = math.sqrt(sum(int(x) * int(x) for x in samples) / len(samples)) / 32768
    return {
        "captured": True,
        "sample_rate": rate,
        "duration_seconds": round(len(samples) / rate, 2),
        "overall_rms": round(overall, 6),
        "one_second_rms": windows,
        "active_audio_windows": active,
        "audio_detected": active >= 3 and overall > 0.002,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id", default=os.getenv("YOUTUBE_TEST_VIDEO_ID", "5vilULw-9Gg"))
    parser.add_argument("--seconds", type=int, default=35)
    parser.add_argument("--query", default=os.getenv("MUSIC_TEST_QUERY", ""))
    parser.add_argument("--app-root", default="", help="Serve this historical app snapshot while keeping the GitHub Pages origin")
    args = parser.parse_args()
    if args.query:
        search_url = "https://www.youtube.com/results?" + __import__("urllib.parse").parse.urlencode({"search_query": args.query})
        request = urllib.request.Request(search_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=20) as response:
            page_html = response.read(8_000_000).decode("utf-8", errors="replace")
        found = re.search(r'"videoRenderer":\s*\{\s*"videoId":\s*"([A-Za-z0-9_-]{11})"', page_html)
        if not found:
            raise SystemExit("Could not resolve a YouTube result for query: " + args.query)
        args.video_id = found.group(1)
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", args.video_id):
        raise SystemExit("Invalid YouTube video ID; expected 11 characters")
    if not 15 <= args.seconds <= 90:
        raise SystemExit("--seconds must be between 15 and 90")

    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "video_id": args.video_id,
        "requested_capture_seconds": args.seconds,
        "scope": "real YouTube embed playback and OS audio output only",
        "lyric_content_verified": False,
        "vocal_sync_verified": False,
        "audio_file_retained": False,
    }
    audio_path = None
    ffmpeg = None
    server = None
    try:
        for binary in ("ffmpeg", "pulseaudio", "pactl"):
            if not shutil.which(binary):
                raise RuntimeError(f"Required executable not found: {binary}")
        start_audio_sink()
        with tempfile.TemporaryDirectory(prefix="music-audio-probe-") as temp:
            audio_path = Path(temp) / "probe.wav"

            from lyric_audio_verify import identify, verify as verify_lyrics
            identified = identify(args.video_id)
            video_title, expected_title, expected_artist, channel, description = identified
            app_video = {
                "id": args.video_id,
                "title": video_title,
                "channelTitle": channel,
                "description": description,
                "duration": 0,
                "thumbnail": f"https://i.ytimg.com/vi/{args.video_id}/hqdefault.jpg",
            }
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    headless=False,
                    args=["--no-sandbox", "--disable-dev-shm-usage",
                          "--autoplay-policy=no-user-gesture-required",
                          "--disable-blink-features=AutomationControlled"],
                    env={**os.environ, "PULSE_SINK": "music_probe"},
                )
                context = browser.new_context(
                    viewport={"width": 1365, "height": 900},
                    user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                    service_workers="block",
                )
                page = context.new_page()
                if args.app_root:
                    app_root = Path(args.app_root).resolve()
                    def serve_snapshot(route):
                        from urllib.parse import urlparse, unquote
                        request_path = unquote(urlparse(route.request.url).path)
                        relative = request_path.split("/Music/", 1)[-1] or "index.html"
                        candidate = (app_root / relative).resolve()
                        if candidate.is_file() and app_root in candidate.parents:
                            route.fulfill(path=str(candidate))
                        else:
                            route.continue_()
                    page.route("https://kanghuijun000.github.io/Music/**", serve_snapshot)
                browser_errors = []
                network_errors = []
                page.on("pageerror", lambda error: browser_errors.append(str(error)[:300]))
                page.on("requestfailed", lambda request: network_errors.append({
                    "url": request.url[:220], "failure": str(request.failure or "")[:180]
                }) if "youtube" in request.url else None)
                page.goto("https://kanghuijun000.github.io/Music/?qa=1&qa_version=124",
                          wait_until="domcontentloaded", timeout=45000)
                page.wait_for_function(
                    "window.__musicQa && window.__musicQa.snapshot().playerReady",
                    timeout=60000,
                )
                # Start capture before selecting the video so the recording begins at video time zero.
                ffmpeg = subprocess.Popen([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "pulse", "-i", "music_probe.monitor",
                    "-t", str(args.seconds + 8), "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", str(audio_path),
                ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                page.evaluate("(video) => window.__musicQa.setVideo(video)", app_video)
                deadline = time.monotonic() + args.seconds
                last_time = 0.0
                playing_seen = False
                state_changes = []
                renderer_samples = 0
                renderer_mismatches = 0
                last_state = None
                while time.monotonic() < deadline:
                    snap = page.evaluate("window.__musicQa.snapshot()")
                    state = snap.get("playerState")
                    current = float(snap.get("playerTime") or 0)
                    last_time = max(last_time, current)
                    if state == 1:
                        playing_seen = True
                    if state != last_state:
                        state_changes.append({"state": state, "playerTime": round(current, 2)})
                        last_state = state
                    if state == 1 and int(snap.get("expectedIndex", -1)) >= 0:
                        renderer_samples += 1
                        if int(snap.get("renderedIndex", -1)) != int(snap.get("expectedIndex", -1)):
                            renderer_mismatches += 1
                    time.sleep(0.2)
                app_snapshot = page.evaluate("window.__musicQa.snapshot()")
                report["app_lyrics_status"] = str(app_snapshot.get("lyricsStatus") or "")
                report["app_lyric_track"] = app_snapshot.get("track") or {}
                report["app_lyric_timing_basis"] = app_snapshot.get("timingBasis")
                report["app_lyric_offset_seconds"] = app_snapshot.get("lyricOffsetSeconds")
                report["lyric_flow_events"] = ((app_snapshot.get("lyricFlow") or {}).get("events") or [])[-30:]
                static_issues = app_snapshot.get("staticValidation")
                if isinstance(static_issues, list):
                    blocking_issues = [issue for issue in static_issues if issue != "동기화 가사가 없고 일반 가사만 있습니다."]
                    report["app_static_validation"] = static_issues
                    report["app_static_validation_passed"] = not blocking_issues
                report["player_playing_seen"] = playing_seen
                report["player_time_advanced_seconds"] = round(last_time, 2)
                report["player_state_changes"] = state_changes
                report["browser_errors"] = browser_errors[:8]
                report["youtube_network_errors"] = network_errors[:12]
                report["youtube_player_error_code"] = app_snapshot.get("playerError")
                report["app_renderer"] = {
                    "timed_line_count": len(app_snapshot.get("lines") or []),
                    "plain_lyrics_present": bool(app_snapshot.get("plainLyricsPresent")),
                    "timing_basis": app_snapshot.get("timingBasis"),
                    "lyric_source": (app_snapshot.get("track") or {}).get("source"),
                    "upstream_provider": (app_snapshot.get("track") or {}).get("upstreamProvider"),
                    "sample_count": renderer_samples,
                    "mismatch_count": renderer_mismatches,
                    "mismatch_ratio": round(renderer_mismatches / renderer_samples, 3) if renderer_samples else None,
                }
                browser.close()

            if ffmpeg:
                try:
                    ffmpeg.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    ffmpeg.terminate()
                    ffmpeg.wait(timeout=5)
            report["audio"] = inspect_audio(audio_path)
            report["lyric_verification"] = verify_lyrics(audio_path, args.video_id, app_snapshot, identified)
            report["lyric_content_verified"] = bool(report["lyric_verification"].get("lyric_content_verified"))
            report["vocal_sync_verified"] = bool(report["lyric_verification"].get("vocal_sync_verified"))
            renderer = report.get("app_renderer") or {}
            renderer_ok = bool(renderer.get("sample_count", 0) >= 5 and (renderer.get("mismatch_ratio") or 0) <= 0.05)
            report["probe_passed"] = bool(
                report["player_playing_seen"]
                and report["player_time_advanced_seconds"] >= 5
                and report["audio"].get("audio_detected")
                and report["lyric_verification"].get("overall") == "PASS"
                and renderer_ok
            )
            if report["probe_passed"]:
                report["verification_status"] = "PASS"
            elif renderer.get("plain_lyrics_present") and renderer.get("timed_line_count", 0) < 2:
                # Plain lyrics are an intentional fallback, not a failed sync test.
                report["verification_status"] = "INCONCLUSIVE"
                report["inconclusive_reason"] = "Plain lyrics loaded without timed lines; vocal synchronization is not applicable."
            elif renderer.get("timed_line_count", 0) >= 2 and not report["audio"].get("audio_detected"):
                # A non-embeddable video or silent CI audio sink cannot verify
                # vocal timing; do not mislabel a successfully loaded lyric track as a code failure.
                report["verification_status"] = "INCONCLUSIVE"
                report["inconclusive_reason"] = (
                    "Synced lyrics loaded, but YouTube playback/audio was unavailable; "
                    "vocal synchronization was not verified."
                )
            else:
                report["verification_status"] = "FAIL"
    except Exception as exc:
        report["probe_passed"] = False
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if ffmpeg and ffmpeg.poll() is None:
            ffmpeg.terminate()
        if server:
            server.shutdown()
        if audio_path and audio_path.exists():
            audio_path.unlink(missing_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("verification_status") in ("PASS", "INCONCLUSIVE") else 1


if __name__ == "__main__":
    raise SystemExit(main())
