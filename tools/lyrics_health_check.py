#!/usr/bin/env python3
"""Read-only health checks for Music lyric providers. Never stores lyric text."""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TIMEOUT = 9
USER_AGENT = "Music-Lyrics-HealthCheck/1.0 (+https://github.com/kanghuijun000/Music)"
FIXTURES = [
    {"title": "사랑인걸", "artist": "모세", "duration": 0, "kind": "baseline"},
    {"title": "좋은 밤 좋은 꿈", "artist": "너드커넥션", "duration": 0, "kind": "baseline"},
    {"title": "TICK TOCK", "artist": "알파", "duration": 0, "kind": "strict-match"},
]

def norm(value: object) -> str:
    value = str(value or "").lower()
    value = re.sub(r"\([^)]*(feat|prod|lyrics|가사)[^)]*\)", " ", value, flags=re.I)
    return re.sub(r"[^0-9a-z가-힣]", "", value)

def title_match(actual: object, expected: str) -> bool:
    a, e = norm(actual), norm(expected)
    return bool(a and e and (a == e or a.startswith(e) or e.startswith(a)))

def artist_match(actual: object, expected: str) -> bool:
    a, e = norm(actual), norm(expected)
    return bool(a and e and (a == e or e in a or a in e))

def identity_match(actual_title: object, actual_artist: object, expected_title: str, expected_artist: str) -> bool:
    return title_match(actual_title, expected_title) and artist_match(actual_artist, expected_artist)

def timed_line_count(value: object) -> int:
    if not isinstance(value, str):
        return 0
    lrc = re.findall(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]", value)
    ttml = re.findall(r"\bbegin\s*=\s*['\"][^'\"]+['\"]", value, flags=re.I)
    return max(len(lrc), len(ttml))

def request_json(url: str) -> tuple[object | None, dict, float, str | None]:
    started = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            raw = response.read(2_000_000)
            elapsed = round((time.monotonic() - started) * 1000)
            try:
                data = json.loads(raw.decode("utf-8-sig"))
            except Exception:
                return None, {"http": response.status}, elapsed, "invalid_json"
            return data, {"http": response.status}, elapsed, None
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read(500).decode("utf-8", errors="replace").strip()
        except Exception:
            detail = ""
        return {"_http_error_detail": detail}, {"http": exc.code}, round((time.monotonic() - started) * 1000), f"http_{exc.code}"
    except Exception as exc:
        return None, {}, round((time.monotonic() - started) * 1000), type(exc).__name__

def check_static() -> list[dict]:
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    sw = (ROOT / "sw.js").read_text(encoding="utf-8")
    results = []
    checks = {
        "closeDuration declaration is active": bool(re.search(
            r"^\s*const closeDuration=Number\(item\.duration\)>0&&duration>=10;",
            app, re.M)),
        "closeDuration is not hidden inside an escaped newline comment":
            not bool(re.search(r"^\s*//.*\\\\n.*const closeDuration=", app, re.M)),
        "synced-only candidate gate exists": "_synced" in app and "ttmlLines.length>=2" in app,
        "shared plain lyric cache fallback is absent": "findSharedPlainLyricCache" not in app,
        "lyric cache namespace exists": bool(re.search(r"music_lyrics_cache_v\d+", app)),
        "app and service-worker versions agree": bool(
            re.search(r"app\.js\?v=(\d+)", index)
            and re.search(r'CACHE_VERSION="v(\d+)"', sw)
            and re.search(r"\./app\.js\?v=(\d+)", sw)
            and re.search(r"app\.js\?v=(\d+)", index).group(1)
                == re.search(r'CACHE_VERSION="v(\d+)"', sw).group(1)
                == re.search(r"\./app\.js\?v=(\d+)", sw).group(1)),
    }
    for name, ok in checks.items():
        results.append({"category": "static", "name": name, "status": "PASS" if ok else "FAIL"})
    return results

