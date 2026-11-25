const API_BASE="https://www.googleapis.com/youtube/v3";
const STORAGE_KEY="musiq_youtube_api_key_v1";
const LYRIC_API="https://lrclib.net/api";
const lyricState={lines:[],plain:"",lastIndex:-1,lastWordIndex:-1,wordSynced:false,loading:false};
const playbackAudit={active:false,videoId:"",samples:0,missingTicks:0,mismatchTicks:0,transitions:[],marks:[],lastRenderedIndex:-1,lastUiUpdate:0,startedAt:0,invalid:[]};
const lyricFlowAudit={videoId:"",startedAt:0,events:[],renderedRequests:[]};
function resetLyricFlowAudit(videoId){lyricFlowAudit.videoId=String(videoId||"");lyricFlowAudit.startedAt=Date.now();lyricFlowAudit.events=[];lyricFlowAudit.renderedRequests=[];}
function recordLyricFlow(stage,details={}){
 if(!lyricFlowAudit.videoId||lyricFlowAudit.videoId!==currentVideoId)return;
 let playerTime=null;try{const value=Number(ytPlayer?.getCurrentTime?.());if(Number.isFinite(value))playerTime=Number(value.toFixed(3));}catch(_){}
 lyricFlowAudit.events.push({stage,at:new Date().toISOString(),elapsedMs:Date.now()-lyricFlowAudit.startedAt,playerTime,
  loading:Boolean(lyricState.loading),lineCount:lyricState.lines.length,offsetSeconds:Number(lyricOffsetSeconds)||0,
  videoManualAdvanceSeconds:getVideoManualAdvanceSeconds(currentVideoId),firstLineCalibrationSeconds:getVideoFirstLineCalibrationSeconds(currentVideoId),lyricLeadSeconds:LYRIC_LEAD_SECONDS,
  effectiveAppOffsetSeconds:Number(getLyricTimelineOffsetSeconds(currentVideoId).toFixed(3)),
  timingBasis:lyricTimingBasis,...details});
 if(lyricFlowAudit.events.length>60)lyricFlowAudit.events.shift();
}

// Small display compensation for polling and paint latency.
const LYRIC_LEAD_SECONDS=0.04;
// Timestamps are millisecond-based; tolerate at most 1 ms of floating-point boundary noise.
const LYRIC_TIMELINE_EPSILON_SECONDS=0.001;
function finiteTimestampSeconds(value){
 if(value===null||value===undefined||typeof value==="boolean"||
  (typeof value==="string"&&!value.trim()))return NaN;
 const number=Number(value);
 return Number.isFinite(number)?number:NaN;
}
function providerMillisecondsToSeconds(value){
 const number=finiteTimestampSeconds(value);
 return Number.isFinite(number)?number/1000:NaN;
}

// Provisional user-reported per-upload first-lyric calibration. This is deliberately separate
// from song/provider timestamps and from legacy manual video corrections.
// Love Yourself (웅키 lyric upload) was reported about 150 ms late; only this
// exact upload receives the small advance. Refine/remove only with new evidence.
const FIRST_LINE_CALIBRATION_SECONDS_BY_VIDEO=Object.freeze({
 "TKDpOEkT0cY":0.15
});
function getVideoFirstLineCalibrationSeconds(videoId){
 const value=FIRST_LINE_CALIBRATION_SECONDS_BY_VIDEO[String(videoId||"")];
 return Number.isFinite(value)?value:0;
}

// Additional whole-timeline delay based on a user-reported playback observation.
// Scoped to one exact YouTube upload; does not modify shared lyrics or other videos.
const VIDEO_TIMELINE_DELAY_SECONDS_BY_VIDEO=Object.freeze({
 "TKDpOEkT0cY":0.35
});
function getVideoTimelineDelaySeconds(videoId){
 const value=VIDEO_TIMELINE_DELAY_SECONDS_BY_VIDEO[String(videoId||"")];
 return Number.isFinite(value)&&value>=0?Math.min(value,2):0;
}

// Upload-specific playback-layer corrections only; never rewrite shared song lyrics.
// Positive values advance lyric display; negative values delay it.
function getVideoManualAdvanceSeconds(videoId){
 const id=String(videoId||"");
 if(id==="afYxfsgiuLI")return 0.95;
 if(id==="cFgk2PMgPJ4")return -0.30;
 return 0;
}

// Refine from word timing conservatively. Preserve the original 120ms
// single-token rule; only the expanded 120–300ms band needs two matching tokens.
const LYRIC_WORD_ANCHOR_MAX_ADJUSTMENT_SECONDS=0.30;
const LYRIC_WORD_ANCHOR_LEGACY_SECONDS=0.12;
function getLyricLineStartTime(line,lines=null,index=-1){
 const base=finiteTimestampSeconds(line?.time);
 if(!Number.isFinite(base)||base<0)return NaN;
 const words=(Array.isArray(line?.words)?line.words:[])
  .filter(word=>word?.start!==null&&word?.start!==undefined&&typeof word.start!=="boolean"&&
   !(typeof word.start==="string"&&!word.start.trim())&&Number.isFinite(Number(word.start))&&
   Number(word.start)>=0&&String(word?.text||"").trim())
  .sort((a,b)=>Number(a.start)-Number(b.start));
 if(words.length<2)return base;
 const first=words[0],second=words[1];
 const lineText=String(line?.text||"").replace(/\s+/gu,"");
 const firstText=String(first.text||"").replace(/\s+/gu,"");
 const secondText=String(second.text||"").replace(/\s+/gu,"");
 const delta=Number(first.start)-base;
 const absoluteDelta=Math.abs(delta);
 const wordGap=Number(second.start)-Number(first.start);
 if(!lineText||!firstText||!lineText.startsWith(firstText))return base;
 if(!Number.isFinite(delta)||absoluteDelta>LYRIC_WORD_ANCHOR_MAX_ADJUSTMENT_SECONDS)return base;
 // Keep all previously trusted small adjustments. Larger adjustments require
 // both consecutive word tokens to match the exact lyric-line prefix.
 if(absoluteDelta>LYRIC_WORD_ANCHOR_LEGACY_SECONDS&&
    (!secondText||!lineText.startsWith(firstText+secondText)))return base;
 if(!Number.isFinite(wordGap)||wordGap<=0||wordGap>1.5)return base;
 const candidate=Number(Number(first.start).toFixed(3));
 // Adjacent lines share a midpoint boundary. Never let a refined timestamp
 // cross that boundary and reverse the provider's original line ordering.
 if(Array.isArray(lines)&&Number.isInteger(index)&&index>=0){
  const previous=index>0?finiteTimestampSeconds(lines[index-1]?.time):NaN;
  const next=index+1<lines.length?finiteTimestampSeconds(lines[index+1]?.time):NaN;
  if(Number.isFinite(previous)&&candidate<=(previous+base)/2)return base;
  if(Number.isFinite(next)&&candidate>=(base+next)/2)return base;
 }
 return candidate;
}

function getLyricTextFingerprint(value){
 const normalized=String(value||"").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,"");
 if(!normalized)return "";
 let hash=2166136261;
 for(let i=0;i<normalized.length;i++){hash^=normalized.charCodeAt(i);hash=Math.imul(hash,16777619);}
 return (hash>>>0).toString(16).padStart(8,"0");
}

// Read-only QA evidence for the existing word-anchor refinement.
// Fingerprints let QA compare text alignment without exporting lyric text.
function getLyricWordTimingEvidence(lines=lyricState.lines,limit=5){
 const source=Array.isArray(lines)?lines:[];
 const count=Math.max(0,Math.min(10,Number(limit)||5));
 return source.slice(0,count).map((line,index)=>{
  const base=finiteTimestampSeconds(line?.time);
  const effective=getLyricLineStartTime(line,source,index);
  const words=Array.isArray(line?.words)?line.words:[];
  const round=value=>value===null||value===undefined||typeof value==="boolean"||
   (typeof value==="string"&&!value.trim())?null:
   Number.isFinite(Number(value))?Number(Number(value).toFixed(3)):null;
  return {
   lineIndex:index,
   textFingerprint:getLyricTextFingerprint(line?.text),
   textLength:String(line?.text||"").length,
   baseLineTime:round(base),
   effectiveLineTime:round(effective),
   appliedWordAnchorDelta:round(Number.isFinite(base)&&Number.isFinite(effective)?effective-base:NaN),
   wordCount:words.length,
   firstWords:words.slice(0,6).map(word=>({
    textFingerprint:getLyricTextFingerprint(word?.text),
    textLength:String(word?.text||"").length,start:round(word?.start),end:round(word?.end)
   }))
  };
 });
}

function getLyricTimelineOffsetSeconds(videoId=currentVideoId){
 return (Number(lyricOffsetSeconds)||0)-getVideoManualAdvanceSeconds(videoId)-LYRIC_LEAD_SECONDS-getVideoFirstLineCalibrationSeconds(videoId)+getVideoTimelineDelaySeconds(videoId);
}
function getLyricTimelineTime(playerTime,videoId=currentVideoId){
 const time=Number(playerTime);
 return Number.isFinite(time)?time-getLyricTimelineOffsetSeconds(videoId):NaN;
}
function getLyricPlayerTimeForLine(line,lines=null,index=-1,videoId=currentVideoId){
 const lineTime=getLyricLineStartTime(line,lines,index);
 return Number.isFinite(lineTime)?lineTime+getLyricTimelineOffsetSeconds(videoId):NaN;
}
function getLyricLineIndexAtPlayerTime(playerTime,videoId=currentVideoId){
 const time=Number(playerTime);
 const relativeTime=time-(Number(lyricOffsetSeconds)||0)+getVideoManualAdvanceSeconds(videoId);
 const lyricTime=getLyricTimelineTime(time,videoId);
 if(!Number.isFinite(relativeTime)||relativeTime<0||!Number.isFinite(lyricTime))return -1;
 let index=-1;
 for(let i=0;i<lyricState.lines.length;i++){
  if(getLyricLineStartTime(lyricState.lines[i],lyricState.lines,i)<=lyricTime+LYRIC_TIMELINE_EPSILON_SECONDS)index=i;
  else break;
 }
 return index;
}

let lyricPreviewRenderedToken=0;
let lyricLastObservedPlayerTime=null;
function getLyricTransitionDuration(index){
 const start=finiteTimestampSeconds(lyricState.lines[index]?.time),next=finiteTimestampSeconds(lyricState.lines[index+1]?.time);
 if(!Number.isFinite(start)||!Number.isFinite(next))return 180;
 const gap=next-start;
 if(gap<=0)return 110;
 // Match the visual hand-off to phrase spacing: quicker for rapid lines,
 // gently longer for sustained phrases, without delaying the lyric timestamp.
 return Math.round(Math.max(110,Math.min(260,gap*160)));
}
const lyricCache=new Map();
// TrackID.dev: video-level track timestamps. Results are cached per YouTube video.
const TRACK_ANALYSIS_CACHE_KEY="music_track_timing_v1";
const TRACK_ANALYSIS_CACHE_LIMIT=80;
let lyricOffsetSeconds=0,trackAnalysisToken=0,lyricTimingBasis="catalog";
// Never apply an unverified per-video offset. Use only a matched track timestamp from analysis.
function getVideoLyricOffset(videoId,detected=0){const value=finiteTimestampSeconds(detected);return Number.isFinite(value)&&value>=0?Math.min(value,1800):null;}
function readTrackAnalysisCache(){try{const value=JSON.parse(localStorage.getItem(TRACK_ANALYSIS_CACHE_KEY)||"{}");return value&&typeof value==="object"?value:{};}catch(_){return {};}}
function writeTrackAnalysisCache(cache){try{const entries=Object.entries(cache).sort((a,b)=>(Number(b[1]?.savedAt)||0)-(Number(a[1]?.savedAt)||0));localStorage.setItem(TRACK_ANALYSIS_CACHE_KEY,JSON.stringify(Object.fromEntries(entries.slice(0,TRACK_ANALYSIS_CACHE_LIMIT))));}catch(error){console.warn("Track timing cache could not be saved:",error);}}
function trackText(value){return String(value||"").toLocaleLowerCase().normalize("NFKC").replace(/\[[^\]]*\]|\([^)]*\)/g," ").replace(/\b(official|music video|lyrics?|audio|video|visuali[sz]er|mv|topic|4k|hd|remaster(?:ed)?|live|performance|vevo)\b/gi," ").replace(/가사|뮤직비디오|뮤비|공식영상|오디오|라이브|리마스터/gi," ").replace(/[^\p{L}\p{N}]+/gu," ").trim();}
function trackSimilarity(a,b){const x=trackText(a),y=trackText(b);if(!x||!y)return 0;if(x===y)return 1;if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length);const xs=new Set(x.split(" ")),ys=new Set(y.split(" "));return [...xs].filter(v=>ys.has(v)).length/Math.max(xs.size,ys.size);}
 // Verified artist-name aliases allow the same catalog track to be shared
 // across Korean/English channel metadata without relaxing song matching.
 const ARTIST_IDENTITY_ALIASES=[["버즈","buzz"],["카더가든","car the garden"],["너드커넥션","nerd connection"],["범진","beomjin","beom jin","beom-jin"]];
 function canonicalArtistIdentity(value){
  const normalized=trackText(value);
  if(!normalized)return "";
  for(const pair of ARTIST_IDENTITY_ALIASES){
   const aliases=pair.map(trackText);
   if(aliases.includes(normalized))return aliases[0];
  }
  return normalized;
 }
 function artistIdentityMatches(a,b,threshold=0.90){
  const left=canonicalArtistIdentity(a),right=canonicalArtistIdentity(b);
  return Boolean(left&&right&&(left===right||trackSimilarity(left,right)>=threshold));
 }
