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
    args = parser.parse_args()
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
            ffmpeg = subprocess.Popen([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "pulse", "-i", "music_probe.monitor",
                "-t", str(args.seconds + 8), "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le", str(audio_path),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

            html = make_page(args.video_id).encode("utf-8")

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(html)

                def log_message(self, *_):
                    pass

            server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-dev-shm-usage",
                          "--autoplay-policy=no-user-gesture-required"],
                    env={**os.environ, "PULSE_SINK": "music_probe"},
                )
                page = browser.new_page()
                page.goto("http://127.0.0.1:8765", wait_until="domcontentloaded", timeout=30000)
                deadline = time.monotonic() + args.seconds
                last_time = 0.0
                playing_seen = False
                while time.monotonic() < deadline:
                    state = page.evaluate("window.probe || null")
                    if state:
                        report["player_state"] = state.get("state")
                        report["player_error"] = state.get("error")
                        report["reported_duration_seconds"] = round(float(state.get("duration") or 0), 2)
                        current = float(state.get("currentTime") or 0)
                        last_time = max(last_time, current)
                        if state.get("state") == "playing":
                            playing_seen = True
                        if state.get("state") == "error":
                            break
                        if playing_seen and last_time >= 8:
                            # Continue capturing beyond startup to sample multiple audio windows.
                            time.sleep(max(0, min(4, deadline - time.monotonic())))
                    time.sleep(0.5)
                report["player_playing_seen"] = playing_seen
                report["player_time_advanced_seconds"] = round(last_time, 2)
                report["player_state_changes"] = page.evaluate("window.probe?.changes || []")
                browser.close()

            if ffmpeg:
                try:
                    ffmpeg.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    ffmpeg.terminate()
                    ffmpeg.wait(timeout=5)
            report["audio"] = inspect_audio(audio_path)
            report["probe_passed"] = bool(
                report["player_playing_seen"]
                and report["player_time_advanced_seconds"] >= 5
                and report["audio"].get("audio_detected")
            )
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
    return 0 if report.get("probe_passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
