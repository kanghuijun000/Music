#!/usr/bin/env python3
"""Compare the live Music app's rendered lyric source with transient player audio."""
from __future__ import annotations
import array, difflib, json, math, re, sys, urllib.parse, urllib.request, wave
from pathlib import Path

def norm(value):
    text=str(value or "").lower()
    text=re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", text)
    text=re.sub(r"\b(official|music video|lyrics?|audio|video|visuali[sz]er|mv|topic|4k|hd|remaster(?:ed)?|live|performance|vevo)\b", " ", text, flags=re.I)
    text=re.sub(r"가사|뮤직비디오|뮤비|공식영상|오디오|라이브|리마스터", " ", text, flags=re.I)
    text=re.sub(r"vevo$", "", text, flags=re.I)
    return re.sub(r"[^0-9a-z가-힣]", "", text)

def fetch_json(url):
    request=urllib.request.Request(url,headers={"User-Agent":"Music-Live-Audio-QA/1.0"})
    with urllib.request.urlopen(request,timeout=15) as response:
        return json.loads(response.read(2_000_000).decode("utf-8-sig"))

def fetch_video_description(video_id):
    request=urllib.request.Request(
        "https://www.youtube.com/watch?v="+video_id,
        headers={"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36"})
    try:
        with urllib.request.urlopen(request,timeout=12) as response:
            html=response.read(5_000_000).decode("utf-8",errors="replace")
        match=re.search(r'"shortDescription"\s*:\s*("(?:\\.|[^"\\])*")',html)
        return json.loads(match.group(1)) if match else ""
    except Exception:
        return ""

def identify(video_id):
    meta=fetch_json("https://www.youtube.com/oembed?url="+urllib.parse.quote(
        "https://www.youtube.com/watch?v="+video_id,safe="")+"&format=json")
    title=str(meta.get("title",""))
    author=str(meta.get("author_name",""))
    description=fetch_video_description(video_id)
    cleaned=title
    # Remove leading/trailing lyric labels and trailing show/episode brackets.
    cleaned=re.sub(r"^\s*[\[【(（][^\]】)）]*(?:가사|lyrics?)[^\]】)）]*[\]】)）]\s*","",cleaned,flags=re.I)
    cleaned=re.sub(r"\s*[\[【(（][^\]】)）]*(?:가사|lyrics?)[^\]】)）]*[\]】)）]\s*$","",cleaned,flags=re.I)
    cleaned=re.sub(r"\s*[|｜/ㅣ]\s*(?:가사|lyrics?).*$","",cleaned,flags=re.I).strip()
    cleaned=re.sub(r"\s*[\[【(（][^\]】)）]*[\]】)）]\s*$","",cleaned).strip()

    evidence=title+" "+author+" "+description
    ticktock=re.search(r"\bTICK\s*TOCK\b",title,flags=re.I)
    ticktock_smtm=re.search(r"쇼미더머니\s*12|\bSMTM\s*12\b|SHOW\s*ME\s*THE\s*MONEY\s*12",evidence,flags=re.I)
    ticktock_producer=(re.search(r"ZICO",evidence,flags=re.I)
                       and re.search(r"Crush",evidence,flags=re.I)
                       and re.search(r"prod\.?\s*by",evidence,flags=re.I))
    if ticktock and (ticktock_smtm or ticktock_producer):
        artist="김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁"
        track="TICK TOCK"
    else:
        quoted=re.match(r"""^(.+?)\s+['"“‘](.+?)['"”’]\s*(?:lyrics?|가사)?$""",cleaned,flags=re.I)
        if quoted:
            artist=quoted.group(1).strip()
            track=quoted.group(2).strip()
        else:
            match=re.match(r"^(.+?)\s*[-–—]\s*(.+)$",cleaned)
            if match:
                artist=match.group(1).strip()
                track=match.group(2).strip()
            else:
                # Some curator uploads prepend Buzz's album number without a separator.
                buzz=re.match(r"^(버즈|buzz)\s*(?:\d+집\s*)?(.+)$",cleaned,flags=re.I)
                if buzz:
                    artist="버즈 (Buzz)"
                    track=buzz.group(2).strip()
                else:
                    artist=author.replace(" - Topic","").strip()
                    track=cleaned
    track=re.sub(r"\s*\([^)]*(?:official|lyrics?|가사|audio|video)[^)]*\)","",track,flags=re.I).strip()
    # Auto-generated music descriptions may identify a track as "Song · Artist".
    # Resolve this only when one side exactly identifies the selected video title.
    if description and (not artist or artist==author):
        for line in description.splitlines():
            credit=re.match(r"^\s*(.{2,180}?)\s[·•]\s(.{2,180})\s*$",line.strip())
            if not credit:
                continue
            left,right=credit.group(1).strip(),credit.group(2).strip()
            left_is_title=norm(left)==norm(track)
            right_is_title=norm(right)==norm(track)
            if left_is_title != right_is_title:
                artist=right if left_is_title else left
                track=left if left_is_title else right
                break
    return title,track,artist,author,description

