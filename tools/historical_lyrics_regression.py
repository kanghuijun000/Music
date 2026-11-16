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
    ("ff08c106ce746b764f5f5e77eaa78e96c3df8fc2", "before-korean-spacing-guard"),
    ("a14f3e2e00a8612e8924d5f88b5e6580aae94972", "after-korean-spacing-guard"),
    ("680e1bba3b68a8175e3a752cd6ad7cb9f4d5b972", "after-smooth-lyric-transition"),
    ("837a3a642253bbdaf50c9bcc934c0e7cf89bc6be", "before-title-context-improvements"),
]
FIXED = [
    {"name": "오래된 노래 — exact user video", "video_id": "LMyH5WT7JEM", "audio_check": False, "seconds": 25},
    {"name": "Counting Stars — exact previously tested video", "video_id": "5vilULw-9Gg", "audio_check": False, "seconds": 25},
    {"name": "Sold Out — exact previously tested lyric video", "video_id": "GspDybPhOeY", "audio_check": False, "seconds": 25},
    {"name": "비망록 — Buzz (Flux Records Korea lyric upload)", "video_id": "Y7gpPlXyhDE", "audio_check": False, "seconds": 25},
    {"name": "사랑인걸 — Moses (웅키 lyric video)", "video_id": "yPqI1VAHX8Q", "audio_check": False, "seconds": 25},
    {"name": "인사 — Beomjin (exact short-title user video)", "video_id": "bbqr6NkJ88A", "audio_check": True, "seconds": 45},
    {"name": "사랑인걸 — exact user video with reported constant lag", "video_id": "6RsbVu2fG_o", "audio_check": True, "seconds": 45},
    {"name": "좋은 밤 좋은 꿈 — Nerd Connection (웅키 lyric video)", "video_id": "mTonMiKVZRw", "audio_check": False, "seconds": 25},
    {"name": "밤편지 — IU (lyric video)", "video_id": "EjMTw4xLcBI", "audio_check": False, "seconds": 25},
    {"name": "조용히 완전히 영원히 — Nerd Connection (official lyrics video)", "video_id": "1q2fBL1LqZI", "audio_check": False, "seconds": 25},
    {"name": "Home Sweet Home — Car, the garden (lyric upload)", "video_id": "9ZAmRR6mDpU", "audio_check": False, "seconds": 25},
    {"name": "Home Sweet Home — Car, the garden (official audio)", "video_id": "MV9kclfajk8", "audio_check": True, "seconds": 45},
    {"name": "TICK TOCK — SMTM12 (original lyric upload)", "video_id": "Nx9pNz6-Wns", "audio_check": False, "seconds": 25},
    {"name": "Sold Out — Hawk Nelson (alternate lyric video)", "video_id": "aW0xVc4CsL8", "audio_check": True, "seconds": 70},
]
RANDOM_POOL = [
    {"name": "Counting Stars — OneRepublic (official music video)", "video_id": "hT_nvWreIhg", "audio_check": True, "seconds": 45},
    {"name": "TICK TOCK — SMTM12 (Mnet official video)", "video_id": "0sxLgAVPWVs", "audio_check": True, "seconds": 45},
    {"name": "사건의 지평선 — Younha (official M/V)", "video_id": "BBdC1rl5sKY", "audio_check": True, "seconds": 45},
    {"name": "Perfect — Ed Sheeran (official music video)", "video_id": "2Vv-BfVoq4g", "audio_check": True, "seconds": 45},
    {"name": "Dynamite — BTS (official music video)", "video_id": "gdZLi9oWNZg", "audio_check": False, "seconds": 25},
    {"name": "Ditto — NewJeans (performance video)", "video_id": "Km71Rr9K-Bw", "audio_check": False, "seconds": 25},
    {"name": "Blinding Lights — The Weeknd (official video)", "video_id": "4NRXx6U8ABQ", "audio_check": False, "seconds": 25},
]
# Deterministic random sample: identical songs on every commit, so commit-to-commit
# differences cannot be explained by a changing test set.
TESTS = FIXED + random.Random("Music-lyrics-regression-2026-11-15").sample(RANDOM_POOL, len(RANDOM_POOL))

