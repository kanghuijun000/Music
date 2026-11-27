#!/usr/bin/env python3
"""Read-only live probe of Lyrica for the Korean sync-recovery target.
The report deliberately stores metadata and counts only, never lyric text.
"""
from __future__ import annotations
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://wilooper-lyrica.hf.space/lyrics/"
QUERIES = [
    ("허각", "언제나"),
    ("Huh Gak", "언제나"),
    ("Huh Gak", "Always"),
]
OUT = Path("lyrica-korean-sync-probe.json")


def is_hangul(text: str) -> bool:
    return any("\uac00" <= ch <= "\ud7a3" for ch in text)


def probe(artist: str, song: str) -> dict:
    params = urllib.parse.urlencode({
        "artist": artist, "song": song, "timestamps": "true",
        "fast": "true", "metadata": "true",
    })
    request = urllib.request.Request(
        BASE + "?" + params,
        headers={"User-Agent": "Music-Lyrica-Probe/1.0", "Accept": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=50) as response:
            raw = response.read(2_000_000)
            elapsed = round((time.monotonic() - started) * 1000)
            payload = json.loads(raw.decode("utf-8", errors="replace"))
            data = payload.get("data") if isinstance(payload, dict) else {}
            data = data if isinstance(data, dict) else {}
            timed = data.get("timed_lyrics") or data.get("timedLyrics") or []
            timed = timed if isinstance(timed, list) else []
            plain = str(data.get("lyrics") or data.get("plainLyrics") or "")
            timed_texts = [
                str(line.get("text") or line.get("lyrics") or "")
                for line in timed if isinstance(line, dict)
            ]
            return {
                "artist_query": artist, "song_query": song,
                "http_status": response.status, "elapsed_ms": elapsed,
                "api_status": payload.get("status"),
                "source": data.get("source"),
                "returned_artist": data.get("artist"),
                "returned_title": data.get("title") or data.get("song"),
                "has_timestamps": bool(data.get("hasTimestamps") or data.get("has_timestamps")),
                "sync_level": data.get("sync_level") or data.get("syncLevel"),
                "timed_line_count": len(timed),
                "hangul_timed_line_count": sum(is_hangul(line) for line in timed_texts),
                "latin_only_timed_line_count": sum(bool(line) and not is_hangul(line) for line in timed_texts),
                "plain_line_count": sum(bool(line.strip()) for line in plain.splitlines()),
                "hangul_plain_line_count": sum(is_hangul(line) for line in plain.splitlines()),
                "error": (payload.get("error") or {}).get("message") if isinstance(payload.get("error"), dict) else payload.get("error"),
            }
    except urllib.error.HTTPError as exc:
        return {"artist_query": artist, "song_query": song, "http_status": exc.code,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "error": exc.read(500).decode("utf-8", errors="replace")}
    except Exception as exc:
        return {"artist_query": artist, "song_query": song,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "error": type(exc).__name__ + ": " + str(exc)[:300]}


def main() -> None:
    results = []
    for artist, song in QUERIES:
        result = probe(artist, song)
        if result.get("http_status") in (502, 503, 504) or "Timeout" in str(result.get("error")):
            time.sleep(4)
            retry = probe(artist, song)
            retry["retry"] = True
            result = retry
        results.append(result)
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "endpoint": BASE,
        "target": {"artist": "허각", "title": "언제나", "youtube_video_id": "MQ8EdGX3DZE"},
        "privacy": "Lyric text is not stored; only source metadata and line counts are reported.",
        "results": results,
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
