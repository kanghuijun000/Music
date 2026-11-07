#!/usr/bin/env python3
"""Compare the live Music app's rendered lyric source with transient player audio."""
from __future__ import annotations
import difflib, json, re, sys, urllib.parse, urllib.request
from pathlib import Path

def norm(value):
    return re.sub(r"[^0-9a-z가-힣]", "", str(value or "").lower())

def fetch_json(url):
    request=urllib.request.Request(url,headers={"User-Agent":"Music-Live-Audio-QA/1.0"})
    with urllib.request.urlopen(request,timeout=15) as response:
        return json.loads(response.read(2_000_000).decode("utf-8-sig"))

def identify(video_id):
    meta=fetch_json("https://www.youtube.com/oembed?url="+urllib.parse.quote(
        "https://www.youtube.com/watch?v="+video_id,safe="")+"&format=json")
    title=str(meta.get("title",""))
    author=str(meta.get("author_name",""))
    cleaned=re.sub(r"\s*[|｜/]\s*(?:가사|lyrics?).*$","",title,flags=re.I).strip()
    match=re.match(r"^(.+?)\s*[-–—]\s*(.+)$",cleaned)
    if match:
        artist=match.group(1).strip()
        track=re.sub(r"\s*\([^)]*(?:official|lyrics?|가사|audio|video)[^)]*\)","",match.group(2),flags=re.I).strip()
    else:
        artist=author.replace(" - Topic","").strip()
        track=cleaned
    return title,track,artist,author

