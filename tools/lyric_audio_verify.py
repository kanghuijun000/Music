#!/usr/bin/env python3
"""Conservative lyric-vocal verification from transient official-player audio."""
from __future__ import annotations
import difflib, json, re, sys, urllib.parse, urllib.request
from pathlib import Path

def norm(s):
    return re.sub(r"[^0-9a-z가-힣]", "", str(s or "").lower())

def fetch_json(url):
    req=urllib.request.Request(url,headers={"User-Agent":"Music-Lyric-Audio-QA/1.0"})
    with urllib.request.urlopen(req,timeout=12) as r:
        return json.loads(r.read(2_000_000).decode("utf-8-sig"))

def parse_lrc(raw):
    out=[]
    for line in str(raw or "").splitlines():
        stamps=re.findall(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]",line)
        text=re.sub(r"\[[^\]]+\]","",line).strip()
        if not text: continue
        for mm,ss,frac in stamps:
            ms=int((frac or "0").ljust(3,"0")[:3])
            out.append((int(mm)*60+int(ss)+ms/1000,text))
    return sorted(out)

def identify(video_id):
    meta=fetch_json("https://www.youtube.com/oembed?url="+urllib.parse.quote("https://www.youtube.com/watch?v="+video_id,safe="")+"&format=json")
    title=str(meta.get("title",""))
    author=str(meta.get("author_name",""))
    # Parse common "Artist - Track" title format; keep channel as an independent artist hint.
    cleaned=re.sub(r"\s*[|｜/]\s*(?:가사|lyrics?).*$","",title,flags=re.I).strip()
    m=re.match(r"^(.+?)\s*[-–—]\s*(.+)$",cleaned)
    if m:
        artist=m.group(1).strip()
        track=re.sub(r"\s*\([^)]*(?:official|lyrics?|가사|audio|video)[^)]*\)","",m.group(2),flags=re.I).strip()
    else:
        artist=author.replace(" - Topic","").strip()
        track=cleaned
    return title,track,artist

def get_lyrics(track,artist):
    q=urllib.parse.urlencode({"track_name":track,"artist_name":artist})
    candidates=fetch_json("https://lrclib.net/api/search?"+q)
    if not isinstance(candidates,list): return None
    ranked=[]
    for x in candidates:
        t=norm(x.get("trackName")); a=norm(x.get("artistName"))
        ts=difflib.SequenceMatcher(None,norm(track),t).ratio()
        ars=difflib.SequenceMatcher(None,norm(artist),a).ratio()
        if ts>=0.86 and ars>=0.78 and x.get("syncedLyrics"):
            ranked.append((ts*0.55+ars*0.45,x))
    if not ranked: return None
    ranked.sort(key=lambda z:z[0],reverse=True)
    if len(ranked)>1 and ranked[1][0]>=ranked[0][0]-0.025: return None
    return ranked[0][1]

def verify(audio_path,video_id):
    report={"identity_verified":False,"transcription_verified":False,"vocal_sync_verified":False,
            "overall":"UNVERIFIED","audio_file_retained":False}
    try:
        title,track,artist=identify(video_id)
        report.update(video_title=title,track=track,artist=artist)
        lyric=get_lyrics(track,artist)
        if not lyric:
            report["reason"]="No unique strict title+artist synced-lyrics match in LRCLIB"
            return report
        lines=parse_lrc(lyric.get("syncedLyrics"))
        report.update(identity_verified=True,lyric_source="LRCLIB",
                      matched_track=lyric.get("trackName"),matched_artist=lyric.get("artistName"),
                      timed_lyric_lines=len(lines))
        if len(lines)<6:
            report["reason"]="Too few timed lyric lines for audio verification"
            return report
        from faster_whisper import WhisperModel
        model=WhisperModel("small",device="cpu",compute_type="int8")
        segments,info=model.transcribe(str(audio_path),language=None,beam_size=5,
                                      vad_filter=True,word_timestamps=False)
        heard=[]
        for seg in segments:
            txt=norm(seg.text)
            if txt: heard.append((float(seg.start),float(seg.end),txt))
        report["asr_language"]=info.language
        report["asr_segments"]=len(heard)
        report["transcription_verified"]=bool(heard and info.language in ("ko","en","ja","zh"))
        if not heard:
            report["reason"]="ASR did not detect usable vocal text"
            return report
        # Estimate a single lyric/video offset. Match lyric lines against nearby ASR windows.
        best=None
        for offset_step in range(-80,81):
            offset=offset_step*0.25
            matches=[]
            for t,lyric_text in lines:
                target=norm(lyric_text)
                if len(target)<3: continue
                options=[]
                for start,end,heard_text in heard:
                    delta=abs((start+end)/2-(t+offset))
                    if delta>7.0: continue
                    ratio=difflib.SequenceMatcher(None,target,heard_text).ratio()
                    # Containment helps when ASR segments contain multiple lyric words.
                    if target in heard_text or heard_text in target: ratio=max(ratio,min(len(target),len(heard_text))/max(len(target),len(heard_text)))
                    options.append((ratio,delta))
                if options:
                    ratio,delta=max(options,key=lambda z:z[0]-z[1]*0.025)
                    if ratio>=0.42: matches.append((ratio,delta))
            if matches:
                quality=sum(r-d*0.025 for r,d in matches)/len(matches)
                if best is None or quality>best[0]: best=(quality,offset,matches)
        if not best:
            report["reason"]="No reliable overlap between recognized vocals and timed lyrics"
            return report
        _,offset,matches=best
        errors=sorted(x[1] for x in matches)
        median=errors[len(errors)//2]
        report.update(matched_vocal_lines=len(matches),matched_line_ratio=round(len(matches)/max(1,len(lines)),3),
                      estimated_lyric_offset_seconds=round(offset,2),median_vocal_line_time_error_seconds=round(median,2))
        # Conservative pass: several independent vocal/lyric matches and tight timing.
        passed=len(matches)>=6 and len(matches)/len(lines)>=0.30 and median<=1.5
        report["vocal_sync_verified"]=passed
        report["overall"]="PASS" if passed else "FAIL_OR_INCONCLUSIVE"
        if not passed: report["reason"]="Insufficient lyric-to-vocal matches or timing error exceeds 1.5 seconds"
        return report
    except Exception as exc:
        report["reason"]=type(exc).__name__+": "+str(exc)[:300]
        return report

if __name__=="__main__":
    if len(sys.argv)!=3: raise SystemExit("usage: lyric_audio_verify.py AUDIO.wav VIDEO_ID")
    print(json.dumps(verify(Path(sys.argv[1]),sys.argv[2]),ensure_ascii=False,indent=2))