def provider_check(provider: str, fixture: dict) -> dict:
    title, artist = fixture["title"], fixture["artist"]
    q = urllib.parse.urlencode
    if provider == "LRCLIB":
        url = "https://lrclib.net/api/search?" + q({"track_name": title, "artist_name": artist})
    elif provider == "SyncLRC":
        url = "https://api.synclrc.dev/search?" + q({"q": f"{title} {artist}", "limit": "10"})
    elif provider == "Unison":
        url = "https://unison.boidu.dev/lyrics/search?" + q({"q": f"{title} {artist}", "limit": "10"})
    else:
        url = "https://api.betterlyrics.org/getLyrics?" + q({
            "s": title, "a": artist, "al": "", "d": str(fixture.get("duration") or "")
        })

    data, meta, elapsed, error = request_json(url)
    result = {
        "category": "provider", "provider": provider,
        "fixture": f'{artist} - {title}', "http": meta.get("http"),
        "elapsed_ms": elapsed, "status": "FAIL", "reason": error or ""
    }
    if error:
        if isinstance(data, dict) and data.get("_http_error_detail"):
            result["response_detail"] = str(data["_http_error_detail"])[:240]
        return result

    candidates = data if isinstance(data, list) else (
        data.get("results", data.get("data", [])) if isinstance(data, dict)
        and isinstance(data.get("results", data.get("data", [])), list)
        else [data] if isinstance(data, dict) else []
    )
    result["candidate_count"] = len(candidates)
    result["response_keys"] = sorted(list(data.keys()))[:20] if isinstance(data, dict) else []
    selected = None
    for item in candidates[:10]:
        if not isinstance(item, dict):
            continue
        actual_title = item.get("trackName") or item.get("track") or item.get("song") or item.get("title") or ""
        actual_artist = item.get("artistName") or item.get("artist") or ""
        if not identity_match(actual_title, actual_artist, title, artist):
            continue
        duration = float(item.get("duration") or 0)
        expected = float(fixture.get("duration") or 0)
        if duration and expected and abs(duration - expected) > max(18, expected * .12):
            continue
        selected = item
        break

    # Unison search returns candidates only; fetch lyrics by the exact returned video ID.
    if provider == "Unison" and selected:
        video_id = str(selected.get("videoId") or selected.get("video_id") or "")
        if not video_id:
            result["reason"] = "candidate_missing_video_id"
            return result
        lyric_url = "https://unison.boidu.dev/lyrics?" + q({"v": video_id})
        lyric_data, lyric_meta, lyric_ms, lyric_error = request_json(lyric_url)
        result["lyrics_http"] = lyric_meta.get("http")
        result["elapsed_ms"] += lyric_ms
        if lyric_error or not isinstance(lyric_data, dict):
            result["reason"] = lyric_error or "invalid_lyrics_response"
            return result
        payload = lyric_data.get("data") if isinstance(lyric_data.get("data"), dict) else lyric_data
        if str(payload.get("videoId") or "") != video_id:
            result["reason"] = "returned_video_id_mismatch"
            return result
        selected = payload

    if not selected:
        result["status"] = "WARN"
        result["reason"] = "no_strict_title_artist_candidate"
        result["sample_metadata"] = [
            {
                "title": str(x.get("trackName") or x.get("track") or x.get("song") or x.get("title") or "")[:90],
                "artist": str(x.get("artistName") or x.get("artist") or "")[:70],
                "duration": x.get("duration")
            }
            for x in candidates[:3] if isinstance(x, dict)
        ]
        return result

    # Provider-specific timed lyric fields; never print or persist lyric contents.
    timed = (
        selected.get("syncedLyrics") or selected.get("karaoke") or selected.get("synced")
        or selected.get("ttml") or selected.get("lyrics")
    )
    if isinstance(timed, dict):
        timed = timed.get("karaoke") or timed.get("synced") or ""
    count = timed_line_count(timed)
    result["timed_lines"] = count
    result["status"] = "PASS" if count >= 2 else "FAIL"
    result["reason"] = "" if count >= 2 else "no_two_or_more_timed_lines"
    return result

def main() -> int:
    results = check_static()
    # Deliberately test separate fixtures to reveal provider coverage, not just one lucky hit.
    for fixture in FIXTURES:
        for provider in ("LRCLIB", "SyncLRC", "Unison", "Better Lyrics/TTML"):
            try:
                results.append(provider_check(provider, fixture))
            except Exception as exc:
                results.append({
                    "category": "provider", "provider": provider,
                    "fixture": f'{fixture["artist"]} - {fixture["title"]}',
                    "status": "FAIL", "reason": type(exc).__name__
                })
    # Synthetic negative check: unrelated candidate must never pass identity matching.
    correct_accepted = identity_match("TICK TOCK", "알파", "TICK TOCK", "알파")
    wrong_title_rejected = not identity_match("다른 노래", "알파", "TICK TOCK", "알파")
    wrong_artist_rejected = not identity_match("TICK TOCK", "다른 가수", "TICK TOCK", "알파")
    results.append({
        "category": "safety", "name": "exact song and artist identity accepted",
        "status": "PASS" if correct_accepted else "FAIL"
    })
    results.append({
        "category": "safety", "name": "wrong title and wrong artist are rejected",
        "status": "PASS" if wrong_title_rejected and wrong_artist_rejected else "FAIL"
    })
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "note": "Server-side API check only. Browser CORS and playback synchronization require a real browser/device.",
        "summary": {
            "passed": sum(x["status"] == "PASS" for x in results),
            "warnings": sum(x["status"] == "WARN" for x in results),
            "failed": sum(x["status"] == "FAIL" for x in results),
            "browser_cors": "NOT_TESTED",
            "real_playback_sync": "NOT_TESTED"
        },
        "results": results
    }
    (ROOT / "lyrics-health-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for item in results:
        label = item.get("provider") or item.get("name")
        fixture = f' [{item["fixture"]}]' if item.get("fixture") else ""
        print(f'{item["status"]:4} {item["category"]:8} {label}{fixture} {item.get("reason", "")} {item.get("response_detail", "")}')
    print(json.dumps(report["summary"], ensure_ascii=False))
    return 1 if report["summary"]["failed"] else 0

if __name__ == "__main__":
    sys.exit(main())