def run(cmd, *, timeout=1200):
    return subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=timeout)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", required=True, help="Historical commit SHA")
    parser.add_argument("--fixed-only", action="store_true", help="Run only the fixed comparison fixtures")
    args = parser.parse_args()
    test_set = FIXED if args.fixed_only else TESTS
    if args.commit.upper() == "HEAD":
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        label = "current-app"
    else:
        match = next(((sha, label) for sha, label in COMMITS if sha.startswith(args.commit)), None)
        if not match:
            raise SystemExit("Commit is not in the approved historical regression list, or use HEAD for the checked-out commit")
        sha, label = match
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "commit": sha,
        "stage": label,
        "test_set": [item["name"] for item in test_set],
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
        for test in test_set:
            command = [sys.executable, "tools/youtube_audio_probe.py", "--seconds", str(test.get("seconds", 45)), "--app-root", str(snapshot)]
            if test.get("video_id"):
                command += ["--video-id", test["video_id"]]
            else:
                command += ["--query", test["query"]]
            if not test.get("audio_check", True):
                command.append("--skip-audio")
            try:
                probe_path = ROOT / "youtube-audio-probe-report.json"
                probe_path.unlink(missing_ok=True)
                proc = run(command, timeout=1200)
                detail = json.loads(probe_path.read_text(encoding="utf-8")) if probe_path.exists() else {}
                verification = detail.get("lyric_verification") or {}
                result = {
                    "song": test["name"],
                    "audio_check": bool(test.get("audio_check", True)),
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
                    "app_lyrics_status": detail.get("app_lyrics_status", ""),
                    "app_lyric_track": detail.get("app_lyric_track", {}),
                    "app_lyric_timing_basis": detail.get("app_lyric_timing_basis"),
                    "app_lyric_offset_seconds": detail.get("app_lyric_offset_seconds"),
                    "lyric_flow_events": detail.get("lyric_flow_events", []),
                    "app_static_validation": detail.get("app_static_validation"),
                    "app_static_validation_passed": detail.get("app_static_validation_passed"),
                    "verification_status": detail.get("verification_status", "MISSING"),
                    "player_playing_seen": detail.get("player_playing_seen", False),
                    "player_time_advanced_seconds": detail.get("player_time_advanced_seconds", 0),
                    "youtube_player_error_code": detail.get("youtube_player_error_code"),
                    "browser_errors": detail.get("browser_errors", []),
                    "youtube_network_errors": detail.get("youtube_network_errors", []),
                    "renderer_sample_count": (detail.get("app_renderer") or {}).get("sample_count", 0),
                    "renderer_mismatch_ratio": (detail.get("app_renderer") or {}).get("mismatch_ratio"),
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
        "identity_verified": sum(1 for x in results if (x.get("lyric_verification") or {}).get("identity_verified")),
        "retrieval_passed": sum(1 for x in results if (x.get("lyric_verification") or {}).get("identity_verified") and (int(x.get("timed_line_count") or 0) >= 2 or x.get("plain_lyrics_present"))),
        "vocal_sync_passed": sum(1 for x in results if (x.get("lyric_verification") or {}).get("vocal_sync_verified")),
        "vocal_sync_inconclusive": sum(1 for x in results if x.get("verification_status") == "INCONCLUSIVE" and x.get("audio_check", True)),
        "audio_check_skipped": sum(1 for x in results if not x.get("audio_check", True)),
        "vocal_sync_failed": sum(1 for x in results if x.get("verification_status") == "FAIL"),
        "timing_verification_failures": sum(1 for x in results if x.get("verification_status") == "FAIL"),
        "youtube_embed_blocked": sum(1 for x in results if x.get("youtube_player_error_code") in (101, 150)),
        "diagnostic_event_count": sum(len(x.get("lyric_flow_events") or []) for x in results),
        "static_validation_failed": sum(1 for x in results if x.get("app_static_validation_passed") is False),
        "player_started": sum(1 for x in results if x.get("player_playing_seen")),
        "youtube_or_environment_inconclusive": sum(1 for x in results if x.get("audio_check", True) and not (x.get("audio") or {}).get("audio_detected")),
    }
    out = ROOT / f"historical-lyrics-regression-{sha[:10]}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    retrieval_failures = [x for x in results if x.get("error") or not (x.get("lyric_verification") or {}).get("identity_verified") or not (int(x.get("timed_line_count") or 0) >= 2 or x.get("plain_lyrics_present")) or x.get("app_static_validation_passed") is False or x.get("verification_status") not in ("PASS", "INCONCLUSIVE")]
    if args.commit.upper() == "HEAD" and not report["summary"]["vocal_sync_passed"]:
        report["summary"]["sync_gate"] = "NO_AUDIO_SYNC_PASS"
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
        return 1
    return 0 if len(results) == len(test_set) and not retrieval_failures else 1

if __name__ == "__main__":
    raise SystemExit(main())
