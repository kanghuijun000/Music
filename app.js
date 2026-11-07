const API_BASE="https://www.googleapis.com/youtube/v3";
const STORAGE_KEY="musiq_youtube_api_key_v1";
const LYRIC_API="https://lrclib.net/api";
const lyricState={lines:[],plain:"",lastIndex:-1,lastWordIndex:-1,wordSynced:false,loading:false};
// Small display compensation for polling and paint latency.
const LYRIC_LEAD_SECONDS=0.04;
const lyricCache=new Map();
// TrackID.dev: video-level track timestamps. Results are cached per YouTube video.
const TRACK_ANALYSIS_CACHE_KEY="music_track_timing_v1";
const TRACK_ANALYSIS_CACHE_LIMIT=80;
let lyricOffsetSeconds=0,trackAnalysisToken=0,lyricTimingBasis="catalog";
// Never apply an unverified per-video offset. Use only a matched track timestamp from analysis.
function getVideoLyricOffset(videoId,detected=0){const value=Number(detected);return Number.isFinite(value)&&value>=0?Math.min(value,1800):0;}
function readTrackAnalysisCache(){try{const value=JSON.parse(localStorage.getItem(TRACK_ANALYSIS_CACHE_KEY)||"{}");return value&&typeof value==="object"?value:{};}catch(_){return {};}}
function writeTrackAnalysisCache(cache){try{const entries=Object.entries(cache).sort((a,b)=>(Number(b[1]?.savedAt)||0)-(Number(a[1]?.savedAt)||0));localStorage.setItem(TRACK_ANALYSIS_CACHE_KEY,JSON.stringify(Object.fromEntries(entries.slice(0,TRACK_ANALYSIS_CACHE_LIMIT))));}catch(error){console.warn("Track timing cache could not be saved:",error);}}
function trackText(value){return String(value||"").toLocaleLowerCase().normalize("NFKC").replace(/\[[^\]]*\]|\([^)]*\)/g," ").replace(/\b(official|music video|lyrics?|audio|video|visuali[sz]er|mv|topic|4k|hd|remaster(?:ed)?|live|performance|vevo)\b/gi," ").replace(/가사|뮤직비디오|뮤비|공식영상|오디오|라이브|리마스터/gi," ").replace(/[^\p{L}\p{N}]+/gu," ").trim();}
function trackSimilarity(a,b){const x=trackText(a),y=trackText(b);if(!x||!y)return 0;if(x===y)return 1;if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length);const xs=new Set(x.split(" ")),ys=new Set(y.split(" "));return [...xs].filter(v=>ys.has(v)).length/Math.max(xs.size,ys.size);}
function getLyricsIdentity(video,identifiedTrack=null){
 const cleanVideoTitle=value=>String(value||"")
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\s*(?:ㅣ|\/|\||[-–—])\s*(?:가사|lyrics?|official|뮤직비디오|뮤비|audio|video|live|performance|remaster(?:ed)?).*$/i," ")
  .replace(/\s+/g," ").trim();
 if(identifiedTrack){
  const title=String(identifiedTrack.title||identifiedTrack.trackName||"").trim();
  const artist=String(identifiedTrack.artist||identifiedTrack.artistName||"").trim();
  if(title&&artist){
   const videoTitle=cleanVideoTitle(video?.title);
   const titles=[...new Set([title,...(videoTitle&&trackSimilarity(videoTitle,title)>=0.55?[videoTitle]:[])])];
   const queries=[{title,artist},{title,artist:""}];
   const uniqueQueries=[];
   for(const query of queries){
    const key=trackText(query.title)+"|"+trackText(query.artist);
    if(!uniqueQueries.some(item=>item.key===key))uniqueQueries.push({key,title:query.title,artist:query.artist||""});
   }
   return {raw:title+" - "+artist,title,artist,artistKnown:true,isTopic:false,channel:artist,generic:false,
    titles,queries:uniqueQueries,identified:true};
  }
 }
 const originalTitle=String(video?.title||"").trim();
 // Artist (alternate name) - Song is a common Korean lyric-video title format.
 // Keep the parenthetical text as an artist alias, never as a possible song title.
 const identityTitleSource=originalTitle.replace(/\s*\[[^\]]*\]\s*$/,"").trim();
 const leadingParentheticalArtist=identityTitleSource.match(/^\s*([^()]+?)\s*\(([^()]*)\)\s*[-–—|]\s*(.+?)\s*$/);
 const parentheticalAliases=[...originalTitle.matchAll(/\(([^()]*)\)/g)]
  .map(match=>String(match[1]||"").trim())
  .filter(value=>value
   &&!/^(official|lyrics?|가사|audio|video|뮤직비디오|뮤비|live|performance|remaster(?:ed)?|4k|hd)$/i.test(value)
   &&!/^(?:prod\.?|produced by|feat\.?|ft\.?|featuring)\b/i.test(value)
   &&!/쇼미더머니|\b(?:episode|ep\.?|official video)\b/i.test(value));
 const raw=cleanVideoTitle(originalTitle);
 const parts=raw.split(/\s+[-–—|]\s+/).map(v=>v.trim()).filter(Boolean);
 const channelRaw=String(video?.channelTitle||"").trim();
 const isTopic=/\s*-\s*Topic$/i.test(channelRaw);
 const channel=channelRaw.replace(/\s*-\s*Topic$/i,"").trim();
 const generic=/^(youtube|vevo|various artists|unknown|official|music|stone music entertainment|1thek|kakao entertainment|kakao music|genie music|bugs!?|nhn bugs|danal entertainment|poclanos|mirrorball music|sony music korea|warner music korea|universal music korea|dingo music|딩고뮤직|멜론|melon|mnet|kbs kpop|mbckpop|sbs kpop)$/i.test(channel);
 let title=raw,artist="",artistKnown=false,queries=[],artistAliases=[];
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
 if(leadingParentheticalArtist&&!artistKnown){
  const candidateArtist=String(leadingParentheticalArtist[1]||"").trim();
  const parentheticalName=String(leadingParentheticalArtist[2]||"").trim();
  const songTitle=String(leadingParentheticalArtist[3]||"").trim();
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
 const titleAliases=artistAliases.length&&leadingParentheticalArtist
  ?parentheticalAliases.filter(value=>value!==String(leadingParentheticalArtist[2]||"").trim())
  :parentheticalAliases;
 // Only real song-title candidates belong in global validation.
 // The opposite side of an ambiguous "A - B" title is queried separately;
 // treating both sides as titles can accept lyrics for the artist name itself.
 const uniqueTitles=[...new Set([title,...titleAliases].map(v=>String(v||"").trim()).filter(Boolean))];
 if(!queries.length)queries=[{title,artist:artistKnown?artist:""}];
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
 return {raw,title,artist,artistAliases,artistKnown,isTopic,channel,generic,titles:uniqueTitles,queries:uniqueQueries.slice(0,10)};
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
 const add=(prefix,title,artist="")=>{
  const t=lyricCacheNormalize(title),a=lyricCacheNormalize(artist);
  if(!t)return;
  const key=prefix==="title"?"song-title:"+t:"song:"+t+"|"+a;
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
function sharedLyricCacheMatches(cached,video){
 if(!cached||!cached.trackName)return false;
 const identity=getLyricsIdentity(video);
 const titleScore=Math.max(0,...identity.titles.map(title=>trackSimilarity(title,cached.trackName)));
 if(titleScore<0.92)return false;
 // Shared lyrics must never be reused from title guesses alone.
 // Require an independently established artist identity.
 if(!identity.artistKnown)return false;
 const cachedArtist=String(cached.artistName||"").trim();
 if(!cachedArtist||trackSimilarity(identity.artist,cachedArtist)<0.90)return false;
 return true;
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
 return Boolean(item&&(String(item.plain||"").trim()||(Array.isArray(item.lines)&&item.lines.some(line=>line&&String(line.text||"").trim()))));
}
function prepareSharedCacheForVideo(item,sourceKey,targetVideoId){
 if(!item)return null;
 if(item.timingBasis!=="video"||sourceKey===targetVideoId)return item;
 const plain=String(item.plain||"").trim()||((item.lines||[]).map(line=>String(line?.text||"").trim()).filter(Boolean).join("\n"));
 if(!plain)return null;
 return {...item,lines:[],plain,wordSynced:false,timingBasis:"catalog",source:"Shared song text"};
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
  const score=trackSimilarity(cached.trackName,identity.title)*0.65+trackSimilarity(cached.artistName,identity.artist)*0.35;
  if(score>bestScore){bestScore=score;best=prepareSharedCacheForVideo(cached,key,video.id);}
 }
 return best;
}
function findSharedPlainLyricCache(video){
 const entries=readAllStoredLyricEntries(),identity=getLyricsIdentity(video);
 for(const key of getSongLyricCacheKeys(video)){
  const cached=entries.find(entry=>entry[0]===key)?.[1];
  if(cached&&cached.source==="Unison shared text"&&String(cached.plain||"").trim()&&sharedLyricCacheMatches(cached,video))return cached;
 }
 let best=null,bestScore=0;
 for(const [key,cached] of entries){
  if(cached?.source!=="Unison shared text"||!String(cached.plain||"").trim()||!sharedLyricCacheMatches(cached,video))continue;
  const score=trackSimilarity(cached.trackName,identity.title)*0.65+trackSimilarity(cached.artistName,identity.artist)*0.35;
  if(score>bestScore){bestScore=score;best=cached;}
 }
 return best;
}
function findIdentifiedLyricCache(video,identifiedTrack){
 const metadata={trackName:identifiedTrack?.title||"",artistName:identifiedTrack?.artist||"",acoustidId:identifiedTrack?.acoustidId||""};
 const entries=readAllStoredLyricEntries();
 for(const key of getSongLyricCacheKeys(video,metadata)){
  const cached=entries.find(entry=>entry[0]===key)?.[1];
  if(!hasUsableCachedLyrics(cached))continue;
  if(key.startsWith("song-acoustid:")||(trackSimilarity(cached.trackName,metadata.trackName)>=0.92&&trackSimilarity(cached.artistName,metadata.artistName)>=0.82)){
   const prepared=prepareSharedCacheForVideo(cached,key,video.id);if(prepared)return prepared;
  }
 }
 let best=null,bestScore=0;
 for(const [key,cached] of entries){
  if(!hasUsableCachedLyrics(cached)||!cached.trackName||!cached.artistName)continue;
  const titleScore=trackSimilarity(cached.trackName,metadata.trackName),artistScore=trackSimilarity(cached.artistName,metadata.artistName);
  if(titleScore<0.92||artistScore<0.82)continue;
  const score=titleScore*0.6+artistScore*0.4;
  if(score>bestScore){bestScore=score;best=prepareSharedCacheForVideo(cached,key,video.id);}
 }
 return best;
}
function storeIdentifiedLyricsForSong(video,identifiedTrack){
 if(!identifiedTrack||!hasUsableCachedLyrics({lines:lyricState.lines,plain:lyricState.plain}))return false;
 const videoBound=lyricTimingBasis==="video";
 const plain=String(lyricState.plain||"").trim()||(videoBound?(lyricState.lines||[]).map(line=>String(line.text||"").trim()).filter(Boolean).join("\n"):"");
 const item={lines:videoBound?[]:(lyricState.lines||[]).map(line=>({...line})),plain,
  wordSynced:videoBound?false:Boolean(lyricState.wordSynced),timingBasis:"catalog",source:"Identified song shared text",
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
function promoteVideoLyricsToSongCache(sourceOffset){
 const videoId=currentVideoId;
 const cached=lyricCache.get(videoId)||readStoredLyric(videoId);
 if(!cached||cached.timingBasis!=="video"||!Array.isArray(cached.lines)||!cached.lines.length||!cached.videoMetadata)return false;
 const offset=Math.max(0,Math.min(1800,Number(sourceOffset)||0));
 const normalizedLines=cached.lines.map(line=>({...line,time:Math.max(0,Number(line.time)-offset)}));
 const normalized={...cached,lines:normalizedLines,timingBasis:"catalog",source:"Unison aligned"};
 lyricTimingBasis="catalog";lyricOffsetSeconds=0;
 lyricState.lines=normalizedLines;lyricState.plain=String(cached.plain||"");
 lyricState.wordSynced=Boolean(cached.wordSynced);lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;
 storeLyricsForVideo(cached.videoMetadata,normalized,true);
 renderLyrics();
 return true;
}
function selectTrackStart(tracks,video){const expected=expectedTrackIdentity(video);const candidates=(Array.isArray(tracks)?tracks:[]).map(track=>{const title=trackSimilarity(track.title,expected.title);const artist=expected.artist?trackSimilarity(track.artist,expected.artist):(track.artist?0.65:0.4);const confidence=Number(track.confidence)||0;return{track,title,artist,confidence,score:title*0.62+artist*0.23+confidence*0.15};}).filter(item=>Number.isFinite(Number(item.track?.timestamp))&&Number(item.track.timestamp)>=0&&item.title>=0.68&&item.artist>=0.45&&item.confidence>=0.65).sort((a,b)=>b.score-a.score);return candidates[0]?.track||null;}
function applyTrackOffset(seconds){
 const hasMatch=seconds!==null&&seconds!==undefined&&Number.isFinite(Number(seconds));
 const value=hasMatch?Number(seconds):0;
 if(lyricTimingBasis==="video"){
  if(hasMatch)promoteVideoLyricsToSongCache(value);
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
  const confidence=Number(track?.confidence),duration=Number(track?.duration),timestamp=Number(track?.timestamp);
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
 try{await initialLyricsPromise;}catch(_){}
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
 currentIdentifiedTrack=identified;
 loadAlbumArtwork(video,identified);
 // Apply the fingerprint timestamp even when the existing lyrics already match.
 // Video-bound lyrics are normalized by applyTrackOffset before being reused.
 applyTrackOffset(getVideoLyricOffset(video.id,identified.timestamp));
 if(hasLyrics&&sameTrack){
  storeIdentifiedLyricsForSong(video,identified);
  setLyricsStatus("음원 확인 · "+identified.artist+" — "+identified.title);
  return true;
 }
 showLyricsMessage("음원으로 "+identified.artist+" — "+identified.title+"을 확인했어요. 가사를 다시 검색하고 있어요…");
 await loadLyrics(video,false,identified);
 if(!isCurrent()||currentVideoId!==video.id)return;
 const found=Boolean(lyricState.lines.length||String(lyricState.plain||"").trim());
 if(!found&&previous){
  // Never keep lyrics from a different track after audio fingerprinting identifies this video.
  lyricState.lines=[];lyricState.plain="";lyricState.wordSynced=false;
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.loading=false;
  lyricTimingBasis="catalog";lyricOffsetSeconds=0;currentLyricsTrack=null;
  renderLyrics();
  setLyricsStatus("음원은 확인했지만 해당 곡과 일치하는 가사를 찾지 못했어요. 다른 곡의 가사는 표시하지 않았어요.");
 }else if(found){
  storeIdentifiedLyricsForSong(video,identified);
  setLyricsStatus("음원 식별로 곡 정보 보정됨");
 }
 return true;
}
async function startTrackOffsetAnalysis(video,initialLyricsPromise=Promise.resolve()){
 const token=++trackAnalysisToken,videoId=String(video?.id||"");if(!videoId)return;
 const cache=readTrackAnalysisCache();let cached=cache[videoId];const now=Date.now();
 const isCurrent=()=>token===trackAnalysisToken&&videoId===currentVideoId;
 const finishWithTracks=async tracks=>{
  try{await initialLyricsPromise;}catch(_){}
  if(!isCurrent())return;
  const identifiedHandled=await tryLoadLyricsFromIdentifiedTrack(video,tracks,initialLyricsPromise,isCurrent);
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
   const tracks=Array.isArray(job.tracks)?job.tracks:[];
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

const LYRIC_CACHE_STORAGE_KEY="music_lyrics_cache_v23";
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

const ids=["searchForm","searchInput","searchButton","coverImage","resultsTitle","resultCount","resultsList","messageState","playerFrame","nowTitle","nowChannel","connectionStatus","settingsButton","settingsDialog","apiKeyInput","saveKeyButton","removeKeyButton","progressBar","currentTime","totalTime","playPauseButton","playbackState","lyricsView","lyricsStatus","lyricsDiagnostics","lyricsDiagnosticsContent"];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
let apiKey=localStorage.getItem(STORAGE_KEY)||"",currentVideoId="",lastResults=[],toastTimer,ytPlayer=null,ytReady=false,progressTimer=null,lyricTimer=null,seeking=false,lyricLoadToken=0,lyricAbortController=null,selectedVideoDuration=0,contentTimelineReady=false,searchRequestToken=0,searchAbortController=null;
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
let recentSearches=loadRecentSearches();
function loadRecentSearches(){
 try{
  const saved=JSON.parse(localStorage.getItem(HISTORY_KEY)||"[]");
  return Array.isArray(saved)?saved.filter(item=>typeof item==="string"&&item.trim()).slice(0,HISTORY_LIMIT):[];
 }catch(_){return [];}
}
function saveRecentSearch(query){
 const value=String(query||"").trim();
 if(!value)return;
 recentSearches=[value,...recentSearches.filter(item=>item.toLocaleLowerCase()!==value.toLocaleLowerCase())].slice(0,HISTORY_LIMIT);
 try{localStorage.setItem(HISTORY_KEY,JSON.stringify(recentSearches));}catch(error){console.warn("Recent searches could not be saved:",error);}
 renderRecentSearches();
}
function renderRecentSearches(){
 const panel=document.getElementById("recentSearches");
 if(!panel)return;
 panel.replaceChildren();
 if(!recentSearches.length){panel.hidden=true;return;}
 const heading=document.createElement("div");
 heading.className="recent-heading";
 const label=document.createElement("span");
 label.textContent="최근 검색";
 const clear=document.createElement("button");
 clear.type="button";clear.className="recent-clear";clear.textContent="전체 삭제";
 clear.addEventListener("click",event=>{event.stopPropagation();recentSearches=[];try{localStorage.removeItem(HISTORY_KEY);}catch(_){}renderRecentSearches();el.searchInput.focus();});
 heading.append(label,clear);panel.append(heading);
 recentSearches.forEach(query=>{
  const row=document.createElement("div");row.className="recent-row";
  const choose=document.createElement("button");choose.type="button";choose.className="recent-query";
  const icon=document.createElement("span");icon.className="recent-clock";icon.textContent="↺";
  const text=document.createElement("span");text.className="recent-query-text";text.textContent=query;
  choose.append(icon,text);
  choose.addEventListener("click",()=>{el.searchInput.value=query;hideRecentSearches();searchMusic(query);});
  const remove=document.createElement("button");remove.type="button";remove.className="recent-remove";remove.textContent="×";remove.setAttribute("aria-label",query+" 기록 삭제");
  remove.addEventListener("click",event=>{event.stopPropagation();recentSearches=recentSearches.filter(item=>item!==query);try{localStorage.setItem(HISTORY_KEY,JSON.stringify(recentSearches));}catch(_){}renderRecentSearches();});
  row.append(choose,remove);panel.append(row);
 });
 panel.hidden=false;
}
function showRecentSearches(){if(recentSearches.length)renderRecentSearches();}
function hideRecentSearches(){const panel=document.getElementById("recentSearches");if(panel)panel.hidden=true;}
function updateConnectionStatus(){const ready=Boolean(apiKey);el.connectionStatus.classList.toggle("ready",ready);el.connectionStatus.innerHTML=ready?"<i></i> 검색 연결됨":"<i></i> API 미설정";}
function showToast(message){let toast=document.querySelector(".toast");if(!toast){toast=document.createElement("div");toast.className="toast";toast.setAttribute("role","status");document.body.appendChild(toast);}toast.textContent=message;toast.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove("show"),2600);}
function openSettings(){el.apiKeyInput.value=apiKey;el.settingsDialog.showModal();}
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
   output.push({time,text:ordered.map(word=>word.text).join(""),words:ordered});
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
  if(indent===4&&s.startsWith("start_ms:")){line.time=Number(s.slice(9).trim())/1000;continue;}
  if(indent===4&&s.startsWith("end_ms:")){line.end=Number(s.slice(7).trim())/1000;continue;}
  if(indent===4&&s==="words:"){insideWords=true;continue;}
  if(indent===6&&insideWords&&s.startsWith("- text:")){
   saveWord();word={text:parseYamlText(s.slice(7).trim()),start:NaN,end:NaN};continue;
  }
  if(indent===8&&insideWords&&word&&s.startsWith("start_ms:")){word.start=Number(s.slice(9).trim())/1000;continue;}
  if(indent===8&&insideWords&&word&&s.startsWith("end_ms:")){word.end=Number(s.slice(7).trim())/1000;continue;}
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
 const relativeTime=current-lyricOffsetSeconds;
 const lyricTime=Math.max(0,relativeTime+LYRIC_LEAD_SECONDS);
 let index=-1;
 if(timelineReady&&relativeTime>=0){for(let i=0;i<lyricState.lines.length;i++){if(lyricState.lines[i].time<=lyricTime)index=i;else break;}}
 // 플레이어 타임라인이 준비되기 전에도 첫 세 줄을 미리 보여준다.
 const wordIndex=-1;
 if(index===lyricState.lastIndex&&wordIndex===lyricState.lastWordIndex&&timelineReady)return;
 lyricState.lastIndex=index;lyricState.lastWordIndex=wordIndex;
 el.lyricsView.replaceChildren();
 const start=index<0?0:Math.max(0,index-1),end=index<0?Math.min(lyricState.lines.length,3):Math.min(lyricState.lines.length,index+2);
 for(let i=start;i<end;i++){
  const item=lyricState.lines[i],row=document.createElement("div");
  row.className="lyric-line"+(i===index?" current":"")+(i<index?" past":"");
  row.textContent=item.text;
  el.lyricsView.append(row);
 }
 el.lyricsStatus.textContent="";
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
 const requestId=++lyricLoadToken;
 if(lyricAbortController)lyricAbortController.abort(new Error("다른 곡으로 전환했어요."));
 const requestController=new AbortController();
 lyricAbortController=requestController;
 const lyricSignal=requestController.signal;
 const diagnostics=[];
 const candidates=[];
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
 if(cached&&((Array.isArray(cached.lines)&&cached.lines.some(line=>line&&Number.isFinite(Number(line.time))&&String(line.text||"").trim()))||String(cached.plain||"").trim())&&!usePuter){
  lyricState.lines=(cached.lines||[]).filter(item=>item&&Number.isFinite(Number(item.time))&&String(item.text||"").trim()&&!isCreditMetadata(item.text)).map(item=>({...item,time:Number(item.time)}));
  lyricState.plain=String(cached.plain||"").split(/\r?\n/).filter(line=>line.trim()&&!isCreditMetadata(line)).join("\n");
  lyricState.wordSynced=Boolean(cached.wordSynced);
  currentLyricsTrack={title:cached.trackName||"",artist:cached.artistName||"",duration:Number(cached.duration)||0};
  lyricTimingBasis=cached.timingBasis==="video"?"video":"catalog";
  lyricOffsetSeconds=lyricTimingBasis==="video"?0:lyricOffsetSeconds;
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.loading=false;
  renderLyrics();
  return;
 }
 if(cached&&!usePuter)record("로컬 캐시","CACHE_EMPTY","저장된 항목에 표시 가능한 가사가 없어 새로 검색합니다.");
 lyricState.loading=true;lyricState.lines=[];lyricState.plain="";
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
  const title=titleScore(item.trackName||item.title||item.song||"",extraTitles);
  const singer=artistScore(item.artistName||item.artist||"",extraArtists);
  const duration=durationScore(item.duration);
  const itemArtist=String(item.artistName||item.artist||"").trim();
  // Candidate artist metadata can support a match when the video identity is unknown,
  // but only together with a close duration and a strong title match.
  const closeDuration=duration>=22;
  const exactVideoSource=provider==="Unison"&&item._sameVideoSource===true;
  const expectedTitles=[identity.title,...identity.titles,...extraTitles].map(normalize).filter(Boolean);
  const hasShortAmbiguousTitle=expectedTitles.some(value=>value.replace(/\s+/g,"").length<=2);
  const artistNames=[identity.artist,...(identity.artistAliases||[]),...(identity.isTopic?[channel]:[]),...extraArtists].filter(Boolean).map(normalize);
  const exactArtistMatch=Boolean(itemArtist)&&artistNames.includes(normalize(itemArtist));
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
   if((identity.artistKnown||extraArtists.length)&&(!itemArtist||singer<75)){item._rejectCode="MATCH_ARTIST_MISMATCH";record(provider,item._rejectCode,"가수 정보 불일치 ("+Math.round(singer)+")");return null;}
  }
  const lines=extractLines(item).filter(line=>line&&Number.isFinite(Number(line.time))&&Number(line.time)>=0&&String(line.text||"").trim()&&!isCreditMetadata(line.text))
   .map((line,index)=>({...line,time:Number(line.time),_order:index}))
   .sort((a,b)=>a.time-b.time);
  const songDuration=Number(item.duration)||Number(video.duration)||0;
  const validLines=lines.length>=2&&(!songDuration||lines.every(line=>line.time<=songDuration+90));
  lines.forEach(line=>delete line._order);
  const plain=String(item.plainLyrics||item.plain||"").split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!isCreditMetadata(line));
  if(!validLines&&!plain.length){
   item._rejectCode=lines.length?"PARSE_TIMESTAMPS_INVALID":"PARSE_NO_LYRICS";
   record(provider,item._rejectCode,lines.length+"개 타임스탬프 행을 읽었지만 표시 조건을 통과하지 못했습니다.");
   return null;
  }
  const normalized={...item,ttmlLines:validLines?lines:[],plainLyrics:plain.join("\n")};
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
  const valid=validate(item,extraArtists,extraTitles,provider);
  if(valid){valid._source=provider;candidates.push(valid);}
  return valid;
 }
 const jobs=[];
 jobs.push((async()=>{
  const provider="Unison";
  try{
   let body=null,lookupMode="video",lookupArtist="";
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
    record(provider,"UNISON_NOT_FOUND","현재 영상과 곡·가수 기준 검색에서 가사를 찾지 못했습니다.");
    return;
   }
   const data=body.data;
   const format=String(data.format||"").toLowerCase();
   const parsedLines=format==="ttml"?parseTtml(data.lyrics):format==="lrc"?parseLrc(data.lyrics):[];
   const sourceVideoId=String(data.videoId||"");
   const sameVideo=sourceVideoId?sourceVideoId===video.id:lookupMode==="video";
   let normalizedOtherVideoLines=[];
   if(!sameVideo&&sourceVideoId&&parsedLines.length>1){
    const sourceTiming=readTrackAnalysisCache()[sourceVideoId];
    if(sourceTiming?.status==="completed"){
     const sourceArtist=data.artist||artist||"";
     const referenceVideo={id:sourceVideoId,title:[data.song||track,sourceArtist].filter(Boolean).join(" - "),
      channelTitle:sourceArtist?sourceArtist+" - Topic":"",duration:Number(data.duration)||0};
     const sourceMatch=selectTrackStart(sourceTiming.tracks,referenceVideo);
     if(sourceMatch){
      const sourceOffset=getVideoLyricOffset(sourceVideoId,sourceMatch.timestamp);
      normalizedOtherVideoLines=parsedLines.map(line=>({...line,time:Math.max(0,Number(line.time)-sourceOffset)}));
     }
    }
   }
   const videoTimed=sameVideo&&parsedLines.length>1;
   const otherVideoAligned=!sameVideo&&normalizedOtherVideoLines.length>1;
   const otherVideoText=!videoTimed&&!otherVideoAligned;
   const usableLines=videoTimed?parsedLines:otherVideoAligned?normalizedOtherVideoLines:[];
   const fallbackText=format==="plain"?data.lyrics:parsedLines.map(line=>line.text).filter(Boolean).join("\n");
   const valid=accept(provider,{trackName:data.song||data.track||track,artistName:data.artist||artist,duration:Number(data.duration)||video.duration,
    syncedLyrics:videoTimed&&format==="lrc"?data.lyrics:"",plainLyrics:format==="plain"?data.lyrics:(otherVideoText?(fallbackText||extractPlainText(data.lyrics)):""),
    ttmlLines:usableLines,hasWordSync:usableLines.some(line=>line.words?.length),
    communityConfidence:data.confidence||"",_videoBound:videoTimed,_sameVideoSource:sameVideo,_unisonOtherVideo:otherVideoText,_unisonSourceVideoId:sourceVideoId},lookupArtist?[lookupArtist]:[],[data.song||track]);
   if(!valid)record(provider,"UNISON_RESULT_REJECTED","응답은 받았지만 제목·가수·가사 형식 검증에서 제외됐습니다.");
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
     const valid=accept(provider,{trackName:data.track||variant.title,artistName:data.artist||variant.artist,
      duration:Number(data.duration)||video.duration,syncedLyrics:timed,plainLyrics:data.plain||extractPlainText(timed),ttmlLines:lines,hasWordSync:enhanced.length>0},[variant.artist],[variant.title]);
     if(!valid)record(provider,"SYNCLRC_NO_MATCH","직접 조회 응답에 검증 가능한 가사가 없습니다.");
    }catch(error){if(error?.code!=="CANCELLED"&&error?.status!==429&&error?.code!=="HTTP_404")record(provider,error?.code||"PROVIDER_ERROR",error?.message||"제공처 오류",error?.elapsed||0,error?.status||"");}
   }));
  }
  // Search fallback also runs for known artists, with a strict artist match in that case.
  if(!candidates.some(item=>item._source===provider)){
   const queries=[...new Set(identity.queries.map(item=>item.title).filter(Boolean))].slice(0,6);
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
      const title=titleScore(item.track||"",[query]);
      const candidateArtist=String(item.artist||"").trim();
      const artistMatches=identity.artistKnown?artistScore(candidateArtist,[identity.artist])>=75:Boolean(candidateArtist);
      const duration=Number(item.duration)||0,want=Number(video.duration)||0;
      const closeDuration=!duration||!want||Math.abs(duration-want)<=Math.max(20,want*0.12);
      return title>=78&&artistMatches&&closeDuration;
     }).sort((a,b)=>durationScore(b.duration)-durationScore(a.duration));
     for(const item of matches.slice(0,3)){
      const lyrics=item.lyrics||{};
      const timed=lyrics.karaoke||lyrics.synced||"";
      const enhanced=parseEnhancedLrc(timed),lines=enhanced.length?enhanced:parseLrc(timed);
      const valid=accept(provider,{trackName:item.track,artistName:item.artist,duration:Number(item.duration)||video.duration,
       syncedLyrics:timed,plainLyrics:lyrics.plain||extractPlainText(timed),ttmlLines:lines,hasWordSync:enhanced.length>0},
       identity.artistKnown?[identity.artist]:[item.artist],[query]);
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
     if(accept(provider,item,query.variant?.artist?[query.variant.artist]:[],[query.variant?.title||track]))accepted++;
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
    const {data}=await fetchJson(url,{},8000,provider+"/TTML");
    const lines=parseTtml(data.ttml||"");
    const valid=accept(provider+"/TTML",{trackName:variant.title,artistName:variant.artist||artist,
     duration:Number(video.duration)||0,ttmlLines:lines,plainLyrics:"",matchConfidence:Number(data.score)||0},
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
     const valid=accept(provider+"/"+endpoint.name,{trackName:data.track||data.song||variant.title,
      artistName:data.artistName||data.artist||variant.artist||artist,duration:Number(data.duration)||video.duration,
      syncedLyrics:endpoint.name==="Kugou"?data.lyrics:"",ttmlLines:lines,plainLyrics:data.plainLyrics||extractPlainText(data.lyrics),hasWordSync:endpoint.name==="QQ"},variant.artist?[variant.artist]:[],[variant.title]);
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
 const allJobs=Promise.allSettled(jobs);
 let searchDeadlineTimer;
 const deadline=new Promise(resolve=>{searchDeadlineTimer=setTimeout(()=>resolve(false),13000);});
 const jobsCompleted=await Promise.race([allJobs.then(()=>true),deadline]);
 clearTimeout(searchDeadlineTimer);
 if(!jobsCompleted){
  record("전체 검색","SEARCH_DEADLINE","13초 제한에 도달해 남은 제공처 요청을 취소합니다.");
  requestController.abort(Object.assign(new Error("가사 검색 제한 시간 초과"),{code:"CANCELLED"}));
  await allJobs;
 }
 if(requestId!==lyricLoadToken)return;
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
   const {data}=await fetchJson(url,{},7000,"Better Lyrics/TTML");
   const candidate={trackName:data.track||track,artistName:data.artist||artist,duration:Number(data.duration)||Number(albumMatch.duration),
    ttmlLines:parseTtml(data.ttml||""),syncedLyrics:"",plainLyrics:data.plainLyrics||"",matchConfidence:Number(data.score)||0};
   const valid=accept("Better Lyrics/TTML",candidate,albumMatch.artistName?[albumMatch.artistName]:[],[albumMatch.trackName||track]);
   if(!valid)record("Better Lyrics/TTML","TTML_RESULT_REJECTED","TTML 응답을 받았지만 파싱 또는 곡 검증에서 제외됐습니다.");
  }catch(error){if(error?.code!=="CANCELLED"&&error?.status!==404&&error?.status!==429)record("Better Lyrics/TTML",error?.code||"PROVIDER_ERROR",error?.message||"제공처 오류",error?.elapsed||0,error?.status||"");}
 }
 if(requestId!==lyricLoadToken)return;
 candidates.sort((a,b)=>{
  const sync=(b._synced?10000:0)-(a._synced?10000:0);
  return sync+(b._score-a._score);
 });
 const selected=candidates.find(item=>item._synced)||candidates.find(item=>item.plainLyrics);
 if(!selected){
  const sharedPlain=identifiedTrack?null:findSharedPlainLyricCache(video);
  if(sharedPlain){
   lyricState.loading=false;lyricState.lines=[];lyricState.plain=String(sharedPlain.plain||"");
   currentLyricsTrack={title:sharedPlain.trackName||"",artist:sharedPlain.artistName||"",duration:Number(sharedPlain.duration)||0};
   lyricState.wordSynced=false;lyricTimingBasis="catalog";lyricOffsetSeconds=0;
   lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;renderLyrics();
   el.lyricsStatus.textContent="일반 가사 · 다른 영상에서 가져옴 (싱크 정보 없음)";
   hideDiagnostics();return;
  }
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
 const hasWords=wordLines.some(item=>item.words?.length);
 lyricState.lines=(selected._synced?wordLines:[]).filter(item=>!isCreditMetadata(item.text));
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
 currentLyricsTrack={title:selected.trackName||selected.title||track,artist:selected.artistName||selected.artist||artist,duration:Number(selected.duration)||0};
 const sourceIsVideoBound=Boolean(selected._videoBound);
 const fromOtherUnisonVideo=Boolean(selected._unisonOtherVideo);
 lyricTimingBasis=sourceIsVideoBound?"video":"catalog";
 const cachedLyrics={lines:lyricState.lines,plain:lyricState.plain,wordSynced:hasWords,timingBasis:lyricTimingBasis,
  source:fromOtherUnisonVideo?"Unison shared text":selected._source,
  trackName:selected.trackName||selected.title||track,artistName:selected.artistName||selected.artist||artist,duration:Number(selected.duration)||Number(video.duration)||0,
  acoustidId:identifiedTrack?.acoustidId||currentIdentifiedTrack?.acoustidId||"",
  videoMetadata:{id:video.id,title:video.title,channelTitle:video.channelTitle,duration:Number(video.duration)||0}};
 if(sourceIsVideoBound){
  storeLyric(video.id,cachedLyrics);
  const sharedText={...cachedLyrics,lines:[],plain:lyricState.plain||lyricState.lines.map(line=>line.text).filter(Boolean).join("\n"),
   wordSynced:false,timingBasis:"catalog",source:"Unison shared text"};
  if(sharedText.plain.trim())for(const key of getSongLyricCacheKeys(video,sharedText))storeLyric(key,sharedText);
  const timingCache=readTrackAnalysisCache()[video.id];
  if(timingCache?.status==="completed"){
   const match=selectTrackStart(timingCache.tracks,video);
   if(match)applyTrackOffset(getVideoLyricOffset(video.id,match.timestamp));
  }
 }else if(fromOtherUnisonVideo){
  lyricState.lines=[];lyricState.wordSynced=false;lyricTimingBasis="catalog";
  cachedLyrics.lines=[];cachedLyrics.wordSynced=false;cachedLyrics.timingBasis="catalog";
  cachedLyrics.plain=lyricState.plain||cachedLyrics.plain;
  if(cachedLyrics.plain.trim())for(const key of getSongLyricCacheKeys(video,cachedLyrics))storeLyric(key,cachedLyrics);
 }else storeLyricsForVideo(video,cachedLyrics,true);
 lyricState.loading=false;
 hideDiagnostics();
 renderLyrics();
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
function onYouTubeIframeAPIReady(){ytPlayer=new YT.Player("playerFrame",{width:"200",height:"200",videoId:"",playerVars:{autoplay:0,controls:0,playsinline:1,rel:0,fs:0,iv_load_policy:3,disablekb:1},events:{onReady:()=>{ytReady=true;el.playbackState.textContent="재생 준비 완료";if(currentVideoId)ytPlayer.loadVideoById(currentVideoId);},onStateChange:event=>{if(event.data===YT.PlayerState.PLAYING){el.playbackState.textContent="재생 중";updateMediaSession("playing");clearInterval(progressTimer);progressTimer=setInterval(updateProgress,100);clearInterval(lyricTimer);lyricTimer=setInterval(renderLyrics,50);}else if(event.data===YT.PlayerState.PAUSED){clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;el.playbackState.textContent="일시정지";updateMediaSession("paused");updateProgress();}else if(event.data===YT.PlayerState.ENDED){clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;el.playbackState.textContent="재생 완료";updateMediaSession("none");updateProgress();}else if(event.data===YT.PlayerState.BUFFERING){el.playbackState.textContent="불러오는 중…";}},onError:event=>{clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;contentTimelineReady=false;el.playPauseButton.disabled=true;el.progressBar.disabled=true;el.playbackState.textContent="재생할 수 없는 영상";const reason=event.data===101||event.data===150?"영상 소유자가 외부 플레이어 재생을 허용하지 않아요.":event.data===100?"영상이 삭제되었거나 비공개예요.":"YouTube 플레이어에서 재생 오류가 발생했어요.";showToast(reason+" 다른 검색 결과를 선택해 주세요.");}}});}
window.onYouTubeIframeAPIReady=onYouTubeIframeAPIReady;
const ytScript=document.createElement("script");ytScript.src="https://www.youtube.com/iframe_api";ytScript.async=true;document.head.appendChild(ytScript);
function setPlayer(video){currentVideoId=video.id;currentIdentifiedTrack=null;currentLyricsTrack=null;clearAlbumArtwork();lyricOffsetSeconds=0;lyricTimingBasis="catalog";trackAnalysisToken++;clearInterval(progressTimer);progressTimer=null;clearInterval(lyricTimer);lyricTimer=null;seeking=false;selectedVideoDuration=Number(video.duration)||0;contentTimelineReady=false;updateMediaMetadata(video);updateMediaSession("none");el.nowTitle.textContent=video.title;el.nowChannel.textContent=video.channelTitle;el.currentTime.textContent="0:00";el.totalTime.textContent=formatTime(video.duration);el.progressBar.value="0";el.progressBar.max=String(Math.max(1,Math.floor((video.duration||0)*10)));el.progressBar.disabled=true;el.playPauseButton.disabled=true;el.playbackState.textContent="YouTube 플레이어 연결 중…";if(ytReady&&ytPlayer)ytPlayer.loadVideoById(video.id);renderResults(lastResults);const inferred=getLyricsIdentity(video);if(inferred.artistKnown)loadAlbumArtwork(video,{title:inferred.title,artist:inferred.artist});const lyricsPromise=loadLyrics(video);lyricsPromise.then(()=>{if(currentVideoId===video.id&&currentLyricsTrack?.title&&currentLyricsTrack?.artist)loadAlbumArtwork(video,currentLyricsTrack);}).catch(error=>console.warn("Artwork metadata follow-up skipped:",error?.message||error));startTrackOffsetAnalysis(video,lyricsPromise);}
function renderResults(items){el.resultsList.replaceChildren();el.messageState.hidden=items.length>0;if(!items.length)return;const fragment=document.createDocumentFragment();items.forEach((video,index)=>{const row=document.createElement("article"),image=document.createElement("img"),info=document.createElement("div"),title=document.createElement("div"),channel=document.createElement("div"),badge=document.createElement("div"),play=document.createElement("button");row.className="track"+(video.id===currentVideoId?" active":"");image.className="track-thumb";image.src=video.thumbnail;image.alt="";image.loading=index>5?"lazy":"eager";info.className="track-info";title.className="track-title";title.textContent=video.title;channel.className="track-channel";channel.textContent=video.channelTitle;badge.className="track-badge";badge.textContent="음악";info.append(title,channel,badge);play.type="button";play.className="play-track";play.setAttribute("aria-label",video.title+" 재생");play.innerHTML='<svg viewBox="0 0 24 24"><path d="M7 4.8c0-.8.9-1.3 1.6-.9l10.2 7.2c.6.4.6 1.3 0 1.8L8.6 20.1c-.7.5-1.6 0-1.6-.9V4.8Z"/></svg>';play.addEventListener("click",()=>setPlayer(video));row.addEventListener("click",event=>{if(!event.target.closest("button"))setPlayer(video);});row.append(image,info,play);fragment.append(row);});el.resultsList.append(fragment);}
async function youtubeRequest(endpoint,params,signal){const url=new URL(API_BASE+"/"+endpoint);Object.entries({...params,key:apiKey}).forEach(([key,value])=>url.searchParams.set(key,value));let response;try{response=await fetch(url,{signal});}catch(error){if(signal?.aborted)throw new Error(signal.reason?.message||"검색 요청이 취소됐어요.");throw new Error("Google API에 연결하지 못했어요. ("+(error?.message||"네트워크 오류")+")");}let data={};try{data=await response.json();}catch(_){}if(!response.ok){const apiError=data?.error||{},reason=apiError.errors?.[0]?.reason||"reason 정보 없음",message=apiError.message||response.statusText||"Google 오류",status=response.status;let hint="";if(reason==="keyInvalid"||reason==="keyExpired")hint="Google Cloud에서 키가 유효한지 확인하세요.";else if(reason==="accessNotConfigured")hint="YouTube Data API v3를 활성화해야 합니다.";else if(reason==="quotaExceeded"||reason==="dailyLimitExceeded")hint="YouTube Data API 할당량을 초과했습니다.";else if(/referer|referrer|API_KEY_HTTP_REFERRER_BLOCKED/i.test(reason+" "+message))hint="GitHub Pages 도메인을 웹사이트 제한에 등록해야 합니다.";throw new Error("요청 단계: "+endpoint+". HTTP "+status+". Google 오류 코드: "+reason+". 설명: "+message+(hint?" 해결 단서: "+hint:""));}return data;}
async function searchMusic(query){
 const requestId=++searchRequestToken;
 if(searchAbortController){searchAbortController.abort();searchAbortController=null;}
 const clean=String(query||"").trim();
 if(!apiKey){setLoading(false);openSettings();showToast("먼저 YouTube API 키를 설정해 주세요.");return;}
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
  const allowed=new Map((details.items||[]).filter(v=>v.snippet?.categoryId==="10"&&v.status?.embeddable===true).map(v=>[v.id,v]));
  lastResults=(searchData.items||[]).filter(item=>allowed.has(item.id.videoId)).map(item=>{
   const v=allowed.get(item.id.videoId),thumbs=v.snippet.thumbnails||item.snippet.thumbnails||{},iso=v.contentDetails?.duration||"PT0S",m=iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/),duration=m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;
   return{id:v.id,title:v.snippet.title,channelTitle:v.snippet.channelTitle,thumbnail:thumbs.high?.url||thumbs.medium?.url||thumbs.default?.url||"",duration};
  });
  el.resultCount.textContent=lastResults.length+"곡";
  if(!lastResults.length){showMessage("재생 가능한 음악이 없어요","음악 카테고리이면서 외부 재생이 허용된 영상이 없어요. 다른 검색어를 시도해 보세요.");return;}
  renderResults(lastResults);
 }catch(error){
  if(requestId!==searchRequestToken)return;
  console.error("Music search failure:",error?.message||error);lastResults=[];el.resultCount.textContent="";
  showMessage("검색할 수 없어요",error?.message||"알 수 없는 오류가 발생했습니다.","error");
 }finally{
  clearTimeout(timeout);
  if(requestId===searchRequestToken){searchAbortController=null;setLoading(false);}
 }
}
el.searchForm.addEventListener("submit",event=>{event.preventDefault();const query=el.searchInput.value.trim();if(query)saveRecentSearch(query);hideRecentSearches();searchMusic(query);});
el.searchInput.addEventListener("focus",showRecentSearches);
el.searchInput.addEventListener("click",showRecentSearches);
el.searchInput.addEventListener("keydown",event=>{if(event.key==="Escape")hideRecentSearches();});
document.addEventListener("click",event=>{if(!event.target.closest(".search-area"))hideRecentSearches();});
renderRecentSearches();
document.querySelectorAll("[data-query]").forEach(button=>button.addEventListener("click",()=>{el.searchInput.value=button.dataset.query;searchMusic(button.dataset.query);}));
el.settingsButton.addEventListener("click",openSettings);
el.saveKeyButton.addEventListener("click",()=>{const value=el.apiKeyInput.value.trim();if(!value){showToast("API 키를 입력해 주세요.");return;}apiKey=value;localStorage.setItem(STORAGE_KEY,apiKey);updateConnectionStatus();el.settingsDialog.close();showToast("API 키를 이 기기에 저장했어요.");});
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
updateConnectionStatus();if(!apiKey)showMessage("먼저 검색 연결을 설정해 주세요","오른쪽 위 설정에서 YouTube Data API 키를 입력하면 음악 검색을 시작할 수 있어요.","error");
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