def verify(audio_path,video_id,app_snapshot):
    report={"app_lyrics_loaded":False,"identity_verified":False,
            "transcription_verified":False,"lyric_content_verified":False,
            "vocal_sync_verified":False,"overall":"UNVERIFIED",
            "audio_file_retained":False}
    try:
        video_title,expected_title,expected_artist,channel=identify(video_id)
        app_snapshot=app_snapshot if isinstance(app_snapshot,dict) else {}
        lines=[x for x in app_snapshot.get("lines",[]) if isinstance(x,dict)
               and str(x.get("text") or "").strip()
               and isinstance(x.get("time"),(int,float)) and float(x["time"])>=0]
        track=app_snapshot.get("track") or {}
        app_title=str(track.get("title") or "")
        app_artist=str(track.get("artist") or "")
        title_score=difflib.SequenceMatcher(None,norm(expected_title),norm(app_title)).ratio()
        artist_score=difflib.SequenceMatcher(None,norm(expected_artist),norm(app_artist)).ratio()
        identity_ok=bool(app_title and app_artist and title_score>=0.84 and artist_score>=0.76)
        report.update(video_title=video_title,expected_title=expected_title,expected_artist=expected_artist,
                      app_track_title=app_title,app_track_artist=app_artist,
                      app_lyric_source=str(track.get("source") or ""),
                      app_upstream_provider=str(track.get("upstreamProvider") or ""),
                      app_timing_basis=str(app_snapshot.get("timingBasis") or ""),
                      app_lyric_offset_seconds=round(float(app_snapshot.get("lyricOffsetSeconds") or 0),3),
                      app_timed_line_count=len(lines),app_plain_lyrics_present=bool(app_snapshot.get("plainLyricsPresent")),
                      title_identity_score=round(title_score,3),artist_identity_score=round(artist_score,3),
                      identity_verified=identity_ok,app_lyrics_loaded=len(lines)>=2)
        if not identity_ok:
            report["reason"]="The app did not load a unique lyric track matching the selected video's title and artist"
            return report
        if len(lines)<6:
            report["reason"]="The app did not load enough synced lyric lines for audio verification"
            return report

        from faster_whisper import WhisperModel
        model=WhisperModel("small",device="cpu",compute_type="int8")
        segments,info=model.transcribe(str(audio_path),language=None,beam_size=5,
                                      vad_filter=True,word_timestamps=True)
        words=[]
        for segment in segments:
            segment_words=getattr(segment,"words",None) or []
            if segment_words:
                for word in segment_words:
                    text=norm(word.word)
                    if text:
                        words.append((float(word.start),float(word.end),text))
            else:
                text=norm(segment.text)
                if text:
                    words.append((float(segment.start),float(segment.end),text))
        report["asr_language"]=info.language
        report["asr_language_probability"]=round(float(getattr(info,"language_probability",0) or 0),3)
        report["asr_word_count"]=len(words)
        report["transcription_verified"]=bool(len(words)>=6 and info.language_probability>=0.35)
        if not report["transcription_verified"]:
            report["reason"]="Speech recognition did not produce sufficiently confident vocal text"
            return report

        # Build candidate vocal word groups for each displayed app lyric line.
        candidates_by_line=[]
        for line in lines:
            target=norm(line["text"])
            candidates=[]
            if len(target)<3:
                candidates_by_line.append(candidates);continue
            for start_index in range(len(words)):
                joined=""
                for end_index in range(start_index,min(len(words),start_index+12)):
                    joined+=words[end_index][2]
                    if len(joined)>len(target)*1.8+8: break
                    if len(joined)<max(2,int(len(target)*0.45)): continue
                    ratio=difflib.SequenceMatcher(None,target,joined).ratio()
                    if target in joined or joined in target:
                        ratio=max(ratio,min(len(target),len(joined))/max(len(target),len(joined)))
                    if ratio>=0.43:
                        candidates.append((ratio,words[start_index][0],words[end_index][1],start_index,end_index))
            candidates_by_line.append(candidates)

        best=None
        for offset_step in range(-180,181):
            offset=offset_step*0.25
            matches=[]
            used=set()
            for line_index,line in enumerate(lines):
                expected=float(line["time"])+offset
                options=[]
                for candidate in candidates_by_line[line_index]:
                    ratio,start,end,first,last=candidate
                    delta=abs(start-expected)
                    if delta<=5.5 and not any(i in used for i in range(first,last+1)):
                        options.append((ratio-delta*0.018,ratio,delta,first,last))
                if options:
                    _,ratio,delta,first,last=max(options,key=lambda x:x[0])
                    if ratio>=0.48:
                        matches.append((ratio,delta))
                        used.update(range(first,last+1))
            if matches:
                errors=sorted(item[1] for item in matches)
                median=errors[len(errors)//2]
                average=sum(item[0] for item in matches)/len(matches)
                quality=len(matches)*2+average-median*0.02
                if best is None or quality>best[0]:
                    best=(quality,offset,matches,median,average)

        if not best:
            report["reason"]="No reliable match between the app's displayed lyrics and recognized vocals"
            return report
        _,offset,matches,median,average=best
        eligible=sum(1 for line in lines if float(line["time"])<=float(words[-1][1])+45)
        ratio=len(matches)/max(1,eligible)
        report.update(matched_vocal_lines=len(matches),eligible_lyric_lines=eligible,
                      matched_line_ratio=round(ratio,3),
                      estimated_video_intro_or_lyric_offset_seconds=round(offset,2),
                      median_vocal_word_start_error_seconds=round(median,2),
                      mean_text_similarity=round(average,3))
        content_ok=len(matches)>=5 and ratio>=0.25
        sync_ok=content_ok and median<=1.5
        report["lyric_content_verified"]=content_ok
        report["vocal_sync_verified"]=sync_ok
        report["overall"]="PASS" if sync_ok else "FAIL_OR_INCONCLUSIVE"
        if not sync_ok:
            report["reason"]="Too few matching vocal lines or median vocal-to-lyric timing error exceeds 1.5 seconds"
        return report
    except Exception as exc:
        report["reason"]=type(exc).__name__+": "+str(exc)[:300]
        return report

if __name__=="__main__":
    if len(sys.argv)!=4: raise SystemExit("usage: lyric_audio_verify.py AUDIO.wav VIDEO_ID APP_SNAPSHOT.json")
    snapshot=json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    print(json.dumps(verify(Path(sys.argv[1]),sys.argv[2],snapshot),ensure_ascii=False,indent=2))
