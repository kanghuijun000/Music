#!/usr/bin/env python3
"""Read-only health checks for Music lyric providers. Never stores lyric text."""
from __future__ import annotations

import json
import random
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
BASE_FIXTURES = [
    {"title": "사랑인걸", "artist": "모세", "duration": 0, "kind": "baseline"},
    {"title": "좋은 밤 좋은 꿈", "artist": "너드커넥션", "duration": 0, "kind": "baseline"},
    {"title": "TICK TOCK", "artist": "알파", "duration": 0, "kind": "strict-match"},
]
RANDOM_POOL = [
    {"title": "밤편지", "artist": "아이유", "duration": 0, "kind": "random"},
    {"title": "주저하는 연인들을 위해", "artist": "잔나비", "duration": 0, "kind": "random"},
    {"title": "Ditto", "artist": "NewJeans", "duration": 0, "kind": "random"},
    {"title": "Blinding Lights", "artist": "The Weeknd", "duration": 0, "kind": "random"},
    {"title": "Yellow", "artist": "Coldplay", "duration": 0, "kind": "random"},
    {"title": "Perfect", "artist": "Ed Sheeran", "duration": 0, "kind": "random"},
    {"title": "사건의 지평선", "artist": "윤하", "duration": 0, "kind": "random"},
    {"title": "Dynamite", "artist": "BTS", "duration": 0, "kind": "random"},
]
# Daily seeded sample: varied but reproducible for a given date.
FIXTURES = BASE_FIXTURES + random.Random(datetime.now(timezone.utc).date().isoformat()).sample(RANDOM_POOL, 3)

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
    if isinstance(value, list):
        return sum(1 for line in value if isinstance(line, dict) and str(line.get("text") or "").strip()
                   and isinstance(line.get("start"), (int, float)))
    if not isinstance(value, str):
        return 0
    lrc = re.findall(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]", value)
    ttml = re.findall(r"\bbegin\s*=\s*['\"][^'\"]+['\"]", value, flags=re.I)
    lyricsfile = re.findall(r"(?m)^\s*start_ms:\s*\d+", value)
    qrc = re.findall(r"(?m)^\[\d+,\d+\]", value)
    return max(len(lrc), len(ttml), len(lyricsfile), len(qrc))

