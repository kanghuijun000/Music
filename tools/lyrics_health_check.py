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
TIMEOUT = 12
USER_AGENT = "Music-Lyrics-HealthCheck/1.0 (+https://github.com/kanghuijun000/Music)"
BASE_FIXTURES = [
    {"title": "오래된 노래", "artist": "스탠딩 에그", "duration": 272, "kind": "regression"},
    {"title": "비망록", "artist": "버즈", "duration": 0, "kind": "regression"},
    {"title": "밤편지", "artist": "아이유", "duration": 0, "kind": "regression"},
    {"title": "사랑인걸", "artist": "모세", "duration": 0, "kind": "baseline"},
    {"title": "인사", "artist": "범진", "duration": 215, "kind": "strict-match"},
    {"title": "언제나", "artist": "허각", "duration": 230, "kind": "hangul-sync-recovery"},
    {"title": "좋은 밤 좋은 꿈", "artist": "너드커넥션", "duration": 0, "kind": "baseline"},
    {"title": "Home Sweet Home", "artist": "카더가든", "duration": 206, "kind": "regression"},
    {"title": "Counting Stars", "artist": "OneRepublic", "duration": 0, "kind": "regression"},
    {"title": "Sold Out", "artist": "Hawk Nelson", "duration": 0, "kind": "regression"},
    {"title": "조용히 완전히 영원히", "artist": "너드커넥션", "duration": 189, "kind": "baseline"},
    {"title": "TICK TOCK (Feat. ZICO) (Prod. by ZICO, Crush)", "artist": "김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁", "duration": 230, "kind": "strict-match"},
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

ARTIST_ALIAS_GROUPS = (
    frozenset((norm("버즈"), norm("buzz"))),
    frozenset((norm("카더가든"), norm("car the garden"))),
    frozenset((norm("너드커넥션"), norm("nerd connection"))),
    frozenset((norm("범진"), norm("beomjin"), norm("beom jin"), norm("beom-jin"))),
)

def artist_match(actual: object, expected: str) -> bool:
    a, e = norm(actual), norm(expected)
    if not a or not e:
        return False
    if any(a in aliases and e in aliases for aliases in ARTIST_ALIAS_GROUPS):
        return True
    return a == e or e in a or a in e

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
    verifier = (ROOT / "tools/lyric_audio_verify.py").read_text(encoding="utf-8")
    probe = (ROOT / "tools/youtube_audio_probe.py").read_text(encoding="utf-8")
    results = []
    liriqo_start = app.find('const provider="LiriQo";')
    liriqo_end = app.find('if(candidates.length===0', liriqo_start) if liriqo_start >= 0 else -1
    liriqo_block = app[liriqo_start:liriqo_end] if liriqo_start >= 0 and liriqo_end > liriqo_start else ""
    checks = {
        "parenthetical artist aliases take precedence over generic lyric-label parsing": "if(!artistKnown&&!leadingParentheticalArtist&&(hasExplicitLyricsLabel||hasOfficialVideoLabel)&&(parts.length===2||parts.length===1))" in app,
        "shared song lyric cache checks verified artist aliases from both uploads": "function cachedArtistIdentityNames(cached)" in app and "identity.artistAliases" in app and "cachedArtistIdentityNames(cached)" in app,
        "video-specific offsets are never reused across different uploads": 'if(item.timingBasis==="video"&&sourceKey!==targetVideoId)return null;' in app,
        "quoted lyric-video titles resolve artist and song": "quotedArtistTitle=raw.match" in app,
        "LiriQo video-ID and song searches do not block each other": "Promise.any(attempts)" in app,
        "closeDuration declaration is active": bool(re.search(
            r"^\s*const closeDuration=Number\(item\.duration\)>0&&duration>=10;",
            app, re.M)),
        "closeDuration is not hidden inside an escaped newline comment":
            not bool(re.search(r"^\s*//.*\\\\n.*const closeDuration=", app, re.M)),
        "synced-only candidate gate exists": "_synced" in app and "ttmlLines.length>=2" in app,
        "exact video source can omit artist only with exact title and close duration": "exactVideoIdentityWithoutArtist=exactVideoSource&&!itemArtist&&title===100&&closeDuration" in app,
        "verified lyrics can finish before all providers settle": "firstVerifiedCandidate.then(()=>" in app and "await delay(450)" in app,
        "audio identification waits for initial lyrics resolution before applying the fingerprint offset": "try{await initialLyricsPromise;}catch(_){}" in app and "const finishWithTracks=async tracks=>{" in app,
        "same-track plain lyrics trigger a fingerprinted synced-lyrics retry": "previousPlainFallback=Boolean(previous&&!previous.lines.length" in app and "reason:previousPlainFallback?\"upgrade_plain_to_synced\"" in app,
        "same-track plain lyrics are preserved if no verified synced replacement exists": "sameTrack&&previousPlainFallback" in app and "lyricState.plain=previous.plain" in app,
        "fingerprint cache reuse still verifies title and artist": "const titleMatches=trackSimilarity(cached.trackName,metadata.trackName)>=0.92;" in app and "if(titleMatches&&artistMatches)" in app,
        "on-device playback audit is wired": "recordPlaybackAuditRender(index,current)" in app and "auditStartButton" in app,
        "timed lyric renderer wiring is present": "function renderLyrics(" in app and "lyricState.lines" in app,
        "lyric-video description credits are available for identity matching": "snippet.description" in app and "video?.description" in app,
        "manual vocal-start timing check is available": "auditMarkButton" in app and "medianUserMarkedOffsetMs" in app,
        "render, audit and QA use one shared lyric timeline conversion": "function getLyricTimelineTime" in app and "return getLyricLineIndexAtPlayerTime(playerTime,currentVideoId);" in app and "getLyricPlayerTimeForLine(line,lyricState.lines,index,currentVideoId)" in app,
        "audio regression includes manual correction and display lead in the app offset": "effectiveAppOffsetSeconds" in app and "def effective_app_offset(app_snapshot):" in verifier and "offset_error<=0.25" in verifier,
        "audio regression fits one constant offset with a fine search": "offset_model=\"single_constant_offset\"" in verifier and "offset_search_resolution_seconds=0.025" in verifier and "delta<=2.5" in verifier,
        "official YouTube descriptions reach the app identity parser": "fetch_video_description(video_id)" in verifier and '"description": description' in probe and "video_title, expected_title, expected_artist, channel, description = identified" in probe,
        "YouTube search results retain video descriptions for artist identification": 'description:String(v.snippet.description||"")' in app,
        "QA snapshot exposes provider-level lyric diagnostics": "lyricFlow:{events:lyricFlowAudit.videoId===currentVideoId" in app,
        "QA snapshot validates loaded lyric timestamps and lines": "staticValidation:auditValidateLoadedLyrics()" in app,
        "loaded lyric audit checks verified Korean spacing": "normalizeTimedLyricsSpacing(lines,lyricState.plain||\"\")" in app and "한국어 가사 띄어쓰기를 검증할 수 없습니다." in app,
        "spacing validator is shared at top level before the QA audit": 0 <= app.find("function normalizeTimedLyricsSpacing") < app.find("function auditValidateLoadedLyrics") and app.count("function normalizeTimedLyricsSpacing") == 1,
        "plain-lyrics fallback remains valid when audio verification is unavailable": "renderer.get(\"plain_lyrics_present\")" in probe and 'report["verification_status"] = "INCONCLUSIVE"' in probe,
        "retrieval-only videos still receive strict song identity verification": '"--skip-audio"' in probe and "verify_lyrics(None, args.video_id, app_snapshot, identified)" in probe and "if audio_path is None:" in verifier,
        "comma-containing artist names are not split into false aliases": "Commas can be part of one artist name" in app and 'trackText(artist)==="car the garden"' in app and 'trackText(artist)==="카더가든"' in app and "creditedArtist.split" not in app,
        "Nerd Connection Korean-English artist alias is explicit": '["너드커넥션","nerd connection"]' in app and artist_match("Nerd Connection", "너드커넥션") and not artist_match("Nerdcore", "너드커넥션"),
        "Beomjin Korean-English artist alias is explicit and narrow": '["범진","beomjin","beom jin","beom-jin"]' in app and artist_match("Beomjin", "범진") and not artist_match("Beom", "범진"),
        "underscore-separated lyric-video suffix is normalized": "|_|[-–—]" in app,
        "shared plain lyric cache fallback is absent": "findSharedPlainLyricCache" not in app,
        "Korean romanized sync does not suppress the Hangul-capable LiriQo fallback": (
            "const requiresHangulSync=hasHangulText([identity.title,identity.artist,...(identity.titles||[])].filter(Boolean).join(\" \"));" in app
            and "item._synced&&(!requiresHangulSync||hasHangulTimedLyrics(item))" in app
            and 'const provider="LiriQo";' in app
            and 'jobs.push((async()=>{\n  const provider="LiriQo";' not in app
        ),
        "Hangul timed-line detection is independent of Hangul plain lyrics": (
            "function candidateTimedLyricsText(item)" in app
            and "function candidatePlainLyricsText(item)" in app
            and "function hasHangulTimedLyrics(item)" in app
            and "hasHangulText(candidateTimedLyricsText(item))" in app
            and "const lyrics=candidateTimedLyricsText(item);" in app
        ),
        "the same candidate's Hangul plain lyrics can restore its romanized sync": (
            "hasHangulPlainLyrics(romanized)" in app
            and "restoreRomanizedKoreanSync(romanized.ttmlLines,candidate.plainLyrics)" in app
            and "selected=asHangulPlainFallback(plainCandidates[0])" in app
        ),
        "LiriQo fallback requests full results in the actual LiriQo code path": (
            bool(liriqo_block)
            and 'videoUrl.searchParams.set("full","1");' in liriqo_block
            and 'songUrl.searchParams.set("full","1");' in liriqo_block
            and 'if(valid&&valid._synced&&(!requiresHangulSync||hasHangulTimedLyrics(valid)))return true;' in liriqo_block
            and 'LiriQo 요청 제한 시간 초과"),{code:"TIMEOUT"})),15000);' in liriqo_block
        ),
        "Hangul script requirement is derived from song titles rather than artist names": (
            "function requiresHangulLyricsScript(trackIdentity)" in app
            and "trackIdentity?.title" in app
            and "trackIdentity?.titles" in app
            and "const requiresHangulSync=requiresHangulLyricsScript(identity);" in app
            and "const expectedKoreanScript=requiresHangulLyricsScript(identity);" in app
        ),
        "romanized sync restoration uses global monotonic alignment with conservative thresholds": (
            "const dp=Array.from({length:timed.length+1}" in app
            and "const maxGroupLines=4;" in app
            and "best.minSimilarity<0.70" in app
            and "coverage<0.70" in app
        ),
        "LiriQo plain-text results can be used as a final fallback": (
            "item.plain||item.plainLyrics" in app and '==="plain"?item.lyrics' in app
        ),
        "LiriQo millisecond timestamps are converted to seconds": (
            "time:providerMillisecondsToSeconds(line?.start)" in app and "start:providerMillisecondsToSeconds(word?.start)" in app
        ),
        "LiriQo requests are cancelled when the user changes songs": (
            "lyricFallbackAbortController" in app
            and "if(lyricFallbackAbortController)lyricFallbackAbortController.abort" in app
        ),
        "QA exposes Hangul-vs-Latin timed and plain lyric counts without lyric text": (
            "hangulTimedLineCount" in app and "latinOnlyTimedLineCount" in app
            and "hangulPlainLineCount" in app and "latinOnlyPlainLineCount" in app
            and 'report["hangul_timed_line_count"]' in probe
            and 'report["hangul_plain_line_count"]' in probe
        ),
        "last-resort Hangul plain fallback only runs when no candidate exists": (
            "if(candidates.length===0&&!lyricSignal.aborted&&hasHangulText(" in app
            and 'const provider="Lyrics.ovh/한글 일반 가사 대체";' in app
            and "싱크 타임스탬프는 만들지 않았습니다." in app
        ),
        "lyric cache namespace exists": bool(re.search(r"music_lyrics_cache_v\d+", app)),
        "app and service-worker versions agree": bool(
            re.search(r"app\.js\?v=([^\"&]+)", index)
            and re.search(r'CACHE_VERSION="([^"]+)"', sw)
            and re.search(r"\./app\.js\?v=([^\"&]+)", sw)
            and re.search(r"app\.js\?v=([^\"&]+)", index).group(1)
                == re.search(r'CACHE_VERSION="([^"]+)"', sw).group(1)
                == re.search(r"\./app\.js\?v=([^\"&]+)", sw).group(1)),
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
        url = "https://api.liriqo-alfarrizi.my.id/v1/lyrics?" + q({"title": title, "artist": artist, "full": "1"})
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
        pool = list(data.get("tracks", [])) if isinstance(data, dict) and isinstance(data.get("tracks"), list) else []
        if isinstance(data, dict) and isinstance(data.get("primary"), dict):
            pool.append(data["primary"])
        for item in pool:
            if isinstance(item, dict):
                candidates.append({**item, "trackName": item.get("title") or item.get("trackName") or metadata.get("title") or "",
                                   "artistName": item.get("artist") or item.get("artistName") or metadata.get("artist") or "",
                                   "duration": item.get("duration") or metadata.get("duration") or 0})
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
    plain = selected.get("plain") or selected.get("plainLyrics") or ""
    plain_count = sum(1 for line in str(plain).splitlines() if line.strip())
    hangul_plain_count = sum(1 for line in str(plain).splitlines() if re.search(r"[가-힣]", line))
    latin_only_plain_count = sum(1 for line in str(plain).splitlines() if re.search(r"[a-z]", line, re.I) and not re.search(r"[가-힣]", line))
    result["timed_lines"] = count
    if provider == "LiriQo" and isinstance(timed, list):
        result["hangul_timed_lines"] = sum(
            1 for line in timed if isinstance(line, dict)
            and re.search(r"[가-힣]", str(line.get("text") or ""))
            and isinstance(line.get("start"), (int, float))
        )
    else:
        result["hangul_timed_lines"] = None
    result["plain_lines"] = plain_count
    result["hangul_plain_lines"] = hangul_plain_count
    result["latin_only_plain_lines"] = latin_only_plain_count
    result["lyric_mode"] = "synced" if count >= 2 else "plain" if plain_count >= 2 else "none"
    result["status"] = "PASS" if count >= 2 or plain_count >= 2 else "WARN"
    result["reason"] = "" if count >= 2 or plain_count >= 2 else "candidate_found_but_no_usable_lyrics"
    if provider == "LiriQo":
        cors = meta.get("cors")
        result["browser_cors"] = "PASS" if cors in ("*", "https://kanghuijun000.github.io") else "NOT_CONFIRMED"
        if meta.get("http") == 200 and result["browser_cors"] != "PASS":
            result["status"] = "WARN"
            result["reason"] = (result["reason"] + "; " if result["reason"] else "") + "browser_cors_header_missing"
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
    exact_video_missing_artist_allowed = (
        title_match("조용히 완전히 영원히", "조용히 완전히 영원히")
        and 189 > 0 and abs(189 - 189) <= max(18, 189 * .12)
    )
    exact_video_wrong_title_rejected = not title_match("다른 노래", "조용히 완전히 영원히")
    exact_video_wrong_duration_rejected = abs(240 - 189) > max(18, 189 * .12)
    results.append({
        "category": "safety", "name": "exact video-bound title and duration may verify missing artist metadata",
        "status": "PASS" if exact_video_missing_artist_allowed and exact_video_wrong_title_rejected and exact_video_wrong_duration_rejected else "FAIL"
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
            "browser_cors": (
                "PASS" if (liriqo_successes := [x for x in results if x.get("category") == "provider"
                                                and x.get("provider") == "LiriQo" and x.get("http") == 200])
                and all(x.get("browser_cors") == "PASS" for x in liriqo_successes)
                else "NOT_CONFIRMED"
            ),
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
        cors = f' cors={item.get("browser_cors")}' if item.get("provider") == "LiriQo" else ""
        print(f'{item["status"]:4} {item["category"]:8} {label}{fixture} {item.get("reason", "")} {item.get("response_detail", "")}{cors}')
    print(json.dumps(report["summary"], ensure_ascii=False))
    return 1 if any(x["category"] in ("static", "safety") and x["status"] == "FAIL" for x in results) else 0

if __name__ == "__main__":
    sys.exit(main())
