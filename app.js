const API_BASE="https://www.googleapis.com/youtube/v3";
const STORAGE_KEY="musiq_youtube_api_key_v1";
const LYRIC_API="https://lrclib.net/api";
const lyricState={lines:[],plain:"",lastIndex:-1,lastWordIndex:-1,wordSynced:false};
const lyricCache=new Map();
const ids=["searchForm","searchInput","searchButton","resultsTitle","resultCount","resultsList","messageState","playerFrame","nowTitle","nowChannel","connectionStatus","settingsButton","settingsDialog","apiKeyInput","saveKeyButton","removeKeyButton","progressBar","currentTime","totalTime","playPauseButton","playbackState","lyricsView","lyricsStatus"];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
let apiKey=localStorage.getItem(STORAGE_KEY)||"",currentVideoId="",lastResults=[],toastTimer,ytPlayer=null,ytReady=false,progressTimer=null,seeking=false;
function updateConnectionStatus(){const ready=Boolean(apiKey);el.connectionStatus.classList.toggle("ready",ready);el.connectionStatus.innerHTML=ready?"<i></i> 검색 연결됨":"<i></i> API 미설정";}
function showToast(message){let toast=document.querySelector(".toast");if(!toast){toast=document.createElement("div");toast.className="toast";toast.setAttribute("role","status");document.body.appendChild(toast);}toast.textContent=message;toast.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove("show"),2600);}
function openSettings(){el.apiKeyInput.value=apiKey;el.settingsDialog.showModal();}
function setLoading(loading){el.searchButton.disabled=loading;el.searchButton.innerHTML=loading?'<span>검색 중…</span>':'<span>검색</span><svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';}
function showMessage(title,description,kind="empty"){el.resultsList.replaceChildren();el.messageState.hidden=false;el.messageState.replaceChildren();const heading=document.createElement("h3"),paragraph=document.createElement("p"),art=document.createElement("div");heading.textContent=title;paragraph.textContent=description;art.className="empty-art";art.innerHTML=kind==="empty"?'<span class="disc"></span><span class="disc-hole"></span><span class="note">♪</span>':'<span class="note">!</span>';el.messageState.append(art,heading,paragraph);}
function formatTime(seconds){if(!Number.isFinite(seconds)||seconds<0)return"0:00";const n=Math.floor(seconds);return Math.floor(n/60)+":"+String(n%60).padStart(2,"0");}
function parseLrc(source){
 const lines=[];
 for(const raw of String(source||"").split(/\r?\n/)){
  const m=raw.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
  if(!m)continue;
  const fraction=(m[3]||"0").padEnd(3,"0");
  const time=Number(m[1])*60+Number(m[2])+Number(fraction)/1000;
  const text=m[4].trim();
  if(text)lines.push({time,text,words:[]});
 }
 return lines.sort((a,b)=>a.time-b.time);
}
function parseQrc(source){
 if(!source||typeof DOMParser==="undefined")return [];
 const doc=new DOMParser().parseFromString(String(source),"application/xml");
 if(doc.querySelector("parsererror"))return [];
 const output=[];
 doc.querySelectorAll("LyricContent").forEach(node=>{
  const raw=node.textContent||"";
  const tokens=[...raw.matchAll(/\((\d+),(\d+)\)([^()]+)/g)];
  if(!tokens.length)return;
  const words=tokens.map(match=>({start:Number(match[1])/1000,end:(Number(match[1])+Number(match[2]))/1000,text:match[3]}));
  output.push({time:words[0].start,text:words.map(word=>word.text).join(""),words});
 });
 return output.sort((a,b)=>a.time-b.time);
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
  if(words.length)output.push({time:base,text,words});
 }
 return output.sort((a,b)=>a.time-b.time);
}
function parseTimedTextTime(value){
 if(!value)return NaN;
 const parts=String(value).trim().split(":");
 let seconds=0;
 if(parts.length===3)seconds=Number(parts[0])*3600+Number(parts[1])*60+Number(parts[2]);
 else if(parts.length===2)seconds=Number(parts[0])*60+Number(parts[1]);
 else seconds=Number(parts[0]);
 return Number.isFinite(seconds)?seconds:NaN;
}
function parseTtml(source){
 if(!source||typeof DOMParser==="undefined")return [];
 const doc=new DOMParser().parseFromString(String(source),"application/xml");
 if(doc.querySelector("parsererror"))return [];
 const output=[];
 doc.querySelectorAll("p").forEach(p=>{
  const words=[];
  const collect=(node)=>{
   node.childNodes.forEach(child=>{
    if(child.nodeType!==1)return;
    if(child.localName==="span"){
     const begin=child.getAttribute("begin");
     if(begin){
      const start=parseTimedTextTime(begin),end=parseTimedTextTime(child.getAttribute("end"));
      const text=child.textContent||"";
      if(Number.isFinite(start)&&text)words.push({start,end,text});
     }else collect(child);
    }
   });
  };
  collect(p);
  const time=parseTimedTextTime(p.getAttribute("begin"))||words[0]?.start;
  if(Number.isFinite(time)&&words.length){
   output.push({time,text:words.map(word=>word.text).join(""),words});
  }else if(Number.isFinite(time)&&(p.textContent||"").trim()){
   output.push({time,text:p.textContent.trim(),words:[]});
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
 return output.filter(item=>Number.isFinite(item.time)).sort((a,b)=>a.time-b.time);
}
function showLyricsMessage(message){
 el.lyricsView.replaceChildren();
 const node=document.createElement("div");
 node.className="lyrics-placeholder";
 node.textContent=message;
 el.lyricsView.append(node);
 el.lyricsStatus.textContent="LYRICS";
}
function renderLyrics(){
 if(!lyricState.lines.length){
  if(lyricState.lastIndex===-2||lyricState.lastIndex===-3)return;
  el.lyricsView.replaceChildren();
  if(lyricState.plain){
   lyricState.plain.split(/\r?\n/).filter(Boolean).slice(0,100).forEach(text=>{
    const row=document.createElement("div");row.className="lyric-line plain";row.textContent=text;el.lyricsView.append(row);
   });
   el.lyricsStatus.textContent="일반 가사 · 동기화 미지원";
   lyricState.lastIndex=-2;
  }else {showLyricsMessage("동기화 가능한 가사가 없거나, 가사 정보를 불러오지 못했어요.");lyricState.lastIndex=-3;}
  return;
 }
 const current=ytPlayer&&typeof ytPlayer.getCurrentTime==="function"?ytPlayer.getCurrentTime():0;
 let index=-1;
 for(let i=0;i<lyricState.lines.length;i++){if(lyricState.lines[i].time<=current)index=i;else break;}
 let wordIndex=-1;
 const activeLine=index>=0?lyricState.lines[index]:null;
 if(lyricState.wordSynced&&activeLine?.words?.length){
  for(let i=0;i<activeLine.words.length;i++){if(activeLine.words[i].start<=current)wordIndex=i;else break;}
 }
 if(index===lyricState.lastIndex&&wordIndex===lyricState.lastWordIndex)return;
 lyricState.lastIndex=index;lyricState.lastWordIndex=wordIndex;
 el.lyricsView.replaceChildren();
 const start=Math.max(0,index-2),end=Math.min(lyricState.lines.length,index+5);
 for(let i=start;i<end;i++){
  const item=lyricState.lines[i],row=document.createElement("div");
  row.className="lyric-line"+(i===index?" current":"")+(i<index?" past":"");
  if(i===index&&lyricState.wordSynced&&item.words?.length){
   item.words.forEach((part,j)=>{
    const span=document.createElement("span");
    span.className="lyric-word"+(j===wordIndex?" active":"")+(j>wordIndex?" upcoming":"");
    span.textContent=part.text;
    row.append(span);
   });
  }else row.textContent=item.text;
  el.lyricsView.append(row);
 }
 el.lyricsStatus.textContent=lyricState.wordSynced?"단어 단위 동기화":"시간 동기화 가사";
}
async function loadLyrics(video){
 lyricState.lines=[];lyricState.plain="";lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.wordSynced=false;
 showLyricsMessage("곡 정보를 확인하고 가사를 검색하고 있어요…");
 const cacheKey=video.id;
 if(lyricCache.has(cacheKey)){
  const cached=lyricCache.get(cacheKey);
  lyricState.lines=cached.lines;lyricState.plain=cached.plain;lyricState.wordSynced=cached.wordSynced;
  renderLyrics();return;
 }
 const headers={"X-User-Agent":"Music/1.0 (https://kanghuijun000.github.io/)"};
 const normalize=value=>String(value||"").toLowerCase()
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\s*[-–|]\s*(official|lyrics?|audio|video|visuali[sz]er|mv|topic)\b/gi," ")
  .replace(/[^\p{L}\p{N}]+/gu," ").trim();
 const rawTitle=String(video.title||"").trim();
 const titleWithoutTags=rawTitle
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\s*(?:\/|\|)\s*(가사|lyrics?|official|뮤직비디오|뮤비|audio|video)\b.*$/i," ")
  .replace(/\b(official music video|official audio|lyrics video|lyric video|lyrics|lyric|가사|뮤직비디오|뮤비)\b/gi," ")
  .replace(/\s+/g," ").trim();
 const titleParts=titleWithoutTags.split(/\s+[-–|]\s+/).map(value=>value.trim()).filter(Boolean);
 const parsedArtist=titleParts.length>1?titleParts[0]:"";
 const cleanTitle=titleParts.length>1?titleParts.slice(1).join(" - "):titleWithoutTags;
 const channel=String(video.channelTitle||"").replace(/\s*-\s*Topic$/i,"").trim();
 const duration=Number(video.duration)||0;
 const titleVariants=[...new Set([cleanTitle,titleWithoutTags,...titleParts].filter(value=>value&&normalize(value).length>=2))];
 const wanted=normalize(cleanTitle);
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function requestJson(url,headersArg={}){
  let response=await fetch(url,{headers:headersArg});
  if(response.status===429||response.status===503){
   const retryHeader=response.headers.get("Retry-After");
   const retrySeconds=retryHeader?Number(retryHeader):0;
   const waitMs=Number.isFinite(retrySeconds)&&retrySeconds>0?Math.min(retrySeconds*1000,5000):1000;
   await delay(waitMs);
   response=await fetch(url,{headers:headersArg});
  }
  return response;
 }
 function searchApple(term){
  return new Promise((resolve,reject)=>{
   const callbackName="musicAppleCallback_"+Math.random().toString(36).slice(2);
   const script=document.createElement("script");
   const url=new URL("https://itunes.apple.com/search");
   url.searchParams.set("term",term);
   url.searchParams.set("entity","song");
   url.searchParams.set("country","kr");
   url.searchParams.set("limit","25");
   url.searchParams.set("callback",callbackName);
   let finished=false;
   const cleanup=()=>{
    if(finished)return;
    finished=true;
    try{delete window[callbackName];}catch(_){window[callbackName]=undefined;}
    script.remove();
    clearTimeout(timer);
   };
   const timer=setTimeout(()=>{cleanup();reject(new Error("음원 정보 검색 시간 초과"));},7000);
   window[callbackName]=data=>{cleanup();resolve(Array.isArray(data?.results)?data.results:[]);};
   script.onerror=()=>{cleanup();reject(new Error("음원 정보 검색 연결 실패"));};
   script.src=url.toString();
   document.head.appendChild(script);
  });
 }
 let identity={track:cleanTitle,artist:parsedArtist,album:"",duration};
 const appleTerms=[cleanTitle,...titleVariants.slice(1),rawTitle].filter((value,index,array)=>value&&array.indexOf(value)===index).slice(0,3);
 for(const term of appleTerms){
  try{
   const results=await searchApple(term);
   const ranked=results.map(item=>{
    const title=normalize(item.trackName);
    const artist=normalize(item.artistName);
    const titleMatch=titleVariants.some(candidate=>{
     const target=normalize(candidate);
     return target&&(title===target||title.includes(target)||target.includes(title));
    });
    const durationDifference=duration&&item.trackTimeMillis?Math.abs(item.trackTimeMillis/1000-duration):9999;
    const channelMatch=channel&&artist&&(artist===normalize(channel)||normalize(channel).includes(artist)||artist.includes(normalize(channel)));
    const score=(titleMatch?100:0)+(channelMatch?20:0)+(durationDifference<=3?60:durationDifference<=10?30:durationDifference<=30?5:-20);
    return {item,score,titleMatch,durationDifference};
   }).filter(entry=>entry.titleMatch).sort((a,b)=>b.score-a.score);
   if(ranked.length){
    const item=ranked[0].item;
    identity={
     track:item.trackName||cleanTitle,
     artist:item.artistName||"",
     album:item.collectionName||"",
     duration:item.trackTimeMillis?Math.round(item.trackTimeMillis/1000):duration
    };
    break;
   }
  }catch(error){console.warn("Apple metadata lookup:",error?.message||error);}
 }
 // Apple catalog may not list a video; only use the YouTube channel as a last-resort artist hint.
 if(!identity.artist)identity.artist=parsedArtist||channel;
 const exactUrl=new URL(LYRIC_API+"/get");
 exactUrl.searchParams.set("track_name",identity.track);
 if(identity.artist)exactUrl.searchParams.set("artist_name",identity.artist);
 if(identity.album)exactUrl.searchParams.set("album_name",identity.album);
 if(identity.duration)exactUrl.searchParams.set("duration",String(identity.duration));
 let selected=null,temporaryFailure=false;
 try{
  const exactResponse=await requestJson(exactUrl,headers);
  if(exactResponse.ok)selected=await exactResponse.json();
  else if(exactResponse.status===429||exactResponse.status===503)temporaryFailure=true;
 }catch(error){temporaryFailure=true;console.warn("LRCLIB exact lookup:",error?.message||error);}
 // Exact metadata lookup failed or was temporarily unavailable: search by separate title/artist fields.
 if(!selected){
  const searchUrls=[];
  const structured=new URL(LYRIC_API+"/search");
  structured.searchParams.set("track_name",identity.track);
  if(identity.artist)structured.searchParams.set("artist_name",identity.artist);
  searchUrls.push(structured);
  const broad=new URL(LYRIC_API+"/search");
  broad.searchParams.set("q",[identity.track,identity.artist].filter(Boolean).join(" "));
  searchUrls.push(broad);
  const found=[];
  for(const url of searchUrls){
   try{
    const response=await requestJson(url,headers);
    if(response.status===429||response.status===503){temporaryFailure=true;continue;}
    if(!response.ok)continue;
    const items=await response.json();
    if(Array.isArray(items))found.push(...items);
    if(found.some(item=>normalize(item.trackName)===normalize(identity.track)))break;
   }catch(error){temporaryFailure=true;console.warn("LRCLIB search:",error?.message||error);}
  }
  const seen=new Set();
  const ranked=found.filter(item=>{
   if(!item||seen.has(item.id))return false;
   seen.add(item.id);return true;
  }).map(item=>{
   const title=normalize(item.trackName);
   const artist=normalize(item.artistName);
   const titleMatch=title&&(title===normalize(identity.track)||title.includes(normalize(identity.track))||normalize(identity.track).includes(title));
   const artistMatch=!identity.artist||!artist||artist===normalize(identity.artist)||artist.includes(normalize(identity.artist))||normalize(identity.artist).includes(artist);
   const durationDifference=identity.duration&&item.duration?Math.abs(identity.duration-item.duration):9999;
   const score=(item.syncedLyrics?100:0)+(item.plainLyrics?10:0)+(titleMatch?100:-100)+(artistMatch?35:-70)+(durationDifference<=2?55:durationDifference<=8?25:durationDifference<=20?0:-35);
   return {...item,_score:score};
  }).sort((a,b)=>b._score-a._score);
  selected=ranked.find(item=>(item.syncedLyrics||item.plainLyrics)&&item._score>0)||null;
 }
 // Additional independent lyric catalogs. Prefer timed lyrics over a plain-text hit.
 // Karalyr is LRCLIB-compatible and focuses on word-synced karaoke data.
 if(!selected?.syncedLyrics&&!selected?.hasWordSync){
  try{
   const url=new URL("https://karalyr.com/api/get");
   url.searchParams.set("track_name",identity.track);
   url.searchParams.set("artist_name",identity.artist);
   if(identity.album)url.searchParams.set("album_name",identity.album);
   if(identity.duration)url.searchParams.set("duration",String(identity.duration));
   const response=await requestJson(url,{ "X-Karalyr-Client":"Music/1.0 (https://kanghuijun000.github.io/)" });
   if(response.ok){
    const data=await response.json();
    if(data?.syncedLyrics||data?.plainLyrics)selected=data;
   }else if(response.status===429||response.status===503)temporaryFailure=true;
  }catch(error){temporaryFailure=true;console.warn("Karalyr lookup:",error?.message||error);}
 }
 // SyncLRC offers karaoke, line-synced and plain variants through a documented public API.
 if(!selected?.hasWordSync&&!selected?.syncedLyrics){
  try{
   const url=new URL("https://api.synclrc.dev/lyrics");
   url.searchParams.set("track",identity.track);
   url.searchParams.set("artist",identity.artist);
   if(identity.album)url.searchParams.set("album",identity.album);
   if(identity.duration)url.searchParams.set("duration",String(identity.duration));
   url.searchParams.set("type","karaoke");
   const response=await requestJson(url);
   if(response.ok){
    const data=await response.json();
    const timed=data.karaoke||data.synced||data.lyrics||"";
    if(timed){
     const wordLines=parseEnhancedLrc(timed);
     const lines=wordLines.length?wordLines:parseLrc(timed);
     if(lines.length){
      selected={...(selected||{}),syncedLyrics:timed,plainLyrics:data.plain||selected?.plainLyrics||"",hasWordSync:wordLines.length>0,lyricsfile:null,ttmlLines:wordLines};
     }
    }
    if(!selected?.syncedLyrics&&data.plain)selected={...(selected||{}),plainLyrics:data.plain};
   }else if(response.status===429||response.status===503)temporaryFailure=true;
  }catch(error){temporaryFailure=true;console.warn("SyncLRC lookup:",error?.message||error);}
 }
 // Better Lyrics provider-specific endpoints: Kugou provides broad line-level coverage
 // and QQ provides word-timed QRC; neither requires an API key for cache misses.
 if(!lyricState.lines.length&&!selected?.syncedLyrics){
  for(const provider of ["kugou","qq"]){
   try{
    const url=new URL("https://api.betterlyrics.org/"+provider+"/getLyrics");
    url.searchParams.set("s",identity.track);
    url.searchParams.set("a",identity.artist);
    url.searchParams.set("al",identity.album||identity.track);
    url.searchParams.set("d",String(identity.duration||Math.round(duration)||1));
    const response=await requestJson(url);
    if(!response.ok){if(response.status===429||response.status===503)temporaryFailure=true;continue;}
    const data=await response.json();
    const raw=data.lyrics||"";
    if(provider==="kugou"){
     const lines=parseLrc(raw);
     if(lines.length){selected={...(selected||{}),syncedLyrics:raw,plainLyrics:selected?.plainLyrics||"",hasWordSync:false};break;}
    }else{
     const qrcLines=parseQrc(raw);
     if(qrcLines.length){selected={...(selected||{}),syncedLyrics:"",plainLyrics:selected?.plainLyrics||"",hasWordSync:true,ttmlLines:qrcLines};break;}
    }
   }catch(error){temporaryFailure=true;console.warn("Better Lyrics "+provider+" lookup:",error?.message||error);}
  }
 }
 // Better Lyrics serves cached TTML with syllable-level timestamps without a key.
 if(!selected?.hasWordSync&&!selected?.syncedLyrics){
  try{
   const url=new URL("https://api.betterlyrics.org/getLyrics");
   url.searchParams.set("s",identity.track);
   url.searchParams.set("a",identity.artist);
   url.searchParams.set("al",identity.album||identity.track);
   url.searchParams.set("d",String(identity.duration||Math.round(duration)||1));
   const response=await requestJson(url);
   if(response.ok){
    const data=await response.json();
    const timed=parseTtml(data.ttml||"");
    if(timed.length)selected={...(selected||{}),ttml:data.ttml,ttmlLines:timed,hasWordSync:true};
   }else if(response.status===429||response.status===503)temporaryFailure=true;
  }catch(error){temporaryFailure=true;console.warn("Better Lyrics lookup:",error?.message||error);}
 }
 // Independent plain-lyrics fallback. This provider does not provide line timing.
 if(!selected||(!selected.syncedLyrics&&!selected.plainLyrics)){
  if(identity.artist&&identity.track){
   try{
    const fallbackUrl="https://api.lyrics.ovh/v1/"+encodeURIComponent(identity.artist)+"/"+encodeURIComponent(identity.track);
    const fallbackResponse=await requestJson(fallbackUrl);
    if(fallbackResponse.ok){
     const fallbackData=await fallbackResponse.json();
     if(typeof fallbackData?.lyrics==="string"&&fallbackData.lyrics.trim()){
      selected={plainLyrics:fallbackData.lyrics,syncedLyrics:null,hasWordSync:false};
     }
    }
   }catch(error){console.warn("Plain lyrics fallback:",error?.message||error);}
  }
 }
 if(!selected){
  showLyricsMessage(temporaryFailure
   ?"가사 서버가 일시적으로 응답하지 않아요. 잠시 후 다시 시도해 주세요."
   :"이 곡의 가사를 무료 데이터베이스에서 찾지 못했어요");
  return;
 }
 const wordLines=selected.ttmlLines?.length?selected.ttmlLines:(selected.hasWordSync?parseLyricsfile(selected.lyricsfile):[]);
 const hasWords=wordLines.some(item=>item.words.length>0);
 lyricState.lines=hasWords?wordLines:parseLrc(selected.syncedLyrics||"");
 lyricState.plain=selected.plainLyrics||"";
 lyricState.wordSynced=hasWords;
 lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;
 if(!lyricState.lines.length&&!lyricState.plain){
  showLyricsMessage("가사 데이터는 찾았지만 표시할 수 있는 형식이 아니에요");return;
 }
 lyricCache.set(cacheKey,{lines:lyricState.lines,plain:lyricState.plain,wordSynced:hasWords});
 renderLyrics();
}
function updateProgress(){
 if(!ytPlayer||typeof ytPlayer.getCurrentTime!=="function")return;
 const duration=ytPlayer.getDuration()||0,current=ytPlayer.getCurrentTime()||0;
 el.progressBar.disabled=duration<=0;
 if(duration>0){
  el.progressBar.max=String(Math.max(1,Math.floor(duration*10)));
  if(!seeking)el.progressBar.value=String(Math.min(Number(el.progressBar.max),Math.floor(current*10)));
 }
 if(!seeking)el.currentTime.textContent=formatTime(current);
 el.totalTime.textContent=formatTime(duration);
 renderLyrics();
 const state=ytPlayer.getPlayerState();
 el.playPauseButton.textContent=state===1?"Ⅱ":"▶";
 el.playPauseButton.setAttribute("aria-label",state===1?"일시정지":"재생");
 el.playPauseButton.disabled=duration<=0;
}
function onYouTubeIframeAPIReady(){ytPlayer=new YT.Player("playerFrame",{width:"200",height:"200",videoId:"",playerVars:{autoplay:0,controls:0,playsinline:1,rel:0,fs:0,iv_load_policy:3,disablekb:1},events:{onReady:()=>{ytReady=true;el.playbackState.textContent="재생 준비 완료";if(currentVideoId)ytPlayer.loadVideoById(currentVideoId);},onStateChange:event=>{if(event.data===YT.PlayerState.PLAYING){el.playbackState.textContent="재생 중";clearInterval(progressTimer);progressTimer=setInterval(updateProgress,500);}else if(event.data===YT.PlayerState.PAUSED){el.playbackState.textContent="일시정지";updateProgress();}else if(event.data===YT.PlayerState.ENDED){el.playbackState.textContent="재생 완료";updateProgress();}else if(event.data===YT.PlayerState.BUFFERING){el.playbackState.textContent="불러오는 중…";}}}});}
window.onYouTubeIframeAPIReady=onYouTubeIframeAPIReady;
const ytScript=document.createElement("script");ytScript.src="https://www.youtube.com/iframe_api";ytScript.async=true;document.head.appendChild(ytScript);
function setPlayer(video){currentVideoId=video.id;el.nowTitle.textContent=video.title;el.nowChannel.textContent=video.channelTitle;el.currentTime.textContent="0:00";el.totalTime.textContent=formatTime(video.duration);el.progressBar.value="0";el.progressBar.max=String(Math.max(1,Math.floor((video.duration||0)*10)));el.progressBar.disabled=true;el.playPauseButton.disabled=true;el.playbackState.textContent="YouTube 플레이어 연결 중…";if(ytReady&&ytPlayer)ytPlayer.loadVideoById(video.id);renderResults(lastResults);loadLyrics(video);}
function renderResults(items){el.resultsList.replaceChildren();el.messageState.hidden=items.length>0;if(!items.length)return;const fragment=document.createDocumentFragment();items.forEach((video,index)=>{const row=document.createElement("article"),image=document.createElement("img"),info=document.createElement("div"),title=document.createElement("div"),channel=document.createElement("div"),badge=document.createElement("div"),play=document.createElement("button");row.className="track"+(video.id===currentVideoId?" active":"");image.className="track-thumb";image.src=video.thumbnail;image.alt="";image.loading=index>5?"lazy":"eager";info.className="track-info";title.className="track-title";title.textContent=video.title;channel.className="track-channel";channel.textContent=video.channelTitle;badge.className="track-badge";badge.textContent="MUSIC CATEGORY";info.append(title,channel,badge);play.type="button";play.className="play-track";play.setAttribute("aria-label",video.title+" 재생");play.innerHTML='<svg viewBox="0 0 24 24"><path d="M7 4.8c0-.8.9-1.3 1.6-.9l10.2 7.2c.6.4.6 1.3 0 1.8L8.6 20.1c-.7.5-1.6 0-1.6-.9V4.8Z"/></svg>';play.addEventListener("click",()=>setPlayer(video));row.addEventListener("click",event=>{if(!event.target.closest("button"))setPlayer(video);});row.append(image,info,play);fragment.append(row);});el.resultsList.append(fragment);}
async function youtubeRequest(endpoint,params){const url=new URL(API_BASE+"/"+endpoint);Object.entries({...params,key:apiKey}).forEach(([key,value])=>url.searchParams.set(key,value));let response;try{response=await fetch(url);}catch(error){throw new Error("Google API에 연결하지 못했어요. ("+(error?.message||"네트워크 오류")+")");}let data={};try{data=await response.json();}catch(_){}if(!response.ok){const apiError=data?.error||{},reason=apiError.errors?.[0]?.reason||"reason 정보 없음",message=apiError.message||response.statusText||"Google 오류",status=response.status;let hint="";if(reason==="keyInvalid"||reason==="keyExpired")hint="Google Cloud에서 키가 유효한지 확인하세요.";else if(reason==="accessNotConfigured")hint="YouTube Data API v3를 활성화해야 합니다.";else if(reason==="quotaExceeded"||reason==="dailyLimitExceeded")hint="YouTube Data API 할당량을 초과했습니다.";else if(/referer|referrer|API_KEY_HTTP_REFERRER_BLOCKED/i.test(reason+" "+message))hint="GitHub Pages 도메인을 웹사이트 제한에 등록해야 합니다.";throw new Error("요청 단계: "+endpoint+". HTTP "+status+". Google 오류 코드: "+reason+". 설명: "+message+(hint?" 해결 단서: "+hint:""));}return data;}
async function searchMusic(query){if(!apiKey){openSettings();showToast("먼저 YouTube API 키를 설정해 주세요.");return;}const clean=query.trim();if(!clean){showToast("노래 제목이나 가수를 입력해 주세요.");return;}el.resultsTitle.textContent='"'+clean+'" 검색 결과';el.resultCount.textContent="";showMessage("음악을 찾고 있어요","YouTube 음악 카테고리에서 검색 중입니다.","loading");setLoading(true);try{const searchData=await youtubeRequest("search",{part:"snippet",type:"video",videoCategoryId:"10",videoEmbeddable:"true",maxResults:"25",q:clean,regionCode:"KR",relevanceLanguage:"ko",safeSearch:"moderate",order:"relevance"});const ids=(searchData.items||[]).filter(item=>item.id?.videoId).map(item=>item.id.videoId);if(!ids.length){lastResults=[];el.resultCount.textContent="0곡";showMessage("검색 결과가 없어요","다른 노래 제목이나 가수 이름으로 검색해 보세요.");return;}const details=await youtubeRequest("videos",{part:"snippet,status,contentDetails",id:ids.join(",")}),allowed=new Map((details.items||[]).filter(v=>v.snippet?.categoryId==="10"&&v.status?.embeddable===true).map(v=>[v.id,v]));lastResults=(searchData.items||[]).filter(item=>allowed.has(item.id.videoId)).map(item=>{const v=allowed.get(item.id.videoId),thumbs=v.snippet.thumbnails||item.snippet.thumbnails||{},iso=v.contentDetails?.duration||"PT0S",m=iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/),duration=m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;return{id:v.id,title:v.snippet.title,channelTitle:v.snippet.channelTitle,thumbnail:thumbs.high?.url||thumbs.medium?.url||thumbs.default?.url||"",duration};});el.resultCount.textContent=lastResults.length+"곡";if(!lastResults.length){showMessage("재생 가능한 음악이 없어요","음악 카테고리이면서 외부 재생이 허용된 영상이 없어요. 다른 검색어를 시도해 보세요.");return;}renderResults(lastResults);}catch(error){console.error("Music search failure:",error?.message||error);lastResults=[];el.resultCount.textContent="";showMessage("검색할 수 없어요",error?.message||"알 수 없는 오류가 발생했습니다.","error");}finally{setLoading(false);}}
el.searchForm.addEventListener("submit",event=>{event.preventDefault();searchMusic(el.searchInput.value);});
document.querySelectorAll("[data-query]").forEach(button=>button.addEventListener("click",()=>{el.searchInput.value=button.dataset.query;searchMusic(button.dataset.query);}));
el.settingsButton.addEventListener("click",openSettings);
el.saveKeyButton.addEventListener("click",()=>{const value=el.apiKeyInput.value.trim();if(!value){showToast("API 키를 입력해 주세요.");return;}apiKey=value;localStorage.setItem(STORAGE_KEY,apiKey);updateConnectionStatus();el.settingsDialog.close();showToast("API 키를 이 기기에 저장했어요.");});
el.removeKeyButton.addEventListener("click",()=>{apiKey="";localStorage.removeItem(STORAGE_KEY);el.apiKeyInput.value="";updateConnectionStatus();el.settingsDialog.close();showToast("저장된 API 키를 삭제했어요.");});
el.settingsDialog.addEventListener("click",event=>{if(event.target===el.settingsDialog)el.settingsDialog.close();});
el.playPauseButton.addEventListener("click",()=>{if(!ytPlayer)return;if(ytPlayer.getPlayerState()===YT.PlayerState.PLAYING)ytPlayer.pauseVideo();else ytPlayer.playVideo();});
el.progressBar.addEventListener("input",()=>{if(!ytPlayer)return;seeking=true;el.currentTime.textContent=formatTime(Number(el.progressBar.value)/10);});
el.progressBar.addEventListener("change",()=>{if(!ytPlayer||el.progressBar.disabled)return;const target=Number(el.progressBar.value)/10;ytPlayer.seekTo(target,true);seeking=false;el.currentTime.textContent=formatTime(target);updateProgress();});
updateConnectionStatus();if(!apiKey)showMessage("먼저 검색 연결을 설정해 주세요","오른쪽 위 설정에서 YouTube Data API 키를 입력하면 음악 검색을 시작할 수 있어요.","error");