function extractVideoTitleMetadata(value){
 const source=String(value||"");
 const splitNames=value=>String(value||"").split(/\s*(?:,|&|×)\s*|\s+x\s+/i).map(item=>item.trim()).filter(Boolean);
 const featuredArtists=[];
 for(const match of source.matchAll(/\b(?:feat\.?|ft\.?|featuring)\s*[:.]?\s*([^()[\]|/]+)/gi))featuredArtists.push(...splitNames(match[1]));
 const producerNames=[];
 for(const match of source.matchAll(/\b(?:prod(?:uced)?\.?\s*(?:by)?|produced\s+by)\s*[:.]?\s*([^()[\]|/]+)/gi))producerNames.push(...splitNames(match[1]));
 const bracketGroups=[...source.matchAll(/[\[(]([^\])]+)[\])]/g)].map(match=>String(match[1]||"").trim()).filter(Boolean);
 const contextTags=bracketGroups.filter(value=>!/(?:lyrics?|가사|official|audio|video|\bm\/?v\b|\b4k\b|\bhd\b)/i.test(value)
  &&!/(?:feat\.?|ft\.?|featuring|prod\.?|produced by)/i.test(value)
  &&!/(?:remix|rework|acoustic|\blive\b|instrumental|karaoke|\bcover\b|sped up|slowed|nightcore|radio edit|unplugged|리믹스|어쿠스틱|라이브|반주|커버)/i.test(value));
 return {featuredArtists:[...new Set(featuredArtists)],producerNames:[...new Set(producerNames)],contextTags:[...new Set(contextTags)],versionKey:getTrackVersionKey(source)};
}
function getTrackVersionKey(value){
 const source=String(value||"");
 const groups=[...source.matchAll(/[\[(]([^\])]+)[\])]/g)].map(match=>String(match[1]||""));
 const tail=source.match(/(?:[-–—|/]|ㅣ)\s*((?:official\s+)?(?:remix|rework|acoustic|instrumental|inst\.?|karaoke|cover|sped\s*up|slowed|nightcore|radio\s*edit|unplugged|demo|piano\s+version|orchestral)(?:\s+(?:version|ver\.?|edit|mix))?)/i);
 const candidates=[...groups,...(tail?[tail[1]]:[])];
 const markers=[["remix",/\b(?:remix|rework|리믹스)\b/i],["acoustic",/\b(?:acoustic|unplugged|어쿠스틱)\b/i],
  ["live",/\b(?:live|라이브)\b/i],["instrumental",/\b(?:instrumental|inst\.?|karaoke|반주)\b/i],
  ["cover",/\b(?:cover|커버)\b/i],["sped-up",/\b(?:sped\s*up|nightcore)\b/i],["slowed",/\bslowed\b/i],
  ["radio-edit",/\bradio\s*edit\b/i],["demo",/\bdemo\b/i],["piano",/\bpiano\s+version\b/i],["orchestral",/\borchestral\b/i]];
 return markers.filter(([,pattern])=>candidates.some(candidate=>pattern.test(candidate))).map(([name])=>name).join("+");
}
function lyricCacheVersionMatches(cached,video){
 return getTrackVersionKey(cached?.videoMetadata?.title||"")===getTrackVersionKey(video?.title||"");
}
function getLyricsIdentity(video,identifiedTrack=null){
 const cleanVideoTitle=value=>String(value||"")
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\s*(?:ㅣ|\/|\||_|[-–—])\s*(?:가사|lyrics?|official|뮤직비디오|뮤비|audio|video|performance|remaster(?:ed)?).*$/i," ")
  .replace(/\s+official\s+(?:audio|mv|music\s*video)$/i," ")
  .replace(/\s+(?:official\s+)?(?:m\/v|mv|performance\s+video)$/i," ")
  .replace(/\s+/g," ").trim();
 const titleMetadata=extractVideoTitleMetadata(video?.title||"");
 if(identifiedTrack){
  const title=String(identifiedTrack.title||identifiedTrack.trackName||"").trim();
  const artist=String(identifiedTrack.artist||identifiedTrack.artistName||"").trim();
  if(title&&artist){
   const videoTitle=cleanVideoTitle(video?.title);
   const titles=[...new Set([title,...(videoTitle&&trackSimilarity(videoTitle,title)>=0.55?[videoTitle]:[])])];
   const artistAliases=trackText(artist)==="car the garden"?["카더가든"]:
    trackText(artist)==="카더가든"?["Car, the garden"]:[];
   const queries=[{title,artist},...artistAliases.map(name=>({title,artist:name})),{title,artist:""}];
   const uniqueQueries=[];
   for(const query of queries){
    const key=trackText(query.title)+"|"+trackText(query.artist);
    if(!uniqueQueries.some(item=>item.key===key))uniqueQueries.push({key,title:query.title,artist:query.artist||""});
   }
   return {raw:title+" - "+artist,title,artist,artistAliases,artistKnown:true,isTopic:false,channel:artist,generic:false,
    titles,queries:uniqueQueries,searchTerms:[title],featuredArtists:titleMetadata.featuredArtists,
    producerNames:titleMetadata.producerNames,contextTags:titleMetadata.contextTags,versionKey:titleMetadata.versionKey,identified:true};
  }
 }
 const originalTitle=String(video?.title||"").trim();
 // Artist (alternate name) - Song is a common Korean lyric-video title format.
 // Keep the parenthetical text as an artist alias, never as a possible song title.
 const identityTitleSource=originalTitle.replace(/\s*\[[^\]]*\]\s*$/,"").trim();
 const hasExplicitLyricsLabel=/(?:\[[^\]]*(?:가사|lyrics?)[^\]]*\]|\([^)]*(?:가사|lyrics?)[^)]*\)|\b(?:lyrics?)\b|가사)/i.test(originalTitle);
 const leadingParentheticalArtist=identityTitleSource.match(/^\s*([^()]+?)\s*\(([^()]*)\)\s*[-–—|]\s*(.+?)\s*$/);
 const parentheticalAliases=[...originalTitle.matchAll(/\(([^()]*)\)/g)]
  .map(match=>String(match[1]||"").trim())
  .filter(value=>value
   &&!/(?:official|lyrics?|가사|audio|video|뮤직비디오|뮤비|live|performance|remaster(?:ed)?|4k|hd|color coded)/i.test(value)
   &&!/^(?:prod\.?|produced by|feat\.?|ft\.?|featuring)\b/i.test(value)
   &&!/쇼미더머니|\b(?:episode|ep\.?|official video)\b/i.test(value));
 const raw=cleanVideoTitle(originalTitle);
 const parts=raw.split(/\s+[-–—|]\s+/).map(v=>v.trim()).filter(Boolean);
 const channelRaw=String(video?.channelTitle||"").trim();
 const isTopic=/\s*-\s*Topic$/i.test(channelRaw);
 const channel=channelRaw.replace(/\s*-\s*Topic$/i,"").replace(/\s*VEVO$/i,"").trim();
 const generic=/^(youtube|vevo|various artists|unknown|official|music|stone music entertainment|1thek|kakao entertainment|kakao music|genie music|bugs!?|nhn bugs|danal entertainment|poclanos|mirrorball music|sony music korea|warner music korea|universal music korea|dingo music|딩고뮤직|멜론|melon|mnet|kbs kpop|mbckpop|sbs kpop)$/i.test(channel);
 let title=raw,artist="",artistKnown=false,queries=[],artistAliases=[];
 // Buzz lyric uploads sometimes encode the album number before the song
 // without an artist/title separator (for example: "[가사]버즈2집 비망록").
 const buzzAlbumMatch=raw.match(/^(?:버즈|buzz)\s*\d+\s*집\s*(.+)$/i);
 if(!artistKnown&&buzzAlbumMatch&&String(buzzAlbumMatch[1]||"").trim()){
  title=String(buzzAlbumMatch[1]).trim();
  artist="버즈";
  artistAliases=["Buzz"];
  artistKnown=true;
  queries=[{title,artist},{title,artist:"Buzz"},{title,artist:""}];
 }
 if(parts.length>1&&!generic){
  const first=parts[0],rest=parts.slice(1).join(" - ");
  if(trackSimilarity(channel,first)>=0.6){title=rest;artist=channel;artistKnown=true;}
  else if(trackSimilarity(channel,rest)>=0.6){title=first;artist=channel;artistKnown=true;}
  else if(isTopic){title=first;artist=channel;artistKnown=true;}
  else{
   // Keep both title/artist arrangements when the channel cannot identify the singer.
   title=first;
   queries=[{title:first,artist:rest},{title:rest,artist:first},{title:first,artist:""},{title:rest,artist:""}];
  }
 }else if(parts.length>1){
  title=parts[0];
  const rest=parts.slice(1).join(" - ");
  queries=[{title,artist:rest},{title:rest,artist:title},{title,artist:""},{title:rest,artist:""}];
 }else if(!generic&&isTopic){
  artist=channel;artistKnown=Boolean(channel);
 }
 // Quoted song names are common in curator titles such as
 // "NewJeans 'Ditto' Lyrics". Only trust this form when a lyric label is present.
 const quotedArtistTitle=raw.match(/^(.+?)\s+['"“‘](.+?)['"”’]\s*(?:(?:lyrics?|가사)|(?:official\s*(?:audio|mv|music\s*video)|performance\s*video|mv))?$/i);
 const hasOfficialVideoLabel=/\b(?:official\s*(?:audio|mv|music\s*video)|performance\s*video|mv)\b/i.test(originalTitle);
 if(!artistKnown&&(hasExplicitLyricsLabel||hasOfficialVideoLabel)&&quotedArtistTitle){
  const quotedArtist=String(quotedArtistTitle[1]||"").trim();
  const quotedTitle=String(quotedArtistTitle[2]||"").trim();
  if(quotedArtist&&quotedTitle&&trackText(quotedArtist)!==trackText(quotedTitle)){
   title=quotedTitle;
   artist=quotedArtist;
   artistKnown=true;
   queries=[{title,artist},{title,artist:""}];
  }
 }
 // Explicitly labelled lyric uploads commonly use "Artist - Song".
// A lyric-curator channel should not make both sides ambiguous; short-title
// validation below still requires exact artist AND duration matches.
if(!artistKnown&&!leadingParentheticalArtist&&(hasExplicitLyricsLabel||hasOfficialVideoLabel)&&(parts.length===2||parts.length===1)){
 const compactParts=parts.length===2?parts:raw.match(/^(.{2,100}?)\s*[-–—]\s*(.{2,140})$/)?.slice(1)||[];
 const [artistCandidate,songCandidate]=compactParts.map(value=>String(value||"").trim());
 if(artistCandidate&&songCandidate&&trackText(artistCandidate)!==trackText(songCandidate)){
  title=songCandidate;
  artist=artistCandidate;
  artistKnown=true;
  queries=[{title:songCandidate,artist:artistCandidate},{title:songCandidate,artist:""}];
 }
}
if(leadingParentheticalArtist&&!artistKnown){
  const candidateArtist=String(leadingParentheticalArtist[1]||"").trim();
  const parentheticalName=String(leadingParentheticalArtist[2]||"").trim();
  const songTitle=cleanVideoTitle(leadingParentheticalArtist[3]);
  if(candidateArtist&&parentheticalName&&songTitle){
   title=songTitle;
   artist=candidateArtist;
   artistAliases=[parentheticalName];
   artistKnown=true;
   // Search the song under both Korean and alternate-language artist names.
   queries=[
    {title:songTitle,artist:candidateArtist},
    {title:songTitle,artist:parentheticalName},
    {title:songTitle,artist:""}
   ];
  }
 }
 // Canonical credits for this Show Me the Money 12 track. The upload title
 // contains featured/producers, not the primary performers, and curator
 // channels do not reliably identify the artist. Scope narrowly to its
 // album/title/producer signature to avoid other songs named "Tick Tock".
 if(!artistKnown&&/\bTICK\s*TOCK\b/i.test(originalTitle)&&/쇼미더머니\s*12/i.test(originalTitle)&&/prod\.?\s*by\s*zico\s*,?\s*crush/i.test(originalTitle)){
  title="TICK TOCK";
  artist="김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁";
  artistAliases=["김하온","HAON","Nosun","Raf Sandou","Marv","정준혁"];
  artistKnown=true;
  queries=[
   {title,artist},
   ...artistAliases.map(name=>({title,artist:name})),
   {title,artist:""}
  ];
 }
 // Some lyric-curator uploads use the channel name as the YouTube artist.
 // Recover credited performers only from a description line whose track title
 // independently matches this video's cleaned title.
 if(video?.description){
  const descriptionLines=String(video.description).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  // YouTube auto-generated music descriptions use "Song · Artist", while
  // curator descriptions commonly use "Artist - Song". Accept either order
  // only when exactly one side independently matches the selected video title.
  if(!artistKnown){
   const credit=descriptionLines.map(line=>line.replace(/^[#•*\d.)\s]+/,"").trim())
    .map(line=>line.match(/^(.{2,180}?)\s(?:[-–—]|[·•])\s(.{2,180})$/))
    .find(match=>{
     if(!match)return false;
     const leftTitle=trackSimilarity(cleanVideoTitle(match[1]),raw)>=0.92;
     const rightTitle=trackSimilarity(cleanVideoTitle(match[2]),raw)>=0.92;
     const titleSide=leftTitle?match[1]:match[2];
     return leftTitle!==rightTitle&&trackText(titleSide)!==trackText(channel);
    });
   if(credit){
    const left=String(credit[1]||"").trim();
    const right=String(credit[2]||"").trim();
    const titleIsLeft=trackSimilarity(cleanVideoTitle(left),raw)>=0.92;
    const creditedArtist=titleIsLeft?right:left;
    const creditedTitle=cleanVideoTitle(titleIsLeft?left:right);
    if(creditedArtist&&creditedTitle){
     title=creditedTitle;
     artist=creditedArtist;
     const creditedAliases=[
      creditedArtist,
      ...[...creditedArtist.matchAll(/\(([^()]*)\)/g)].map(match=>String(match[1]||"").trim())
     ];
     if(trackText(creditedArtist)==="car the garden")creditedAliases.push("카더가든");
     if(trackText(creditedArtist)==="카더가든")creditedAliases.push("Car, the garden");
     artistAliases=[...new Set(creditedAliases.filter(Boolean))];
     artistKnown=true;
     queries=[
      {title:creditedTitle,artist:creditedArtist},
      ...artistAliases.map(name=>({title:creditedTitle,artist:name})),
      {title:creditedTitle,artist:""}
     ];
    }
   }
  }
  // A lyric-curator description may name the original music video as
  // "OriginalMusicVideo: Artist - Song". Trust it only when the song side
  // independently matches the selected video's title suffix.
  const originalVideoCredit=descriptionLines.map(line=>line.replace(/^[#•*\d.)\s]+/,"").trim())
   .map(line=>line.match(/(?:Original\s*Music\s*Video)\s*[:：]\s*[•·]?\s*(.{2,120}?)\s*[-–—]\s*(.{2,180})/i))
   .find(match=>{
    if(!match)return false;
    const titleParts=raw.split(/\s*[-–—]\s*/).map(part=>part.trim()).filter(Boolean);
    const videoTrack=titleParts.length>1?titleParts.slice(1).join(" - "):raw;
    return trackSimilarity(cleanVideoTitle(match[2]),videoTrack)>=0.92;
   });
  if(originalVideoCredit){
   const creditedArtist=String(originalVideoCredit[1]||"").trim();
   const creditedTitle=cleanVideoTitle(originalVideoCredit[2]);
   if(creditedArtist&&creditedTitle&&(!artistKnown||trackSimilarity(artist,creditedArtist)<0.82)){
    title=creditedTitle;
    artist=creditedArtist;
    artistAliases=[creditedArtist];
    artistKnown=true;
    queries=[{title:creditedTitle,artist:creditedArtist},{title:creditedTitle,artist:""}];
   }
  }
 }
 // Canonical song identity overrides per-video channel/title guesses.
 // The same track is uploaded under lyric-curator, Mnet and artist/topic channels.
 const tickTockEvidence=[originalTitle,String(video?.description||""),channelRaw].join(" ");
 const tickTockTitle=/\bTICK\s*TOCK\b/i.test(originalTitle);
 const tickTockSmtm=/쇼미더머니\s*12|\bSMTM\s*12\b|SHOW\s*ME\s*THE\s*MONEY\s*12/i.test(tickTockEvidence);
 const tickTockProducer=/ZICO/i.test(tickTockEvidence)&&/Crush/i.test(tickTockEvidence)&&/prod\.?\s*by/i.test(tickTockEvidence);
 const tickTockPerformers=["김하온","HAON","Nosun","Raf Sandou","Marv","정준혁"];
 const tickTockEvidenceNormalized=trackText(tickTockEvidence);
 const tickTockPerformerHits=tickTockPerformers.filter(name=>tickTockEvidenceNormalized.includes(trackText(name))).length;
 if(tickTockTitle&&(tickTockSmtm||tickTockProducer||tickTockPerformerHits>=2)){
  title="TICK TOCK";
  artist="김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁";
  artistAliases=[...tickTockPerformers];
  artistKnown=true;
  queries=[
   {title,artist},
   ...artistAliases.map(name=>({title,artist:name})),
   {title,artist:""}
  ];
 }
 const titleAliases=quotedArtistTitle?[]:(artistAliases.length&&leadingParentheticalArtist
  ?parentheticalAliases.filter(value=>value!==String(leadingParentheticalArtist[2]||"").trim())
  :parentheticalAliases);
 // Only real song-title candidates belong in global validation.
 // The opposite side of an ambiguous "A - B" title is queried separately;
 // treating both sides as titles can accept lyrics for the artist name itself.
 const uniqueTitles=[...new Set([title,...titleAliases].map(v=>String(v||"").trim()).filter(Boolean))];
 if(!queries.length)queries=[{title,artist:artistKnown?artist:""}];
 // Commas can be part of one artist name; add only known whole-name aliases.
 if(trackText(artist)==="car the garden")artistAliases.push("카더가든");
 if(trackText(artist)==="카더가든")artistAliases.push("Car, the garden");
 artistAliases=[...new Set(artistAliases.filter(Boolean))];
 if(artistKnown){
  for(const alias of artistAliases){
   if(!queries.some(item=>trackText(item.artist)===trackText(alias)))queries.push({title,artist:alias});
  }
 }
 const baseQueries=queries.slice();
 const aliasQueries=titleAliases.flatMap(alias=>artistKnown
  ?[{title:alias,artist},{title:alias,artist:""}]
  :[{title:alias,artist:""}]);
 // Keep primary-title lookups first, then alternate title aliases, then broad fallbacks.
 const artistGuesses=baseQueries.filter(item=>item.artist);
 const titleOnlyQueries=baseQueries.filter(item=>!item.artist);
 queries=[...artistGuesses,...titleOnlyQueries,...aliasQueries,{title,artist:""}];
 const uniqueQueries=[];
 for(const q of queries){
  if(!q.title)continue;
  const key=trackText(q.title)+"|"+trackText(q.artist);
  if(!uniqueQueries.some(item=>item.key===key))uniqueQueries.push({key,title:q.title,artist:q.artist||""});
 }
 const searchTerms=[title];
 const addSearchTerm=value=>{
  const term=String(value||"").replace(/\s+/g," ").trim();
  if(term&&term!==title&&!searchTerms.some(item=>trackText(item)===trackText(term)))searchTerms.push(term);
 };
 if(titleMetadata.featuredArtists.length)addSearchTerm(title+" "+titleMetadata.featuredArtists.join(" "));
 if(titleMetadata.producerNames.length)addSearchTerm(title+" "+titleMetadata.producerNames.join(" "));
 if(titleMetadata.contextTags.length)addSearchTerm(title+" "+titleMetadata.contextTags.join(" "));
 if(titleMetadata.versionKey)addSearchTerm(title+" "+titleMetadata.versionKey.replace(/\+/g," "));
 const searchOnlyQueries=searchTerms.slice(1,4).map(searchTitle=>({title:searchTitle,artist:artistKnown?artist:"",searchOnly:true}));
 return {raw,title,artist,artistAliases,artistKnown,isTopic,channel,generic,titles:uniqueTitles,queries:uniqueQueries.slice(0,10),
  searchTerms:searchTerms.slice(0,4),featuredArtists:titleMetadata.featuredArtists,
  producerNames:titleMetadata.producerNames,contextTags:titleMetadata.contextTags,versionKey:titleMetadata.versionKey};
}
function expectedTrackIdentity(video){
 const identity=getLyricsIdentity(video);
 return {title:identity.title,artist:identity.artist};
}
function lyricCacheNormalize(value){
 return String(value||"").toLocaleLowerCase().normalize("NFKC")
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\b(official|music video|lyrics?|audio|video|visuali[sz]er|mv|topic|4k|hd|remaster(?:ed)?|live|performance|vevo)\b/gi," ")
  .replace(/(?:ㅣ|\|)\s*(?:가사|lyrics?).*$/i," ")
  .replace(/(?:\/|·|-)\s*(?:가사|lyrics?).*$/i," ")
  .replace(/가사|뮤직비디오|뮤비|공식영상|오디오|라이브|리마스터/gi," ")
  .replace(/[^\p{L}\p{N}]+/gu," ").trim();
}
function getSongLyricCacheKeys(video,metadata=null){
 const identity=getLyricsIdentity(video),pairs=[];
 if(identity.artistKnown)pairs.push({title:identity.title,artist:identity.artist});
 pairs.push(...identity.queries);
 if(metadata){
  pairs.unshift({title:metadata.trackName||metadata.title||"",artist:metadata.artistName||metadata.artist||""});
 }
 const keys=[];
 const versionSuffix=identity.versionKey?"|version:"+identity.versionKey:"";
 const add=(prefix,title,artist="")=>{
  const t=lyricCacheNormalize(title),a=lyricCacheNormalize(artist);
  if(!t)return;
  const canonicalArtist=prefix==="title"?"":canonicalArtistIdentity(artist)||a;
  const key=prefix==="title"?"song-title:"+t+versionSuffix:"song:"+t+"|"+canonicalArtist+versionSuffix;
  if(!keys.includes(key))keys.push(key);
 };
 if(metadata?.acoustidId){
  const acoustid=String(metadata.acoustidId).trim().toLowerCase();
  if(acoustid&&!keys.includes("song-acoustid:"+acoustid))keys.unshift("song-acoustid:"+acoustid);
 }
 for(const pair of pairs)add("song",pair.title,pair.artist);
 for(const title of [...identity.titles,metadata?.trackName||metadata?.title||""])add("title",title);
 return keys;
}
function cachedArtistIdentityNames(cached){
 const storedArtist=String(cached?.artistName||"").trim();
 const names=[storedArtist];
 // Preserve alternate spellings only when the provider's stored artist
 // independently agrees with the source video's explicit artist identity.
 if(cached?.videoMetadata&&storedArtist){
  const sourceIdentity=getLyricsIdentity(cached.videoMetadata);
  const sourceArtists=[sourceIdentity.artist,...(sourceIdentity.artistAliases||[])].filter(Boolean);
  if(sourceIdentity.artistKnown&&sourceArtists.some(name=>artistIdentityMatches(storedArtist,name,0.82))){
   names.push(...sourceArtists);
  }
 }
 return [...new Set(names.map(value=>String(value||"").trim()).filter(Boolean))];
}
function sharedLyricCacheMatches(cached,video){
 if(!cached||!cached.trackName||!lyricCacheVersionMatches(cached,video))return false;
 const identity=getLyricsIdentity(video);
 const titleScore=Math.max(0,...identity.titles.map(title=>trackSimilarity(title,cached.trackName)));
 if(titleScore<0.92)return false;
 // Shared lyrics must never be reused from title guesses alone.
 // Require independently established artist identities on both uploads.
 if(!identity.artistKnown)return false;
 const targetArtists=[identity.artist,...(identity.artistAliases||[])].filter(Boolean);
 const cachedArtists=cachedArtistIdentityNames(cached);
 if(!cachedArtists.length)return false;
 const isCanonicalTickTock=trackSimilarity(identity.title,"TICK TOCK")>=0.99&&
  trackText(identity.artist)===trackText("김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁");
 if(isCanonicalTickTock){
  const credited=["김하온","HAON","Nosun","Raf Sandou","Marv","정준혁"];
  return cachedArtists.some(cachedArtist=>{
   const normalizedCached=trackText(cachedArtist);
   return credited.some(name=>normalizedCached===trackText(name)||normalizedCached.includes(trackText(name)))||
    trackSimilarity(cachedArtist,"김하온 (HAON), Nosun, Raf Sandou, Marv, 정준혁")>=0.90;
  });
 }
 return targetArtists.some(target=>cachedArtists.some(candidate=>artistIdentityMatches(target,candidate,0.90)));
}
function readAllStoredLyricEntries(){
 const entries=new Map(lyricCache);
 try{
  const saved=JSON.parse(localStorage.getItem(LYRIC_CACHE_STORAGE_KEY)||"{}");
  if(saved&&typeof saved==="object")for(const [key,item] of Object.entries(saved))if(item&&typeof item==="object")entries.set(key,item);
 }catch(_){}
 return [...entries.entries()];
}
function hasUsableCachedLyrics(item){
 return Boolean(item&&Array.isArray(item.lines)&&item.lines.length>=2&&item.lines.every(line=>
  line&&Number.isFinite(finiteTimestampSeconds(line.time))&&finiteTimestampSeconds(line.time)>=0&&String(line.text||"").trim()));
}
function prepareSharedCacheForVideo(item,sourceKey,targetVideoId){
 if(!hasUsableCachedLyrics(item))return null;
 if(item.timingBasis==="video"&&sourceKey!==targetVideoId)return null;
 return item;
}
function findSharedLyricCache(video){
 const entries=readAllStoredLyricEntries(),identity=getLyricsIdentity(video);
 for(const key of getSongLyricCacheKeys(video)){
  const cached=entries.find(entry=>entry[0]===key)?.[1];
  if(cached&&cached.source!=="Unison shared text"&&hasUsableCachedLyrics(cached)&&sharedLyricCacheMatches(cached,video)){
   const prepared=prepareSharedCacheForVideo(cached,key,video.id);if(prepared)return prepared;
  }
 }
 let best=null,bestScore=0;
 for(const [key,cached] of entries){
  if(cached?.source==="Unison shared text"||!hasUsableCachedLyrics(cached)||!sharedLyricCacheMatches(cached,video))continue;
  const targetArtists=[identity.artist,...(identity.artistAliases||[])].filter(Boolean);
  const artistSimilarity=Math.max(0,...cachedArtistIdentityNames(cached).flatMap(candidate=>targetArtists.map(target=>trackSimilarity(candidate,target))));
  const score=trackSimilarity(cached.trackName,identity.title)*0.65+artistSimilarity*0.35;
  if(score>bestScore){bestScore=score;best=prepareSharedCacheForVideo(cached,key,video.id);}
 }
 return best;
}
function findIdentifiedLyricCache(video,identifiedTrack){
 const metadata={trackName:identifiedTrack?.title||"",artistName:identifiedTrack?.artist||"",acoustidId:identifiedTrack?.acoustidId||""};
 const entries=readAllStoredLyricEntries();
 for(const key of getSongLyricCacheKeys(video,metadata)){
  const cached=entries.find(entry=>entry[0]===key)?.[1];
  if(!hasUsableCachedLyrics(cached)||!lyricCacheVersionMatches(cached,video))continue;
  // A fingerprint cache key is useful for discovery, but title and artist
  // must still independently confirm the exact song before lyrics are reused.
  const titleMatches=trackSimilarity(cached.trackName,metadata.trackName)>=0.92;
  const expectedArtists=[metadata.artistName,...getLyricsIdentity(video).artistAliases||[],getLyricsIdentity(video).artist].filter(Boolean);
  const artistMatches=cachedArtistIdentityNames(cached).some(candidate=>expectedArtists.some(expected=>artistIdentityMatches(candidate,expected,0.82)));
  if(titleMatches&&artistMatches){
   const prepared=prepareSharedCacheForVideo(cached,key,video.id);if(prepared)return prepared;
  }
 }
 let best=null,bestScore=0;
 for(const [key,cached] of entries){
  if(!hasUsableCachedLyrics(cached)||!cached.trackName||!cached.artistName||!lyricCacheVersionMatches(cached,video))continue;
  const titleScore=trackSimilarity(cached.trackName,metadata.trackName);
  const expectedArtists=[metadata.artistName,...getLyricsIdentity(video).artistAliases||[],getLyricsIdentity(video).artist].filter(Boolean);
  const artistScore=cachedArtistIdentityNames(cached).some(candidate=>expectedArtists.some(expected=>artistIdentityMatches(candidate,expected,0.82)))?1:0;
  if(titleScore<0.92||artistScore<0.82)continue;
  const score=titleScore*0.6+artistScore*0.4;
  if(score>bestScore){bestScore=score;best=prepareSharedCacheForVideo(cached,key,video.id);}
 }
 return best;
}
function storeIdentifiedLyricsForSong(video,identifiedTrack){
 if(!identifiedTrack||lyricTimingBasis!=="catalog"||!hasUsableCachedLyrics({lines:lyricState.lines}))return false;
 const item={lines:(lyricState.lines||[]).map(line=>({...line})),plain:String(lyricState.plain||""),
  wordSynced:Boolean(lyricState.wordSynced),timingBasis:"catalog",source:"Identified song synced lyrics",
  trackName:identifiedTrack.title,artistName:identifiedTrack.artist,duration:Number(identifiedTrack.duration)||0,
  acoustidId:identifiedTrack.acoustidId||"",videoMetadata:{id:video.id,title:video.title,channelTitle:video.channelTitle,duration:Number(video.duration)||0}};
 if(!hasUsableCachedLyrics(item))return false;
 for(const key of getSongLyricCacheKeys(video,item))storeLyric(key,item);
 return true;
}
function storeLyricsForVideo(video,item,allowCrossVideo=true){
 storeLyric(video.id,item);
 if(!allowCrossVideo)return;
 for(const key of getSongLyricCacheKeys(video,item))storeLyric(key,item);
}
function promoteVideoLyricsToSongCache(sourceOffset,identifiedTrack=null){
  const videoId=currentVideoId;
  const cached=lyricCache.get(videoId)||readStoredLyric(videoId);
  if(!cached||cached.timingBasis!=="video"||!Array.isArray(cached.lines)||!cached.lines.length||!cached.videoMetadata)return false;
  const parsedOffset=finiteTimestampSeconds(sourceOffset);
  if(!Number.isFinite(parsedOffset)||parsedOffset<0)return false;
  const offset=Math.min(1800,parsedOffset);
  // Convert line and word timestamps from this video's timeline to the
  // identified song timeline. Keep the original video cache as a fallback.
  const normalizedLines=normalizeVideoBoundLyricsToSongTimeline(cached.lines,offset);
  const distinctTimes=new Set(normalizedLines.map(line=>Math.round(line.time*100))).size;
  if(normalizedLines.length<2||distinctTimes<2)return false;
  const normalized={...cached,lines:normalizedLines,timingBasis:"catalog",source:"Identified song synced lyrics",
   trackName:identifiedTrack?.title||cached.trackName,artistName:identifiedTrack?.artist||cached.artistName,
   duration:Number(identifiedTrack?.duration)||Number(cached.duration)||0,
   acoustidId:identifiedTrack?.acoustidId||cached.acoustidId||""};
  if(!normalized.trackName||!normalized.artistName)return false;
  lyricTimingBasis="catalog";lyricOffsetSeconds=offset;
  lyricState.lines=normalizedLines;lyricState.plain=String(cached.plain||"");
  lyricState.wordSynced=Boolean(cached.wordSynced);lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;
  for(const key of getSongLyricCacheKeys(cached.videoMetadata,normalized))storeLyric(key,normalized);
  recordLyricFlow("video_synced_lyrics_promoted_to_song_cache",{title:normalized.trackName,artist:normalized.artistName,lineCount:normalizedLines.length,sourceVideoId:videoId,trackStartOffset:offset});
  renderLyrics();
  return true;
 }
 function selectTrackStart(tracks,video){
 const expected=expectedTrackIdentity(video),videoDuration=Number(video?.duration)||0;
 if(!expected.title||!expected.artist)return null;
 const candidates=(Array.isArray(tracks)?tracks:[]).map(track=>{
  const title=trackSimilarity(track.title,expected.title),artist=trackSimilarity(track.artist,expected.artist);
  const confidence=Number(track.confidence)||0,duration=Number(track.duration)||0,timestamp=finiteTimestampSeconds(track.timestamp);
  // A YouTube upload may contain an edited intro before the identified song.
  // Permit the video to be longer than the song, but keep the reverse mismatch tight.
  const durationMatches=!duration||!videoDuration||
   (duration<=videoDuration+15&&videoDuration-duration<=Math.max(90,duration*0.30));
  return {track,title,artist,confidence,duration,timestamp,durationMatches,
   key:trackText(track.title)+"|"+trackText(track.artist),score:title*0.45+artist*0.30+confidence*0.20+(durationMatches?0.05:0)};
 }).filter(item=>item.title>=0.90&&item.artist>=0.80&&item.confidence>=0.80&&item.durationMatches&&
  Number.isFinite(item.timestamp)&&item.timestamp>=0&&(!videoDuration||item.timestamp<videoDuration))
 .sort((a,b)=>b.score-a.score);
 if(!candidates.length)return null;
 const unique=[];
 for(const item of candidates){
  const prior=unique.find(existing=>existing.key===item.key);
  if(!prior)unique.push(item);
  else if(item.score>prior.score)Object.assign(prior,item);
 }
 unique.sort((a,b)=>b.score-a.score);
 if(unique.length>1&&unique[1].score>=unique[0].score-0.08)return null;
 return unique[0].track;
}

function normalizeVideoBoundLyricsToSongTimeline(lines,sourceOffset){
 const offset=finiteTimestampSeconds(sourceOffset);
 if(!Number.isFinite(offset)||offset<0)return [];
 return (Array.isArray(lines)?lines:[])
  .filter(line=>Number.isFinite(finiteTimestampSeconds(line?.time))&&finiteTimestampSeconds(line.time)>=offset)
  .map(line=>({...line,time:finiteTimestampSeconds(line.time)-offset,
   words:Array.isArray(line.words)?line.words.map(word=>{
    const start=finiteTimestampSeconds(word?.start),end=finiteTimestampSeconds(word?.end);
    return {...word,
     start:Number.isFinite(start)?Math.max(0,start-offset):word.start,
     end:Number.isFinite(end)?Math.max(0,end-offset):word.end
    };
   }).filter(word=>!Number.isFinite(finiteTimestampSeconds(word.end))||finiteTimestampSeconds(word.end)>=0):line.words
  }));
}
async function resolveReferenceVideoSongOffset(referenceVideo){
 const videoId=String(referenceVideo?.id||"");
 if(!videoId)return null;
 const now=Date.now();
 let cache=readTrackAnalysisCache(),entry=cache[videoId];
 const age=now-(Number(entry?.savedAt)||0);
 if(entry?.status==="completed"&&age<30*24*60*60*1000){
  const match=selectTrackStart(entry.tracks,referenceVideo);
  return match?getVideoLyricOffset(videoId,match.timestamp):null;
 }
 if(entry?.status==="failed"&&age<15*60*1000)return null;
 if((entry?.status==="paused"||entry?.status==="pending")&&Number(entry.retryAfter)>now)return null;
 let jobId=entry?.status==="pending"&&entry.jobId&&age<24*60*60*1000?String(entry.jobId):"";
 if(!jobId){
  const reservation=reserveTrackAnalysisRequest();
  if(!reservation.allowed){
   cache=readTrackAnalysisCache();
   cache[videoId]={status:"paused",savedAt:Date.now(),retryAfter:reservation.retryAt,reason:"local_rate_limit"};
   writeTrackAnalysisCache(cache);return null;
  }
  try{
   const response=await fetch("https://trackid.dev/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({url:"https://www.youtube.com/watch?v="+encodeURIComponent(videoId)})});
   if(response.status===429){
    cache=readTrackAnalysisCache();
    cache[videoId]={status:"paused",savedAt:Date.now(),retryAfter:Date.now()+15*60*1000,reason:"rate_limited"};
    writeTrackAnalysisCache(cache);return null;
   }
   if(!response.ok)throw new Error("TrackID HTTP "+response.status);
   const created=await response.json();
   if(!created?.jobId)throw new Error("TrackID 분석 작업 ID가 없습니다.");
   jobId=String(created.jobId);
   cache=readTrackAnalysisCache();
   cache[videoId]={status:"pending",jobId,savedAt:Date.now(),polls:0};
   writeTrackAnalysisCache(cache);
  }catch(error){
   console.warn("Reference-video timing analysis could not start:",error);
   cache=readTrackAnalysisCache();
   cache[videoId]={status:"failed",savedAt:Date.now(),reason:"request_failed"};
   writeTrackAnalysisCache(cache);return null;
  }
 }
 const pollDelays=[3000,5000,10000,20000,35000,60000];
 for(let attempt=0;attempt<pollDelays.length;attempt++){
  await trackAnalysisDelay(pollDelays[attempt]);
  let job;
  try{
   const response=await fetch("https://trackid.dev/api/job/"+encodeURIComponent(jobId));
   if(response.status===429){
    cache=readTrackAnalysisCache();
    cache[videoId]={status:"paused",jobId,savedAt:Date.now(),retryAfter:Date.now()+15*60*1000,reason:"rate_limited"};
    writeTrackAnalysisCache(cache);return null;
   }
   if(response.status===404||response.status===410){
    cache=readTrackAnalysisCache();delete cache[videoId];writeTrackAnalysisCache(cache);return null;
   }
   if(!response.ok)continue;
   job=await response.json();
  }catch(error){console.warn("Reference-video timing poll failed:",error);continue;}
  if(job?.status==="completed"){
   const tracks=Array.isArray(job.tracks)?job.tracks:[];
   const match=selectTrackStart(tracks,referenceVideo);
   cache=readTrackAnalysisCache();
   cache[videoId]=match?{status:"completed",tracks,savedAt:Date.now()}:{status:"failed",savedAt:Date.now(),reason:"no_confident_track"};
   writeTrackAnalysisCache(cache);
   return match?getVideoLyricOffset(videoId,match.timestamp):null;
  }
  if(job?.status==="failed"){
   cache=readTrackAnalysisCache();cache[videoId]={status:"failed",savedAt:Date.now(),reason:"analysis_failed"};
   writeTrackAnalysisCache(cache);return null;
  }
 }
 cache=readTrackAnalysisCache();
 cache[videoId]={status:"pending",jobId,savedAt:Date.now(),retryAfter:Date.now()+2*60*1000,polls:pollDelays.length};
 writeTrackAnalysisCache(cache);return null;
}

function applyTrackOffset(seconds,identifiedTrack=null){
 const parsedOffset=finiteTimestampSeconds(seconds);
 const hasMatch=Number.isFinite(parsedOffset)&&parsedOffset>=0;
 const value=hasMatch?Math.min(parsedOffset,1800):0;
 if(lyricTimingBasis==="video"){
  if(hasMatch)promoteVideoLyricsToSongCache(value,identifiedTrack);
  return;
 }
 lyricOffsetSeconds=Number.isFinite(value)&&value>=0?Math.min(value,1800):0;
 lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;renderLyrics();
}
const trackAnalysisDelay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function setLyricsStatus(message){
 if(!el?.lyricsStatus)return;
 el.lyricsStatus.textContent=String(message||"");
 el.lyricsStatus.hidden=!message;
}
const TRACK_ANALYSIS_REQUESTS_KEY="music_track_analysis_requests_v1";
const TRACK_ANALYSIS_REQUEST_WINDOW=15*60*1000;
const TRACK_ANALYSIS_MAX_REQUESTS=7;
function reserveTrackAnalysisRequest(){
 const now=Date.now();
 try{
  const raw=JSON.parse(localStorage.getItem(TRACK_ANALYSIS_REQUESTS_KEY)||"[]");
  const recent=(Array.isArray(raw)?raw:[]).map(Number).filter(value=>Number.isFinite(value)&&value>now-TRACK_ANALYSIS_REQUEST_WINDOW&&value<=now+30000).sort((a,b)=>a-b);
  if(recent.length>=TRACK_ANALYSIS_MAX_REQUESTS){
   localStorage.setItem(TRACK_ANALYSIS_REQUESTS_KEY,JSON.stringify(recent));
   return {allowed:false,retryAt:recent[0]+TRACK_ANALYSIS_REQUEST_WINDOW};
  }
  recent.push(now);
  localStorage.setItem(TRACK_ANALYSIS_REQUESTS_KEY,JSON.stringify(recent));
  return {allowed:true,retryAt:0};
 }catch(_){
  // If local storage is unavailable, let the service's own 429 response remain the authority.
  return {allowed:true,retryAt:0};
 }
}
function selectIdentifiedTrack(tracks,video){
 const videoDuration=Number(video?.duration)||0;
 const candidates=(Array.isArray(tracks)?tracks:[]).map(track=>{
  const title=String(track?.title||"").trim(),artist=String(track?.artist||"").trim();
  const confidence=Number(track?.confidence),duration=Number(track?.duration),timestamp=finiteTimestampSeconds(track?.timestamp);
  return {track,title,artist,confidence,duration,timestamp,key:trackText(title)+"|"+trackText(artist)};
 }).filter(item=>item.title&&item.artist&&!item.track?.isUnknown&&Number.isFinite(item.confidence)&&item.confidence>=0.80&&
  Number.isFinite(item.duration)&&item.duration>=45&&Number.isFinite(item.timestamp)&&item.timestamp>=0&&
  (!videoDuration||item.timestamp<videoDuration)&&
  (!videoDuration||(item.duration>=videoDuration*0.35&&item.duration<=videoDuration*1.5)));
 if(!candidates.length)return null;
 const unique=[];
 for(const item of candidates){
  const prior=unique.find(existing=>trackSimilarity(existing.title,item.title)>=0.82&&trackSimilarity(existing.artist,item.artist)>=0.62);
  if(!prior)unique.push(item);
  else if(item.confidence>prior.confidence)Object.assign(prior,item);
 }
 const ranked=unique.sort((a,b)=>b.confidence-a.confidence);
 const best=ranked[0];
 // Only reject close scores when they identify genuinely different songs.
 if(ranked.length>1&&ranked[1].confidence>=best.confidence-0.10)return null;
 return {title:best.title,artist:best.artist,duration:best.duration,confidence:best.confidence,timestamp:best.timestamp,acoustidId:String(best.track?.acoustidId||"")};
}
async function tryLoadLyricsFromIdentifiedTrack(video,tracks,initialLyricsPromise,isCurrent){
 if(!isCurrent()||currentVideoId!==video.id)return false;
 const identified=selectIdentifiedTrack(tracks,video);
 if(!identified)return false;
 const hasLyrics=Boolean(lyricState.lines.length||String(lyricState.plain||"").trim());
 const previous=hasLyrics?{
  lines:lyricState.lines.map(line=>({...line})),plain:lyricState.plain,wordSynced:lyricState.wordSynced,
  lastIndex:lyricState.lastIndex,lastWordIndex:lyricState.lastWordIndex,loading:false,
  timingBasis:lyricTimingBasis,offset:lyricOffsetSeconds,
  track:currentLyricsTrack?{...currentLyricsTrack}:null,
  statusText:el.lyricsStatus.textContent,statusHidden:el.lyricsStatus.hidden
 }:null;
 const durationClose=!previous?.track?.duration||!identified.duration||
  Math.abs(Number(previous.track.duration)-Number(identified.duration))<=Math.max(15,Number(identified.duration)*0.12);
 const sameTrack=previous?.track&&trackSimilarity(previous.track.title,identified.title)>=0.92&&
  trackSimilarity(previous.track.artist,identified.artist)>=0.82&&durationClose;
 const previousPlainFallback=Boolean(previous&&!previous.lines.length&&String(previous.plain||"").trim());
 currentIdentifiedTrack=identified;recordLyricFlow("audio_track_identified",{title:identified.title,artist:identified.artist,hasExistingLyrics:hasLyrics,sameTrack:Boolean(sameTrack),existingLyricsSynced:Boolean(previous?.lines?.length)});
 loadAlbumArtwork(video,identified);
 // Apply the fingerprint timestamp even when the existing lyrics already match.
 // Video-bound lyrics are normalized by applyTrackOffset before they are reused.
 applyTrackOffset(getVideoLyricOffset(video.id,identified.timestamp),identified);
 const hasVerifiedSyncedLyrics=lyricState.lines.length>=2&&
  lyricState.lines.every(line=>Number.isFinite(finiteTimestampSeconds(line.time))&&finiteTimestampSeconds(line.time)>=0&&String(line.text||"").trim());
 // A same-track synced result is already the best usable result; never replace it
 // with a plain-text response from a later provider search.
 if(hasLyrics&&sameTrack&&hasVerifiedSyncedLyrics){
  storeIdentifiedLyricsForSong(video,identified);
  setLyricsStatus("음원 확인 · "+identified.artist+" — "+identified.title);
  return true;
 }
 // A same-track plain lyric result is not final: retry with the fingerprinted
 // title/artist so providers and the shared song cache can supply timed lyrics.
 showLyricsMessage("음원으로 "+identified.artist+" — "+identified.title+"을 확인했어요. 싱크 가사를 다시 검색하고 있어요…");
 recordLyricFlow("identified_lyrics_search_started",{title:identified.title,artist:identified.artist,reason:previousPlainFallback?"upgrade_plain_to_synced":"verify_identified_track"});
 await loadLyrics(video,false,identified);
 if(!isCurrent()||currentVideoId!==video.id)return false;
 const found=Boolean(lyricState.lines.length||String(lyricState.plain||"").trim());
 const foundSynced=lyricState.lines.length>=2;
 if(!found&&previous&&sameTrack&&previousPlainFallback){
  // The audio fingerprint confirms the previous plain lyrics are for this song.
  // Keep them if no timed source is available; never turn them into fake sync lyrics.
  lyricState.lines=previous.lines.map(line=>({...line}));
  lyricState.plain=previous.plain;
  lyricState.wordSynced=previous.wordSynced;
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.loading=false;
  lyricTimingBasis=previous.timingBasis||"catalog";
  lyricOffsetSeconds=Number(previous.offset)||0;
  currentLyricsTrack=previous.track?{...previous.track}:{title:identified.title,artist:identified.artist,duration:identified.duration};
  renderLyrics();
  setLyricsStatus("음원 확인 · "+identified.artist+" — "+identified.title+" · 싱크 가사를 찾지 못해 기존 일반 가사를 유지해요.");
  recordLyricFlow("identified_plain_lyrics_preserved",{title:identified.title,artist:identified.artist,reason:"no_verified_synced_replacement"});
  return true;
 }
 if(!found&&previous){
  // Never keep lyrics from a different track after audio fingerprinting identifies this video.
  lyricState.lines=[];lyricState.plain="";lyricState.wordSynced=false;
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.loading=false;
  lyricTimingBasis="catalog";lyricOffsetSeconds=0;currentLyricsTrack=null;
  renderLyrics();
  setLyricsStatus("음원은 확인했지만 해당 곡과 일치하는 가사를 찾지 못했어요. 다른 곡의 가사는 표시하지 않았어요.");
 }else if(found){
  if(foundSynced)storeIdentifiedLyricsForSong(video,identified);
  setLyricsStatus(foundSynced?"음원 식별로 싱크 가사를 확인했어요.":"음원 식별로 곡 정보 보정됨");
 }
 return true;
}
async function startTrackOffsetAnalysis(video,initialLyricsPromise=Promise.resolve()){
 const token=++trackAnalysisToken,videoId=String(video?.id||"");if(!videoId)return;recordLyricFlow("track_analysis_started",{cacheStatus:String(readTrackAnalysisCache()[videoId]?.status||"none")});
  
 const cache=readTrackAnalysisCache();let cached=cache[videoId];const now=Date.now();
 const isCurrent=()=>token===trackAnalysisToken&&videoId===currentVideoId;
 const finishWithTracks=async tracks=>{
  if(!isCurrent())return;
  // Do not apply a video-start offset until the initial lyric load has decided
  // whether its timestamps belong to the video timeline or the song timeline.
  // Otherwise a fast TrackID response can race loadLyrics() and be overwritten.
  try{await initialLyricsPromise;}catch(_){}
  if(!isCurrent())return;
  recordLyricFlow("track_analysis_results_ready",{trackCount:Array.isArray(tracks)?tracks.length:0});const identifiedHandled=await tryLoadLyricsFromIdentifiedTrack(video,tracks,initialLyricsPromise,isCurrent);
   
  if(!isCurrent())return;
  if(!identifiedHandled){
   const match=selectTrackStart(tracks,video);
   applyTrackOffset(match?getVideoLyricOffset(videoId,match.timestamp):null);
   if(match)setLyricsStatus("가사 시작 시각 보정 적용됨");
  }
 };
 if(cached?.status==="completed"&&Array.isArray(cached.tracks)&&now-(cached.savedAt||0)<30*24*60*60*1000){
  await finishWithTracks(cached.tracks);return;
 }
 if(cached?.status==="failed"&&now-(cached.savedAt||0)<15*60*1000){
  applyTrackOffset(null);
  if(isCurrent())setLyricsStatus(cached.reason==="no_confident_track"?"확실한 음원 일치를 찾지 못했어요. 잠시 후 다시 시도할 수 있어요.":"음원 분석을 잠시 쉬고 있어요. 기본 가사 검색은 계속돼요.");
  return;
 }
 if(cached?.status==="paused"&&Number(cached.retryAfter)>now){
  applyTrackOffset(null);if(isCurrent())setLyricsStatus("음원 분석 요청 제한으로 잠시 대기 중이에요. 기본 가사 검색은 계속돼요.");return;
 }
 if((cached?.status==="pending"||cached?.status==="paused")&&cached.jobId&&now-(cached.savedAt||0)<24*60*60*1000){
  if(Number(cached.retryAfter)>now){applyTrackOffset(null);if(isCurrent())setLyricsStatus("노래 시작 시각 분석 결과를 기다리는 중이에요.");return;}
 }else{
  applyTrackOffset(null);
  const reservation=reserveTrackAnalysisRequest();
  if(!reservation.allowed){
   const paused=readTrackAnalysisCache();paused[videoId]={status:"paused",savedAt:Date.now(),retryAfter:reservation.retryAt,reason:"local_rate_limit"};writeTrackAnalysisCache(paused);
   if(isCurrent())setLyricsStatus("음원 분석 요청 간격을 조절하고 있어요. 기존 가사 재생은 유지돼요.");
   return;
  }
  try{
   const response=await fetch("https://trackid.dev/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:"https://www.youtube.com/watch?v="+encodeURIComponent(videoId)})});
   if(response.status===429){
    const limited=readTrackAnalysisCache();limited[videoId]={status:"paused",savedAt:Date.now(),retryAfter:Date.now()+15*60*1000,reason:"rate_limited"};writeTrackAnalysisCache(limited);
    if(isCurrent())setLyricsStatus("음원 분석 서비스가 요청을 제한했어요. 기본 가사 검색은 계속돼요.");return;
   }
   if(!response.ok)throw new Error("분석 요청 실패 (HTTP "+response.status+")");
   const created=await response.json();if(!created.jobId)throw new Error("분석 작업 ID를 받지 못했어요.");
   cached={status:"pending",jobId:created.jobId,savedAt:Date.now(),polls:0};cache[videoId]=cached;writeTrackAnalysisCache(cache);
  }catch(error){
   console.warn("Track identification unavailable:",error);
   const failed=readTrackAnalysisCache();failed[videoId]={status:"failed",savedAt:Date.now(),reason:"request_failed"};writeTrackAnalysisCache(failed);
   if(isCurrent())setLyricsStatus("음원 식별을 사용할 수 없어 기본 가사 검색을 유지해요.");return;
  }
 }
 if(!cached?.jobId)return;
 if(isCurrent())setLyricsStatus("영상의 실제 음원을 식별 중…");
 const pollDelays=[3000,5000,10000,20000,35000,60000];
 for(let attempt=0;attempt<pollDelays.length;attempt++){
  if(!isCurrent())return;
  await trackAnalysisDelay(pollDelays[attempt]);
  if(!isCurrent())return;
  let response,job;
  try{
   response=await fetch("https://trackid.dev/api/job/"+encodeURIComponent(cached.jobId));
   if(response.status===429){
    const paused=readTrackAnalysisCache();paused[videoId]={...cached,status:"paused",savedAt:Date.now(),retryAfter:Date.now()+15*60*1000,reason:"rate_limited"};writeTrackAnalysisCache(paused);
    if(isCurrent())setLyricsStatus("음원 분석 서비스가 요청을 제한했어요. 기존 가사 재생은 유지돼요.");return;
   }
   if(response.status===404||response.status===410)throw Object.assign(new Error("분석 작업을 찾을 수 없어요."),{staleJob:true});
   if(!response.ok)throw new Error("상태 확인 실패 (HTTP "+response.status+")");
   job=await response.json();
  }catch(error){
   console.warn("Track identification status check failed:",error);
   if(error.staleJob){
    const reset=readTrackAnalysisCache();delete reset[videoId];writeTrackAnalysisCache(reset);
    if(isCurrent())setLyricsStatus("음원 분석 작업이 만료되어 다음 재생 때 다시 시도해요.");return;
   }
   continue;
  }
  if(job.status==="completed"){
   const tracks=Array.isArray(job.tracks)?job.tracks:[];recordLyricFlow("track_analysis_completed",{trackCount:tracks.length,identified:Boolean(selectIdentifiedTrack(tracks,video))});
   
   const reliableTrack=Boolean(selectIdentifiedTrack(tracks,video)||selectTrackStart(tracks,video));
   const updated=readTrackAnalysisCache();
   updated[videoId]=reliableTrack?{status:"completed",tracks,savedAt:Date.now()}:{status:"failed",savedAt:Date.now(),reason:"no_confident_track"};
   writeTrackAnalysisCache(updated);
   await finishWithTracks(tracks);
   if(isCurrent()&&!selectIdentifiedTrack(tracks,video)&&!lyricState.lines.length&&!lyricState.plain){
    setLyricsStatus("확실한 음원 일치를 찾지 못했어요. 기본 가사 검색 결과를 유지해요.");
   }
   return;
  }
  if(job.status==="failed"){
   const updated=readTrackAnalysisCache();updated[videoId]={status:"failed",savedAt:Date.now(),reason:"analysis_failed"};writeTrackAnalysisCache(updated);
   if(isCurrent())setLyricsStatus("음원 식별에 실패해 기본 가사 검색 결과를 유지해요.");return;
  }
 }
 const pending=readTrackAnalysisCache();pending[videoId]={...cached,status:"pending",savedAt:Date.now(),retryAfter:Date.now()+2*60*1000};writeTrackAnalysisCache(pending);
 if(isCurrent())setLyricsStatus("음원 식별이 지연되고 있어요. 음악과 기존 가사는 계속 재생돼요.");
}

const LYRIC_CACHE_STORAGE_KEY="music_lyrics_cache_v30";
const LYRIC_CACHE_LIMIT=150;
const LYRIC_API_COOLDOWN_KEY="music_lrclib_retry_after_v1";
const BETTER_LYRICS_COOLDOWN_KEY="music_betterlyrics_retry_after_v1";
function getLyricApiCooldown(){try{return Number(localStorage.getItem(LYRIC_API_COOLDOWN_KEY))||0;}catch(_){return 0;}}
function setLyricApiCooldown(until){try{localStorage.setItem(LYRIC_API_COOLDOWN_KEY,String(Math.max(Date.now(),Number(until)||0)));}catch(_){}}
function getBetterLyricsCooldown(){try{return Number(localStorage.getItem(BETTER_LYRICS_COOLDOWN_KEY))||0;}catch(_){return 0;}}
function setBetterLyricsCooldown(until){try{localStorage.setItem(BETTER_LYRICS_COOLDOWN_KEY,String(Math.max(Date.now(),Number(until)||0)));}catch(_){}}
function readStoredLyric(cacheKey){
 try{
  const saved=JSON.parse(localStorage.getItem(LYRIC_CACHE_STORAGE_KEY)||"{}");
  const item=saved&&typeof saved==="object"?saved[cacheKey]:null;
  if(!item||!Array.isArray(item.lines))return null;
  lyricCache.set(cacheKey,item);
  return item;
 }catch(_){return null;}
}
function storeLyric(cacheKey,item){
 lyricCache.set(cacheKey,item);
 try{
  const saved=JSON.parse(localStorage.getItem(LYRIC_CACHE_STORAGE_KEY)||"{}");
  const next=saved&&typeof saved==="object"?saved:{};
  next[cacheKey]={lines:item.lines,plain:item.plain||"",wordSynced:Boolean(item.wordSynced),timingBasis:item.timingBasis||"catalog",source:item.source||"",trackName:item.trackName||"",artistName:item.artistName||"",duration:Number(item.duration)||0,videoMetadata:item.videoMetadata||null,savedAt:Date.now()};
  const keys=Object.keys(next).sort((a,b)=>(Number(next[b]?.savedAt)||0)-(Number(next[a]?.savedAt)||0));
  for(const key of keys.slice(LYRIC_CACHE_LIMIT))delete next[key];
  localStorage.setItem(LYRIC_CACHE_STORAGE_KEY,JSON.stringify(next));
 }catch(error){console.warn("Lyrics cache could not be saved:",error);}
}

function removeLyricsAssociatedWithVideo(videoId){
 if(!videoId)return 0;
 let removed=0;
 for(const [key,item] of [...lyricCache.entries()]){
  if(item?.videoMetadata?.id===videoId){lyricCache.delete(key);removed++;}
 }
 try{
  const saved=JSON.parse(localStorage.getItem(LYRIC_CACHE_STORAGE_KEY)||"{}");
  if(saved&&typeof saved==="object"){
   for(const [key,item] of Object.entries(saved)){
    if(item?.videoMetadata?.id===videoId){delete saved[key];removed++;}
   }
   localStorage.setItem(LYRIC_CACHE_STORAGE_KEY,JSON.stringify(saved));
  }
 }catch(error){console.warn("Rejected lyric cache cleanup failed:",error);}
 return removed;
}

function videoLyricCacheMatches(cached,video){
 if(!cached||!cached.trackName||!cached.artistName)return false;
 // A video-ID-specific Unison result is tied directly to this exact video.
 if(cached.source==="Unison"&&cached.videoMetadata?.id===video.id)return true;
 const identity=getLyricsIdentity(video);
 const titleScore=Math.max(0,...identity.titles.map(title=>trackSimilarity(title,cached.trackName)));
 if(titleScore<0.92)return false;
 const artistNames=[identity.artistKnown?identity.artist:"",...(identity.artistAliases||[]),...identity.queries.map(item=>item.artist)].filter(Boolean);
 const shortTitle=identity.titles.some(value=>trackText(value).replace(/\s+/g,"").length<=2);
 if(shortTitle){
  if(!artistNames.some(name=>trackText(name)===trackText(cached.artistName)))return false;
 }else if(!artistNames.some(name=>trackSimilarity(name,cached.artistName)>=0.82))return false;
 const cachedDuration=Number(cached.duration)||0,videoDuration=Number(video.duration)||0;
 if(cachedDuration&&videoDuration&&Math.abs(cachedDuration-videoDuration)>Math.max(15,videoDuration*0.12))return false;
 return true;
}

const ids=["searchForm","searchInput","searchButton","coverImage","resultsTitle","resultCount","resultsList","messageState","playerFrame","nowTitle","nowChannel","connectionStatus","settingsButton","settingsDialog","apiKeyInput","apiKeyError","saveKeyButton","removeKeyButton","progressBar","currentTime","totalTime","playPauseButton","playbackState","lyricsView","lyricsStatus","lyricsDiagnostics","lyricsDiagnosticsContent","lyricsAttribution","auditStartButton","auditMarkButton","auditCopyButton","auditStatus"];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
let apiKey=localStorage.getItem(STORAGE_KEY)||"",currentVideoId="",lastResults=[],toastTimer,ytPlayer=null,ytReady=false,ytPlayerError=null,progressTimer=null,lyricTimer=null,playbackAuditTimer=null,seeking=false,lyricLoadToken=0,lyricAbortController=null,lyricFallbackAbortController=null,selectedVideoDuration=0,contentTimelineReady=false,searchRequestToken=0,searchAbortController=null;
let currentIdentifiedTrack=null,currentLyricsTrack=null;

const ALBUM_ART_CACHE_KEY="music_album_art_cache_v1";
const ALBUM_ART_CACHE_LIMIT=60;
const ALBUM_ART_POSITIVE_TTL=30*24*60*60*1000;
const ALBUM_ART_NEGATIVE_TTL=8*60*60*1000;
let artworkRequestToken=0,artworkRequestController=null,activeArtworkKey="";
function albumArtworkKey(title,artist){return "song:"+trackText(title)+"|"+trackText(artist);}
function readAlbumArtworkCache(){
 try{const saved=JSON.parse(localStorage.getItem(ALBUM_ART_CACHE_KEY)||"{}");return saved&&typeof saved==="object"?saved:{};}catch(_){return {};}
}
function writeAlbumArtworkCache(cache){
 try{
  const entries=Object.entries(cache).sort((a,b)=>(Number(b[1]?.savedAt)||0)-(Number(a[1]?.savedAt)||0));
  localStorage.setItem(ALBUM_ART_CACHE_KEY,JSON.stringify(Object.fromEntries(entries.slice(0,ALBUM_ART_CACHE_LIMIT))));
 }catch(error){console.warn("Album artwork cache could not be saved:",error);}
}
function getAlbumArtworkIdentity(video,preferredTrack=null){
 const candidate=currentIdentifiedTrack||preferredTrack||currentLyricsTrack;
 let title=String(candidate?.title||candidate?.trackName||"").trim();
 let artist=String(candidate?.artist||candidate?.artistName||"").trim();
 if(!title||!artist){
  const inferred=getLyricsIdentity(video);
  if(!inferred.artistKnown)return null;
  title=inferred.title;artist=inferred.artist;
 }
 if(!title||!artist||trackText(artist).length<2)return null;
 return {title,artist,duration:Number(candidate?.duration)||0};
}
function normalizeAlbumArtworkUrl(value){
 try{
  const url=new URL(String(value||""));
  if(url.protocol==="http:")url.protocol="https:";
  const host=url.hostname.toLowerCase();
  if(url.protocol!=="https:"||!(host.endsWith(".mzstatic.com")||host==="mzstatic.com"||host==="itunes.apple.com"))return "";
  url.pathname=url.pathname.replace(/\/\d+x\d+bb(?=\.)/i,"/600x600bb");
  return url.href;
 }catch(_){return "";}
}
function artworkVariantSignature(value){
 const text=String(value||"").toLocaleLowerCase().normalize("NFKC");
 return ["instrumental","karaoke","cover","remix","sped up","slowed","live","acoustic","demo","nightcore","piano version","orchestral"].filter(word=>text.includes(word));
}
function sameArtworkVersion(sourceTitle,resultTitle){
 const source=artworkVariantSignature(sourceTitle),result=artworkVariantSignature(resultTitle);
 return source.length===result.length&&source.every(word=>result.includes(word));
}
function clearAlbumArtwork(){
 artworkRequestToken++;
 if(artworkRequestController){artworkRequestController.abort();artworkRequestController=null;}
 activeArtworkKey="";
 if(!el.coverImage)return;
 el.coverImage.onload=null;el.coverImage.onerror=null;
 el.coverImage.removeAttribute("src");el.coverImage.alt="";
 const frame=el.coverImage.closest(".cover-art");
 if(frame){frame.classList.remove("has-cover");frame.dataset.artworkState="default";}
}
function applyAlbumArtwork(url,title,token,key){
 const image=el.coverImage;if(!image||token!==artworkRequestToken)return;
 image.onload=()=>{
  if(token!==artworkRequestToken)return;
  const frame=image.closest(".cover-art");
  if(frame){frame.classList.add("has-cover");frame.dataset.artworkState="loaded";}
 };
 image.onerror=()=>{
  if(token!==artworkRequestToken)return;
  image.onload=null;image.onerror=null;image.removeAttribute("src");
  if(key){const cache=readAlbumArtworkCache();delete cache[key];writeAlbumArtworkCache(cache);if(activeArtworkKey===key)activeArtworkKey="";}
  const frame=image.closest(".cover-art");
  if(frame){frame.classList.remove("has-cover");frame.dataset.artworkState="default";}
 };
 image.alt=title+" 앨범 커버";
 image.src=url;
}
async function loadAlbumArtwork(video,preferredTrack=null){
 if(!video||video.id!==currentVideoId||!el.coverImage)return false;
 const identity=getAlbumArtworkIdentity(video,preferredTrack);
 if(!identity)return false;
 const key=albumArtworkKey(identity.title,identity.artist);
 if(!key||key==="song:|")return false;
 if(activeArtworkKey===key&&(artworkRequestController||el.coverImage.getAttribute("src")))return true;
 if(artworkRequestController){artworkRequestController.abort();artworkRequestController=null;}
 const token=++artworkRequestToken;activeArtworkKey=key;
 const cache=readAlbumArtworkCache(),cached=cache[key],now=Date.now();
 if(cached&&now-Number(cached.savedAt||0)<(cached.url?ALBUM_ART_POSITIVE_TTL:ALBUM_ART_NEGATIVE_TTL)){
  if(cached.url){const url=normalizeAlbumArtworkUrl(cached.url);if(url){applyAlbumArtwork(url,identity.title,token,key);return true;}}
  return false;
 }
 const controller=new AbortController();artworkRequestController=controller;
 const timeout=setTimeout(()=>controller.abort(),7000);
 try{
  const params=new URLSearchParams({term:identity.title+" "+identity.artist,media:"music",entity:"song",country:"kr",limit:"25"});
  const response=await fetch("https://itunes.apple.com/search?"+params.toString(),{signal:controller.signal,headers:{Accept:"application/json"}});
  if(!response.ok)throw new Error("iTunes Search HTTP "+response.status);
  const data=await response.json();
  if(token!==artworkRequestToken||video.id!==currentVideoId)return false;
  const candidates=(Array.isArray(data.results)?data.results:[]).filter(item=>{
   if(item?.wrapperType!=="track"||item?.kind!=="song"||!item?.trackName||!item?.artistName||!item?.artworkUrl100)return false;
   const titleScore=trackSimilarity(identity.title,item.trackName);
   const artistScore=trackSimilarity(identity.artist,item.artistName);
   if(titleScore<0.9||artistScore<0.86||!sameArtworkVersion(identity.title,item.trackName))return false;
   const expectedDuration=Number(identity.duration)||0,foundDuration=Number(item.trackTimeMillis)/1000;
   if(expectedDuration&&foundDuration&&Math.abs(expectedDuration-foundDuration)>Math.max(18,expectedDuration*0.12))return false;
   return Boolean(normalizeAlbumArtworkUrl(item.artworkUrl100));
  }).map(item=>{
   const titleScore=trackSimilarity(identity.title,item.trackName),artistScore=trackSimilarity(identity.artist,item.artistName);
   const expectedDuration=Number(identity.duration)||0,foundDuration=Number(item.trackTimeMillis)/1000;
   const durationScore=expectedDuration&&foundDuration?Math.max(0,1-Math.abs(expectedDuration-foundDuration)/Math.max(18,expectedDuration*0.12)):0.5;
   return {item,score:titleScore*0.48+artistScore*0.37+durationScore*0.15};
  }).sort((a,b)=>b.score-a.score);
  const best=candidates[0]?.item||null;
  const artworkUrl=best?normalizeAlbumArtworkUrl(best.artworkUrl100):"";
  cache[key]={url:artworkUrl||"",album:best?.collectionName||"",trackName:best?.trackName||"",artistName:best?.artistName||"",savedAt:now};
  writeAlbumArtworkCache(cache);
  if(!artworkUrl)return false;
  applyAlbumArtwork(artworkUrl,identity.title,token,key);
  return true;
 }catch(error){
  if(!controller.signal.aborted)console.warn("Album artwork lookup failed:",error?.message||error);
  return false;
 }finally{
  clearTimeout(timeout);
  if(artworkRequestController===controller)artworkRequestController=null;
 }
}

const HISTORY_KEY="music_recent_searches_v1";
const HISTORY_LIMIT=8;
let recentSearches=loadRecentSearches(),youtubeSuggestions=[],musicSuggestions=[],suggestionTimer=null,suggestionScript=null,suggestionRequestToken=0,musicCatalogController=null,activeSearchRow=-1,searchDropdownOpen=false,suggestionOriginalHandler=null,suggestionHandlerOwner=null,suggestionHandlerInstalled=false;
function loadRecentSearches(){try{const saved=JSON.parse(localStorage.getItem(HISTORY_KEY)||"[]");return Array.isArray(saved)?saved.filter(item=>typeof item==="string"&&item.trim()).slice(0,HISTORY_LIMIT):[];}catch(_){return [];}}
function saveRecentSearch(query){const value=String(query||"").trim();if(!value)return;recentSearches=[value,...recentSearches.filter(item=>item.toLocaleLowerCase()!==value.toLocaleLowerCase())].slice(0,HISTORY_LIMIT);try{localStorage.setItem(HISTORY_KEY,JSON.stringify(recentSearches));}catch(error){console.warn("Recent searches could not be saved:",error);}renderRecentSearches(el.searchInput.value);}
function makeSearchIcon(kind){const icon=document.createElement("span");icon.className=kind==="recent"?"recent-clock":"recent-search-icon";icon.setAttribute("aria-hidden","true");icon.innerHTML=kind==="recent"?'<svg viewBox="0 0 24 24"><path d="M3 11a9 9 0 1 0 2.7-6.4L3 7"/><path d="M3 3v4h4M12 7v5l3 2"/></svg>':'<svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>';return icon;}
function makeSearchArrow(){const arrow=document.createElement("span");arrow.className="recent-insert-icon";arrow.setAttribute("aria-hidden","true");arrow.innerHTML='<svg viewBox="0 0 24 24"><path d="M17 17 7 7M7 7h10M7 7v10"/></svg>';return arrow;}
function makeRecentRemoveButton(query){const remove=document.createElement("button");remove.type="button";remove.className="recent-remove";remove.setAttribute("aria-label","검색 기록 삭제: "+query);remove.title="검색 기록 삭제";remove.textContent="×";remove.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();recentSearches=recentSearches.filter(item=>item.toLocaleLowerCase()!==query.toLocaleLowerCase());try{localStorage.setItem(HISTORY_KEY,JSON.stringify(recentSearches));}catch(error){console.warn("Recent search could not be removed:",error);}activeSearchRow=-1;renderRecentSearches(el.searchInput.value);});return remove;}
function selectSearchQuery(query){const value=String(query||"").trim();if(!value)return;el.searchInput.value=value;saveRecentSearch(value);hideRecentSearches();searchMusic(value);}
function createSearchRow(query,kind){const row=document.createElement("div");row.className="recent-row";row.setAttribute("role","option");row.setAttribute("aria-selected","false");row.dataset.query=query;const select=document.createElement("button");select.type="button";select.className="recent-query";select.setAttribute("aria-label","검색: "+query);select.append(makeSearchIcon(kind));const label=document.createElement("span");label.className="recent-query-text";label.textContent=query;select.append(label);select.addEventListener("click",()=>selectSearchQuery(query));row.append(select);if(kind==="recent")row.append(makeRecentRemoveButton(query));else row.append(makeSearchArrow());return row;}
function renderRecentSearches(query=""){const panel=document.getElementById("recentSearches");if(!panel)return;if(!searchDropdownOpen){panel.hidden=true;return;}panel.replaceChildren();const clean=String(query||"").trim().toLocaleLowerCase();const history=recentSearches.filter(item=>!clean||item.toLocaleLowerCase().includes(clean));const used=new Set([...history.map(item=>item.toLocaleLowerCase()),clean]);const music=musicSuggestions.filter(item=>item.toLocaleLowerCase()!==clean&&!used.has(item.toLocaleLowerCase())).slice(0,6);music.forEach(item=>used.add(item.toLocaleLowerCase()));const general=youtubeSuggestions.filter(item=>item.toLocaleLowerCase()!==clean&&!used.has(item.toLocaleLowerCase())).slice(0,4);if(!history.length&&!music.length&&!general.length){panel.hidden=true;return;}if(history.length){const heading=document.createElement("div");heading.className="recent-heading";const label=document.createElement("span");label.textContent="최근 검색";const clear=document.createElement("button");clear.type="button";clear.className="recent-clear";clear.textContent="전체 삭제";clear.addEventListener("click",event=>{event.stopPropagation();recentSearches=[];try{localStorage.removeItem(HISTORY_KEY);}catch(_){}renderRecentSearches(el.searchInput.value);el.searchInput.focus();});heading.append(label,clear);panel.append(heading);history.forEach(value=>panel.append(createSearchRow(value,"recent")));}if(music.length){const heading=document.createElement("div");heading.className="recent-heading suggestion-heading";const label=document.createElement("span");label.textContent="노래·가수 추천";heading.append(label);panel.append(heading);music.forEach(value=>panel.append(createSearchRow(value,"music")));}if(general.length){const heading=document.createElement("div");heading.className="recent-heading suggestion-heading";const label=document.createElement("span");label.textContent="YouTube 검색 제안";heading.append(label);panel.append(heading);general.forEach(value=>panel.append(createSearchRow(value,"suggestion")));}panel.hidden=false;activeSearchRow=-1;}
function requestMusicCatalogSuggestions(query,token){if(musicCatalogController){musicCatalogController.abort();musicCatalogController=null;}musicSuggestions=[];if(query.length<2)return;const controller=new AbortController();musicCatalogController=controller;const timeout=setTimeout(()=>controller.abort(),900);const url="https://itunes.apple.com/search?"+new URLSearchParams({term:query,entity:"song",limit:"8",country:"KR"}).toString();fetch(url,{signal:controller.signal,mode:"cors"}).then(response=>{if(!response.ok)throw new Error("Music catalog unavailable");return response.json();}).then(data=>{if(token!==suggestionRequestToken||!searchDropdownOpen)return;const items=Array.isArray(data.results)?data.results:[];const candidates=[];for(const item of items){const artist=String(item.artistName||"").trim(),track=String(item.trackName||"").trim();if(artist)candidates.push(artist);if(track&&artist)candidates.push(track+" "+artist);else if(track)candidates.push(track);}musicSuggestions=[...new Set(candidates)].slice(0,8);renderRecentSearches(el.searchInput.value);}).catch(()=>{}).finally(()=>{clearTimeout(timeout);if(musicCatalogController===controller)musicCatalogController=null;});}
function requestYoutubeSuggestions(query){const clean=String(query||"").trim();const token=++suggestionRequestToken;if(suggestionTimer)clearTimeout(suggestionTimer);if(suggestionScript){suggestionScript.remove();suggestionScript=null;}if(musicCatalogController){musicCatalogController.abort();musicCatalogController=null;}youtubeSuggestions=[];musicSuggestions=[];if(!clean){renderRecentSearches(clean);return;}renderRecentSearches(clean);suggestionTimer=setTimeout(()=>{requestMusicCatalogSuggestions(clean,token);const url=new URL("https://suggestqueries.google.com/complete/search");url.searchParams.set("client","youtube");url.searchParams.set("ds","yt");url.searchParams.set("hl","ko");url.searchParams.set("gl","KR");url.searchParams.set("q",clean);const googleRoot=window.google||(window.google={});const autocomplete=googleRoot.ac||(googleRoot.ac={});if(!suggestionHandlerInstalled){suggestionOriginalHandler=autocomplete.h;suggestionHandlerOwner=autocomplete;suggestionHandlerInstalled=true;}let finished=false;const finish=()=>{if(finished)return;finished=true;if(token===suggestionRequestToken&&autocomplete.h===receive){if(suggestionOriginalHandler===undefined)delete autocomplete.h;else autocomplete.h=suggestionOriginalHandler;suggestionHandlerInstalled=false;suggestionOriginalHandler=null;suggestionHandlerOwner=null;}if(suggestionScript){suggestionScript.remove();suggestionScript=null;}};const receive=data=>{if(token!==suggestionRequestToken||String(data?.[0]||"").trim().toLocaleLowerCase()!==clean.toLocaleLowerCase())return;const values=Array.isArray(data?.[1])?data[1].map(item=>Array.isArray(item)?item[0]:item).filter(item=>typeof item==="string"&&item.trim()):[];youtubeSuggestions=[...new Set(values)].slice(0,8);finish();renderRecentSearches(el.searchInput.value);};autocomplete.h=receive;const script=document.createElement("script");suggestionScript=script;script.src=url.toString();script.async=true;script.onerror=finish;script.onload=()=>setTimeout(()=>{if(token===suggestionRequestToken)finish();},80);document.head.appendChild(script);setTimeout(()=>{if(token===suggestionRequestToken)finish();},3500);},240);}
function showRecentSearches(){searchDropdownOpen=true;renderRecentSearches(el.searchInput.value);}
function hideRecentSearches(){searchDropdownOpen=false;suggestionRequestToken++;if(suggestionTimer){clearTimeout(suggestionTimer);suggestionTimer=null;}if(suggestionScript){suggestionScript.remove();suggestionScript=null;}if(musicCatalogController){musicCatalogController.abort();musicCatalogController=null;}if(suggestionHandlerInstalled&&suggestionHandlerOwner){if(suggestionOriginalHandler===undefined)delete suggestionHandlerOwner.h;else suggestionHandlerOwner.h=suggestionOriginalHandler;suggestionHandlerInstalled=false;suggestionOriginalHandler=null;suggestionHandlerOwner=null;}const panel=document.getElementById("recentSearches");if(panel)panel.hidden=true;activeSearchRow=-1;}
function updateConnectionStatus(){const ready=Boolean(apiKey);el.connectionStatus.classList.toggle("ready",ready);el.connectionStatus.innerHTML=ready?"<i></i> 검색 연결됨":"<i></i> API 미설정";}
function showToast(message){let toast=document.querySelector(".toast");if(!toast){toast=document.createElement("div");toast.className="toast";toast.setAttribute("role","status");document.body.appendChild(toast);}toast.textContent=message;toast.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove("show"),2600);}
function setApiKeyError(message=""){const text=typeof message==="string"?message:"";el.apiKeyError.textContent=text;el.apiKeyError.hidden=!text;el.apiKeyInput.setAttribute("aria-invalid",text?"true":"false");}
function getApiKeyProblemMessage(error){if(!error?.apiKeyProblem)return "";const message=String(error?.message||"");if(/keyInvalid|keyExpired/i.test(message))return "잘못된 API 키입니다.";if(/accessNotConfigured/i.test(message))return "YouTube Data API v3가 활성화되어 있지 않습니다. Google Cloud에서 API를 사용 설정해 주세요.";if(/referer|referrer|API_KEY_HTTP_REFERRER_BLOCKED/i.test(message))return "이 API 키에는 현재 Music 사이트 주소가 허용되지 않았습니다. Google Cloud의 웹사이트 제한에 https://kanghuijun000.github.io/* 를 추가해 주세요.";return "YouTube API 키를 확인해 주세요."; }
function openSettings(errorMessage=""){el.apiKeyInput.value=apiKey;setApiKeyError(typeof errorMessage==="string"?errorMessage:"");if(!el.settingsDialog.open)el.settingsDialog.showModal();}
function setLoading(loading){el.searchButton.disabled=loading;el.searchButton.innerHTML=loading?'<span>검색 중…</span>':'<span>검색</span><svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';}
function showMessage(title,description,kind="empty"){el.resultsList.replaceChildren();el.messageState.hidden=false;el.messageState.replaceChildren();const heading=document.createElement("h3"),paragraph=document.createElement("p"),art=document.createElement("div");heading.textContent=title;paragraph.textContent=description;art.className="empty-art";art.innerHTML=kind==="empty"?'<span class="disc"></span><span class="disc-hole"></span><span class="note">♪</span>':'<span class="note">!</span>';el.messageState.append(art,heading,paragraph);}
function formatTime(seconds){if(!Number.isFinite(seconds)||seconds<0)return"0:00";const n=Math.floor(seconds);return Math.floor(n/60)+":"+String(n%60).padStart(2,"0");}
function isCreditMetadata(value){
 const text=String(value||"").replace(/^[\s\u200B\uFEFF]+/,"").trim();
 if(!text)return false;
 return /^(?:词|曲|词曲|作词|作曲|编曲|作词作曲|作词人|作曲人|编曲人|制作人|制作|演唱|出品|监制|录音|混音|母带|lyrics?|music|written\s+by|composed\s+by|arranged\s+by|produced\s+by|songwriter|composer|arranger|producer|작사|작곡|작사·작곡|작사작곡|편곡|프로듀서|제작|노래|가수)\s*[:：]/i.test(text);
}
function parseLrc(source){
 const lines=[];
 for(const raw of String(source||"").split(/\r?\n/)){
  // LRC permits several timestamps on one lyric line, e.g. [00:12.30][00:42.10]same text.
  const stamps=[...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
  if(!stamps.length)continue;
  const text=raw.slice(stamps[stamps.length-1].index+stamps[stamps.length-1][0].length).trim();
  if(!text||isCreditMetadata(text))continue;
  for(const stamp of stamps){
   const fraction=(stamp[3]||"0").padEnd(3,"0");
   const time=Number(stamp[1])*60+Number(stamp[2])+Number(fraction)/1000;
   if(Number.isFinite(time))lines.push({time,text,words:[]});
  }
 }
 return lines.sort((a,b)=>a.time-b.time);
}
function parseQrc(source){
 if(!source)return [];
 let body=String(source);
 // Better Lyrics returns QQ QRC inside a QrcInfos XML envelope.
 // Parse the envelope first; use a conservative attribute fallback if XML parsing fails.
 if(typeof DOMParser!=="undefined"){
  const doc=new DOMParser().parseFromString(body,"application/xml");
  if(!doc.querySelector("parsererror")){
   const nodes=[...doc.getElementsByTagName("*")];
   const lyricNode=nodes.find(node=>String(node.localName||node.nodeName).toLowerCase()==="lyric_1")
    ||nodes.find(node=>node.hasAttribute("LyricContent"));
   if(lyricNode)body=lyricNode.getAttribute("LyricContent")||lyricNode.textContent||"";
  }
 }
 if(body===String(source)){
  const match=body.match(/LyricContent\s*=\s*"([\s\S]*?)"(?=\s+[A-Za-z_][\w:.-]*\s*=|\s*\/>)/i);
  if(match)body=match[1];
 }
 body=body.replace(/&quot;/g,'"').replace(/&amp;/g,"&").replace(/&#10;/g,"\n").replace(/&#13;/g,"")
  .replace(/&lt;/g,"<").replace(/&gt;/g,">");
 const output=[];
 for(const raw of body.split(/\r?\n/)){
  const line=raw.trim();
  const header=line.match(/^\[(\d+),(\d+)\]/);
  if(!header)continue;
  const rest=line.slice(header[0].length),words=[];
  let textStart=0;
  for(const token of rest.matchAll(/\((\d+),(\d+)\)/g)){
   const text=rest.slice(textStart,token.index);
   if(text)words.push({text,start:Number(token[1])/1000,end:(Number(token[1])+Number(token[2]))/1000});
   textStart=token.index+token[0].length;
  }
  const tail=rest.slice(textStart);
  if(tail)words.push({text:tail,start:NaN,end:NaN});
  const cleanText=words.map(word=>word.text).join("").replace(/\s+/g," ").trim();
  if(!cleanText||isCreditMetadata(cleanText))continue;
  if(/^(lyrics by|composed by|arranged by|producer|작사|작곡|편곡|제작|作词|作曲|编曲|制作人)[:：]/i.test(cleanText))continue;
  const timedWords=words.filter(word=>Number.isFinite(word.start));
  output.push({time:Number(header[1])/1000,text:cleanText,words:timedWords});
 }
 return output.filter(line=>Number.isFinite(line.time)).sort((a,b)=>a.time-b.time);
}
function parseEnhancedLrc(source){
 const output=[];
 for(const raw of String(source||"").split(/\r?\n/)){
  const lineMatch=raw.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
  if(!lineMatch)continue;
  const base=Number(lineMatch[1])*60+Number(lineMatch[2])+Number((lineMatch[3]||"0").padEnd(3,"0"))/1000;
  const content=lineMatch[4]||"";
  const token=/<(\d{1,2}:\d{2}(?:\.\d{1,3})?)>/g;
  const matches=[...content.matchAll(token)];
  if(!matches.length)continue;
  const words=[];
  matches.forEach((match,index)=>{
   const start=parseTimedTextTime(match[1]);
   const end=matches[index+1]?parseTimedTextTime(matches[index+1][1]):NaN;
   const text=content.slice(match.index+match[0].length,matches[index+1]?.index??content.length);
   if(Number.isFinite(start)&&text)words.push({start,end,text});
  });
  const text=words.map(word=>word.text).join("");
  if(words.length&&!isCreditMetadata(text))output.push({time:base,text,words});
 }
 return output.sort((a,b)=>a.time-b.time);
}
function parseTimedTextTime(value){
 if(value===null||value===undefined||value==="")return NaN;
 const input=String(value).trim();
 const offset=input.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(h|m|s|ms)$/i);
 if(offset){const amount=Number(offset[1]),unit=offset[2].toLowerCase();return amount*(unit==="h"?3600:unit==="m"?60:unit==="ms"?.001:1);}
 const parts=input.split(":");
 let seconds=NaN;
 if(parts.length===3)seconds=Number(parts[0])*3600+Number(parts[1])*60+Number(parts[2]);
 else if(parts.length===2)seconds=Number(parts[0])*60+Number(parts[1]);
 else if(parts.length===1)seconds=Number(parts[0]);
 return Number.isFinite(seconds)?seconds:NaN;
}
function preserveTimedTextSpacing(sourceText,wordText){
 const source=String(sourceText||"").replace(/\s+/gu," ").trim();
 const words=String(wordText||"").replace(/\s+/gu," ").trim();
 if(!source)return words;
 const compact=value=>value.replace(/\s+/gu,"");
 return compact(source)&&compact(source)===compact(words)?source:words;
}
function parseTtml(source){
 if(!source||typeof DOMParser==="undefined")return [];
 const doc=new DOMParser().parseFromString(String(source),"application/xml");
 if(doc.querySelector("parsererror"))return [];
 const output=[];
 const paragraphs=[...doc.getElementsByTagName("*")].filter(node=>node.localName==="p");
 paragraphs.forEach(p=>{
  const words=[];
  const ownBegin=parseTimedTextTime(p.getAttribute("begin"));
  const parentBegin=Number.isFinite(ownBegin)?ownBegin:0;
  const collect=(node,ancestorBegin)=>{
   node.childNodes.forEach(child=>{
    if(child.nodeType===3||child.nodeType===4)return;
    if(child.nodeType!==1)return;
    const begin=parseTimedTextTime(child.getAttribute("begin"));
    const end=parseTimedTextTime(child.getAttribute("end"));
    const hasBegin=Number.isFinite(begin);
    // Some TTML feeds repeat media-absolute timestamps on both <p> and <span>;
    // others use span offsets relative to the parent. Avoid adding an absolute
    // timestamp twice, while still supporting relative child offsets.
    const absoluteBegin=ancestorBegin+(hasBegin&&begin<ancestorBegin?begin:hasBegin?begin-ancestorBegin:0);
    if(child.localName==="span"&&hasBegin){
     const text=child.textContent||"";
     const absoluteEnd=Number.isFinite(end)?ancestorBegin+(end<ancestorBegin?end:end-ancestorBegin):NaN;
     if(text.trim())words.push({start:absoluteBegin,end:absoluteEnd,text});
    }else collect(child,absoluteBegin);
   });
  };
  collect(p,parentBegin);
  const time=Number.isFinite(ownBegin)?ownBegin:(words[0]?.start??NaN);
  const fullText=(p.textContent||"").replace(/\s+/g," ").trim();
  if(Number.isFinite(time)&&words.length){
   const ordered=words.sort((a,b)=>a.start-b.start);
   const joinedText=ordered.map(word=>word.text).join("");
    // Preserve the original TTML paragraph's whitespace between timed spans.
    // Text nodes are intentionally excluded from word timing, but not from display text.
    output.push({time,text:preserveTimedTextSpacing(fullText,joinedText),words:ordered});
  }else if(Number.isFinite(time)&&fullText){
   output.push({time,text:fullText,words:[]});
  }
 });
 return output.sort((a,b)=>a.time-b.time);
}
function parseYamlText(value){
 const raw=String(value||"").trim();
 if(raw.startsWith("'")&&raw.endsWith("'"))return raw.slice(1,-1).replace(/''/g,"'");
 if(raw.startsWith('"')){try{return JSON.parse(raw);}catch(_){}}
 return raw;
}
function parseLyricsfile(source){
 if(!source||typeof source!=="string")return [];
 const output=[];let line=null,word=null,insideLines=false,insideWords=false;
 const saveWord=()=>{if(line&&word&&Number.isFinite(word.start)&&word.text!==undefined)line.words.push(word);word=null;};
 const saveLine=()=>{saveWord();if(line&&line.text!==undefined&&Number.isFinite(line.time))output.push(line);line=null;insideWords=false;};
 for(const raw of source.split(/\r?\n/)){
  const indent=(raw.match(/^ */)||[""])[0].length;
  const s=raw.trim();
  if(!s||s.startsWith("#"))continue;
  if(indent===0){insideLines=s==="lines:";continue;}
  if(!insideLines)continue;
  if(indent===2&&s.startsWith("- text:")){
   saveLine();line={text:parseYamlText(s.slice(7).trim()),time:NaN,end:NaN,words:[]};insideWords=false;continue;
  }
  if(!line)continue;
  if(indent===4&&s.startsWith("start_ms:")){line.time=providerMillisecondsToSeconds(s.slice(9).trim());continue;}
  if(indent===4&&s.startsWith("end_ms:")){line.end=providerMillisecondsToSeconds(s.slice(7).trim());continue;}
  if(indent===4&&s==="words:"){insideWords=true;continue;}
  if(indent===6&&insideWords&&s.startsWith("- text:")){
   saveWord();word={text:parseYamlText(s.slice(7).trim()),start:NaN,end:NaN};continue;
  }
  if(indent===8&&insideWords&&word&&s.startsWith("start_ms:")){word.start=providerMillisecondsToSeconds(s.slice(9).trim());continue;}
  if(indent===8&&insideWords&&word&&s.startsWith("end_ms:")){word.end=providerMillisecondsToSeconds(s.slice(7).trim());continue;}
 }
 saveLine();
 return output.filter(item=>Number.isFinite(item.time)&&!isCreditMetadata(item.text)).sort((a,b)=>a.time-b.time);
}
function showLyricsMessage(message){
 el.lyricsView.replaceChildren();
 const node=document.createElement("div");
 node.className="lyrics-placeholder";
 node.textContent=message;
 el.lyricsView.append(node);
 el.lyricsStatus.textContent="";
 el.lyricsStatus.hidden=true;
}
function setLyricsDiagnostics(entries,summary){
 const panel=document.getElementById("lyricsDiagnostics");
 const output=document.getElementById("lyricsDiagnosticsContent");
 if(!panel||!output)return;
 if(!entries||!entries.length){panel.hidden=true;return;}
 output.textContent=[summary||"가사 검색 진단",...entries.map(item=>"["+item.code+"] "+item.provider+(item.detail?" — "+item.detail:"")+(item.status?" (HTTP "+item.status+")":"")+(item.elapsed?" ("+item.elapsed+"ms)":""))].join("\n");
 panel.hidden=false;
 panel.open=false;
}
function renderLyrics(){
 if(lyricState.loading)return;
 if(!lyricState.lines.length){
  if(!currentVideoId){
   if(lyricState.lastIndex===-4)return;
   showLyricsMessage("곡을 선택하면 가사가 여기에 표시됩니다.");
   lyricState.lastIndex=-4;
   return;
  }
  if(lyricState.lastIndex===-2||lyricState.lastIndex===-3)return;
  el.lyricsView.replaceChildren();
  if(lyricState.plain){
   lyricState.plain.split(/\r?\n/).filter(Boolean).slice(0,100).forEach(text=>{
    const row=document.createElement("div");row.className="lyric-line plain";row.textContent=text;el.lyricsView.append(row);
   });
   el.lyricsStatus.textContent="일반 가사 · 실시간 싱크 미지원";
   el.lyricsStatus.hidden=false;
   lyricState.lastIndex=-2;
  }else {showLyricsMessage("동기화 가능한 가사가 없거나, 가사 정보를 불러오지 못했어요.");lyricState.lastIndex=-3;}
  return;
 }
 const timelineReady=contentTimelineReady;
 const current=timelineReady&&ytPlayer&&typeof ytPlayer.getCurrentTime==="function"?ytPlayer.getCurrentTime():0;
 const previousObservedTime=lyricLastObservedPlayerTime;
 const previousIndex=lyricState.lastIndex;
 const observedDelta=Number.isFinite(Number(current))&&Number.isFinite(Number(previousObservedTime))?Number(current)-Number(previousObservedTime):null;
 lyricLastObservedPlayerTime=Number.isFinite(Number(current))?Number(current):null;
 const relativeTime=Number(current)-(Number(lyricOffsetSeconds)||0)+getVideoManualAdvanceSeconds(currentVideoId);
 const lyricTime=getLyricTimelineTime(current,currentVideoId);
 let index=-1;
 if(timelineReady&&Number.isFinite(relativeTime)&&relativeTime>=0&&Number.isFinite(lyricTime)){for(let i=0;i<lyricState.lines.length;i++){if(getLyricLineStartTime(lyricState.lines[i],lyricState.lines,i)<=lyricTime+LYRIC_TIMELINE_EPSILON_SECONDS)index=i;else break;}}
 // 플레이어 타임라인이 준비되기 전에도 첫 세 줄을 미리 보여준다.
 const wordIndex=-1;
 if(index===lyricState.lastIndex&&wordIndex===lyricState.lastWordIndex&&(index>=0?timelineReady:lyricPreviewRenderedToken===lyricLoadToken))return;
 lyricState.lastIndex=index;lyricState.lastWordIndex=wordIndex;
  if(index<0)lyricPreviewRenderedToken=lyricLoadToken;
  if(!lyricFlowAudit.renderedRequests.includes(lyricLoadToken)){
   lyricFlowAudit.renderedRequests.push(lyricLoadToken);
   recordLyricFlow("first_lyrics_rendered_for_request",{requestId:lyricLoadToken,firstLineTime:finiteTimestampSeconds(lyricState.lines[0]?.time),currentLineIndex:index,timelineReady,playerTime:Number(current)||0});
  }
 el.lyricsView.replaceChildren();
 const start=index<0?0:Math.max(0,index-1),end=index<0?Math.min(lyricState.lines.length,3):Math.min(lyricState.lines.length,index+2);
 for(let i=start;i<end;i++){
  const item=lyricState.lines[i],row=document.createElement("div");
  const animateCurrent=i===index&&index>=0&&previousIndex>=0&&index===previousIndex+1&&timelineReady&&observedDelta!==null&&observedDelta>=-0.05&&observedDelta<=0.35;
  row.className="lyric-line"+(i===index?" current":"")+(i<index?" past":"")+(animateCurrent?" entering":"");
  if(animateCurrent)row.style.setProperty("--lyric-transition-ms",getLyricTransitionDuration(index)+"ms");
  row.textContent=item.text;
  el.lyricsView.append(row);
 }
 recordPlaybackAuditRender(index,current);
 el.lyricsStatus.textContent="";
}

function auditExpectedLineIndex(playerTime){
 return getLyricLineIndexAtPlayerTime(playerTime,currentVideoId);
}
function auditMedian(values){
 const sorted=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);
 if(!sorted.length)return null;
 const mid=Math.floor(sorted.length/2);
 return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
function auditSetStatus(message){if(el.auditStatus)el.auditStatus.textContent=String(message||"");}
function resetPlaybackAudit(){
 if(playbackAuditTimer){clearInterval(playbackAuditTimer);playbackAuditTimer=null;}
 Object.assign(playbackAudit,{active:false,videoId:currentVideoId,samples:0,missingTicks:0,mismatchTicks:0,transitions:[],marks:[],lastRenderedIndex:-1,lastUiUpdate:0,startedAt:0,invalid:[]});
 if(el.auditStartButton){el.auditStartButton.textContent="검증 시작";el.auditStartButton.disabled=!currentVideoId;}
 if(el.auditMarkButton)el.auditMarkButton.disabled=true;
 if(el.auditCopyButton)el.auditCopyButton.disabled=true;
 auditSetStatus(currentVideoId?"재생 후 검증을 시작하면 가사 표시와 타임스탬프를 측정합니다.":"곡을 선택하면 검증할 수 있습니다.");
}
function restoreTimedLineSpacing(lines,plainText){
 if(!Array.isArray(lines)||!lines.length||typeof plainText!=="string"||!plainText.trim())return lines;
 const source=plainText.replace(/\r/g,"").trim();
 let compact="",positions=[];
 for(let i=0;i<source.length;i++){
  if(!/\s/u.test(source[i])){compact+=source[i];positions.push(i);}
 }
 if(compact.length<12)return lines;
 let cursor=0,eligibleChars=0,matchedChars=0,eligibleLines=0,matchedLines=0;
 const output=lines.map(line=>{
  const original=String(line?.text||"");
  if(!/[가-힣]/u.test(original)||/\s/u.test(original))return line;
  const key=original.replace(/\s+/gu,"");
  if(!key)return line;
  eligibleChars+=key.length;eligibleLines++;
  const at=compact.indexOf(key,cursor);
  if(at<0)return line;
  const start=positions[at],end=positions[at+key.length-1]+1;
  const restored=source.slice(start,end).trim();
  if(!restored||restored.replace(/\s+/gu,"")!==key)return line;
  cursor=at+key.length;matchedChars+=key.length;matchedLines++;
  return {...line,text:restored};
 });
 if(!eligibleChars||matchedChars/eligibleChars<0.85||matchedLines<Math.min(2,eligibleLines))return lines;
 return output;
}
function normalizeTimedLyricsSpacing(lines,plainText){
 const source=Array.isArray(lines)?lines:[];
 const restored=restoreTimedLineSpacing(source,plainText);
 const unspacedLongKorean=restored.filter(item=>{
  const value=String(item?.text||"");
  return /[가-힣]/u.test(value)&&!/\s/u.test(value)&&value.replace(/[^가-힣]/gu,"").length>=8;
 }).length;
 const unsafe=unspacedLongKorean>=2;
 return {lines:unsafe?[]:restored,restored:restored!==source,unsafe};
}

function auditValidateLoadedLyrics(){
 const lines=lyricState.lines,problems=[];
 if(!lines.length)problems.push(lyricState.plain?"동기화 가사가 없고 일반 가사만 있습니다.":"표시할 가사가 없습니다.");
 if(lines.length){
  if(lines.length<2)problems.push("가사 줄이 2개 미만입니다.");
  if(lines.some(line=>!Number.isFinite(finiteTimestampSeconds(line.time))||finiteTimestampSeconds(line.time)<0))problems.push("잘못된 타임스탬프가 있습니다.");
  if(lines.some((line,index)=>index>0&&finiteTimestampSeconds(line.time)<finiteTimestampSeconds(lines[index-1].time)))problems.push("타임스탬프 순서가 뒤섞였습니다.");
  if(new Set(lines.map(line=>Math.round(finiteTimestampSeconds(line.time)*100))).size<2)problems.push("서로 다른 타임스탬프가 2개 미만입니다.");
  const duration=Number(ytPlayer?.getDuration?.())||Number(selectedVideoDuration)||0;
  if(duration&&lines.some(line=>finiteTimestampSeconds(line.time)>duration+90))problems.push("영상 길이보다 지나치게 늦은 가사 타임스탬프가 있습니다.");
  if(lines.some(line=>!String(line.text||"").trim()))problems.push("내용이 비어 있는 가사 줄이 있습니다.");
  const spacingCheck=normalizeTimedLyricsSpacing(lines,lyricState.plain||"");
  if(spacingCheck.unsafe)problems.push("한국어 가사 띄어쓰기를 검증할 수 없습니다.");
  else if((spacingCheck.lines||[]).length===lines.length&&spacingCheck.lines.some((line,index)=>String(line.text||"")!==String(lines[index].text||"")))problems.push("띄어쓰기 복구 결과가 실제 화면 가사에 반영되지 않았습니다.");
 }
 return problems;
}
function recordPlaybackAuditRender(index,playerTime){
 if(!playbackAudit.active||playbackAudit.videoId!==currentVideoId||index<0||index===playbackAudit.lastRenderedIndex)return;
 const line=lyricState.lines[index];if(!line)return;
 const scheduledPlayerTime=getLyricPlayerTimeForLine(line,lyricState.lines,index,currentVideoId);
 if(!Number.isFinite(scheduledPlayerTime)||!Number.isFinite(Number(playerTime)))return;
 const uiDelayMs=Math.round((Number(playerTime)-scheduledPlayerTime)*1000);
 playbackAudit.transitions.push({lineIndex:index,playerTime:Number(Number(playerTime).toFixed(3)),scheduledPlayerTime:Number(scheduledPlayerTime.toFixed(3)),uiDelayMs});
 if(playbackAudit.transitions.length>120)playbackAudit.transitions.shift();
 playbackAudit.lastRenderedIndex=index;
}
function samplePlaybackAudit(){
 if(!playbackAudit.active||playbackAudit.videoId!==currentVideoId||!ytPlayer||!contentTimelineReady)return;
 let state,current;try{state=ytPlayer.getPlayerState();current=Number(ytPlayer.getCurrentTime());}catch(_){return;}
 if(state!==YT.PlayerState.PLAYING||!Number.isFinite(current))return;
 playbackAudit.samples++;
 if(!lyricState.lines.length)playbackAudit.missingTicks++;
 else{
  const expected=auditExpectedLineIndex(current),rendered=lyricState.lastIndex;
  const currentNode=el.lyricsView?.querySelector(".lyric-line.current");
  const displayedText=String(currentNode?.textContent||"").trim();
  const expectedText=expected>=0?String(lyricState.lines[expected]?.text||"").trim():"";
  if(expected>=0&&(!currentNode||rendered!==expected||displayedText!==expectedText))playbackAudit.mismatchTicks++;
 }
 if(el.auditMarkButton)el.auditMarkButton.disabled=lyricState.lastIndex<0||!lyricState.lines.length;
 if(Date.now()-playbackAudit.lastUiUpdate>1000){
  playbackAudit.lastUiUpdate=Date.now();
  const median=auditMedian(playbackAudit.transitions.map(item=>item.uiDelayMs));
  auditSetStatus("측정 "+playbackAudit.samples+"회 · 화면 누락 "+playbackAudit.missingTicks+"회 · 표시 불일치 "+playbackAudit.mismatchTicks+"회"+
   (median===null?"":" · 화면 전환 지연 중앙값 "+Math.round(median)+"ms")+
   (playbackAudit.marks.length?" · 실제 발음 표시 "+playbackAudit.marks.length+"회":""));
 }
}
function getPlaybackAuditReport(){
 const delays=playbackAudit.transitions.map(item=>item.uiDelayMs),vocalOffsets=playbackAudit.marks.map(item=>item.offsetMs);
 return {generatedAt:new Date().toISOString(),videoId:currentVideoId,videoTitle:String(el.nowTitle?.textContent||""),videoChannel:String(el.nowChannel?.textContent||""),
  lyricTrack:currentLyricsTrack?{title:currentLyricsTrack.title,artist:currentLyricsTrack.artist,duration:currentLyricsTrack.duration,source:currentLyricsTrack.source,upstreamProvider:currentLyricsTrack.upstreamProvider}:null,lyricFlow:{events:lyricFlowAudit.videoId===currentVideoId?lyricFlowAudit.events.slice():[],startedAt:lyricFlowAudit.startedAt||null},
   
  timingBasis:lyricTimingBasis,lyricOffsetSeconds,
  videoManualAdvanceSeconds:getVideoManualAdvanceSeconds(currentVideoId),firstLineCalibrationSeconds:getVideoFirstLineCalibrationSeconds(currentVideoId),lyricLeadSeconds:LYRIC_LEAD_SECONDS,
  effectiveAppOffsetSeconds:Number(getLyricTimelineOffsetSeconds(currentVideoId).toFixed(3)),
  syncedLineCount:lyricState.lines.length,plainLyricPresent:Boolean(String(lyricState.plain||"").trim()),
  wordTimingEvidence:getLyricWordTimingEvidence(lyricState.lines,5),
  playerState:ytPlayer?.getPlayerState?.()??null,playerTime:Number(ytPlayer?.getCurrentTime?.()||0),samples:playbackAudit.samples,
  missingTicks:playbackAudit.missingTicks,mismatchTicks:playbackAudit.mismatchTicks,uiTransitionCount:playbackAudit.transitions.length,
  medianUiDelayMs:auditMedian(delays),userMarkedVocalStarts:playbackAudit.marks.length,medianUserMarkedOffsetMs:auditMedian(vocalOffsets),
  vocalMarks:playbackAudit.marks.slice(-30),transitions:playbackAudit.transitions.slice(-60),staticValidation:auditValidateLoadedLyrics(),
  limitations:["화면 전환 지연은 플레이어 타임라인과 DOM 표시의 차이이며 실제 보컬과 가사 내용의 일치 증명은 아닙니다.",
   "실제 보컬 시작 표시는 사용자가 들리는 순간 버튼을 누른 기록이며 사람의 반응 지연이 포함됩니다.",
   "YouTube iframe 오디오는 교차 출처로 보호되어 앱이 음성 파형을 직접 분석하지 않습니다."]};
}

async function puterAIAlternateSearch(track,artist,channel,duration,normalize,isGood,requestId){
 if(!window.puter?.ai?.chat)return null;
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),4600);
 try{
  const prompt="Identify this exact music track using web search. Return ONLY compact JSON with track, artists array, aliases array. Do not provide lyrics. Prefer original studio recording, not covers. Track: "+track+". Artist: "+(artist||"unknown")+". Channel: "+(channel||"unknown")+". Duration seconds: "+duration+". Return at most 2 title aliases and 3 artist spellings. If uncertain, return empty arrays.";
  const result=await window.puter.ai.chat(prompt,{model:"openai/gpt-5.4-nano",tools:[{type:"web_search"}],max_tokens:160,temperature:0,signal:controller.signal});
  if(requestId!==lyricLoadToken)return null;
  const content=typeof result==="string"?result:(result?.message?.content||result?.text||"");
  const match=String(content).match(/\{[\s\S]*\}/);
  if(!match)return null;
  const data=JSON.parse(match[0]);
  const tracks=[track,...(Array.isArray(data.aliases)?data.aliases:[]),...(data.track?[data.track]:[])].filter(x=>typeof x==="string"&&x.trim()).slice(0,4);
  const artists=[artist,...(Array.isArray(data.artists)?data.artists:[])].filter(x=>typeof x==="string"&&x.trim()).slice(0,4);
  const candidates=[];
  for(const name of tracks)for(const singer of (artists.length?artists:[""])){
   const url=new URL(LYRIC_API+"/search");url.searchParams.set("track_name",name);if(singer)url.searchParams.set("artist_name",singer);
   candidates.push((async()=>{const response=await fetch(url,{headers:{"X-User-Agent":"Music/1.0 (https://kanghuijun000.github.io/)"},signal:controller.signal});if(!response.ok)throw new Error("Provider unavailable");const list=await response.json();if(!Array.isArray(list))return null;return list.map(item=>item&&(item.syncedLyrics||item.plainLyrics||item.lyricsfile)?isGood(item,artists,tracks):null)
    .filter(Boolean).sort((a,b)=>(Number(b._score)||0)-(Number(a._score)||0))[0]||null;})());
  }
  try{return await Promise.any(candidates.map(job=>job.then(item=>{if(!item)throw new Error("No verified match");return item;})));}catch(_){return null;}
 }catch(error){console.warn("Puter AI fallback unavailable:",error?.message||error);return null;}
 finally{clearTimeout(timeout);}
}
async function loadLyrics(video,usePuter=false,identifiedTrack=null){
 const requestId=++lyricLoadToken;recordLyricFlow("lyrics_search_started",{requestId,identifiedSearch:Boolean(identifiedTrack),usePuter:Boolean(usePuter)});
  
 if(lyricAbortController)lyricAbortController.abort(new Error("다른 곡으로 전환했어요."));
 if(lyricFallbackAbortController)lyricFallbackAbortController.abort(new Error("다른 곡으로 전환했어요."));
 lyricFallbackAbortController=null;
 const requestController=new AbortController();
 lyricAbortController=requestController;
 const lyricSignal=requestController.signal;
 const diagnostics=[];
 const candidates=[];
 let resolvedUnisonSharedLyrics=null;
 const applyResolvedUnisonSharedLyrics=()=>{
  const item=resolvedUnisonSharedLyrics;
  if(!item||requestId!==lyricLoadToken||currentVideoId!==video.id||lyricState.lines.length)return false;
  const active=currentLyricsTrack;
  if(!active?.title||!active?.artist)return false;
  if(trackSimilarity(active.title,item.trackName)<0.92||!artistIdentityMatches(active.artist,item.artistName,0.82))return false;
  const activeDuration=Number(active.duration)||0,itemDuration=Number(item.duration)||0;
  if(activeDuration&&itemDuration&&Math.abs(activeDuration-itemDuration)>Math.max(15,itemDuration*0.12))return false;
  lyricState.lines=item.lines.map(line=>({...line}));
  lyricState.wordSynced=Boolean(item.wordSynced);
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;
  lyricTimingBasis="catalog";
  setLyricsStatus("다른 영상에서 확보한 싱크 가사를 확인해 적용했어요.");
  recordLyricFlow("cross_video_synced_lyrics_applied",{track:item.trackName,artist:item.artistName,lineCount:item.lines.length,sourceVideoId:item.sourceVideoId||""});
  resolvedUnisonSharedLyrics=null;
  renderLyrics();return true;
 };
 let notifyFirstVerifiedCandidate;
 let firstVerifiedCandidateNotified=false;
 const firstVerifiedCandidate=new Promise(resolve=>{notifyFirstVerifiedCandidate=resolve;});
 const startedAt=Date.now();
 const identity=getLyricsIdentity(video,identifiedTrack);
 const track=identity.title;
 const artist=identity.artist;
 const channel=identity.channel;
 const normalize=value=>String(value||"").toLocaleLowerCase().normalize("NFKC")
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\b(official|lyrics?|audio|video|visuali[sz]er|mv|topic|4k|hd|remaster(?:ed)?|live|performance)\b/gi," ")
  .replace(/(?:ㅣ|\|)\s*(?:가사|lyrics?).*$/i," ")
  .replace(/(?:\/|·|-)\s*(?:가사|lyrics?).*$/i," ")
  .replace(/가사|뮤직비디오|뮤비|공식영상|오디오|라이브|리마스터/gi," ")
  .replace(/[^\p{L}\p{N}]+/gu," ").trim();
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const record=(provider,code,detail="",elapsed=0,status="")=>{
  const cleanDetail=String(detail||"").replace(/\s+/g," ").slice(0,220);
  const existing=diagnostics.find(item=>item.provider===provider&&item.code===code&&item.detail===cleanDetail&&item.status===status);
  if(existing){existing.count=(existing.count||1)+1;existing.elapsed=Math.max(existing.elapsed||0,elapsed||0);return;}
  diagnostics.push({provider,code,detail:cleanDetail,elapsed,status,count:1});
 };
 const showDiagnostics=(summary)=>{
  const panel=document.getElementById("lyricsDiagnostics");
  const output=document.getElementById("lyricsDiagnosticsContent");
  if(!panel||!output)return;
  output.replaceChildren();
  const intro=document.createElement("div");
  intro.className="diagnostic-summary";
  intro.textContent=summary||"가사 검색이 완료되지 않았습니다.";
  output.append(intro);
  diagnostics.forEach(d=>{
   const row=document.createElement("div");
   row.className="diagnostic-row";
   const codeButton=document.createElement("button");
   codeButton.type="button";
   codeButton.className="diagnostic-code";
   codeButton.textContent="["+d.code+"]";
   codeButton.title="클릭해서 오류 코드 복사";
   codeButton.setAttribute("aria-label",d.code+" 오류 코드 복사");
   codeButton.dataset.copyDiagnosticCode=d.code;
   const detail=document.createElement("span");
   const suffix=[d.status?"HTTP "+d.status:"",d.elapsed?d.elapsed+"ms":""].filter(Boolean).join(" · ");
   detail.textContent=d.provider+(d.count>1?" ×"+d.count:"")+(d.detail?" — "+d.detail:"")+(suffix?" ("+suffix+")":"");
   row.append(codeButton,detail);
   output.append(row);
  });
  output.onclick=async event=>{
   const button=event.target.closest("button[data-copy-diagnostic-code]");
   if(!button||!output.contains(button))return;
   const code=button.dataset.copyDiagnosticCode;
   try{
    if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(code);
    else{
     const field=document.createElement("textarea");
     field.value=code;field.setAttribute("readonly","");
     field.style.position="fixed";field.style.opacity="0";
     document.body.append(field);field.select();
     const copied=document.execCommand("copy");field.remove();
     if(!copied)throw new Error("copy failed");
    }
    button.textContent="복사됨";
    button.classList.add("copied");
    button.setAttribute("aria-label",code+" 복사 완료");
   }catch(_){
    button.textContent="복사 실패";
    button.setAttribute("aria-label",code+" 복사 실패");
   }
  };
  panel.hidden=false;
  panel.open=false;
 };
 const hideDiagnostics=()=>{
  const panel=document.getElementById("lyricsDiagnostics");
  if(panel)panel.hidden=true;
 };
 if(aiAssistButton)aiAssistButton.hidden=true;
 hideDiagnostics();
 const videoCached=identifiedTrack?null:(lyricCache.get(video.id)||readStoredLyric(video.id));
 const validVideoCache=videoCached&&videoLyricCacheMatches(videoCached,video)?videoCached:null;
 const cached=identifiedTrack?findIdentifiedLyricCache(video,identifiedTrack):
  (validVideoCache||findSharedLyricCache(video));
 const cachedPlain=String(cached?.plain||"").split(/\r?\n/).filter(line=>line.trim()&&!isCreditMetadata(line)).join("\n");
 const cachedLines=(cached?.lines||[]).filter(item=>item&&Number.isFinite(finiteTimestampSeconds(item.time))&&String(item.text||"").trim()&&!isCreditMetadata(item.text)).map(item=>({...item,time:finiteTimestampSeconds(item.time)}));
 const cacheSpacing=normalizeTimedLyricsSpacing(cachedLines,cachedPlain);
 const spacingRecoveredLines=cacheSpacing.lines;
 const cacheSpacingRecovered=cacheSpacing.restored;
 const cacheSpacingRepairFailed=Boolean(cached&&cacheSpacing.unsafe);
 if(cached&&hasUsableCachedLyrics(cached)&&!usePuter&&!cacheSpacingRepairFailed){
  lyricState.lines=spacingRecoveredLines;
  lyricState.plain=cachedPlain;
  if(cacheSpacingRecovered){
   cached.lines=spacingRecoveredLines;
   storeLyric(video.id,cached);
   for(const key of getSongLyricCacheKeys(video,cached))storeLyric(key,cached);
   recordLyricFlow("cached_lyrics_spacing_recovered",{requestId,track:cached.trackName||"",lineCount:spacingRecoveredLines.length});
  }
  lyricState.wordSynced=Boolean(cached.wordSynced);
  currentLyricsTrack={title:cached.trackName||"",artist:cached.artistName||"",duration:Number(cached.duration)||0};
  lyricTimingBasis=cached.timingBasis==="video"?"video":"catalog";
  lyricOffsetSeconds=lyricTimingBasis==="video"?0:lyricOffsetSeconds;
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.loading=false;
  renderLyrics();
  return;
 }
 if(cacheSpacingRepairFailed){
  recordLyricFlow("cached_lyrics_spacing_repair_failed",{requestId,track:cached.trackName||"",lineCount:cachedLines.length,plainHasHangulSpacing:/[가-힣].*\s.*[가-힣]/u.test(cachedPlain)});
  record("로컬 캐시","CACHE_SPACING_REPAIR_FAILED","저장된 한국어 싱크 가사의 띄어쓰기를 원문에서 복구하지 못해 제공처를 다시 검색합니다.");
 }else if(cached&&!usePuter){
  record("로컬 캐시","CACHE_EMPTY","저장된 항목에 표시 가능한 가사가 없어 새로 검색합니다.");
 }
 lyricState.loading=true;lyricState.lines=[];lyricState.plain="";recordLyricFlow("lyrics_search_loading",{requestId});
  
 lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.wordSynced=false;
 showLyricsMessage("곡 정보를 확인하고 여러 가사 제공처를 검색하고 있어요…");
 const headers={"X-User-Agent":"Music/1.1 (https://kanghuijun000.github.io/)"};
 const stripFeat=value=>String(value||"").replace(/\b(feat|ft|featuring|with)\b.*$/i,"").trim();
 function titleScore(value,extraTitles=[]){
  const got=normalize(value);
  if(!got)return 0;
  const choices=[...identity.titles,...extraTitles].map(normalize).filter(Boolean);
  let best=0;
  for(const wanted of choices){
   const a=stripFeat(got),b=stripFeat(wanted);
   const compactA=a.replace(/\s+/g,""),compactB=b.replace(/\s+/g,"");
   if(a===b||compactA===compactB){best=Math.max(best,100);continue;}
   if(a.startsWith(b+" ")||b.startsWith(a+" ")||compactA.startsWith(compactB)||compactB.startsWith(compactA)){best=Math.max(best,82);continue;}
   if(a.includes(b)||b.includes(a)){best=Math.max(best,65);continue;}
   const aw=new Set(a.split(" ")),bw=new Set(b.split(" "));
   const overlap=[...aw].filter(word=>bw.has(word)).length;
   best=Math.max(best,overlap/Math.max(aw.size,bw.size)*45);
  }
  return best;
 }
 function artistScore(value,extraArtists=[]){
  if(!identity.artistKnown&&!extraArtists.length)return 55;
  const got=normalize(value);
  const names=[identity.artist,...(identity.artistAliases||[]),...(identity.isTopic?[channel]:[]),...extraArtists].filter(Boolean).map(normalize);
  if(!got)return 50;
  if(names.some(name=>got===name))return 100;
  if(names.some(name=>got.includes(name)||name.includes(got)))return 75;
  return -35;
 }
 function durationScore(value){
  const got=Number(value)||0,want=Number(video.duration)||0;
  if(!got||!want)return 12;
  const diff=Math.abs(got-want);
  if(diff<=3)return 30;
  if(diff<=8)return 22;
  if(diff<=18)return 10;
  if(diff<=Math.max(30,want*.1))return -5;
  return -18;
 }
 function extractLines(item){
  if(Array.isArray(item?.ttmlLines)&&item.ttmlLines.length)return item.ttmlLines;
  if(typeof item?.ttml==="string"){const parsed=parseTtml(item.ttml);if(parsed.length)return parsed;}
  if(item?.lyricsfile){const parsed=parseLyricsfile(item.lyricsfile);if(parsed.length)return parsed;}
  if(item?.syncedLyrics){
   const enhanced=parseEnhancedLrc(item.syncedLyrics);
   if(enhanced.length)return enhanced;
   const lrc=parseLrc(item.syncedLyrics);
   if(lrc.length)return lrc;
  }
  return [];
 }
 function extractPlainText(value){
  if(typeof value!=="string")return "";
  const raw=value.replace(/\r/g,"").trim();
  if(!raw||/<\?xml|<tt\b|<div\b|<p\b|^\s*\{/i.test(raw))return "";
  const lines=raw.split("\n").map(line=>line.replace(/^\s*(?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/g,"").trim())
   .filter(line=>line&&!isCreditMetadata(line)&&!/^[\[(](?:ar|ti|al|by|length|re|ve|offset)\s*[:=]/i.test(line));
  const text=lines.join("\n");
  return lines.length>=2&&text.length>=12?text:"";
 }
 function validate(item,extraArtists=[],extraTitles=[],provider="가사 제공처"){
  if(!item){record(provider,"EMPTY_RESPONSE","응답 데이터가 비어 있습니다.");return null;}
  const evidence=item._providerQueryEvidence||null;
  const evidenceCacheHit=String(evidence?.cacheStatus||"").toUpperCase()==="HIT";
  const evidenceScore=Number(evidence?.score)||0;
  const evidenceDuration=Number(evidence?.duration)||0;
  const evidenceDurationMatches=evidenceDuration>0&&Number(video.duration)>0&&
   Math.abs(evidenceDuration-Number(video.duration))<=Math.max(5,Number(video.duration)*0.04);
  const evidenceTitle=String(evidence?.title||"").trim();
  const evidenceArtist=String(evidence?.artist||"").trim();
  const evidenceTrusted=Boolean(evidence&&evidenceTitle&&evidenceArtist&&evidenceDurationMatches&&
   (evidenceCacheHit||evidenceScore>=0.92)&&titleScore(evidenceTitle,extraTitles)>=100&&
   artistScore(evidenceArtist,extraArtists)>=90);
  const candidateTitle=String(item.trackName||item.title||item.song||(evidenceTrusted?evidenceTitle:""));
  const candidateArtist=String(item.artistName||item.artist||(evidenceTrusted?evidenceArtist:""));
  const candidateVersion=getTrackVersionKey(candidateTitle);
  if(candidateVersion!==(identity.versionKey||"")){
   item._rejectCode="MATCH_VERSION_MISMATCH";
   record(provider,item._rejectCode,"영상과 가사 후보의 음원 버전이 일치하지 않아 제외했습니다.");
   return null;
  }
  const title=titleScore(candidateTitle,extraTitles);
  const singer=artistScore(candidateArtist,extraArtists);
  const duration=durationScore(item.duration||(evidenceTrusted?evidenceDuration:0));
  const itemArtist=candidateArtist.trim();
  // Candidate artist metadata can support a match when the video identity is unknown,
  // but only together with a close duration and a strong title match.
  // A verified provider duration may differ from the video by up to 18s (intro/outro/edit).
  // Missing duration metadata must not count as a close match.
  const closeDuration=Number(item.duration)>0&&duration>=10;
  const exactVideoSource=(provider==="Unison"||provider==="LiriQo")&&item._sameVideoSource===true;
  const exactVideoIdentityWithoutArtist=exactVideoSource&&!itemArtist&&title===100&&closeDuration;
  const expectedTitles=[identity.title,...identity.titles,...extraTitles].map(normalize).filter(Boolean);
  const hasShortAmbiguousTitle=expectedTitles.some(value=>value.replace(/\s+/g,"").length<=2);
  const artistNames=[identity.artist,...(identity.artistAliases||[]),...(identity.isTopic?[channel]:[]),...extraArtists].filter(Boolean).map(normalize);
  const exactArtistMatch=Boolean(itemArtist)&&artistNames.some(name=>artistIdentityMatches(itemArtist,name,1));
  if(hasShortAmbiguousTitle){
   // Very short titles such as "인사" are shared by unrelated songs.
   // Do not accept fuzzy title/artist matches or missing duration metadata.
   if(title<100){item._rejectCode="AMBIGUOUS_TITLE_NOT_EXACT";record(provider,item._rejectCode,"짧고 중복되는 곡 제목은 완전 일치가 필요합니다.");return null;}
   if(!exactArtistMatch){item._rejectCode="AMBIGUOUS_ARTIST_NOT_EXACT";record(provider,item._rejectCode,"중복 제목 곡은 가수 이름까지 정확히 일치해야 합니다.");return null;}
   if(!closeDuration){item._rejectCode="AMBIGUOUS_DURATION_UNVERIFIED";record(provider,item._rejectCode,"중복 제목 곡은 재생시간도 확인해야 합니다.");return null;}
  }else{
   const strongArtistMatch=Boolean(itemArtist)&&(identity.artistKnown||extraArtists.length>0)&&singer>=75;
   const titleThreshold=strongArtistMatch&&closeDuration?78:90;
   if(title<titleThreshold){item._rejectCode="MATCH_TITLE_MISMATCH";record(provider,item._rejectCode,"제목 일치도 부족 ("+Math.round(title)+", 기준 "+titleThreshold+")");return null;}
   // Require artist context from the video/query, not the candidate alone.
   const verifiedArtistContext=identity.artistKnown||extraArtists.length>0||exactVideoSource;
   if(!verifiedArtistContext){
    item._rejectCode="MATCH_ARTIST_UNVERIFIED";record(provider,item._rejectCode,"영상 또는 검색어에서 가수를 확인할 수 없어 후보를 제외했습니다.");return null;
   }
   if((identity.artistKnown||extraArtists.length)&&(!itemArtist||singer<75)&&!exactVideoIdentityWithoutArtist){item._rejectCode="MATCH_ARTIST_MISMATCH";record(provider,item._rejectCode,"가수 정보 불일치 ("+Math.round(singer)+")");return null;}
  }
  const plain=String(item.plainLyrics||item.plain||"").split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!isCreditMetadata(line));
  let lines=extractLines(item).filter(line=>line&&Number.isFinite(finiteTimestampSeconds(line.time))&&finiteTimestampSeconds(line.time)>=0&&String(line.text||"").trim()&&!isCreditMetadata(line.text))
   .map((line,index)=>({...line,time:Number(line.time),_order:index}))
   .sort((a,b)=>a.time-b.time);
  const spacing=normalizeTimedLyricsSpacing(lines,plain.join("\n"));
  lines=spacing.lines;
  if(spacing.unsafe){
   record(provider,"KOREAN_SPACING_UNVERIFIED","띄어쓰기를 확인할 원문이 없어 잘못된 한국어 싱크 가사를 제외하고 일반 가사만 유지합니다.");
  }
  const songDuration=Number(item.duration)||Number(video.duration)||0;
  const distinctTimestampCount=new Set(lines.map(line=>Math.round(Number(line.time)*100))).size;
  const validLines=lines.length>=2&&distinctTimestampCount>=2&&(!songDuration||lines.every(line=>line.time<=songDuration+90));
  lines.forEach(line=>delete line._order);
  if(!validLines&&!plain.length){
   item._rejectCode=lines.length?"PARSE_TIMESTAMPS_INVALID":"PARSE_NO_LYRICS";
   record(provider,item._rejectCode,lines.length+"개 타임스탬프 행을 읽었지만 표시 조건을 통과하지 못했습니다.");
   return null;
  }
  const normalized={...item,trackName:candidateTitle,artistName:candidateArtist,
   duration:Number(item.duration)||(evidenceTrusted?evidenceDuration:0),
   ttmlLines:validLines?lines:[],plainLyrics:plain.join("\n")};
  const communityBonus=item.communityConfidence==="high"?12:item.communityConfidence==="medium"?6:0;
  const rawMatchConfidence=Number(item.matchConfidence)||0;
  const normalizedMatchConfidence=rawMatchConfidence>1?rawMatchConfidence/100:rawMatchConfidence;
  const matchBonus=Math.max(0,Math.min(1,normalizedMatchConfidence))*15;
  normalized._score=title+singer+duration+(validLines?45:0)+(validLines&&lines.some(line=>line.words?.length)?12:0)+communityBonus+matchBonus;
  normalized._synced=validLines;
  normalized._source=item._source||provider;
  record(provider,"CANDIDATE_ACCEPTED",(validLines?"동기화 "+lines.length+"줄":"일반 가사 "+plain.length+"줄")+" · 제목 "+Math.round(title)+" · 가수 "+Math.round(singer));
  return normalized;
 }
 async function fetchJson(url,customHeaders=headers,timeoutMs=8000,provider="가사 제공처"){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(Object.assign(new Error("요청 제한 시간 초과"),{code:"TIMEOUT"})),timeoutMs);
  const abortFromParent=()=>controller.abort(lyricSignal.reason||Object.assign(new Error("다른 곡으로 전환됨"),{code:"CANCELLED"}));
  if(lyricSignal.aborted)abortFromParent();else lyricSignal.addEventListener("abort",abortFromParent,{once:true});
  const began=Date.now();
  try{
   let response;
   try{response=await fetch(url,{headers:customHeaders,signal:controller.signal});}
   catch(error){
    if(controller.signal.aborted){
     const reason=controller.signal.reason||error;
     if(reason?.code==="CANCELLED")throw reason;
     throw Object.assign(new Error(reason?.message||"요청 시간이 초과됐습니다."),{code:reason?.code||"TIMEOUT",elapsed:Date.now()-began});
    }
    throw Object.assign(new Error(error?.message||"네트워크 또는 CORS 연결 실패"),{code:"NETWORK_OR_CORS",elapsed:Date.now()-began});
   }
   const text=await response.text();
   let data=null;
   if(text){try{data=JSON.parse(text);}catch(_){data=null;}}
   if(!response.ok){
    const status=response.status,rawRetry=response.headers.get("Retry-After");
    const retrySeconds=rawRetry!==null&&rawRetry.trim()!==""?Number(rawRetry):NaN;
    const retryDate=rawRetry!==null&&!Number.isFinite(retrySeconds)?Date.parse(rawRetry):NaN;
    const retryAfterMs=Number.isFinite(retrySeconds)?Math.max(1000,retrySeconds*1000):Number.isFinite(retryDate)?Math.max(1000,retryDate-Date.now()):30000;
    const detail=data?.message||data?.error||data?.hint||(text?text.slice(0,180):response.statusText);
    throw Object.assign(new Error("HTTP "+status+(detail?": "+detail:"")),{code:"HTTP_"+status,status,retryAfterMs,body:text.slice(0,240),headers:{provider:response.headers.get("X-Provider"),cache:response.headers.get("X-Cache-Status"),rateLimit:response.headers.get("X-RateLimit-Type"),remaining:response.headers.get("X-RateLimit-Remaining")}});
   }
   if(!data||typeof data!=="object")throw Object.assign(new Error("HTTP 200 응답이 JSON 형식이 아닙니다."),{code:"INVALID_JSON",status:response.status,body:text.slice(0,180)});
   return {data,headers:{provider:response.headers.get("X-Provider"),cache:response.headers.get("X-Cache-Status"),rateLimit:response.headers.get("X-RateLimit-Type"),remaining:response.headers.get("X-RateLimit-Remaining")},elapsed:Date.now()-began};
  }catch(error){
   // Provider-level handlers record failures once; avoid duplicate diagnostic rows here.
   if(error?.status===429&&provider.startsWith("Better Lyrics"))setBetterLyricsCooldown(Date.now()+(Number(error.retryAfterMs)||30000));
   if(error?.status===429&&provider==="LRCLIB")setLyricApiCooldown(Date.now()+(Number(error.retryAfterMs)||30000));
   throw error;
  }finally{clearTimeout(timer);lyricSignal.removeEventListener("abort",abortFromParent);}
 }
 function accept(provider,item,extraArtists=[],extraTitles=[]){
  if(requestId!==lyricLoadToken||lyricSignal.aborted)return null;
  const valid=validate(item,extraArtists,extraTitles,provider);
  if(valid){
   valid._source=provider;candidates.push(valid);
   const timingLines=Array.isArray(valid.ttmlLines)?valid.ttmlLines:[];
   const safeSeconds=value=>value===null||value===undefined||typeof value==="boolean"||
    (typeof value==="string"&&!value.trim())?null:
    Number.isFinite(Number(value))?Number(Number(value).toFixed(3)):null;
   recordLyricFlow("lyric_candidate_timing_evidence",{
    provider,trackName:valid.trackName||valid.title||"",artistName:valid.artistName||valid.artist||"",
    duration:Number(valid.duration)||0,score:Number(valid._score)||0,synced:Boolean(valid._synced),
    videoBound:Boolean(valid._videoBound),sameVideoSource:Boolean(valid._sameVideoSource),
    sourceVideoId:String(valid._unisonSourceVideoId||valid.sourceVideoId||""),
    upstreamProvider:String(valid._liriqoProvider||valid.upstreamProvider||""),lineCount:timingLines.length,
    firstLines:timingLines.slice(0,3).map((line,index)=>{
     const baseTime=finiteTimestampSeconds(line?.time);
     const effectiveTime=getLyricLineStartTime(line,timingLines,index);
     return {
      time:safeSeconds(baseTime),effectiveTime:safeSeconds(effectiveTime),
      wordAnchorDelta:safeSeconds(Number.isFinite(baseTime)&&Number.isFinite(effectiveTime)?effectiveTime-baseTime:null),
      textFingerprint:getLyricTextFingerprint(line?.text),
      textLength:String(line?.text||"").length,
      wordCount:Array.isArray(line?.words)?line.words.length:0,
      words:(Array.isArray(line?.words)?line.words:[]).slice(0,4).map(word=>({
       textFingerprint:getLyricTextFingerprint(word?.text),
       textLength:String(word?.text||"").length,
       start:safeSeconds(word?.start),
       end:safeSeconds(word?.end)
      }))
     };
    })
   });
   if(valid._synced&&Number(valid._score)>=220&&!firstVerifiedCandidateNotified){
    firstVerifiedCandidateNotified=true;recordLyricFlow("first_verified_synced_candidate",{requestId,provider,score:Number(valid._score)||0});
     
    notifyFirstVerifiedCandidate(valid);
   }
  }
  return valid;
 }
 const jobs=[];
 jobs.push((async()=>{
  const provider="Unison";
  try{
   let body=null,lookupMode="video",lookupArtist="",pendingSourceAlignment=null;
   const videoUrl=new URL("https://unison.boidu.dev/lyrics");
   videoUrl.searchParams.set("v",video.id);
   try{const result=await fetchJson(videoUrl,{},8000,provider+"/영상 ID");body=result.data;}
   catch(error){if(error?.code!=="HTTP_404")throw error;}
   if(!body?.success||!body?.data?.lyrics){
    const variants=identity.queries.filter(item=>item.artist).slice(0,5);
    for(const variant of variants){
     try{
      const songUrl=new URL("https://unison.boidu.dev/lyrics");
      songUrl.searchParams.set("song",variant.title);
      songUrl.searchParams.set("artist",variant.artist);
      const result=await fetchJson(songUrl,{},8000,provider+"/곡·가수 검색");
      if(result.data?.success&&result.data?.data?.lyrics){body=result.data;lookupMode="song";lookupArtist=variant.artist;break;}
     }catch(error){if(error?.code!=="HTTP_404"&&error?.code!=="CANCELLED")record(provider+"/곡·가수 검색",error?.code||"PROVIDER_ERROR",error?.message||"검색 실패",error?.elapsed||0,error?.status||"");}
    }
   }
   if(!body?.success||!body?.data?.lyrics){
    const variant=identity.queries.find(item=>item.artist);
    if(variant){
     for(const searchTerm of (identity.searchTerms||[variant.title]).slice(0,2)){
      if(lyricSignal.aborted)break;
      try{
       const searchUrl=new URL("https://unison.boidu.dev/lyrics/search");
       searchUrl.searchParams.set("q",searchTerm+" "+variant.artist);
       searchUrl.searchParams.set("limit","10");
       const searchResult=await fetchJson(searchUrl,{},7000,provider+"/후보 검색");
       const ranked=(Array.isArray(searchResult.data?.data)?searchResult.data.data:[])
        .filter(item=>{
         const score=Number(item.matchScore)||0,candidateTitle=String(item.song||""),candidateArtist=String(item.artist||"");
         const candidateDuration=Number(item.duration)||0,expectedDuration=Number(video.duration)||0;
         const durationMatches=!candidateDuration||!expectedDuration||Math.abs(candidateDuration-expectedDuration)<=Math.max(18,expectedDuration*0.12);
         return Boolean(item.videoId)&&score>=0.92&&titleScore(candidateTitle,identity.titles)>=90&&
          artistScore(candidateArtist,[variant.artist,...(identity.artistAliases||[])])>=90&&durationMatches;
        }).slice(0,3);
       for(const candidate of ranked){
        if(lyricSignal.aborted)break;
        try{
         const candidateUrl=new URL("https://unison.boidu.dev/lyrics");candidateUrl.searchParams.set("v",String(candidate.videoId));
         const candidateResult=await fetchJson(candidateUrl,{},7000,provider+"/후보 영상 조회");
         if(candidateResult.data?.success&&candidateResult.data?.data?.lyrics&&String(candidateResult.data.data.videoId||"")===String(candidate.videoId)){
          body=candidateResult.data;lookupMode="ranked-search";lookupArtist=variant.artist;break;
         }
        }catch(error){
         if(error?.code==="CANCELLED")throw error;
         if(error?.status!==404)record(provider+"/후보 영상 조회",error?.code||"PROVIDER_ERROR",error?.message||"후보 영상 조회 실패",error?.elapsed||0,error?.status||"");
        }
       }
       if(body?.success&&body?.data?.lyrics)break;
      }catch(error){
       if(error?.code==="CANCELLED")throw error;
       if(error?.status!==404)record(provider+"/후보 검색",error?.code||"PROVIDER_ERROR",error?.message||"후보 검색 실패",error?.elapsed||0,error?.status||"");
      }
     }
    }
   }
   if(!body?.success||!body?.data?.lyrics){
    record(provider,"UNISON_NOT_FOUND","현재 영상과 곡·가수 기준 검색에서 가사를 찾지 못했습니다.");
    return;
   }
   const data=body.data;
   const format=String(data.format||"").toLowerCase();
    const explicitlyUnsynced=format==="plain"||String(data.syncType||"").toLowerCase()==="plain";
    const parsedLines=explicitlyUnsynced?[]:format==="ttml"?parseTtml(data.lyrics):format==="lrc"?parseLrc(data.lyrics):[];
   const sourceVideoId=String(data.videoId||"");
   const sameVideo=Boolean(sourceVideoId)&&sourceVideoId===video.id;
   let normalizedOtherVideoLines=[];
   if(!sameVideo&&sourceVideoId&&parsedLines.length>1){
    const sourceArtist=String(data.artist||lookupArtist||(identity.artistKnown?artist:"")).trim();
    const referenceVideo={id:sourceVideoId,title:[data.song||track,sourceArtist].filter(Boolean).join(" - "),
     channelTitle:sourceArtist?sourceArtist+" - Topic":"",duration:Number(data.duration)||0};
    const sourceTiming=readTrackAnalysisCache()[sourceVideoId];
    const sourceMatch=sourceTiming?.status==="completed"?selectTrackStart(sourceTiming.tracks,referenceVideo):null;
    if(sourceMatch){
     const sourceOffset=getVideoLyricOffset(sourceVideoId,sourceMatch.timestamp);
     normalizedOtherVideoLines=normalizeVideoBoundLyricsToSongTimeline(parsedLines,sourceOffset);
    }else if(sourceArtist&&(data.song||track)){
     // Keep source timestamps pending until the source video's own intro offset is verified.
     pendingSourceAlignment={referenceVideo,sourceVideoId,lines:parsedLines.map(line=>({...line})),
      plain:String(data.lyrics||""),trackName:String(data.song||track),artistName:sourceArtist,
      duration:Number(data.duration)||0};
    }
   }
   const videoTimed=sameVideo&&parsedLines.length>1;
   const otherVideoAligned=!sameVideo&&normalizedOtherVideoLines.length>1;
   const otherVideoText=!videoTimed&&!otherVideoAligned;
   const usableLines=videoTimed?parsedLines:otherVideoAligned?normalizedOtherVideoLines:[];
   const fallbackText=format==="plain"?data.lyrics:parsedLines.map(line=>line.text).filter(Boolean).join("\n");
   const valid=accept(provider,{trackName:data.song||data.track||"",artistName:data.artist||"",duration:Number(data.duration)||0,
    syncedLyrics:videoTimed&&format==="lrc"?data.lyrics:"",plainLyrics:format==="plain"?data.lyrics:(otherVideoText?(fallbackText||extractPlainText(data.lyrics)):""),
    ttmlLines:usableLines,hasWordSync:usableLines.some(line=>line.words?.length),
    communityConfidence:data.confidence||"",_videoBound:videoTimed,_sameVideoSource:sameVideo,_unisonOtherVideo:otherVideoText,_unisonSourceVideoId:sourceVideoId},lookupArtist?[lookupArtist]:[],[data.song||track]);
   if(!valid)record(provider,"UNISON_RESULT_REJECTED","응답은 받았지만 제목·가수·가사 형식 검증에서 제외됐습니다.");
   else if(pendingSourceAlignment){
    const pending=pendingSourceAlignment;
    void resolveReferenceVideoSongOffset(pending.referenceVideo).then(sourceOffset=>{
     if(!Number.isFinite(sourceOffset))return;
     const normalizedLines=normalizeVideoBoundLyricsToSongTimeline(pending.lines,sourceOffset);
     const sharedItem={lines:normalizedLines,plain:extractPlainText(pending.plain)||fallbackText,
      wordSynced:normalizedLines.some(line=>Array.isArray(line.words)&&line.words.length>0),
      timingBasis:"catalog",source:"Unison cross-video synced lyrics",
      trackName:valid.trackName,artistName:valid.artistName,duration:pending.duration,
      videoMetadata:{id:video.id,title:video.title,channelTitle:video.channelTitle,duration:Number(video.duration)||0},
      sourceVideoId:pending.sourceVideoId};
     if(!hasUsableCachedLyrics(sharedItem))return;
     storeLyricsForVideo(video,sharedItem,true);
     resolvedUnisonSharedLyrics=sharedItem;
     applyResolvedUnisonSharedLyrics();
    }).catch(error=>console.warn("Cross-video synced lyric recovery failed:",error));
   }
  }catch(error){if(error?.code!=="CANCELLED"&&error?.status!==429&&error?.code!=="HTTP_404")record(provider,error?.code||"PROVIDER_ERROR",error?.message||"제공처 오류",error?.elapsed||0,error?.status||"");}
 })());
 jobs.push((async()=>{
  const provider="SyncLRC";
  // Try the exact endpoint first when the video metadata identifies the artist.
  if(identity.artistKnown){
   const variants=identity.queries.filter(item=>item.artist).slice(0,5);
   await Promise.all(variants.map(async variant=>{
    try{
     const url=new URL("https://api.synclrc.dev/lyrics");
     url.searchParams.set("track",variant.title);
     url.searchParams.set("artist",variant.artist);
     if(video.duration)url.searchParams.set("duration",String(video.duration));
     url.searchParams.set("type","karaoke");
     const {data}=await fetchJson(url,{},8000,provider);
     const timed=data.karaoke||data.synced||data.lyrics||"";
     const enhanced=parseEnhancedLrc(timed),lines=enhanced.length?enhanced:parseLrc(timed);
     const valid=accept(provider,{trackName:data.track||"",artistName:data.artist||"",
       duration:Number(data.duration)||0,syncedLyrics:timed,plainLyrics:data.plain||extractPlainText(timed),ttmlLines:lines,hasWordSync:enhanced.length>0},[variant.artist],[variant.title]);
     if(!valid)record(provider,"SYNCLRC_NO_MATCH","직접 조회 응답에 검증 가능한 가사가 없습니다.");
    }catch(error){if(error?.code!=="CANCELLED"&&error?.status!==429&&error?.code!=="HTTP_404")record(provider,error?.code||"PROVIDER_ERROR",error?.message||"제공처 오류",error?.elapsed||0,error?.status||"");}
   }));
  }
  // Search fallback also runs for known artists, with a strict artist match in that case.
  if(!candidates.some(item=>item._source===provider)){
   const queries=[...new Set([...(identity.searchTerms||[]),...identity.queries.map(item=>item.title)].filter(Boolean))].slice(0,6);
   for(const query of queries){
    if(lyricSignal.aborted)break;
    try{
     const searchTerm=normalize(query);
     if(!searchTerm)continue;
     const url=new URL("https://api.synclrc.dev/search");
     url.searchParams.set("q",searchTerm);
     url.searchParams.set("limit","10");
     const {data}=await fetchJson(url,{},8000,provider+"/곡 검색");
     const results=Array.isArray(data?.results)?data.results:[];
     const matches=results.filter(item=>{
      const title=titleScore(item.track||"",identity.titles);
      const candidateArtist=String(item.artist||"").trim();
      const artistMatches=identity.artistKnown?artistScore(candidateArtist,[identity.artist,...(identity.artistAliases||[])])>=75:Boolean(candidateArtist);
      const duration=Number(item.duration)||0,want=Number(video.duration)||0;
      const closeDuration=!duration||!want||Math.abs(duration-want)<=Math.max(20,want*0.12);
      return title>=78&&artistMatches&&closeDuration;
     }).sort((a,b)=>durationScore(b.duration)-durationScore(a.duration));
     for(const item of matches.slice(0,3)){
      const lyrics=item.lyrics||{};
      const timed=lyrics.karaoke||lyrics.synced||"";
      const enhanced=parseEnhancedLrc(timed),lines=enhanced.length?enhanced:parseLrc(timed);
      const valid=accept(provider,{trackName:item.track,artistName:item.artist,duration:Number(item.duration)||0,
       syncedLyrics:timed,plainLyrics:lyrics.plain||extractPlainText(timed),ttmlLines:lines,hasWordSync:enhanced.length>0},
       identity.artistKnown?[identity.artist,...(identity.artistAliases||[]) ]:(identity.queries.find(entry=>entry.artist)?.artist?[identity.queries.find(entry=>entry.artist).artist]:[]),identity.titles);
      if(valid)break;
     }
     if(candidates.some(item=>item._source===provider))break;
     if(!results.length)record(provider,"SYNCLRC_NO_RESULTS","검색어에 해당하는 곡이 없습니다.");
     else if(!matches.length)record(provider,"SYNCLRC_NO_MATCH","검색 결과는 있었지만 제목·가수·재생 시간 조건에 맞는 후보가 없습니다.");
    }catch(error){
     if(error?.code==="CANCELLED")break;
     if(error?.status!==404&&error?.status!==429)record(provider+"/곡 검색",error?.code||"PROVIDER_ERROR",error?.message||"검색 실패",error?.elapsed||0,error?.status||"");
    }
   }
  }
 })());
 jobs.push((async()=>{
  const provider="LRCLIB";
  if(getLyricApiCooldown()>Date.now()){record(provider,"COOLDOWN_ACTIVE","이전 429 응답으로 요청 제한 대기 중입니다.");return;}
  const queries=[];
  if(identity.artistKnown&&Number(video.duration)>=1&&Number(video.duration)<=3600){
   const exact=new URL(LYRIC_API+"/get");
   exact.searchParams.set("track_name",track);exact.searchParams.set("artist_name",artist);exact.searchParams.set("duration",String(video.duration));
   queries.push({url:exact,label:"정확 일치 조회"});
  }
  const variants=identity.queries.slice(0,identity.artistKnown?5:6);
  if(identity.artistKnown){
   if(variants[0])queries.push({kind:"structured",variant:variants[0]});
   const aliasVariant=variants.find((variant,index)=>index>0&&variant.artist);
   if(aliasVariant)queries.push({kind:"structured",variant:aliasVariant});
   const fallbackVariant=variants.find(variant=>!variant.artist)||variants[0];
   if(fallbackVariant)queries.push({kind:"free",variant:fallbackVariant});
  }else{
   for(const variant of variants.slice(0,3))queries.push({kind:"free",variant});
  }
  if(identity.artistKnown){
   for(const searchTerm of (identity.searchTerms||[]).slice(1,2))queries.push({kind:"free",variant:{title:searchTerm,artist}});
  }
  const seen=new Set();
  for(const query of queries){
   if(lyricSignal.aborted)break;
   const key=query.url?query.url.toString():query.kind+":"+query.variant.title+":"+query.variant.artist;
   if(seen.has(key))continue;seen.add(key);
   try{
    const url=query.url||new URL(LYRIC_API+"/search");
    if(!query.url){
     if(query.kind==="structured"){url.searchParams.set("track_name",query.variant.title);if(query.variant.artist)url.searchParams.set("artist_name",query.variant.artist);}
     else url.searchParams.set("q",[query.variant.title,query.variant.artist].filter(Boolean).join(" "));
    }
    const {data}=await fetchJson(url,headers,6500,provider);
    const list=Array.isArray(data)?data:[data];
    if(!list.length)record(provider,"LRCLIB_NO_RESULTS","검색 요청은 성공했지만 일치하는 곡이 없습니다.");
    let accepted=0;
    for(const item of list){
     if(!item)continue;
     if(!item.syncedLyrics&&!item.plainLyrics&&!item.lyricsfile){record(provider,"LRCLIB_EMPTY_ITEM","검색 결과 항목에 가사 필드가 없습니다.");continue;}
     if(accept(provider,item,query.variant?.artist?[identity.artistKnown?identity.artist:query.variant.artist,...(identity.artistAliases||[])]:[],identity.titles))accepted++;
    }
    if(accepted)break;
   }catch(error){
    if(error?.code==="CANCELLED")break;
    if(error?.status===429)break;
    if(error?.status!==404)record(provider,error?.code||"PROVIDER_ERROR",error?.message||"제공처 오류",error?.elapsed||0,error?.status||"");
   }
   await delay(250);
  }
 })());
 jobs.push((async()=>{
  const provider="Karalyr";
  const variants=identity.queries.filter(item=>item.artist).slice(0,3);
  for(const variant of variants){
   if(lyricSignal.aborted)break;
   try{
    const url=new URL("https://karalyr.com/api/get");
    url.searchParams.set("track_name",variant.title);
    url.searchParams.set("artist_name",variant.artist);
    // Do not send the YouTube video's full duration: lyric videos may contain intros/outros.
    // The returned track duration is checked by the shared validator instead.
    const {data}=await fetchJson(url,{},8000,provider);
    if(data?.instrumental){record(provider,"INSTRUMENTAL","해당 곡은 연주곡으로 표시되어 있습니다.");continue;}
    const timed=String(data?.syncedLyrics||"");
    const enhanced=parseEnhancedLrc(timed),lines=enhanced.length?enhanced:parseLrc(timed);
    const valid=accept(provider,{trackName:data.trackName||data.name||"",artistName:data.artistName||"",
     duration:Number(data.duration)||0,syncedLyrics:timed,plainLyrics:"",ttmlLines:lines,
     hasWordSync:enhanced.length>0,matchConfidence:0},[variant.artist],[variant.title]);
    if(valid)break;
    record(provider,"KARALYR_RESULT_REJECTED","응답은 받았지만 곡 정보 또는 싱크 가사 검증을 통과하지 못했습니다.");
   }catch(error){
    if(error?.code==="CANCELLED")break;
    if(error?.status!==404&&error?.status!==429)record(provider,error?.code||"PROVIDER_ERROR",error?.message||"조회 실패",error?.elapsed||0,error?.status||"");
   }
   await delay(250);
  }
 })());
 jobs.push((async()=>{
  const provider="Better Lyrics";
  if(getBetterLyricsCooldown()>Date.now()){record(provider,"COOLDOWN_ACTIVE","이전 429 응답으로 요청 제한 대기 중입니다.");return;}
  const variants=identity.queries.slice(0,6);
  // Try the default TTML endpoint too; it can have cached syllable-synced lyrics
  // even when LRCLIB has no entry. Empty album is explicit, not a guessed album.
  const ttmlVariants=identity.queries.filter(item=>item.artist||identity.artistKnown).slice(0,3);
  for(const variant of ttmlVariants){
   if(lyricSignal.aborted)break;
   try{
    const url=new URL("https://api.betterlyrics.org/getLyrics");
    url.searchParams.set("s",variant.title);
    url.searchParams.set("a",variant.artist||artist);
    url.searchParams.set("al","");
    if(video.duration)url.searchParams.set("d",String(Math.round(Number(video.duration))));
    url.searchParams.set("v",video.id);
    const {data,headers:responseHeaders}=await fetchJson(url,{},8000,provider+"/TTML");
    const lines=parseTtml(data.ttml||"");
    const valid=accept(provider+"/TTML",{trackName:data.track||data.song||"",artistName:data.artist||"",
     duration:Number(data.duration)||0,ttmlLines:lines,plainLyrics:"",matchConfidence:Number(data.score)||0,
     _providerQueryEvidence:{title:variant.title,artist:variant.artist||artist,duration:Number(video.duration)||0,
      score:Number(data.score)||0,cacheStatus:responseHeaders.cache||""}},
     variant.artist?[variant.artist]:[],[variant.title]);
    if(valid)break;
   }catch(error){
    if(error?.code==="CANCELLED")break;
    if(error?.status!==404&&error?.status!==429)record(provider+"/TTML",error?.code||"PROVIDER_ERROR",error?.message||"TTML 조회 실패",error?.elapsed||0,error?.status||"");
   }
  }
  const endpoints=[{name:"Kugou",path:"/kugou/getLyrics",parse:data=>parseLrc(data.lyrics||"")},{name:"QQ",path:"/qq/getLyrics",parse:data=>parseQrc(data.lyrics||"")}];
  await Promise.all(endpoints.map(async endpoint=>{
   for(const variant of variants){
    if(lyricSignal.aborted)return;
    try{
     const url=new URL("https://api.betterlyrics.org"+endpoint.path);
     url.searchParams.set("s",variant.title);
     url.searchParams.set("a",variant.artist||artist||"");
     url.searchParams.set("al","");
     if(video.duration)url.searchParams.set("d",String(Math.round(Number(video.duration))));
     const {data,headers:responseHeaders}=await fetchJson(url,{},8000,provider+"/"+endpoint.name);
     if(!data?.lyrics){record(provider+"/"+endpoint.name,"PROVIDER_EMPTY","응답은 성공했지만 lyrics 필드가 비어 있습니다.");continue;}
     const lines=endpoint.parse(data.lyrics);
     const valid=accept(provider+"/"+endpoint.name,{trackName:data.track||data.song||"",
      artistName:data.artistName||data.artist||"",duration:Number(data.duration)||0,
      syncedLyrics:endpoint.name==="Kugou"?data.lyrics:"",ttmlLines:lines,plainLyrics:data.plainLyrics||extractPlainText(data.lyrics),hasWordSync:endpoint.name==="QQ",
      _providerQueryEvidence:{title:variant.title,artist:variant.artist||artist,duration:Number(video.duration)||0,
       cacheStatus:responseHeaders.cache||""}},variant.artist?[variant.artist]:[],[variant.title]);
     if(valid){
      if(responseHeaders.cache)record(provider+"/"+endpoint.name,"CACHE_"+String(responseHeaders.cache).toUpperCase(),"제공처 캐시 상태");
      return;
     }
     record(provider+"/"+endpoint.name,"PROVIDER_RESULT_REJECTED","응답을 받았지만 가사 파싱 또는 곡 일치 검증에서 제외됐습니다.");
    }catch(error){
     if(error?.code==="CANCELLED")return;
     if(error?.code==="NETWORK_OR_CORS"){
      record(provider+"/"+endpoint.name,error.code,error?.message||"브라우저 네트워크/CORS 연결 실패",error?.elapsed||0,error?.status||"");
      return;
     }
     if(error?.status===429)return;
     if(error?.status!==404)record(provider+"/"+endpoint.name,error?.code||"PROVIDER_ERROR",error?.message||"제공처 오류",error?.elapsed||0,error?.status||"");
    }
   }
  }));
 })());
 const allJobs=Promise.allSettled(jobs);allJobs.then(()=>recordLyricFlow("provider_searches_settled",{requestId,candidateCount:candidates.length}));
  
 let searchDeadlineTimer;
 const deadline=new Promise(resolve=>{searchDeadlineTimer=setTimeout(()=>resolve("deadline"),13000);});
 const outcome=await Promise.race([
  allJobs.then(()=>"complete"),
  firstVerifiedCandidate.then(()=>"candidate"),
  deadline
 ]);
 clearTimeout(searchDeadlineTimer);
 if(outcome==="candidate"){
  // Give other fast providers a short chance to return a stronger verified match.
  await delay(450);
  if(requestId!==lyricLoadToken)return;
  requestController.abort(Object.assign(new Error("검증된 가사를 확보해 나머지 검색을 종료합니다."),{code:"CANCELLED"}));
 }else if(outcome==="deadline"){
  record("전체 검색","SEARCH_DEADLINE","13초 제한에 도달해 남은 제공처 요청을 취소합니다.");
  requestController.abort(Object.assign(new Error("가사 검색 제한 시간 초과"),{code:"CANCELLED"}));
  await allJobs;
 }
 if(requestId!==lyricLoadToken)return;
 if(!candidates.some(item=>item._synced)){recordLyricFlow("provider_search_race_finished",{requestId,outcome,candidateCount:candidates.length});
  
  const provider="LiriQo";recordLyricFlow("liriqo_fallback_started",{requestId,candidateCount:candidates.length});
   
  const fallbackController=new AbortController();
  lyricFallbackAbortController=fallbackController;
  const fallbackTimer=setTimeout(()=>fallbackController.abort(Object.assign(new Error("LiriQo 요청 제한 시간 초과"),{code:"TIMEOUT"})),7500);
  const makeLines=item=>{
   const timed=Array.isArray(item?.timed)?item.timed:[];
   const normalized=timed.map(line=>{
    const rawWords=Array.isArray(line.words)?line.words:
     (Array.isArray(item?.words?.[line.id])?item.words[line.id]:[]);
    const words=rawWords.map(word=>({
     text:String(word?.text||""),start:providerMillisecondsToSeconds(word?.start),
     end:providerMillisecondsToSeconds(word?.end)
    })).filter(word=>word.text&&Number.isFinite(word.start)&&Number.isFinite(word.end)&&word.end>word.start);
    return {time:providerMillisecondsToSeconds(line?.start),text:String(line?.text||""),words};
   }).filter(line=>Number.isFinite(line.time)&&line.time>=0&&line.text.trim());
   if(normalized.length>=2)return normalized;
   if(typeof item?.lrc==="string"){const parsed=parseLrc(item.lrc);if(parsed.length>=2)return parsed;}
   if(typeof item?.ttml==="string"){const parsed=parseTtml(item.ttml);if(parsed.length>=2)return parsed;}
   if(typeof item?.lyricsfile==="string"){const parsed=parseLyricsfile(item.lyricsfile);if(parsed.length>=2)return parsed;}
   if(typeof item?.qrc==="string"){const parsed=parseQrc(item.qrc);if(parsed.length>=2)return parsed;}
   return normalized;
  };
  const tryResult=(data,queryArtist="")=>{
   const metadata=data?.metadata||{};
   const pool=[...(Array.isArray(data?.tracks)?data.tracks:[]),...(data?.primary?[data.primary]:[])];
   const unique=[];
   for(const item of pool)if(item&&!unique.includes(item))unique.push(item);
   const rank={syllable:4,word:3,character:2,line:1,plain:0};
   unique.sort((a,b)=>(rank[String(b.syncLevel||"").toLowerCase()]||0)-(rank[String(a.syncLevel||"").toLowerCase()]||0));
   for(const item of unique){
    const lines=makeLines(item);
    const trackTitle=String(item.title||item.trackName||item.track||metadata.title||"").trim();
    const trackArtist=String(item.artist||item.artistName||metadata.artist||"").trim();
    const durationValue=item.duration??metadata.duration??0;
    const duration=typeof durationValue==="string"&&durationValue.includes(":")
     ?durationValue.split(":").reduce((total,part)=>total*60+Number(part),0):Number(durationValue)||0;
    const plain=String(item.plain||item.plainLyrics||(String(item.syncLevel||"").toLowerCase()==="plain"?item.lyrics:"")||"");
    if(lines.length<2&&!plain.trim())continue;
    const valid=accept(provider,{trackName:trackTitle,artistName:trackArtist,duration,
     ttmlLines:lines,plainLyrics:plain,hasWordSync:lines.some(line=>line.words.length),
     matchConfidence:0,_liriqoProvider:item.upstreamProvider||item.provider||item.lyricsSource||"",
     _sameVideoSource:String(data.videoId||"")===String(video.id)},
     queryArtist?[queryArtist]:[],[identity.title,...identity.titles]);
    if(valid)return Boolean(valid._synced);
   }
   return false;
  };
  const request=async(url,label)=>{
   const began=Date.now();
   try{
    const response=await fetch(url,{headers:{"Accept":"application/json"},signal:fallbackController.signal});
    const raw=await response.text();
    let data=null;
    if(raw){try{data=JSON.parse(raw);}catch(_){}}
    if(!response.ok){
     const error=Object.assign(new Error("HTTP "+response.status+(data?.error?": "+String(data.error).slice(0,150):"")),
      {status:response.status,code:"HTTP_"+response.status,elapsed:Date.now()-began});
     throw error;
    }
    if(!data||typeof data!=="object")throw Object.assign(new Error("응답이 JSON 형식이 아닙니다."),{code:"INVALID_JSON",elapsed:Date.now()-began});
    return data;
   }catch(error){
    if(requestId!==lyricLoadToken||fallbackController.signal.aborted&&error?.name==="AbortError")return null;
    if(error?.status===404)record(provider,"LIRIQO_NOT_FOUND",label+"에서 일치하는 가사를 찾지 못했습니다.",Date.now()-began,404);
    else record(provider+"/"+label,error?.code||"NETWORK_OR_CORS",error?.message||"연결 실패",error?.elapsed||Date.now()-began,error?.status||"");
    return null;
   }
  };
  try{
   const videoUrl=new URL("https://api.liriqo-alfarrizi.my.id/v1/lyrics");
   videoUrl.searchParams.set("v",video.id);
   const attempts=[(async()=>{
    const data=await request(videoUrl,"영상 ID 검색");
    if(data&&tryResult(data))return true;
    if(data)record(provider,"LIRIQO_NO_USABLE_MATCH","영상 ID 결과가 곡 정보 또는 가사 형식 검증을 통과하지 못했습니다.");
    throw new Error("영상 ID 검색에서 검증된 가사를 찾지 못했습니다.");
   })()];
   // Do not let a slow video-ID lookup block a known title/artist search.
   // Try a few independently identified artist aliases concurrently.
   const variants=[];
   for(const variant of identity.queries.filter(item=>item.artist).slice(0,4)){
    const key=trackText(variant.title)+"|"+trackText(variant.artist);
    if(!variants.some(item=>item.key===key))variants.push({...variant,key});
   }
   for(const variant of variants){
    const songUrl=new URL("https://api.liriqo-alfarrizi.my.id/v1/lyrics");
    songUrl.searchParams.set("title",variant.title);
    songUrl.searchParams.set("artist",variant.artist);
    if(video.duration)songUrl.searchParams.set("duration",String(Math.round(Number(video.duration))));
    attempts.push((async()=>{
     const data=await request(songUrl,"곡·가수 검색 ("+variant.artist+")");
     if(data&&tryResult(data,variant.artist))return true;
     if(data)record(provider,"LIRIQO_NO_USABLE_MATCH","곡·가수 검색 결과가 "+variant.artist+" 가수명 검증을 통과하지 못했습니다.");
     throw new Error("곡·가수 검색에서 검증된 가사를 찾지 못했습니다.");
    })());
   }
   let matched=false;
   try{await Promise.any(attempts);matched=true;}catch(_){}
   if(matched)fallbackController.abort();
   if(requestId!==lyricLoadToken)return;
  }finally{
   clearTimeout(fallbackTimer);
   if(lyricFallbackAbortController===fallbackController)lyricFallbackAbortController=null;
  }
 }
 if(candidates.length===0&&usePuter){
  try{
   const ai=await puterAIAlternateSearch(track,artist,channel,video.duration,normalize,
    (item,extraArtists,extraTitles)=>validate(item,extraArtists,extraTitles,"AI 보조 검색"),requestId);
   if(ai){ai._source="AI 보조 검색";candidates.push(ai);}
  }catch(error){record("AI 보조 검색","AI_FALLBACK_FAILED",error?.message||"보조 검색 실패");}
 }
 if(requestId!==lyricLoadToken)return;
 let albumMatch=null;
 const lrclibCandidate=candidates.filter(item=>item._source==="LRCLIB"&&String(item.albumName||"").trim()&&Number(item.duration)>0)
  .sort((a,b)=>(Number(b._score)||0)-(Number(a._score)||0))[0];
 albumMatch=lrclibCandidate||null;
 if(!candidates.some(item=>item._source.startsWith("Better Lyrics"))&&albumMatch&&!lyricSignal.aborted){
  try{
   const url=new URL("https://api.betterlyrics.org/getLyrics");
   url.searchParams.set("s",albumMatch.trackName||track);url.searchParams.set("a",albumMatch.artistName||artist||identity.queries[0]?.artist||"");
   url.searchParams.set("al",String(albumMatch.albumName).trim());
   url.searchParams.set("d",String(Math.round(Number(albumMatch.duration))));
   url.searchParams.set("v",video.id);
   const {data,headers:responseHeaders}=await fetchJson(url,{},7000,"Better Lyrics/TTML");
   const candidate={trackName:data.track||data.song||"",artistName:data.artist||"",duration:Number(data.duration)||0,
    ttmlLines:parseTtml(data.ttml||""),syncedLyrics:"",plainLyrics:data.plainLyrics||"",matchConfidence:Number(data.score)||0,
    _providerQueryEvidence:{title:albumMatch.trackName||track,artist:albumMatch.artistName||artist,
     duration:Number(albumMatch.duration)||0,score:Number(data.score)||0,cacheStatus:responseHeaders.cache||""}};
   const valid=accept("Better Lyrics/TTML",candidate,albumMatch.artistName?[albumMatch.artistName]:[],[albumMatch.trackName||track]);
   if(!valid)record("Better Lyrics/TTML","TTML_RESULT_REJECTED","TTML 응답을 받았지만 파싱 또는 곡 검증에서 제외됐습니다.");
  }catch(error){if(error?.code!=="CANCELLED"&&error?.status!==404&&error?.status!==429)record("Better Lyrics/TTML",error?.code||"PROVIDER_ERROR",error?.message||"제공처 오류",error?.elapsed||0,error?.status||"");}
 }
 if(requestId!==lyricLoadToken)return;
 candidates.sort((a,b)=>{
  const sync=(b._synced?10000:0)-(a._synced?10000:0);
  return sync+(b._score-a._score);
 });
 const selected=candidates.find(item=>item._synced&&Array.isArray(item.ttmlLines)&&item.ttmlLines.length>=2)||
  candidates.filter(item=>!item._synced&&String(item.plainLyrics||"").trim().length>=12)
   .sort((a,b)=>(Number(b._score)||0)-(Number(a._score)||0))[0]||null;
 if(selected)recordLyricFlow("lyric_candidate_selected",{
  provider:selected._source||"",trackName:selected.trackName||selected.title||"",
  artistName:selected.artistName||selected.artist||"",score:Number(selected._score)||0,
  synced:Boolean(selected._synced),videoBound:Boolean(selected._videoBound),
  candidateCount:candidates.length,
  firstLineTime:Array.isArray(selected.ttmlLines)&&selected.ttmlLines.length?
   finiteTimestampSeconds(selected.ttmlLines[0]?.time):null,
  firstLineEffectiveTime:Array.isArray(selected.ttmlLines)&&selected.ttmlLines.length?
   getLyricLineStartTime(selected.ttmlLines[0],selected.ttmlLines,0):null,
  firstLineFingerprint:Array.isArray(selected.ttmlLines)&&selected.ttmlLines.length?
   getLyricTextFingerprint(selected.ttmlLines[0]?.text):"",
  firstLineTextLength:Array.isArray(selected.ttmlLines)&&selected.ttmlLines.length?
   String(selected.ttmlLines[0]?.text||"").length:0,
  alternatives:candidates.filter(item=>item!==selected&&item._synced).slice(0,5).map(item=>({
   provider:item._source||"",trackName:item.trackName||item.title||"",
   artistName:item.artistName||item.artist||"",score:Number(item._score)||0,
   videoBound:Boolean(item._videoBound),sameVideoSource:Boolean(item._sameVideoSource),
   sourceVideoId:String(item._unisonSourceVideoId||item.sourceVideoId||""),
   upstreamProvider:String(item._liriqoProvider||item.upstreamProvider||""),
   firstLineTime:Number.isFinite(finiteTimestampSeconds(item.ttmlLines?.[0]?.time))?
    Number(finiteTimestampSeconds(item.ttmlLines[0].time).toFixed(3)):null,
   firstLineEffectiveTime:Array.isArray(item.ttmlLines)&&item.ttmlLines.length?
    Number(getLyricLineStartTime(item.ttmlLines[0],item.ttmlLines,0).toFixed(3)):null,
   firstLineFingerprint:Array.isArray(item.ttmlLines)&&item.ttmlLines.length?
    getLyricTextFingerprint(item.ttmlLines[0]?.text):"",
   firstLineTextLength:Array.isArray(item.ttmlLines)&&item.ttmlLines.length?
    String(item.ttmlLines[0]?.text||"").length:0
  }))
 });
 if(!selected){
  lyricState.loading=false;
  if(aiAssistButton)aiAssistButton.hidden=false;
  if(!diagnostics.length)record("전체 검색","NO_PROVIDER_RESPONSE","모든 제공처에서 결과를 받지 못했습니다.");
  const hasRateLimit=diagnostics.some(item=>item.code==="HTTP_429");
  const hasNetwork=diagnostics.some(item=>item.code==="NETWORK_OR_CORS");
  const summary=hasRateLimit?"일부 제공처가 요청 횟수 제한(429)을 반환했습니다.":hasNetwork?"네트워크 또는 브라우저 CORS 연결 오류가 발생했습니다.":"가사를 찾지 못했습니다. 아래 오류 코드에서 제공처별 실패 단계를 확인하세요.";
  record("전체 검색","LYRICS_NOT_FOUND",summary+" · "+(Date.now()-startedAt)+"ms 경과");
  showLyricsMessage("가사를 표시하지 못했어요. 아래 진단 정보를 확인해 주세요.");
  showDiagnostics(summary);
  return;
 }
 if(identifiedTrack){
  const candidateTitle=selected.trackName||selected.title||"";
  const candidateArtist=selected.artistName||selected.artist||"";
  const candidateDuration=Number(selected.duration)||0;
  const expectedDuration=Number(identifiedTrack.duration)||0;
  const durationMatches=!candidateDuration||!expectedDuration||
   Math.abs(candidateDuration-expectedDuration)<=Math.max(15,expectedDuration*0.12);
  const identityMatches=trackSimilarity(candidateTitle,identifiedTrack.title)>=0.92&&
   trackSimilarity(candidateArtist,identifiedTrack.artist)>=0.82&&durationMatches;
  if(!identityMatches){
   record(selected._source||"가사 검증","IDENTIFIED_TRACK_MISMATCH",
    "음원 식별 결과와 가사 후보의 곡 정보가 달라 연결을 차단했습니다. 후보: "+candidateArtist+" — "+candidateTitle);
   removeLyricsAssociatedWithVideo(video.id);
   lyricState.loading=false;lyricState.lines=[];lyricState.plain="";lyricState.wordSynced=false;
   lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricTimingBasis="catalog";lyricOffsetSeconds=0;
   currentLyricsTrack=null;
   showLyricsMessage("재생 중인 곡과 가사가 일치하지 않아 표시하지 않았어요.");
   showDiagnostics("음원 식별 결과와 가사 후보가 달라 잘못된 가사를 연결하지 않았습니다.");
   return;
  }
 }
 const wordLines=selected.ttmlLines||[];
 let displayWordLines=wordLines;
 if(selected._synced&&wordLines.length){
  const selectedTitle=selected.trackName||selected.title||"";
  const selectedArtist=selected.artistName||selected.artist||"";
  const spacingSources=[selected,...candidates.filter(item=>{
   if(item===selected||!String(item.plainLyrics||"").trim())return false;
   const sameTitle=trackSimilarity(item.trackName||item.title||"",selectedTitle)>=0.92;
   const sameArtist=trackSimilarity(item.artistName||item.artist||"",selectedArtist)>=0.82;
   const aDuration=Number(item.duration)||0,bDuration=Number(selected.duration)||0;
   const sameDuration=!aDuration||!bDuration||Math.abs(aDuration-bDuration)<=Math.max(15,bDuration*0.12);
   return sameTitle&&sameArtist&&sameDuration;
  })];
  for(const source of spacingSources){
   const restored=restoreTimedLineSpacing(wordLines,String(source.plainLyrics||""));
   if(restored!==wordLines){
    displayWordLines=restored;
    record(source===selected?(selected._source||"가사 제공처"):(source._source||"동일 곡 가사 제공처"),
     "KOREAN_SPACING_RESTORED","동일 곡의 일반 가사와 글자 순서를 대조해 싱크 가사의 띄어쓰기를 복원했습니다.");
    break;
   }
  }
 }
 const hasWords=displayWordLines.some(item=>item.words?.length);
 lyricState.lines=(selected._synced?displayWordLines:[]).filter(item=>!isCreditMetadata(item.text));
 lyricState.plain=String(selected.plainLyrics||"").split(/\r?\n/).filter(line=>line.trim()&&!isCreditMetadata(line)).join("\n");
 lyricState.wordSynced=hasWords;
 lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;
 if(!lyricState.lines.length&&!lyricState.plain){
  lyricState.loading=false;
  showLyricsMessage("가사는 찾았지만 표시 가능한 형식으로 변환하지 못했어요.");
  record(selected._source,"DISPLAY_EMPTY","검증된 후보가 최종 화면 데이터에서 비었습니다.");
  showDiagnostics("가사 검색은 성공했지만 화면에 전달할 가사가 없습니다.");
  return;
 }
 currentLyricsTrack={title:selected.trackName||selected.title||track,artist:selected.artistName||selected.artist||artist,duration:Number(selected.duration)||0,
  source:selected._source||"",upstreamProvider:selected._liriqoProvider||""};
  applyResolvedUnisonSharedLyrics();
  if(el.lyricsAttribution){
   const attribution=selected._source==="LiriQo"?String(selected._liriqoProvider||""):"";
   el.lyricsAttribution.textContent=attribution?"출처 · "+attribution:"";
   el.lyricsAttribution.hidden=!attribution;
  }
 const sourceIsVideoBound=Boolean(selected._synced&&selected._videoBound);
 const fromOtherUnisonVideo=Boolean(selected._synced&&selected._unisonOtherVideo);
 lyricTimingBasis=sourceIsVideoBound?"video":"catalog";
 if(!selected._synced)lyricOffsetSeconds=0;
 if(selected._synced){
  const cachedLyrics={lines:lyricState.lines,plain:lyricState.plain,wordSynced:hasWords,timingBasis:lyricTimingBasis,
   source:fromOtherUnisonVideo?"Unison shared text":selected._source,
   trackName:selected.trackName||selected.title||track,artistName:selected.artistName||selected.artist||artist,duration:Number(selected.duration)||0,
   acoustidId:identifiedTrack?.acoustidId||currentIdentifiedTrack?.acoustidId||"",
   videoMetadata:{id:video.id,title:video.title,channelTitle:video.channelTitle,duration:Number(video.duration)||0}};
  if(sourceIsVideoBound){
   storeLyric(video.id,cachedLyrics);
   const timingCache=readTrackAnalysisCache()[video.id];
   if(timingCache?.status==="completed"){
    const match=selectTrackStart(timingCache.tracks,video);
    if(match)applyTrackOffset(getVideoLyricOffset(video.id,match.timestamp),identifiedTrack);
   }
  }else if(fromOtherUnisonVideo){
   lyricState.lines=[];lyricState.wordSynced=false;lyricTimingBasis="catalog";
   cachedLyrics.lines=[];cachedLyrics.wordSynced=false;cachedLyrics.timingBasis="catalog";
   cachedLyrics.plain=lyricState.plain||cachedLyrics.plain;
   if(cachedLyrics.plain.trim())for(const key of getSongLyricCacheKeys(video,cachedLyrics))storeLyric(key,cachedLyrics);
  }else storeLyricsForVideo(video,cachedLyrics,true);
 }
 lyricState.loading=false;
 hideDiagnostics();
 recordLyricFlow("lyrics_data_ready",{requestId,provider:selected._source||"",syncedLineCount:lyricState.lines.length,hasPlain:Boolean(lyricState.plain)});renderLyrics();
 
}
function updateProgress(){
 if(!ytPlayer||typeof ytPlayer.getCurrentTime!=="function")return;
 refreshMediaSessionFromPlayer();
 const playerDuration=ytPlayer.getDuration()||0;
 const current=ytPlayer.getCurrentTime()||0;
 // The IFrame API's reported duration can differ slightly from Data API metadata.
 // Use the actual loaded player's timeline instead of blocking lyrics on exact duration equality.
 if(!contentTimelineReady&&ytPlayer.getPlayerState&&ytPlayer.getPlayerState()===YT.PlayerState.PLAYING&&playerDuration>0){
  contentTimelineReady=true;
  selectedVideoDuration=playerDuration;
 }
 if(!contentTimelineReady){
  el.progressBar.disabled=true;
  el.progressBar.max=String(Math.max(1,Math.floor((selectedVideoDuration||1)*10)));
  if(!seeking)el.progressBar.value="0";
  if(!seeking)el.currentTime.textContent="0:00";
  el.totalTime.textContent=formatTime(selectedVideoDuration);
  el.playPauseButton.disabled=true;
 }else{
  const duration=selectedVideoDuration||playerDuration;
  el.progressBar.disabled=duration<=0;
  if(duration>0){
   el.progressBar.max=String(Math.max(1,Math.floor(duration*10)));
   if(!seeking)el.progressBar.value=String(Math.min(Number(el.progressBar.max),Math.floor(current*10)));
  }
  if(!seeking)el.currentTime.textContent=formatTime(current);
  el.totalTime.textContent=formatTime(duration);
  el.playPauseButton.disabled=duration<=0;
 }
 const state=ytPlayer.getPlayerState();
 // While playing, the dedicated 50 ms lyric timer owns lyric rendering.
 // Avoid rendering a second time from the 100 ms progress timer.
 if(state!==YT.PlayerState.PLAYING)renderLyrics();
 el.playPauseButton.textContent=state===1?"Ⅱ":"▶";
 el.playPauseButton.setAttribute("aria-label",state===1?"일시정지":"재생");
}
function updateMediaSession(state){
 if(!("mediaSession" in navigator))return;
 try{
  navigator.mediaSession.playbackState=state;
  if("setPositionState" in navigator&&ytPlayer){
   const duration=ytPlayer.getDuration(),position=ytPlayer.getCurrentTime();
   if(Number.isFinite(duration)&&duration>0&&Number.isFinite(position)){
    navigator.mediaSession.setPositionState({duration,playbackRate:state==="playing"?1:0,position:Math.min(duration,Math.max(0,position))});
   }
  }
 }catch(error){console.debug("Media Session update unavailable:",error);}
}
function setupMediaSession(){
 if(!("mediaSession" in navigator))return;
 const actions={
  play:()=>{if(ytPlayer)ytPlayer.playVideo();},
  pause:()=>{if(ytPlayer)ytPlayer.pauseVideo();},
  stop:()=>{if(ytPlayer)ytPlayer.pauseVideo();},
  seekbackward:details=>{if(ytPlayer)ytPlayer.seekTo(Math.max(0,ytPlayer.getCurrentTime()-(details.seekOffset||10)),true);},
  seekforward:details=>{if(ytPlayer)ytPlayer.seekTo(Math.min(ytPlayer.getDuration(),ytPlayer.getCurrentTime()+(details.seekOffset||10)),true);},
  seekto:details=>{if(ytPlayer&&Number.isFinite(details.seekTime))ytPlayer.seekTo(details.seekTime,true);}
 };
 for(const [action,handler] of Object.entries(actions)){
  try{navigator.mediaSession.setActionHandler(action,handler);}
  catch(error){console.debug("Media Session action unavailable:",action,error);}
 }
}
function refreshMediaSessionFromPlayer(){
 if(!ytPlayer||typeof ytPlayer.getPlayerState!=="function")return;
 const state=ytPlayer.getPlayerState();
 if(state===YT.PlayerState.PLAYING)updateMediaSession("playing");
 else if(state===YT.PlayerState.PAUSED)updateMediaSession("paused");
}
function updateMediaMetadata(video){
 if(!("mediaSession" in navigator)||!("MediaMetadata" in window))return;
 try{
  navigator.mediaSession.metadata=new MediaMetadata({title:video.title||"Music",artist:video.channelTitle||"YouTube",album:"Music",artwork:video.thumbnail?[{src:video.thumbnail,sizes:"480x360",type:"image/jpeg"}]:[]});
 }catch(error){console.debug("Media metadata unavailable:",error);}
}
setupMediaSession();
// Refresh lock-screen metadata/position when Android restores the page.
// This does not keep a terminated PWA alive; it only synchronizes a live player.
document.addEventListener("visibilitychange",()=>{
 if(!document.hidden){refreshMediaSessionFromPlayer();updateProgress();}
});
window.addEventListener("pageshow",()=>{refreshMediaSessionFromPlayer();updateProgress();});
function onYouTubeIframeAPIReady(){ytPlayer=new YT.Player("playerFrame",{width:"200",height:"200",videoId:"",playerVars:{autoplay:0,controls:0,playsinline:1,rel:0,fs:0,iv_load_policy:3,disablekb:1},events:{onReady:()=>{ytReady=true;ytPlayerError=null;el.playbackState.textContent="재생 준비 완료";if(currentVideoId)ytPlayer.loadVideoById(currentVideoId);},onStateChange:event=>{if(event.data===YT.PlayerState.PLAYING){el.playbackState.textContent="재생 중";updateMediaSession("playing");if(activePlaylistId)renderPlaylistDetail();clearInterval(progressTimer);progressTimer=setInterval(updateProgress,100);clearInterval(lyricTimer);lyricTimer=setInterval(renderLyrics,50);}else if(event.data===YT.PlayerState.PAUSED){clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;el.playbackState.textContent="일시정지";updateMediaSession("paused");if(activePlaylistId)renderPlaylistDetail();updateProgress();}else if(event.data===YT.PlayerState.ENDED){clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;el.playbackState.textContent="재생 완료";updateMediaSession("none");updateProgress();handlePlaylistEnded();}else if(event.data===YT.PlayerState.BUFFERING){el.playbackState.textContent="불러오는 중…";}},onError:event=>{ytPlayerError=Number(event.data)||0;clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;contentTimelineReady=false;el.playPauseButton.disabled=true;el.progressBar.disabled=true;el.playbackState.textContent="재생할 수 없는 영상";const reason=event.data===101||event.data===150?"영상 소유자가 외부 플레이어 재생을 허용하지 않아요.":event.data===100?"영상이 삭제되었거나 비공개예요.":"YouTube 플레이어에서 재생 오류가 발생했어요.";showToast(reason+" 다른 검색 결과를 선택해 주세요.");}}});}
window.onYouTubeIframeAPIReady=onYouTubeIframeAPIReady;
const ytScript=document.createElement("script");ytScript.src="https://www.youtube.com/iframe_api";ytScript.async=true;document.head.appendChild(ytScript);
function setPlayer(video){if(!playlistInternalSwitch){activePlaylistId="";activePlaylistIndex=-1;}ytPlayerError=null;currentVideoId=video.id;resetPlaybackAudit();resetLyricFlowAudit(video.id);currentIdentifiedTrack=null;currentLyricsTrack=null;if(el.lyricsAttribution){el.lyricsAttribution.textContent="";el.lyricsAttribution.hidden=true;}clearAlbumArtwork();lyricOffsetSeconds=0;lyricTimingBasis="catalog";trackAnalysisToken++;clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;seeking=false;selectedVideoDuration=Number(video.duration)||0;contentTimelineReady=false;updateMediaMetadata(video);updateMediaSession("none");el.nowTitle.textContent=video.title;el.nowChannel.textContent=video.channelTitle;el.currentTime.textContent="0:00";el.totalTime.textContent=formatTime(video.duration);el.progressBar.value="0";el.progressBar.max=String(Math.max(1,Math.floor((video.duration||0)*10)));el.progressBar.disabled=true;el.playPauseButton.disabled=true;el.playbackState.textContent="YouTube 플레이어 연결 중…";if(ytReady&&ytPlayer)ytPlayer.loadVideoById(video.id);renderResults(lastResults);const inferred=getLyricsIdentity(video);if(inferred.artistKnown)loadAlbumArtwork(video,{title:inferred.title,artist:inferred.artist});const lyricsPromise=loadLyrics(video);lyricsPromise.then(()=>{if(currentVideoId===video.id&&currentLyricsTrack?.title&&currentLyricsTrack?.artist)loadAlbumArtwork(video,currentLyricsTrack);}).catch(error=>console.warn("Artwork metadata follow-up skipped:",error?.message||error));startTrackOffsetAnalysis(video,lyricsPromise);}
function renderResults(items){el.resultsList.replaceChildren();el.messageState.hidden=items.length>0;if(!items.length)return;const fragment=document.createDocumentFragment();items.forEach((video,index)=>{const row=document.createElement("article"),image=document.createElement("img"),info=document.createElement("div"),title=document.createElement("div"),channel=document.createElement("div"),badge=document.createElement("div"),play=document.createElement("button");row.className="track"+(video.id===currentVideoId?" active":"");image.className="track-thumb";image.src=video.thumbnail;image.alt="";image.loading=index>5?"lazy":"eager";info.className="track-info";title.className="track-title";title.textContent=video.title;channel.className="track-channel";channel.textContent=video.channelTitle;badge.className="track-badge";badge.textContent="음악";info.append(title,channel,badge);play.type="button";play.className="play-track";play.setAttribute("aria-label",video.title+" 재생");play.innerHTML='<svg viewBox="0 0 24 24"><path d="M7 4.8c0-.8.9-1.3 1.6-.9l10.2 7.2c.6.4.6 1.3 0 1.8L8.6 20.1c-.7.5-1.6 0-1.6-.9V4.8Z"/></svg>';play.addEventListener("click",()=>setPlayer(video));row.addEventListener("click",event=>{if(!event.target.closest("button"))setPlayer(video);});row.append(image,info,play);fragment.append(row);});el.resultsList.append(fragment);}
async function youtubeRequest(endpoint,params,signal){const url=new URL(API_BASE+"/"+endpoint);Object.entries({...params,key:apiKey}).forEach(([key,value])=>url.searchParams.set(key,value));let response;try{response=await fetch(url,{signal});}catch(error){if(signal?.aborted)throw new Error(signal.reason?.message||"검색 요청이 취소됐어요.");throw new Error("Google API에 연결하지 못했어요. ("+(error?.message||"네트워크 오류")+")");}let data={};try{data=await response.json();}catch(_){}if(!response.ok){const apiError=data?.error||{},reason=apiError.errors?.[0]?.reason||"reason 정보 없음",message=apiError.message||response.statusText||"Google 오류",status=response.status;let hint="";if(reason==="keyInvalid"||reason==="keyExpired")hint="Google Cloud에서 키가 유효한지 확인하세요.";else if(reason==="accessNotConfigured")hint="YouTube Data API v3를 활성화해야 합니다.";else if(reason==="quotaExceeded"||reason==="dailyLimitExceeded")hint="YouTube Data API 할당량을 초과했습니다.";else if(/referer|referrer|API_KEY_HTTP_REFERRER_BLOCKED/i.test(reason+" "+message))hint="GitHub Pages 도메인을 웹사이트 제한에 등록해야 합니다.";const error=new Error("요청 단계: "+endpoint+". HTTP "+status+". Google 오류 코드: "+reason+". 설명: "+message+(hint?" 해결 단서: "+hint:""));error.apiKeyProblem=reason==="keyInvalid"||reason==="keyExpired"||reason==="accessNotConfigured"||/referer|referrer|API_KEY_HTTP_REFERRER_BLOCKED/i.test(reason+" "+message);throw error;}return data;}
function getVideoDurationSeconds(video){
 const iso=String(video?.contentDetails?.duration||"");
 const match=iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
 return match?Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0):0;
}
function isLikelyShortVideo(video){
 const title=String(video?.snippet?.title||"");
 const channel=String(video?.snippet?.channelTitle||"");
 if(/(?:#\s*(?:shorts?|쇼츠)|\bshorts?\b|쇼츠|세로\s*영상)/i.test(title+" "+channel))return true;
 const duration=getVideoDurationSeconds(video);
 const thumbs=Object.values(video?.snippet?.thumbnails||{});
 const vertical=thumbs.some(item=>Number(item?.width)>0&&Number(item?.height)>0&&Number(item.height)/Number(item.width)>1.08);
 // Shorts can be up to three minutes. Use vertical thumbnail shape as a second signal
 // so short songs and short-form audio uploads are not rejected by duration alone.
 return duration>0&&duration<=180&&vertical;
}
async function searchMusic(query){
 const requestId=++searchRequestToken;
 if(searchAbortController){searchAbortController.abort();searchAbortController=null;}
 const clean=String(query||"").trim();
 if(!apiKey){setLoading(false);openSettings("YouTube API 키를 입력해 주세요.");return;}
 if(!clean){setLoading(false);showToast("노래 제목이나 가수를 입력해 주세요.");return;}
 const controller=new AbortController();searchAbortController=controller;
 const timeout=setTimeout(()=>controller.abort(new Error("검색 요청 시간이 초과됐어요. 네트워크를 확인한 뒤 다시 시도해 주세요.")),20000);
 el.resultsTitle.textContent='"'+clean+'" 검색 결과';el.resultCount.textContent="";
 showMessage("음악을 찾고 있어요","YouTube 음악 카테고리에서 검색 중입니다.","loading");setLoading(true);
 try{
  const searchData=await youtubeRequest("search",{part:"snippet",type:"video",videoCategoryId:"10",videoEmbeddable:"true",maxResults:"50",q:clean,regionCode:"KR",relevanceLanguage:"ko",safeSearch:"moderate",order:"relevance"},controller.signal);
  if(requestId!==searchRequestToken)return;
  const ids=(searchData.items||[]).filter(item=>item.id?.videoId).map(item=>item.id.videoId);
  if(!ids.length){lastResults=[];el.resultCount.textContent="0곡";showMessage("검색 결과가 없어요","다른 노래 제목이나 가수 이름으로 검색해 보세요.");return;}
  const details=await youtubeRequest("videos",{part:"snippet,status,contentDetails",id:ids.join(",")},controller.signal);
  if(requestId!==searchRequestToken)return;
  const allowed=new Map((details.items||[]).filter(v=>v.snippet?.categoryId==="10"&&v.status?.embeddable===true&&!isLikelyShortVideo(v)).map(v=>[v.id,v]));
  lastResults=(searchData.items||[]).filter(item=>allowed.has(item.id.videoId)).map(item=>{
   const v=allowed.get(item.id.videoId),thumbs=v.snippet.thumbnails||item.snippet.thumbnails||{},iso=v.contentDetails?.duration||"PT0S",m=iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/),duration=m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;
   return{id:v.id,title:v.snippet.title,channelTitle:v.snippet.channelTitle,description:String(v.snippet.description||""),thumbnail:thumbs.high?.url||thumbs.medium?.url||thumbs.default?.url||"",duration};
  });
  el.resultCount.textContent=lastResults.length+"곡";
  if(!lastResults.length){showMessage("재생 가능한 음악이 없어요","음악 카테고리이면서 외부 재생이 허용된 영상이 없어요. 다른 검색어를 시도해 보세요.");return;}
  renderResults(lastResults);
 }catch(error){
  if(requestId!==searchRequestToken)return;
  console.error("Music search failure:",error?.message||error);lastResults=[];el.resultCount.textContent="";
  const apiKeyMessage=getApiKeyProblemMessage(error);if(apiKeyMessage){openSettings(apiKeyMessage);showMessage("YouTube API 키를 확인해 주세요","설정 창의 API 키 아래에 표시된 오류 안내를 확인해 주세요.","error");}else showMessage("검색할 수 없어요",error?.message||"알 수 없는 오류가 발생했습니다.","error");
 }finally{
  clearTimeout(timeout);
  if(requestId===searchRequestToken){searchAbortController=null;setLoading(false);}
 }
}
el.searchForm.addEventListener("submit",event=>{event.preventDefault();const query=el.searchInput.value.trim();if(query)saveRecentSearch(query);hideRecentSearches();searchMusic(query);});
el.searchInput.addEventListener("input",()=>{searchDropdownOpen=true;requestYoutubeSuggestions(el.searchInput.value);});
el.searchInput.addEventListener("focus",showRecentSearches);
el.searchInput.addEventListener("click",showRecentSearches);
el.searchInput.addEventListener("keydown",event=>{if(event.key==="Escape"){hideRecentSearches();return;}if(event.key==="ArrowDown"||event.key==="ArrowUp"){const rows=[...document.querySelectorAll("#recentSearches .recent-row")];if(!rows.length)return;event.preventDefault();activeSearchRow=event.key==="ArrowDown"?(activeSearchRow+1)%rows.length:(activeSearchRow<=0?rows.length-1:activeSearchRow-1);rows.forEach((row,index)=>{row.classList.toggle("keyboard-active",index===activeSearchRow);row.setAttribute("aria-selected",index===activeSearchRow?"true":"false");});return;}if(event.key==="Enter"&&activeSearchRow>=0){const row=document.querySelectorAll("#recentSearches .recent-row")[activeSearchRow];if(row){event.preventDefault();selectSearchQuery(row.dataset.query);}}});
document.addEventListener("click",event=>{if(!event.target.closest(".search-area"))hideRecentSearches();});
renderRecentSearches();
document.querySelectorAll("[data-query]").forEach(button=>button.addEventListener("click",()=>{el.searchInput.value=button.dataset.query;searchMusic(button.dataset.query);}));
el.settingsButton.addEventListener("click",()=>openSettings());
const apiGuideDialog=document.getElementById("apiGuideDialog");
document.getElementById("apiGuideOpenButton").addEventListener("click",()=>apiGuideDialog.showModal());
document.getElementById("copyApiOriginButton").addEventListener("click",async()=>{
 const button=document.getElementById("copyApiOriginButton");
 try{await navigator.clipboard.writeText("https://kanghuijun000.github.io/*");button.textContent="복사 완료";showToast("Music 사이트 주소를 복사했어요.");}
 catch(_){button.textContent="복사 실패";showToast("주소를 길게 눌러 직접 복사해 주세요.");}
 setTimeout(()=>{button.textContent="주소 복사";},1800);
});
document.getElementById("apiGuideFinishButton").addEventListener("click",()=>{
 apiGuideDialog.close();el.settingsDialog.showModal();el.apiKeyInput.focus();
});
apiGuideDialog.addEventListener("click",event=>{if(event.target===apiGuideDialog)apiGuideDialog.close();});
el.apiKeyInput.addEventListener("input",()=>{if(el.apiKeyInput.value.trim())setApiKeyError("");});
el.saveKeyButton.addEventListener("click",()=>{const value=el.apiKeyInput.value.trim();if(!value){setApiKeyError("API 키를 입력해 주세요.");el.apiKeyInput.focus();return;}if(!/^AIza[\w-]{20,}$/.test(value)){setApiKeyError("잘못된 API 키입니다.");el.apiKeyInput.focus();return;}apiKey=value;localStorage.setItem(STORAGE_KEY,apiKey);setApiKeyError("");updateConnectionStatus();el.settingsDialog.close();});
el.removeKeyButton.addEventListener("click",()=>{apiKey="";localStorage.removeItem(STORAGE_KEY);el.apiKeyInput.value="";updateConnectionStatus();el.settingsDialog.close();showToast("저장된 API 키를 삭제했어요.");});
el.settingsDialog.addEventListener("click",event=>{if(event.target===el.settingsDialog)el.settingsDialog.close();});
el.playPauseButton.addEventListener("click",()=>{if(!ytPlayer)return;if(ytPlayer.getPlayerState()===YT.PlayerState.PLAYING)ytPlayer.pauseVideo();else ytPlayer.playVideo();});
el.progressBar.addEventListener("input",()=>{if(!ytPlayer)return;seeking=true;el.currentTime.textContent=formatTime(Number(el.progressBar.value)/10);});
el.progressBar.addEventListener("change",()=>{if(!ytPlayer||el.progressBar.disabled)return;const target=Number(el.progressBar.value)/10;ytPlayer.seekTo(target,true);seeking=false;el.currentTime.textContent=formatTime(target);updateProgress();});
const aiAssistButton=document.getElementById("aiAssistButton");
let puterSdkPromise=null;
function loadPuterSdk(){
 if(window.puter?.ai?.chat)return Promise.resolve(true);
 if(puterSdkPromise)return puterSdkPromise;
 puterSdkPromise=new Promise(resolve=>{
  const script=document.createElement("script");script.src="https://js.puter.com/v2/";script.async=true;
  script.onload=()=>resolve(Boolean(window.puter?.ai?.chat));
  script.onerror=()=>resolve(false);
  document.head.appendChild(script);
  setTimeout(()=>resolve(Boolean(window.puter?.ai?.chat)),7000);
 });
 return puterSdkPromise;
}
aiAssistButton?.addEventListener("click",async()=>{
 const video=lastResults.find(item=>item.id===currentVideoId);
 if(!video)return;
 aiAssistButton.disabled=true;aiAssistButton.textContent="곡 정보 보정 중…";
 const ready=await loadPuterSdk();
 if(ready){await loadLyrics(video,true,currentIdentifiedTrack);}
 else showToast("Puter 연결을 사용할 수 없어요. 기본 가사 검색은 계속 이용할 수 있어요.");
 aiAssistButton.disabled=false;aiAssistButton.textContent="Puter로 곡 정보 보정 후 다시 검색";
});

el.auditStartButton?.addEventListener("click",()=>{
 if(!currentVideoId){auditSetStatus("먼저 재생할 곡을 선택해 주세요.");return;}
 if(playbackAudit.active){
  playbackAudit.active=false;if(playbackAuditTimer){clearInterval(playbackAuditTimer);playbackAuditTimer=null;}
  el.auditStartButton.textContent="검증 다시 시작";el.auditMarkButton.disabled=true;
  el.auditCopyButton.disabled=!(playbackAudit.samples||playbackAudit.marks.length);
  const median=auditMedian(playbackAudit.transitions.map(item=>item.uiDelayMs));
  auditSetStatus("검증 종료 · "+playbackAudit.samples+"회 측정 · 화면 누락 "+playbackAudit.missingTicks+"회 · 표시 불일치 "+playbackAudit.mismatchTicks+"회"+
   (median===null?"":" · 화면 전환 지연 중앙값 "+Math.round(median)+"ms")+
   (playbackAudit.marks.length?" · 보컬 시작 표시 "+playbackAudit.marks.length+"회":""));
  return;
 }
 playbackAudit.active=true;playbackAudit.videoId=currentVideoId;playbackAudit.samples=0;playbackAudit.missingTicks=0;
 playbackAudit.mismatchTicks=0;playbackAudit.transitions=[];playbackAudit.marks=[];playbackAudit.lastRenderedIndex=-1;
 playbackAudit.startedAt=Date.now();playbackAudit.lastUiUpdate=0;playbackAudit.invalid=auditValidateLoadedLyrics();
 el.auditStartButton.textContent="검증 종료";el.auditMarkButton.disabled=true;el.auditCopyButton.disabled=true;
 auditSetStatus(playbackAudit.invalid.length?"가사 사전 검사: "+playbackAudit.invalid.join(" / "):
  "가사 구조 검사 통과. 곡을 재생하면 실제 플레이어 타임라인과 화면 전환을 측정합니다.");
 if(playbackAuditTimer)clearInterval(playbackAuditTimer);playbackAuditTimer=setInterval(samplePlaybackAudit,200);samplePlaybackAudit();
});
el.auditMarkButton?.addEventListener("click",()=>{
 if(!playbackAudit.active||!ytPlayer||!lyricState.lines.length)return;
 try{if(ytPlayer.getPlayerState()!==YT.PlayerState.PLAYING)return;}catch(_){return;}
 const index=lyricState.lastIndex,line=lyricState.lines[index];if(index<0||!line)return;
 let playerTime=0;try{playerTime=Number(ytPlayer.getCurrentTime())||0;}catch(_){return;}
 const offsetMs=Math.round((getLyricTimelineTime(playerTime,currentVideoId)-getLyricLineStartTime(line,lyricState.lines,index))*1000);
 const previous=playbackAudit.marks[playbackAudit.marks.length-1];
 if(previous&&previous.lineIndex===index){auditSetStatus("같은 가사 줄은 한 번만 기록됩니다. 다음 줄이 실제로 시작할 때 눌러 주세요.");return;}
 playbackAudit.marks.push({lineIndex:index,playerTime:Number(playerTime.toFixed(3)),lyricTimestamp:Number(Number(line.time).toFixed(3)),offsetMs});
 if(playbackAudit.marks.length>30)playbackAudit.marks.shift();
 const median=auditMedian(playbackAudit.marks.map(item=>item.offsetMs));
 auditSetStatus("실제 발음 시작 표시 "+playbackAudit.marks.length+"회 기록 · 탭 기준 오차 중앙값 "+Math.round(median)+"ms (사용자 반응 지연 포함)");
 el.auditCopyButton.disabled=false;
});
el.auditCopyButton?.addEventListener("click",async()=>{
 const report=JSON.stringify(getPlaybackAuditReport(),null,2);
 try{
  if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(report);
  else{const field=document.createElement("textarea");field.value=report;field.setAttribute("readonly","");field.style.position="fixed";field.style.opacity="0";document.body.append(field);field.select();const copied=document.execCommand("copy");field.remove();if(!copied)throw new Error("copy failed");}
  auditSetStatus("검증 보고서를 복사했습니다. 보고서에는 가사 본문이 포함되지 않습니다.");
 }catch(_){auditSetStatus("복사에 실패했습니다. 브라우저 클립보드 권한을 확인해 주세요.");}
});

if(new URLSearchParams(location.search).get("qa")==="1"){
 window.__musicQa={
  setVideo(video){setPlayer(video);},
  snapshot(){
   let playerState=null,playerTime=0;
   try{if(ytPlayer){playerState=ytPlayer.getPlayerState();playerTime=Number(ytPlayer.getCurrentTime())||0;}}catch(_){}
   const renderedIndex=Number(lyricState.lastIndex);
   return {
    playerReady:Boolean(ytReady&&ytPlayer),playerState,playerTime,playerError:ytPlayerError,
    videoId:currentVideoId,
    lines:(lyricState.lines||[]).map((line,index)=>({time:getLyricLineStartTime(line,lyricState.lines,index),baseTime:finiteTimestampSeconds(line.time),microAdjustmentSeconds:Number((getLyricLineStartTime(line,lyricState.lines,index)-finiteTimestampSeconds(line.time)).toFixed(3)),text:String(line.text||"")})),
    firstLineTiming:lyricState.lines?.length?{
     baseTime:finiteTimestampSeconds(lyricState.lines[0]?.time),
     effectiveTime:getLyricLineStartTime(lyricState.lines[0],lyricState.lines,0),
     textFingerprint:getLyricTextFingerprint(lyricState.lines[0]?.text),
     wordCount:Array.isArray(lyricState.lines[0]?.words)?lyricState.lines[0].words.length:0
    }:null,
    wordTimingEvidence:getLyricWordTimingEvidence(lyricState.lines,5),
    wordSynced:Boolean(lyricState.wordSynced),
    plainLyricsPresent:Boolean(String(lyricState.plain||"").trim()),
    lyricsLoading:Boolean(lyricState.loading),
    timingBasis:lyricTimingBasis,lyricOffsetSeconds,
    videoManualAdvanceSeconds:getVideoManualAdvanceSeconds(currentVideoId),firstLineCalibrationSeconds:getVideoFirstLineCalibrationSeconds(currentVideoId),lyricLeadSeconds:LYRIC_LEAD_SECONDS,
    effectiveAppOffsetSeconds:Number(getLyricTimelineOffsetSeconds(currentVideoId).toFixed(3)),
    track:currentLyricsTrack?{title:currentLyricsTrack.title||currentLyricsTrack.trackName||"",
      artist:currentLyricsTrack.artist||currentLyricsTrack.artistName||"",
      source:currentLyricsTrack.source||"",upstreamProvider:currentLyricsTrack.upstreamProvider||""}:null,
    renderedIndex,renderedText:renderedIndex>=0?String(lyricState.lines[renderedIndex]?.text||""):"",
    expectedIndex:playerTime>=0?auditExpectedLineIndex(playerTime):-1,
    lyricsStatus:String(el.lyricsStatus?.textContent||""),
    lyricFlow:{events:lyricFlowAudit.videoId===currentVideoId?lyricFlowAudit.events.slice(-60):[]},
    staticValidation:auditValidateLoadedLyrics()
   };
  }
 };
}
updateConnectionStatus();if(!apiKey)showMessage("먼저 검색 연결을 설정해 주세요","오른쪽 위 설정에서 YouTube Data API 키를 입력하면 음악 검색을 시작할 수 있어요.","error");

/* Personal playlists and repeat playback */
const PLAYLIST_STORAGE_KEY="music_playlists_v1";
let musicPlaylists=loadMusicPlaylists();
let openedPlaylistId="";
let activePlaylistId="";
let activePlaylistIndex=-1;
let playlistInternalSwitch=false;
const playlistEl={
 library:document.getElementById("playlistLibrary"),detail:document.getElementById("playlistDetail"),
 grid:document.getElementById("playlistGrid"),empty:document.getElementById("playlistEmpty"),
 detailTitle:document.getElementById("playlistDetailTitle"),detailCount:document.getElementById("playlistDetailCount"),
 songs:document.getElementById("playlistSongList"),songsEmpty:document.getElementById("playlistSongsEmpty"),
 createDialog:document.getElementById("playlistCreateDialog"),nameInput:document.getElementById("playlistNameInput"),
 createForm:document.getElementById("playlistCreateForm"),searchDialog:document.getElementById("playlistSearchDialog"),
 searchForm:document.getElementById("playlistSearchForm"),searchInput:document.getElementById("playlistSearchInput"),
 searchButton:document.getElementById("playlistSearchButton"),searchHint:document.getElementById("playlistSearchHint"),
 searchResults:document.getElementById("playlistSearchResults")
};
function loadMusicPlaylists(){
 try{
  const value=JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY)||"[]");
  if(!Array.isArray(value))return [];
  return value.filter(item=>item&&typeof item.id==="string"&&typeof item.name==="string"&&Array.isArray(item.songs))
   .map(item=>({id:item.id,name:item.name.slice(0,40),songs:item.songs.filter(song=>song&&typeof song.id==="string"&&typeof song.title==="string").map(song=>({id:song.id,title:song.title,channelTitle:String(song.channelTitle||""),thumbnail:String(song.thumbnail||""),duration:Number(song.duration)||0}))}));
 }catch(error){console.warn("Playlist data could not be loaded:",error);return [];}
}
function saveMusicPlaylists(){
 try{localStorage.setItem(PLAYLIST_STORAGE_KEY,JSON.stringify(musicPlaylists));return true;}
 catch(error){showToast("저장 공간이 부족해 모음곡을 저장하지 못했어요.");console.warn("Playlist save failed:",error);return false;}
}
function playlistId(){return window.crypto?.randomUUID?.()||("pl-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,9));}
function findPlaylist(id){return musicPlaylists.find(item=>item.id===id)||null;}
function currentOpenedPlaylist(){return findPlaylist(openedPlaylistId);}
function createPlaylist(){
 const name=String(playlistEl.nameInput.value||"").trim();
 if(!name){showToast("모음곡 이름을 입력해 주세요.");return;}
 const item={id:playlistId(),name:name.slice(0,40),songs:[]};
 musicPlaylists.unshift(item);
 if(!saveMusicPlaylists()){musicPlaylists.shift();return;}
 playlistEl.createDialog.close();playlistEl.nameInput.value="";
 openPlaylist(item.id);showToast("새 모음곡을 만들었어요.");
}
function openPlaylist(id){
 const item=findPlaylist(id);if(!item)return;
 openedPlaylistId=id;
 document.querySelector(".hero").hidden=true;
 document.querySelector(".workspace").hidden=true;
 playlistEl.library.hidden=true;playlistEl.detail.hidden=false;
 document.getElementById("homeNavButton").classList.remove("active");
 document.getElementById("playlistNavButton").classList.add("active");
 renderPlaylistDetail();
}
function showPlaylistLibrary(){
 document.querySelector(".hero").hidden=true;
 document.querySelector(".workspace").hidden=true;
 playlistEl.detail.hidden=true;playlistEl.library.hidden=false;
 document.getElementById("homeNavButton").classList.remove("active");
 document.getElementById("playlistNavButton").classList.add("active");
 renderPlaylistLibrary();
}
function showMusicHome(){
 playlistEl.library.hidden=true;playlistEl.detail.hidden=true;
 document.querySelector(".hero").hidden=false;
 document.querySelector(".workspace").hidden=false;
 document.getElementById("homeNavButton").classList.add("active");
 document.getElementById("playlistNavButton").classList.remove("active");
}
function renderPlaylistLibrary(){
 playlistEl.grid.replaceChildren();
 playlistEl.empty.hidden=musicPlaylists.length>0;
 musicPlaylists.forEach(item=>{
  const card=document.createElement("article");card.className="playlist-card";
  const open=document.createElement("button");open.type="button";open.className="playlist-card-open";
  const art=document.createElement("span");art.className="playlist-card-art";art.textContent="♫";
  const info=document.createElement("span");info.className="playlist-card-info";
  const name=document.createElement("strong");name.textContent=item.name;
  const count=document.createElement("small");count.textContent=item.songs.length+"곡";
  info.append(name,count);open.append(art,info);open.addEventListener("click",()=>openPlaylist(item.id));
  const play=document.createElement("button");play.type="button";play.className="playlist-card-play";play.textContent="▶";play.disabled=!item.songs.length;
  play.setAttribute("aria-label",item.name+" 전체 재생");play.addEventListener("click",()=>playPlaylist(item.id));
  card.append(open,play);playlistEl.grid.append(card);
 });
}
function renderPlaylistDetail(){
 const item=currentOpenedPlaylist();if(!item){showPlaylistLibrary();return;}
 playlistEl.detailTitle.textContent=item.name;
 playlistEl.detailCount.textContent=item.songs.length+"곡";
 playlistEl.songs.replaceChildren();
 playlistEl.songsEmpty.hidden=item.songs.length>0;
 const activeHere=activePlaylistId===item.id;
 const playButton=document.getElementById("playlistPlayAllButton");
 const stopButton=document.getElementById("playlistStopButton");
 let playerState=-1;try{if(ytPlayer)playerState=ytPlayer.getPlayerState();}catch(_){}
 const isPlaying=activeHere&&playerState===YT.PlayerState.PLAYING;
 playButton.textContent=isPlaying?"Ⅱ 일시정지":(activeHere&&playerState===YT.PlayerState.PAUSED?"▶ 다시 재생":"▶ 재생");
 stopButton.disabled=!activeHere;
 item.songs.forEach((song,index)=>{
  const row=document.createElement("article");row.className="playlist-song"+(activeHere&&activePlaylistIndex===index?" is-playing":"");
  row.dataset.songId=song.id;
  const play=document.createElement("button");play.type="button";play.className="playlist-song-main";
  const img=document.createElement("img");img.className="playlist-song-thumb";img.alt="";img.src=song.thumbnail||"";
  const info=document.createElement("span");info.className="playlist-song-info";
  const title=document.createElement("strong");title.textContent=song.title;
  const artist=document.createElement("small");artist.textContent=song.channelTitle;
  info.append(title,artist);play.append(img,info);play.addEventListener("click",()=>playPlaylist(item.id,index));
  const remove=document.createElement("button");remove.type="button";remove.className="playlist-song-remove";remove.textContent="×";remove.setAttribute("aria-label",song.title+" 삭제");remove.addEventListener("click",()=>removePlaylistSong(item.id,index));
  row.append(play,remove);playlistEl.songs.append(row);
  installPlaylistDrag(row,item.id);
 });
}
function reorderPlaylistSong(id,from,to){
 const item=findPlaylist(id);if(!item||from<0||to<0||from>=item.songs.length||to>=item.songs.length||from===to)return;
 const currentSongId=activePlaylistId===id?item.songs[activePlaylistIndex]?.id:null;
 const moved=item.songs.splice(from,1)[0];item.songs.splice(to,0,moved);
 if(currentSongId){activePlaylistIndex=item.songs.findIndex(song=>song.id===currentSongId);}
 saveMusicPlaylists();renderPlaylistDetail();
}
function installPlaylistDrag(row,playlistIdValue){
 let holdTimer=null,dragging=false,startX=0,startY=0,lastX=0,lastY=0,touchMode=false;
 const clearMarks=()=>playlistEl.songs.querySelectorAll(".playlist-song").forEach(node=>node.classList.remove("drop-before","drop-after"));
 const markTarget=(x,y)=>{
  const target=document.elementFromPoint(x,y)?.closest(".playlist-song");
  clearMarks();
  if(target&&target!==row&&target.parentElement===playlistEl.songs){
   const rect=target.getBoundingClientRect();
   target.classList.add(y<rect.top+rect.height/2?"drop-before":"drop-after");
  }
 };
 const finish=(x,y,cancelled=false)=>{
  if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
  if(!dragging)return;
  dragging=false;row.classList.remove("dragging");
  row.dataset.dragged="1";
  setTimeout(()=>{delete row.dataset.dragged;},500);
  const target=!cancelled?document.elementFromPoint(x,y)?.closest(".playlist-song"):null;
  const item=findPlaylist(playlistIdValue);
  if(item&&target&&target.parentElement===playlistEl.songs){
   const from=item.songs.findIndex(song=>song.id===row.dataset.songId);
   const targetIndex=item.songs.findIndex(song=>song.id===target.dataset.songId);
   const rect=target.getBoundingClientRect();
   const after=y>rect.top+rect.height/2;
   let to=targetIndex+(after?1:0);
   if(from<to)to--;
   to=Math.max(0,Math.min(item.songs.length-1,to));
   clearMarks();if(from!==to)reorderPlaylistSong(playlistIdValue,from,to);
  }else clearMarks();
 };
 const begin=(x,y)=>{
  startX=lastX=x;startY=lastY=y;
  holdTimer=setTimeout(()=>{
   dragging=true;row.classList.add("dragging");
   if(navigator.vibrate)navigator.vibrate(25);
  },450);
 };
 const cancelHoldIfMoved=(x,y)=>{
  if(holdTimer&&Math.hypot(x-startX,y-startY)>14){clearTimeout(holdTimer);holdTimer=null;}
 };
 row.addEventListener("touchstart",event=>{
  if(event.touches.length!==1||event.target.closest(".playlist-song-remove"))return;
  touchMode=true;
  const t=event.touches[0];begin(t.clientX,t.clientY);
 },{passive:true});
 row.addEventListener("touchmove",event=>{
  if(!touchMode||event.touches.length!==1)return;
  const t=event.touches[0];lastX=t.clientX;lastY=t.clientY;
  if(!dragging){cancelHoldIfMoved(lastX,lastY);return;}
  event.preventDefault();
  markTarget(lastX,lastY);
 },{passive:false});
 row.addEventListener("touchend",event=>{
  if(!touchMode)return;
  const t=event.changedTouches[0];
  if(dragging)finish(t.clientX,t.clientY,false);
  else if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
  touchMode=false;
 },{passive:true});
 row.addEventListener("touchcancel",()=>{
  if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
  if(dragging)finish(lastX,lastY,true);
  touchMode=false;
 },{passive:true});
 row.addEventListener("pointerdown",event=>{
  if(event.pointerType==="touch"||touchMode)return;
  if(event.button!==0||event.target.closest(".playlist-song-remove"))return;
  begin(event.clientX,event.clientY);
 });
 row.addEventListener("pointermove",event=>{
  if(event.pointerType==="touch"||touchMode)return;
  if(!dragging){cancelHoldIfMoved(event.clientX,event.clientY);return;}
  event.preventDefault();lastX=event.clientX;lastY=event.clientY;markTarget(lastX,lastY);
 });
 row.addEventListener("pointerup",event=>{
  if(event.pointerType==="touch"||touchMode)return;
  if(dragging)finish(event.clientX,event.clientY,false);
  else if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
 });
 row.addEventListener("pointercancel",()=>{
  if(touchMode)return;
  if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
  if(dragging)finish(lastX,lastY,true);
 });
 row.addEventListener("click",event=>{
  if(row.dataset.dragged==="1"){event.preventDefault();event.stopImmediatePropagation();delete row.dataset.dragged;}
 },true);
 row.addEventListener("contextmenu",event=>event.preventDefault());
}
function removePlaylistSong(id,index){
 const item=findPlaylist(id);if(!item||!item.songs[index])return;
 const wasCurrent=activePlaylistId===id&&activePlaylistIndex===index;
 item.songs.splice(index,1);
 if(wasCurrent){activePlaylistId="";activePlaylistIndex=-1;if(ytPlayer)ytPlayer.stopVideo();}
 else if(activePlaylistId===id&&activePlaylistIndex>index)activePlaylistIndex--;
 saveMusicPlaylists();renderPlaylistDetail();showToast("노래를 모음곡에서 삭제했어요.");
}
function playPlaylist(id,index=0){
 const item=findPlaylist(id);if(!item||!item.songs.length){showToast("재생할 노래가 없어요.");return;}
 activePlaylistId=id;activePlaylistIndex=Math.max(0,Math.min(index,item.songs.length-1));
 showPlaylistLibraryIfNotVisible();
 playPlaylistTrack(activePlaylistIndex);
}
function togglePlaylistPlayback(){
 const id=openedPlaylistId,item=findPlaylist(id);if(!item||!item.songs.length){showToast("먼저 모음곡에 노래를 추가해 주세요.");return;}
 if(activePlaylistId===id&&ytPlayer){
  let state=-1;try{state=ytPlayer.getPlayerState();}catch(_){}
  if(state===YT.PlayerState.PLAYING){ytPlayer.pauseVideo();return;}
  if(state===YT.PlayerState.PAUSED||state===YT.PlayerState.CUED||state===YT.PlayerState.BUFFERING){
   ytPlayer.playVideo();return;
  }
  if(activePlaylistIndex>=0&&currentVideoId===item.songs[activePlaylistIndex]?.id){ytPlayer.playVideo();return;}
 }
 playPlaylist(id,0);
}
function stopPlaylistPlayback(){
 if(!activePlaylistId)return;
 activePlaylistId="";activePlaylistIndex=-1;
 if(ytPlayer){try{ytPlayer.stopVideo();}catch(_){}}
 clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;
 el.playbackState.textContent="재생 종료";updateMediaSession("none");
 try{el.currentTime.textContent="0:00";el.progressBar.value="0";}catch(_){}
 renderPlaylistDetail();
}
function showPlaylistLibraryIfNotVisible(){
 if(playlistEl.library.hidden&&playlistEl.detail.hidden)showPlaylistLibrary();
}
function playPlaylistTrack(index){
 const item=findPlaylist(activePlaylistId);if(!item||!item.songs.length){activePlaylistId="";activePlaylistIndex=-1;return;}
 if(index<0||index>=item.songs.length)index=0;
 activePlaylistIndex=index;
 const song=item.songs[index];
 playlistInternalSwitch=true;
 try{setPlayer({...song});}finally{playlistInternalSwitch=false;}
 renderPlaylistDetail();
}
function handlePlaylistEnded(){
 const item=findPlaylist(activePlaylistId);
 if(!item||!item.songs.length)return;
 playPlaylistTrack((activePlaylistIndex+1)%item.songs.length);
}
function addSongToPlaylist(song){
 const item=currentOpenedPlaylist();if(!item)return;
 if(item.songs.some(existing=>existing.id===song.id)){showToast("이미 이 모음곡에 추가된 노래예요.");return;}
 item.songs.push({id:song.id,title:song.title,channelTitle:song.channelTitle,thumbnail:song.thumbnail,duration:song.duration});
 if(saveMusicPlaylists()){renderPlaylistDetail();showToast("노래를 모음곡에 추가했어요.");}
}
function openPlaylistSongSearch(){
 const item=currentOpenedPlaylist();if(!item)return;
 playlistEl.searchInput.value="";playlistEl.searchResults.replaceChildren();
 playlistEl.searchHint.textContent="검색 결과에서 노래를 선택하면 ‘"+item.name+"’에 추가됩니다.";
 playlistEl.searchDialog.showModal();playlistEl.searchInput.focus();
}
async function searchPlaylistSongs(query){
 const clean=String(query||"").trim();if(!clean)return;
 if(!apiKey){playlistEl.searchDialog.close();openSettings("YouTube API 키를 입력해 주세요.");return;}
 playlistEl.searchButton.disabled=true;playlistEl.searchButton.textContent="검색 중…";
 playlistEl.searchResults.replaceChildren();
 const loading=document.createElement("p");loading.className="playlist-search-message";loading.textContent="음악을 검색하고 있어요…";playlistEl.searchResults.append(loading);
 try{
  const data=await youtubeRequest("search",{part:"snippet",type:"video",videoCategoryId:"10",videoEmbeddable:"true",maxResults:"25",q:clean,regionCode:"KR",relevanceLanguage:"ko",safeSearch:"moderate",order:"relevance"});
  const ids=(data.items||[]).filter(item=>item.id?.videoId).map(item=>item.id.videoId);
  if(!ids.length){playlistEl.searchResults.replaceChildren();const msg=document.createElement("p");msg.className="playlist-search-message";msg.textContent="검색 결과가 없어요.";playlistEl.searchResults.append(msg);return;}
  const details=await youtubeRequest("videos",{part:"snippet,status,contentDetails",id:ids.join(",")});
  const allowed=new Map((details.items||[]).filter(v=>v.snippet?.categoryId==="10"&&v.status?.embeddable===true&&!isLikelyShortVideo(v)).map(v=>[v.id,v]));
  const songs=(data.items||[]).filter(entry=>allowed.has(entry.id.videoId)).map(entry=>{
   const v=allowed.get(entry.id.videoId),thumbs=v.snippet.thumbnails||entry.snippet.thumbnails||{},iso=v.contentDetails?.duration||"PT0S",m=iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
   return{id:v.id,title:v.snippet.title,channelTitle:v.snippet.channelTitle,thumbnail:thumbs.high?.url||thumbs.medium?.url||thumbs.default?.url||"",duration:m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0};
  });
  playlistEl.searchResults.replaceChildren();
  if(!songs.length){const msg=document.createElement("p");msg.className="playlist-search-message";msg.textContent="추가할 수 있는 음악 결과가 없어요.";playlistEl.searchResults.append(msg);return;}
  songs.forEach(song=>{
   const row=document.createElement("div");row.className="playlist-search-result";
   const img=document.createElement("img");img.src=song.thumbnail;img.alt="";
   const info=document.createElement("span");info.className="playlist-search-result-info";
   const title=document.createElement("strong");title.textContent=song.title;
   const artist=document.createElement("small");artist.textContent=song.channelTitle;
   info.append(title,artist);
   const add=document.createElement("button");add.type="button";add.textContent="＋ 추가";
   add.addEventListener("click",()=>{addSongToPlaylist(song);add.textContent="추가됨";add.disabled=true;});
   row.append(img,info,add);playlistEl.searchResults.append(row);
  });
 }catch(error){
  const apiKeyMessage=getApiKeyProblemMessage(error);if(apiKeyMessage){if(playlistEl.searchDialog.open)playlistEl.searchDialog.close();openSettings(apiKeyMessage);}playlistEl.searchResults.replaceChildren();const msg=document.createElement("p");msg.className="playlist-search-message";msg.textContent=apiKeyMessage?"YouTube API 키를 확인해 주세요. 설정 창의 빨간 안내를 확인해 주세요.":(error?.message||"검색에 실패했어요.");playlistEl.searchResults.append(msg);
 }finally{playlistEl.searchButton.disabled=false;playlistEl.searchButton.textContent="검색";}
}
document.getElementById("homeNavButton").addEventListener("click",showMusicHome);
document.getElementById("playlistNavButton").addEventListener("click",showPlaylistLibrary);
document.getElementById("createPlaylistFab").addEventListener("click",()=>{playlistEl.nameInput.value="";playlistEl.createDialog.showModal();playlistEl.nameInput.focus();});
document.getElementById("addPlaylistSongFab").addEventListener("click",openPlaylistSongSearch);
document.getElementById("playlistBackButton").addEventListener("click",showPlaylistLibrary);
document.getElementById("playlistRenameButton").addEventListener("click",()=>{
 const item=currentOpenedPlaylist();if(!item)return;
 const name=prompt("새 모음곡 이름을 입력해 주세요.",item.name);
 if(name===null)return;
 if(!name.trim()){showToast("모음곡 이름은 비워둘 수 없어요.");return;}
 item.name=name.trim().slice(0,40);saveMusicPlaylists();renderPlaylistDetail();
});
document.getElementById("playlistDeleteButton").addEventListener("click",()=>{
 const item=currentOpenedPlaylist();if(!item)return;
 if(!confirm("'"+item.name+"' 모음곡을 삭제할까요?"))return;
 if(activePlaylistId===item.id){activePlaylistId="";activePlaylistIndex=-1;if(ytPlayer)ytPlayer.stopVideo();}
 musicPlaylists=musicPlaylists.filter(entry=>entry.id!==item.id);saveMusicPlaylists();openedPlaylistId="";showPlaylistLibrary();
});
document.getElementById("playlistPlayAllButton").addEventListener("click",togglePlaylistPlayback);
document.getElementById("playlistStopButton").addEventListener("click",stopPlaylistPlayback);
playlistEl.createForm.addEventListener("submit",event=>{event.preventDefault();createPlaylist();});
playlistEl.searchForm.addEventListener("submit",event=>{event.preventDefault();searchPlaylistSongs(playlistEl.searchInput.value);});
document.getElementById("playlistSearchClose").addEventListener("click",()=>playlistEl.searchDialog.close());
playlistEl.searchDialog.addEventListener("click",event=>{if(event.target===playlistEl.searchDialog)playlistEl.searchDialog.close();});
renderPlaylistLibrary();

function registerMusicServiceWorker(){
 if(!("serviceWorker" in navigator)||!/^https?:$/.test(location.protocol))return;
 let refreshing=false;
 navigator.serviceWorker.addEventListener("controllerchange",()=>{
  if(refreshing)return;
  refreshing=true;
  location.reload();
 });
 const updateWorker=async()=>{
  try{
   const registration=await navigator.serviceWorker.register("./sw.js",{scope:"./",updateViaCache:"none"});
   await registration.update();
   if(registration.waiting)registration.waiting.postMessage({type:"SKIP_WAITING"});
  }catch(error){console.warn("Service worker update check failed:",error);}
 };
 window.addEventListener("load",updateWorker,{once:true});
 window.addEventListener("pageshow",()=>{if(document.visibilityState==="visible")updateWorker();});
 document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")updateWorker();});
 window.addEventListener("focus",updateWorker);
}


registerMusicServiceWorker();
