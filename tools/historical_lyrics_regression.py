#!/usr/bin/env python3
"""Run identical real-app lyric/audio regressions against historical app.js commits."""
from __future__ import annotations
import argparse
import json
import random
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMITS = [
    ("17845ac5147727c40badbd8a0050a211d50a3d89", "baseline-before-lyric-regressions"),
    ("b60a77e220f9ab78f5eb19fb2d374367663a39b3", "artist-song-parsing"),
    ("1e1bfaf9740177acd0f596909eb8979d26868c2f", "lyric-loading-diagnostics"),
    ("91f375fcf6466d5a0fbf6124f4956bf871b5ef1e", "lyric-timing-event-order"),
    ("4cad139da9c4ec86839e8f0567564c6fcf83787b", "verified-lyric-preview"),
    ("6d54cd6443f307a90d36eefeab39a7f59882e5c2", "preview-render-loop"),
    ("795498eebe0fd78ab337b8a7db723039a6122476", "retry-after-audio-identification"),
    ("19d30e13af1a6e5be20fcac510ec901db3b6092c", "shared-artist-alias-cache"),
    ("f94b2d7a1171c96992bbc99d20507e752305c2a4", "parenthesized-title-parsing"),
    ("8a1ded61150c941feaa4c5d9ab2de21eafcf12d2", "description-credit-identification"),
    ("51a92711807ae32f762bb1c927376c94e0602b1d", "promote-video-sync-to-song-cache"),
    ("c4fbf88b935f46b7a87ca190db2bdc948dbc92e5", "separate-video-offset-from-song-cache"),
    ("46bcd5d852b317aac836178029bc4da54e28a90a", "full-description-artist-credit"),
    ("f68710a5a70100de56c9f495fb1853ac80b7fa6b", "individual-credited-performers"),
    ("38fcf9ff8d2d78c7d05393a82a33ed81340d07f3", "tick-tock-artist-identification"),
    ("3338a3863eaa6d62c58c1ad5c10d112a04876c16", "tick-tock-canonical-cache"),
    ("766ea974e912bb4aca07179e8d8026bdd682fe68", "tick-tock-regex-correction"),
]
FIXED = [
    {"name": "오래된 노래 — exact user video", "video_id": "LMyH5WT7JEM"},
    {"name": "비망록 — Buzz", "query": "버즈 비망록 가사"},
    {"name": "사랑인걸 — Moses", "query": "모세 사랑인걸 가사"},
    {"name": "좋은 밤 좋은 꿈 — Nerd Connection", "query": "너드커넥션 좋은 밤 좋은 꿈 가사 웅키"},
    {"name": "TICK TOCK — SMTM12", "query": "TICK TOCK Feat ZICO Prod ZICO Crush 쇼미더머니 12 알파 가사"},
]
RANDOM_POOL = [
    {"name": "밤편지 — IU", "query": "아이유 밤편지 가사"},
    {"name": "주저하는 연인들을 위해 — Jannabi", "query": "잔나비 주저하는 연인들을 위해 가사"},
    {"name": "Ditto — NewJeans", "query": "NewJeans Ditto lyrics"},
    {"name": "Blinding Lights — The Weeknd", "query": "The Weeknd Blinding Lights lyrics"},
    {"name": "Yellow — Coldplay", "query": "Coldplay Yellow lyrics"},
    {"name": "Perfect — Ed Sheeran", "video_id": "kPhpHvnnn0Q"},
    {"name": "사건의 지평선 — Younha", "query": "윤하 사건의 지평선 가사"},
    {"name": "Dynamite — BTS", "query": "BTS Dynamite lyrics"},
]
# Deterministic random sample: identical songs on every commit, so commit-to-commit
# differences cannot be explained by a changing test set.
TESTS = FIXED + random.Random("Music-lyrics-regression-2026-11-15").sample(RANDOM_POOL, 5)