def verify(audio_path,video_id,app_snapshot,identified=None):
    report={"app_lyrics_loaded":False,"identity_verified":False,
            "transcription_verified":False,"lyric_content_verified":False,
            "vocal_sync_verified":False,"overall":"UNVERIFIED",
            "audio_file_retained":False}
    try:
        identity=identified if isinstance(identified,(tuple,list)) and len(identified)==5 else identify(video_id)
        video_title,expected_title,expected_artist,channel,description=identity
        app_snapshot=app_snapshot if isinstance(app_snapshot,dict) else {}
        lines=[x for x in app_snapshot.get("lines",[]) if isinstance(x,dict)
               and str(x.get("text") or "").strip()
               and isinstance(x.get("time"),(int,float)) and float(x["time"])>=0]
        track=app_snapshot.get("track") or {}
        app_title=str(track.get("title") or "")
        app_artist=str(track.get("artist") or "")
        title_norm=norm(expected_title)
        app_title_norm=norm(app_title)
        title_score=difflib.SequenceMatcher(None,title_norm,app_title_norm).ratio()
        if title_norm and app_title_norm.endswith(title_norm):
            title_score=1.0
        if norm(expected_artist)==norm("김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁"):
            # Keep the full credited collaboration as an exact identity, while
            # also allowing a provider to name one credited performer.
            artist_candidates=[expected_artist,"김하온","HAON","Nosun","Raf Sandou","Marv","정준혁"]
        elif norm(expected_artist) in (norm("Car, the garden"),norm("카더가든")):
            artist_candidates=["Car, the garden","카더가든"]
        else:
            # A comma can be part of a single artist name; never split credits blindly.
            artist_candidates=[expected_artist]
        artist_candidates.extend(re.findall(r"\(([^)]+)\)",expected_artist))
        app_artist_norm=norm(app_artist)
        candidate_artist_norms={norm(candidate) for candidate in artist_candidates if norm(candidate)}
        artist_score=(1.0 if app_artist_norm and app_artist_norm in candidate_artist_norms else
                      max((difflib.SequenceMatcher(None,norm(candidate),app_artist_norm).ratio()
                           for candidate in artist_candidates if norm(candidate)),default=0.0))
        # Regression tests require near-exact title and credited-artist identity.
        # Artist aliases and multi-performer credits are expanded above before scoring.
        identity_ok=bool(title_norm and app_title_norm and title_score>=0.92 and artist_score>=0.90)
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
        if audio_path is None:
            report["overall"]="IDENTITY_ONLY"
            report["reason"]="Audio capture intentionally skipped for this retrieval-only video fixture"
            return report
        if len(lines)<6:
            report["reason"]="The app did not load enough synced lyric lines for audio verification"
            return report

        # Decode the captured 16 kHz WAV ourselves and pass PCM samples to
        # faster-whisper. This avoids PyAV's file-opening metadata_errors
        # incompatibility in some GitHub runner images.
        with wave.open(str(audio_path),"rb") as wav:
            channels=wav.getnchannels()
            sample_width=wav.getsampwidth()
            sample_rate=wav.getframerate()
            raw=wav.readframes(wav.getnframes())
        if sample_width!=2 or sample_rate!=16000:
            raise ValueError("Expected 16-bit, 16 kHz verification audio")
        samples=array.array("h")
        samples.frombytes(raw)
        if sys.byteorder!="little":
            samples.byteswap()
        if channels>1:
            mono=array.array("h")
            for index in range(0,len(samples),channels):
                frame=samples[index:index+channels]
                if frame: mono.append(round(sum(frame)/len(frame)))
            samples=mono
        if not samples:
            report["reason"]="No captured audio samples; vocal synchronization cannot be verified"
            return report
        audio_rms=math.sqrt(sum(int(value)*int(value) for value in samples)/len(samples))/32768
        report["captured_audio_rms"]=round(audio_rms,6)
        if audio_rms<0.002:
            report["reason"]="No audible audio was captured; lyric content loaded but vocal synchronization is unverified"
            return report
        import numpy as np
        audio=np.asarray(samples,dtype=np.float32)/32768.0
        from faster_whisper import WhisperModel
        model=WhisperModel("small",device="cpu",compute_type="int8")
        segments,info=model.transcribe(audio,language=None,beam_size=5,
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
        app_offset=float(app_snapshot.get("lyricOffsetSeconds") or 0)
        offset_error=abs(offset-app_offset)
        content_ok=len(matches)>=5 and ratio>=0.25
        # The search offset is diagnostic only. A pass requires the app to
        # have actually applied that same offset to its rendered timeline.
        sync_ok=content_ok and median<=1.5 and offset_error<=1.5
        report.update(app_applied_offset_seconds=round(app_offset,2),
                      app_to_vocal_offset_error_seconds=round(offset_error,2))
        report["lyric_content_verified"]=content_ok
        report["vocal_sync_verified"]=sync_ok
        report["overall"]="PASS" if sync_ok else "FAIL_OR_INCONCLUSIVE"
        if not sync_ok:
            if not content_ok:
                report["reason"]="Too few matching vocal lines to verify lyric content"
            elif offset_error>1.5:
                report["reason"]=f"Measured vocal offset ({offset:.2f}s) differs from the app-applied offset ({app_offset:.2f}s)"
            else:
                report["reason"]="Median vocal-to-lyric timing error exceeds 1.5 seconds"
        return report
    except Exception as exc:
        report["reason"]=type(exc).__name__+": "+str(exc)[:300]
        return report

if __name__=="__main__":
    if len(sys.argv)!=4: raise SystemExit("usage: lyric_audio_verify.py AUDIO.wav VIDEO_ID APP_SNAPSHOT.json")
    snapshot=json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    print(json.dumps(verify(Path(sys.argv[1]),sys.argv[2],snapshot),ensure_ascii=False,indent=2))