def request_json(url: str) -> tuple[object | None, dict, float, str | None]:
    started = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "X-User-Agent": USER_AGENT, "Origin": "https://kanghuijun000.github.io", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            raw = response.read(2_000_000)
            elapsed = round((time.monotonic() - started) * 1000)
            try:
                data = json.loads(raw.decode("utf-8-sig"))
            except Exception:
                return None, {"http": response.status, "cors": response.headers.get("Access-Control-Allow-Origin")}, elapsed, "invalid_json"
            return data, {"http": response.status, "cors": response.headers.get("Access-Control-Allow-Origin")}, elapsed, None
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read(500).decode("utf-8", errors="replace").strip()
        except Exception:
            detail = ""
        return {"_http_error_detail": detail}, {"http": exc.code, "cors": exc.headers.get("Access-Control-Allow-Origin") if exc.headers else None}, round((time.monotonic() - started) * 1000), f"http_{exc.code}"
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
        "on-device playback audit is wired": "recordPlaybackAuditRender(index,current)" in app and "auditStartButton" in app,
        "timed lyric renderer wiring is present": "function renderLyrics(" in app and "lyricState.lines" in app,
        "manual vocal-start timing check is available": "auditMarkButton" in app and "medianUserMarkedOffsetMs" in app,
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
    duration = str(int(fixture.get("duration") or 0))
    if provider == "LRCLIB":
        url = "https://lrclib.net/api/search?" + q({"track_name": title, "artist_name": artist})
    elif provider == "SyncLRC":
        url = "https://api.synclrc.dev/search?" + q({"q": title, "limit": "10"})
    elif provider == "Unison":
        url = "https://unison.boidu.dev/lyrics/search?" + q({"q": f"{title} {artist}", "limit": "10"})
    elif provider == "Karalyr":
        url = "https://karalyr.com/api/get?" + q({"track_name": title, "artist_name": artist})
    elif provider == "LiriQo":
        url = "https://api.liriqo-alfarrizi.my.id/v1/lyrics?" + q({"title": title, "artist": artist})
    else:
        endpoint = {
            "Better Lyrics/TTML": "/getLyrics",
            "Better Lyrics/Kugou": "/kugou/getLyrics",
            "Better Lyrics/QQ": "/qq/getLyrics",
        }[provider]
        url = "https://api.betterlyrics.org" + endpoint + "?" + q({
            "s": title, "a": artist, "al": "", "d": duration
        })

    data, meta, elapsed, error = request_json(url)
    result = {
        "category": "provider", "provider": provider,
        "fixture": f'{artist} - {title}', "http": meta.get("http"),
        "elapsed_ms": elapsed, "status": "WARN", "reason": error or "",
        "cors_allow_origin": meta.get("cors")
    }
    if error:
        if error == "http_401" and provider.startswith("Better Lyrics/"):
            result["reason"] = "api_key_required_on_live_endpoint"
        if isinstance(data, dict) and data.get("_http_error_detail"):
            result["response_detail"] = str(data["_http_error_detail"])[:240]
        return result

    if provider == "LiriQo":
        metadata = data.get("metadata", {}) if isinstance(data, dict) else {}
        candidates = []
        for item in (data.get("tracks", []) if isinstance(data, dict) else []):
            if isinstance(item, dict):
                candidates.append({**item, "trackName": metadata.get("title") or item.get("title") or "",
                                   "artistName": metadata.get("artist") or item.get("artist") or "",
                                   "duration": metadata.get("duration") or item.get("duration") or 0})
        if not candidates and isinstance(data, dict) and isinstance(data.get("primary"), dict):
            item = data["primary"]
            candidates = [{**item, "trackName": metadata.get("title") or item.get("title") or "",
                           "artistName": metadata.get("artist") or item.get("artist") or "",
                           "duration": metadata.get("duration") or item.get("duration") or 0}]
    elif isinstance(data, list):
        candidates = data
    elif isinstance(data, dict) and isinstance(data.get("results"), list):
        candidates = data["results"]
    elif isinstance(data, dict) and isinstance(data.get("data"), list):
        candidates = data["data"]
    elif isinstance(data, dict) and isinstance(data.get("data"), dict):
        nested = data["data"]
        candidates = nested.get("results", []) if isinstance(nested.get("results"), list) else []
    else:
        candidates = [data] if isinstance(data, dict) else []

    result["candidate_count"] = len(candidates)
    result["response_keys"] = sorted(list(data.keys()))[:24] if isinstance(data, dict) else []
    selected = None
    for item in candidates[:20]:
        if not isinstance(item, dict):
            continue
        actual_title = item.get("trackName") or item.get("track") or item.get("song") or item.get("title") or ""
        actual_artist = item.get("artistName") or item.get("artist") or ""
        if not identity_match(actual_title, actual_artist, title, artist):
            continue
        candidate_duration = float(item.get("duration") or 0)
        expected_duration = float(fixture.get("duration") or 0)
        if candidate_duration and expected_duration and abs(candidate_duration - expected_duration) > max(18, expected_duration * .12):
            continue
        selected = item
        break

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

    result["matched_title"] = str(selected.get("trackName") or selected.get("track") or selected.get("song") or selected.get("title") or "")[:100]
    result["matched_artist"] = str(selected.get("artistName") or selected.get("artist") or "")[:100]
    result["matched_duration"] = selected.get("duration")
    result["sync_level"] = selected.get("syncLevel")
    result["upstream_provider"] = selected.get("upstreamProvider") or selected.get("provider")
    result["match_score"] = data.get("matchScore") if isinstance(data, dict) else None
    if provider == "LRCLIB" or provider == "Karalyr":
        timed = selected.get("syncedLyrics") or selected.get("lyricsfile") or ""
    elif provider == "LiriQo":
        timed = selected.get("timed") or []
    elif provider == "SyncLRC":
        lyric_obj = selected.get("lyrics") if isinstance(selected.get("lyrics"), dict) else selected
        timed = lyric_obj.get("karaoke") or lyric_obj.get("synced") or lyric_obj.get("lyrics") or ""
    else:
        timed = selected.get("lyrics") or selected.get("ttml") or selected.get("syncedLyrics") or ""
    if isinstance(timed, dict):
        timed = timed.get("karaoke") or timed.get("synced") or ""
    count = timed_line_count(timed)
    result["timed_lines"] = count
    result["status"] = "PASS" if count >= 2 else "WARN"
    result["reason"] = "" if count >= 2 else "candidate_found_but_no_two_timed_lines"
    return result

def main() -> int:
    results = check_static()
    # Deliberately test separate fixtures to reveal provider coverage, not just one lucky hit.
    for fixture in FIXTURES:
        for provider in ("LRCLIB", "SyncLRC", "Unison", "Karalyr", "LiriQo", "Better Lyrics/TTML", "Better Lyrics/Kugou", "Better Lyrics/QQ"):
            try:
                results.append(provider_check(provider, fixture))
            except Exception as exc:
                results.append({
                    "category": "provider", "provider": provider,
                    "fixture": f'{fixture["artist"]} - {fixture["title"]}',
                    "status": "WARN", "reason": type(exc).__name__
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
            "provider_passed": sum(x["category"] == "provider" and x["status"] == "PASS" for x in results),
            "provider_warnings": sum(x["category"] == "provider" and x["status"] == "WARN" for x in results),
            "browser_cors": "NOT_TESTED",
            "real_playback_sync": "NOT_TESTED",
            "fixture_count": len(FIXTURES),
            "random_fixture_count": len(FIXTURES) - len(BASE_FIXTURES),
            "fixture_names": [f'{x["artist"]} - {x["title"]}' for x in FIXTURES]
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
    return 1 if any(x["category"] in ("static", "safety") and x["status"] == "FAIL" for x in results) else 0

if __name__ == "__main__":
    sys.exit(main())