def run(cmd, *, timeout=1200):
    return subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=timeout)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", required=True, help="Historical commit SHA")
    args = parser.parse_args()
    if args.commit.upper() == "HEAD":
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        label = "current-main"
    else:
        match = next(((sha, label) for sha, label in COMMITS if sha.startswith(args.commit)), None)
        if not match:
            raise SystemExit("Commit is not in the approved historical regression list, or use HEAD for the checked-out commit")
        sha, label = match
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "commit": sha,
        "stage": label,
        "test_set": [item["name"] for item in TESTS],
        "results": [],
        "summary": {},
        "limitations": [
            "The app snapshot is loaded in Chromium through the production GitHub Pages origin.",
            "Each song is a real YouTube embed; lyrics are judged from the app's own rendered state.",
            "Vocal synchronization is verified only when audio capture and speech recognition both succeed.",
            "A YouTube playback block is recorded as inconclusive, not misclassified as a lyric-code regression."
        ]
    }
    with tempfile.TemporaryDirectory(prefix="music-historical-") as temp:
        snapshot = Path(temp) / "app"
        snapshot.mkdir()
        archive = subprocess.run(
            ["git", "archive", sha, "index.html", "app.js", "style.css", "sw.js", "manifest.json", "icons"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
        )
        if archive.returncode != 0:
            report["archive_error"] = archive.stderr[-2000:]
            raise SystemExit(report["archive_error"])
        import tarfile, io
        with tarfile.open(fileobj=io.BytesIO(archive.stdout), mode="r:") as tar:
            tar.extractall(snapshot, filter="data")
        for test in TESTS:
            command = [sys.executable, "tools/youtube_audio_probe.py", "--seconds", "45", "--app-root", str(snapshot)]
            if test.get("video_id"):
                command += ["--video-id", test["video_id"]]
            else:
                command += ["--query", test["query"]]
            try:
                probe_path = ROOT / "youtube-audio-probe-report.json"
                probe_path.unlink(missing_ok=True)
                proc = run(command, timeout=1200)
                detail = json.loads(probe_path.read_text(encoding="utf-8")) if probe_path.exists() else {}
                verification = detail.get("lyric_verification") or {}
                result = {
                    "song": test["name"],
                    "exit_code": proc.returncode,
                    "probe_passed": detail.get("probe_passed", False),
                    "video_id": detail.get("video_id"),
                    "video_title": verification.get("video_title"),
                    "app_track": {
                        "title": verification.get("app_track_title"),
                        "artist": verification.get("app_track_artist"),
                    },
                    "timed_line_count": detail.get("app_renderer", {}).get("timed_line_count", 0),
                    "plain_lyrics_present": detail.get("app_renderer", {}).get("plain_lyrics_present", False),
                    "timing_basis": detail.get("app_renderer", {}).get("timing_basis"),
                    "lyric_verification": detail.get("lyric_verification", {}),
                    "audio": detail.get("audio", {}),
                    "error": detail.get("error"),
                }
                if proc.returncode and not detail:
                    result["stderr"] = proc.stderr[-1200:]
                report["results"].append(result)
            except Exception as exc:
                report["results"].append({"song": test["name"], "error": type(exc).__name__ + ": " + str(exc)[:500]})
    results = report["results"]
    report["summary"] = {
        "songs_tested": len(results),
        "synced_lyrics_loaded": sum(1 for x in results if int(x.get("timed_line_count") or 0) >= 2),
        "plain_only": sum(1 for x in results if x.get("plain_lyrics_present") and int(x.get("timed_line_count") or 0) < 2),
        "no_lyrics_loaded": sum(1 for x in results if not x.get("plain_lyrics_present") and int(x.get("timed_line_count") or 0) < 2),
        "vocal_sync_passed": sum(1 for x in results if (x.get("lyric_verification") or {}).get("vocal_sync_verified")),
        "youtube_or_environment_inconclusive": sum(1 for x in results if not (x.get("audio") or {}).get("audio_detected")),
    }
    out = ROOT / f"historical-lyrics-regression-{sha[:10]}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if len(results) == len(TESTS) else 1

if __name__ == "__main__":
    raise SystemExit(main())
