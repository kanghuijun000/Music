const API_BASE="https://www.googleapis.com/youtube/v3";
const STORAGE_KEY="musiq_youtube_api_key_v1";
const LYRIC_API="https://lrclib.net/api";
const lyricState={lines:[],plain:"",lastIndex:-1,lastWordIndex:-1,wordSynced:false,loading:false};
const LYRIC_LEAD_SECONDS=0;
const lyricCache=new Map();

const LYRIC_CACHE_STORAGE_KEY="music_lyrics_cache_v1";
const LYRIC_CACHE_LIMIT=150;
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
  next[cacheKey]={lines:item.lines,plain:item.plain||"",wordSynced:Boolean(item.wordSynced),savedAt:Date.now()};
  const keys=Object.keys(next).sort((a,b)=>(Number(next[b]?.savedAt)||0)-(Number(next[a]?.savedAt)||0));
  for(const key of keys.slice(LYRIC_CACHE_LIMIT))delete next[key];
  localStorage.setItem(LYRIC_CACHE_STORAGE_KEY,JSON.stringify(next));
 }catch(error){console.warn("Lyrics cache could not be saved:",error);}
}

const ids=["searchForm","searchInput","searchButton","resultsTitle","resultCount","resultsList","messageState","playerFrame","nowTitle","nowChannel","connectionStatus","settingsButton","settingsDialog","apiKeyInput","saveKeyButton","removeKeyButton","progressBar","currentTime","totalTime","playPauseButton","playbackState","lyricsView","lyricsStatus"];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
let apiKey=localStorage.getItem(STORAGE_KEY)||"",currentVideoId="",lastResults=[],toastTimer,ytPlayer=null,ytReady=false,progressTimer=null,seeking=false,lyricLoadToken=0;
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
  const m=raw.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
  if(!m)continue;
  const fraction=(m[3]||"0").padEnd(3,"0");
  const time=Number(m[1])*60+Number(m[2])+Number(fraction)/1000;
  const text=m[4].trim();
  if(text&&!isCreditMetadata(text))lines.push({time,text,words:[]});
 }
 return lines.sort((a,b)=>a.time-b.time);
}
function parseQrc(source){
 if(!source)return [];
 let body=String(source);
 const doc=typeof DOMParser!=="undefined"?new DOMParser().parseFromString(body,"application/xml"):null;
 const lyricNode=doc?.querySelector("Lyric_1");
 if(lyricNode)body=lyricNode.getAttribute("LyricContent")||"";
 else {
  const match=body.match(/LyricContent="([\s\S]*?)"\s*(?:\/>|[a-zA-Z]+=)/);
  if(match)body=match[1];
 }
 body=body.replace(/&quot;/g,'"').replace(/&amp;/g,"&").replace(/&#10;/g,"\n").replace(/&#13;/g,"");
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
  const cleanText=words.map(word=>word.text).join("");
  if(!cleanText.trim()||isCreditMetadata(cleanText))continue;
  if(/^(lyrics by|composed by|arranged by|producer|작사|작곡|편곡|제작|作词|作曲|编曲|制作人)[:：]/i.test(cleanText.trim()))continue;
  output.push({time:Number(header[1])/1000,text:cleanText,words:words.filter(word=>Number.isFinite(word.start))});
 }
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
  if(words.length&&!isCreditMetadata(text))output.push({time:base,text,words});
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
 const paragraphs=[...doc.getElementsByTagName("*")].filter(node=>node.localName==="p");
 paragraphs.forEach(p=>{
  const words=[];
  const collect=(node)=>{
   node.childNodes.forEach(child=>{
    if(child.nodeType===3||child.nodeType===4)return;
    if(child.nodeType!==1)return;
    if(child.localName==="span"&&child.hasAttribute("begin")){
     const start=parseTimedTextTime(child.getAttribute("begin"));
     const end=parseTimedTextTime(child.getAttribute("end"));
     const text=child.textContent||"";
     if(Number.isFinite(start)&&text)words.push({start,end,text});
    }else collect(child);
   });
  };
  collect(p);
  const ownTime=parseTimedTextTime(p.getAttribute("begin"));
  const time=Number.isFinite(ownTime)?ownTime:(words[0]?.start??NaN);
  const fullText=(p.textContent||"").replace(/\\s+/g," ").trim();
  if(Number.isFinite(time)&&words.length){
   output.push({time,text:words.map(word=>word.text).join(""),words});
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
   el.lyricsStatus.textContent="";
   lyricState.lastIndex=-2;
  }else {showLyricsMessage("동기화 가능한 가사가 없거나, 가사 정보를 불러오지 못했어요.");lyricState.lastIndex=-3;}
  return;
 }
 const current=ytPlayer&&typeof ytPlayer.getCurrentTime==="function"?ytPlayer.getCurrentTime():0;
 const lyricTime=Math.max(0,current+LYRIC_LEAD_SECONDS);
 let index=-1;
 for(let i=0;i<lyricState.lines.length;i++){if(lyricState.lines[i].time<=lyricTime)index=i;else break;}
 // 전주에는 첫 가사를 미리 보여주되, 실제 타임스탬프 전에는 강조하지 않는다.
 const wordIndex=-1;
 if(index===lyricState.lastIndex&&wordIndex===lyricState.lastWordIndex)return;
 lyricState.lastIndex=index;lyricState.lastWordIndex=wordIndex;
 el.lyricsView.replaceChildren();
 const start=Math.max(0,index-1),end=Math.min(lyricState.lines.length,index+2);
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
   candidates.push((async()=>{const response=await fetch(url,{headers:{"X-User-Agent":"Music/1.0 (https://kanghuijun000.github.io/)"},signal:controller.signal});if(!response.ok)throw new Error("Provider unavailable");const list=await response.json();if(!Array.isArray(list))return null;return list.filter(item=>item&&(item.syncedLyrics||item.plainLyrics)&&isGood(item,artists,tracks)).sort((a,b)=>Number(Boolean(b.syncedLyrics))-Number(Boolean(a.syncedLyrics)))[0]||null;})());
  }
  try{return await Promise.any(candidates.map(job=>job.then(item=>{if(!item)throw new Error("No verified match");return item;})));}catch(_){return null;}
 }catch(error){console.warn("Puter AI fallback unavailable:",error?.message||error);return null;}
 finally{clearTimeout(timeout);}
}
async function loadLyrics(video,usePuter=false){
 const requestId=++lyricLoadToken;
 if(aiAssistButton)aiAssistButton.hidden=true;
 const cacheKey=video.id;
 const cached=lyricCache.get(cacheKey)||readStoredLyric(cacheKey);
 if(cached&&!usePuter){
  lyricState.lines=(cached.lines||[]).filter(item=>item&&!isCreditMetadata(item.text));lyricState.plain=String(cached.plain||"").split(/\r?\n/).filter(line=>!isCreditMetadata(line)).join("\n");lyricState.wordSynced=Boolean(cached.wordSynced);
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.loading=false;renderLyrics();return;
 }
 lyricState.loading=true;
 lyricState.lines=[];lyricState.plain="";lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;lyricState.wordSynced=false;
 showLyricsMessage("곡 정보를 확인하고 가사를 검색하고 있어요…");
 const normalize=value=>String(value||"").toLocaleLowerCase()
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\b(official|lyrics?|audio|video|visuali[sz]er|mv|topic)\b/gi," ")
  .replace(/가사|뮤직비디오|뮤비|공식영상|오디오/gi," ")
  .replace(/[^\p{L}\p{N}]+/gu," ").trim();
 const raw=String(video.title||"").trim();
 const cleaned=raw.replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\s*(?:\/|\|)\s*(?:가사|lyrics?|official|뮤직비디오|뮤비|audio|video).*$/i," ")
  .replace(/\s+/g," ").trim();
 const parts=cleaned.split(/\s+[-–|]\s+/).map(x=>x.trim()).filter(Boolean);
 const track=parts.length>1?parts.slice(1).join(" - "):cleaned;
 const isTopic=/\s*-\s*Topic$/i.test(String(video.channelTitle||""));
 const channel=String(video.channelTitle||"").replace(/\s*-\s*Topic$/i,"").trim();
 const artist=parts.length>1?parts[0]:(isTopic?channel:"");
 const duration=Number(video.duration)||0;
 const headers={"X-User-Agent":"Music/1.0 (https://kanghuijun000.github.io/)"};
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function getJson(url,customHeaders=headers){
  const request=async()=>{
   const controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),12000);
   try{return await fetch(url,{headers:customHeaders,signal:controller.signal});}
   finally{clearTimeout(timer);}
  };
  let response;
  try{response=await request();}
  catch(error){if(error?.name==="AbortError")throw new Error("요청 시간 초과");throw error;}
  if(response.status===429||response.status===503){
   await delay(1000);
   try{response=await request();}
   catch(error){if(error?.name==="AbortError")throw new Error("재시도 시간 초과");throw error;}
  }
  if(!response.ok)throw new Error("HTTP "+response.status);
  return response.json();
 }
 function isGood(item,extraArtists=[],extraTitles=[]){
  if(!item||(!item.syncedLyrics&&!item.ttmlLines&&!item.plainLyrics))return false;
  const gotTitle=normalize(item.trackName||item.title||""),wantedTitles=[track,...extraTitles].map(normalize).filter(Boolean);
  if(!gotTitle||!wantedTitles.length)return false;
  const stripExtras=value=>value.replace(/\b(feat|ft|featuring|with)\b.*$/i,"").trim();
  const a=stripExtras(gotTitle);
  const titleMatch=wantedTitles.some(title=>{const b=stripExtras(title);return a===b||(a.length>=b.length+2&&a.startsWith(b+" "))||(b.length>=a.length+2&&b.startsWith(a+" "));});
  const gotArtist=normalize(item.artistName||item.artist||"");
  const artistNames=[artist,...extraArtists];
  if(/카더가든|car\s*,?\s*the\s*garden|car\s*the\s*garden/i.test(artist+" "+channel))artistNames.push("카더가든","Car, the garden","Car the garden");
  const artistMatch=!artist||Boolean(gotArtist&&artistNames.some(name=>{const want=normalize(name);return want&&(gotArtist===want||gotArtist.includes(want)||want.includes(gotArtist));}));
  const gotDuration=Number(item.duration)||0;
  const durationMatch=!duration||!gotDuration||Math.abs(duration-gotDuration)<=Math.max(18,duration*0.1);
  return titleMatch&&artistMatch&&durationMatch&&hasReliableTimestamps(item);
 }
 function hasReliableTimestamps(item){
  let lines=Array.isArray(item?.ttmlLines)?item.ttmlLines:[];
  if(!lines.length&&item?.syncedLyrics){
   const raw=String(item.syncedLyrics);
   lines=parseEnhancedLrc(raw);
   if(!lines.length)lines=parseLrc(raw);
  }
  if(!lines.length&&item?.lyricsfile)lines=parseLyricsfile(item.lyricsfile);
  // Plain-text lyrics have no timestamps, so they remain eligible as a fallback.
  if(!lines.length)return !item?.syncedLyrics&&!item?.ttmlLines?.length&&!item?.lyricsfile;
  const songDuration=Number(item.duration)||duration;
  const valid=lines.filter(line=>line&&Number.isFinite(Number(line.time))&&Number(line.time)>=0&&String(line.text||"").trim()&&!isCreditMetadata(line.text));
  if(valid.length<2||valid.length!==lines.length)return false;
  if(songDuration>0&&valid.some(line=>Number(line.time)>songDuration+12))return false;
  for(let i=1;i<valid.length;i++){
   if(Number(valid[i].time)<Number(valid[i-1].time))return false;
  }
  return true;
 }
 function lrclibItem(item){return isGood(item)&&hasReliableTimestamps(item)&&(item.syncedLyrics||item.plainLyrics)?item:null;}
 const jobs=[];
 // 1) YouTube video ID lookup: the strongest match when this exact video has community-synced lyrics.
 jobs.push((async()=>{
  const url=new URL("https://unison.boidu.dev/lyrics");
  url.searchParams.set("v",video.id);
  const response=await fetch(url);
  if(!response.ok)throw new Error("Unison video match unavailable");
  const body=await response.json(),data=body?.data;
  if(!body?.success||!data?.lyrics)return null;
  const gotDuration=Number(data.duration)||0;
  if(duration&&gotDuration&&Math.abs(duration-gotDuration)>Math.max(22,duration*0.12))return null;
  let lines=[];
  if(data.format==="ttml")lines=parseTtml(data.lyrics);
  else if(data.format==="lrc")lines=parseLrc(data.lyrics);
  const plain=data.format==="plain"?String(data.lyrics):"";
  const item={trackName:data.song||track,artistName:data.artist||artist,duration:gotDuration||duration,syncedLyrics:data.format==="lrc"?data.lyrics:"",plainLyrics:plain,ttmlLines:lines,hasWordSync:lines.some(line=>line.words?.length)};
  if(!isGood(item))return null;
  return item;
 })());
 // 2) Better Lyrics default endpoint: documented response field is `ttml`.
 jobs.push((async()=>{
  const url=new URL("https://api.betterlyrics.org/getLyrics");
  url.searchParams.set("s",track);url.searchParams.set("a",artist||channel||"");
  url.searchParams.set("al",track);url.searchParams.set("d",String(duration||1));
  url.searchParams.set("v",video.id);
  const data=await getJson(url,{});
  const rawLyrics=data.ttml||data.lyrics||"";
  const lines=parseTtml(rawLyrics);
  if(!lines.length)return null;
  const item={trackName:data.track||track,artistName:data.artist||artist,duration:Number(data.duration)||duration,ttmlLines:lines,hasWordSync:lines.some(line=>line.words?.length)};
  return isGood(item)?item:null;
 })());
 // 3) Better Lyrics provider-specific TTML endpoint.
 jobs.push((async()=>{
  const url=new URL("https://api.betterlyrics.org/ttml/getLyrics");
  url.searchParams.set("s",track);url.searchParams.set("a",artist||channel||"");url.searchParams.set("al",track);url.searchParams.set("d",String(duration||1));
  const data=await getJson(url,{});
  const rawLyrics=data.lyrics||data.ttml||"";
  const lines=parseTtml(rawLyrics);
  if(!lines.length)return null;
  const item={trackName:data.track||track,artistName:data.artist||artist,duration:Number(data.duration)||duration,ttmlLines:lines,hasWordSync:lines.some(line=>line.words?.length)};
  return isGood(item)?item:null;
 })());
 const exactUrl=new URL(LYRIC_API+"/get");
 exactUrl.searchParams.set("track_name",track);
 if(artist)exactUrl.searchParams.set("artist_name",artist);
 if(duration)exactUrl.searchParams.set("duration",String(duration));
 jobs.push((async()=>lrclibItem(await getJson(exactUrl)))());
 const searchUrl=new URL(LYRIC_API+"/search");
 searchUrl.searchParams.set("track_name",track);
 if(artist)searchUrl.searchParams.set("artist_name",artist);
 jobs.push((async()=>{
  const list=await getJson(searchUrl);
  return Array.isArray(list)?list.filter(lrclibItem).sort((a,b)=>Number(Boolean(b.syncedLyrics))-Number(Boolean(a.syncedLyrics)))[0]||null:null;
 })());
 // Broaden Korean and alternate-credit searches instead of relying on one exact metadata spelling.
 for(const query of [...new Set([[track,channel],[track,artist],[artist,track]].map(parts=>parts.filter(Boolean).join(" ")).filter(Boolean))]){
  jobs.push((async()=>{
   const url=new URL(LYRIC_API+"/search");url.searchParams.set("q",query);
   const list=await getJson(url);
   return Array.isArray(list)?list.filter(lrclibItem).sort((a,b)=>Number(Boolean(b.syncedLyrics))-Number(Boolean(a.syncedLyrics)))[0]||null:null;
  })());
 }
 // Free-text search catches alternate artist spellings and metadata formatting differences.
 jobs.push((async()=>{
  const url=new URL(LYRIC_API+"/search");
  url.searchParams.set("q",[track,artist,channel].filter(Boolean).join(" "));
  const list=await getJson(url);
  return Array.isArray(list)?list.filter(lrclibItem).sort((a,b)=>{
   const durationA=Number(a.duration)||0,durationB=Number(b.duration)||0;
   const deltaA=duration&&durationA?Math.abs(duration-durationA):9999;
   const deltaB=duration&&durationB?Math.abs(duration-durationB):9999;
   return Number(Boolean(b.syncedLyrics))-Number(Boolean(a.syncedLyrics))||deltaA-deltaB;
  })[0]||null:null;
 })());
 jobs.push((async()=>{
  const url=new URL("https://api.synclrc.dev/lyrics");
  url.searchParams.set("track",track);url.searchParams.set("artist",artist);
  if(duration)url.searchParams.set("duration",String(duration));
  url.searchParams.set("type","karaoke");
  const data=await getJson(url,{});
  const timed=data.karaoke||data.synced||data.lyrics||"";
  const enhanced=parseEnhancedLrc(timed),lines=enhanced.length?enhanced:parseLrc(timed);
  if(!lines.length)return null;
  const item={trackName:data.track||track,artistName:data.artist||artist,duration:Number(data.duration)||duration,syncedLyrics:timed,plainLyrics:data.plain||"",ttmlLines:enhanced,hasWordSync:enhanced.length>0};
  return isGood(item)?item:null;
 })());
 for(const provider of ["kugou","qq"])jobs.push((async()=>{
  const url=new URL("https://api.betterlyrics.org/"+provider+"/getLyrics");
  url.searchParams.set("s",track);url.searchParams.set("a",artist);url.searchParams.set("al",track);url.searchParams.set("d",String(duration||1));
  const data=await getJson(url,{});
  const rawLyrics=data.lyrics||"",lines=provider==="kugou"?parseLrc(rawLyrics):parseQrc(rawLyrics);
  if(!lines.length)return null;
  const item={trackName:data.track||track,artistName:data.artist||artist,duration:Number(data.duration)||duration,syncedLyrics:provider==="kugou"?rawLyrics:"",ttmlLines:provider==="qq"?lines:[],hasWordSync:provider==="qq"};
  return isGood(item)?item:null;
 })());
 const aiJob=usePuter?puterAIAlternateSearch(track,artist,channel,duration,normalize,isGood,requestId):Promise.resolve(null);
 let selected=null;
 const providerJobs=jobs.map(job=>job.then(item=>{if(!item)throw new Error("No verified lyric match");return item;}));
 const aiVerifiedJob=aiJob.then(item=>{if(!item)throw new Error("No AI-verified lyric match");return item;});
 const searchRace=Promise.any([...providerJobs,aiVerifiedJob]).catch(()=>null);
 selected=await Promise.race([searchRace,delay(25000).then(()=>null)]);
 if(requestId!==lyricLoadToken)return;
 if(!selected){
  if(aiAssistButton)aiAssistButton.hidden=false;
  lyricState.loading=false;
  showLyricsMessage("가사 제공처를 모두 확인했지만 일치하는 결과를 찾지 못했어요. 다른 영상 버전이나 표기 정보가 필요할 수 있어요.");
  return;
 }
 if(aiAssistButton)aiAssistButton.hidden=true;
 const wordLines=(selected.ttmlLines?.length?selected.ttmlLines:(selected.hasWordSync?parseLyricsfile(selected.lyricsfile):[])).filter(item=>item&&!isCreditMetadata(item.text));
 const hasWords=wordLines.some(item=>item.words?.length);
 lyricState.lines=(hasWords?wordLines:parseLrc(selected.syncedLyrics||"")).filter(item=>!isCreditMetadata(item.text));
 lyricState.plain=String(selected.plainLyrics||"").split(/\r?\n/).filter(line=>!isCreditMetadata(line)).join("\n");
 lyricState.wordSynced=hasWords;
 lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;
 if(!lyricState.lines.length&&!lyricState.plain){
  lyricState.loading=false;showLyricsMessage("가사 데이터는 찾았지만 표시할 수 있는 형식이 아니에요.");return;
 }
 storeLyric(cacheKey,{lines:lyricState.lines,plain:lyricState.plain,wordSynced:hasWords});
 lyricState.loading=false;renderLyrics();
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
function updateMediaSession(state){
 if(!("mediaSession" in navigator))return;
 try{
  navigator.mediaSession.playbackState=state;
  if(state==="playing"&&"setPositionState" in navigator&&ytPlayer){
   const duration=ytPlayer.getDuration(),position=ytPlayer.getCurrentTime();
   if(Number.isFinite(duration)&&duration>0)navigator.mediaSession.setPositionState({duration,playbackRate:1,position:Math.min(duration,Math.max(0,position||0))});
  }
 }catch(error){console.debug("Media Session update unavailable:",error);}
}
function setupMediaSession(){
 if(!("mediaSession" in navigator))return;
 try{
  navigator.mediaSession.setActionHandler("play",()=>{if(ytPlayer)ytPlayer.playVideo();});
  navigator.mediaSession.setActionHandler("pause",()=>{if(ytPlayer)ytPlayer.pauseVideo();});
  navigator.mediaSession.setActionHandler("stop",()=>{if(ytPlayer)ytPlayer.pauseVideo();});
  navigator.mediaSession.setActionHandler("seekbackward",details=>{if(ytPlayer)ytPlayer.seekTo(Math.max(0,ytPlayer.getCurrentTime()-(details.seekOffset||10)),true);});
  navigator.mediaSession.setActionHandler("seekforward",details=>{if(ytPlayer)ytPlayer.seekTo(Math.min(ytPlayer.getDuration(),ytPlayer.getCurrentTime()+(details.seekOffset||10)),true);});
  navigator.mediaSession.setActionHandler("seekto",details=>{if(ytPlayer&&Number.isFinite(details.seekTime))ytPlayer.seekTo(details.seekTime,true);});
 }catch(error){console.debug("Media Session actions unavailable:",error);}
}
function updateMediaMetadata(video){
 if(!("mediaSession" in navigator)||!("MediaMetadata" in window))return;
 try{
  navigator.mediaSession.metadata=new MediaMetadata({title:video.title||"Music",artist:video.channelTitle||"YouTube",album:"Music",artwork:video.thumbnail?[{src:video.thumbnail,sizes:"480x360",type:"image/jpeg"}]:[]});
 }catch(error){console.debug("Media metadata unavailable:",error);}
}
setupMediaSession();
function onYouTubeIframeAPIReady(){ytPlayer=new YT.Player("playerFrame",{width:"200",height:"200",videoId:"",playerVars:{autoplay:0,controls:0,playsinline:1,rel:0,fs:0,iv_load_policy:3,disablekb:1},events:{onReady:()=>{ytReady=true;el.playbackState.textContent="재생 준비 완료";if(currentVideoId)ytPlayer.loadVideoById(currentVideoId);},onStateChange:event=>{if(event.data===YT.PlayerState.PLAYING){el.playbackState.textContent="재생 중";updateMediaSession("playing");clearInterval(progressTimer);progressTimer=setInterval(updateProgress,100);}else if(event.data===YT.PlayerState.PAUSED){el.playbackState.textContent="일시정지";updateMediaSession("paused");updateProgress();}else if(event.data===YT.PlayerState.ENDED){el.playbackState.textContent="재생 완료";updateMediaSession("none");updateProgress();}else if(event.data===YT.PlayerState.BUFFERING){el.playbackState.textContent="불러오는 중…";}}}});}
window.onYouTubeIframeAPIReady=onYouTubeIframeAPIReady;
const ytScript=document.createElement("script");ytScript.src="https://www.youtube.com/iframe_api";ytScript.async=true;document.head.appendChild(ytScript);
function setPlayer(video){currentVideoId=video.id;updateMediaMetadata(video);updateMediaSession("none");el.nowTitle.textContent=video.title;el.nowChannel.textContent=video.channelTitle;el.currentTime.textContent="0:00";el.totalTime.textContent=formatTime(video.duration);el.progressBar.value="0";el.progressBar.max=String(Math.max(1,Math.floor((video.duration||0)*10)));el.progressBar.disabled=true;el.playPauseButton.disabled=true;el.playbackState.textContent="YouTube 플레이어 연결 중…";if(ytReady&&ytPlayer)ytPlayer.loadVideoById(video.id);renderResults(lastResults);loadLyrics(video);}
function renderResults(items){el.resultsList.replaceChildren();el.messageState.hidden=items.length>0;if(!items.length)return;const fragment=document.createDocumentFragment();items.forEach((video,index)=>{const row=document.createElement("article"),image=document.createElement("img"),info=document.createElement("div"),title=document.createElement("div"),channel=document.createElement("div"),badge=document.createElement("div"),play=document.createElement("button");row.className="track"+(video.id===currentVideoId?" active":"");image.className="track-thumb";image.src=video.thumbnail;image.alt="";image.loading=index>5?"lazy":"eager";info.className="track-info";title.className="track-title";title.textContent=video.title;channel.className="track-channel";channel.textContent=video.channelTitle;badge.className="track-badge";badge.textContent="MUSIC CATEGORY";info.append(title,channel,badge);play.type="button";play.className="play-track";play.setAttribute("aria-label",video.title+" 재생");play.innerHTML='<svg viewBox="0 0 24 24"><path d="M7 4.8c0-.8.9-1.3 1.6-.9l10.2 7.2c.6.4.6 1.3 0 1.8L8.6 20.1c-.7.5-1.6 0-1.6-.9V4.8Z"/></svg>';play.addEventListener("click",()=>setPlayer(video));row.addEventListener("click",event=>{if(!event.target.closest("button"))setPlayer(video);});row.append(image,info,play);fragment.append(row);});el.resultsList.append(fragment);}
async function youtubeRequest(endpoint,params){const url=new URL(API_BASE+"/"+endpoint);Object.entries({...params,key:apiKey}).forEach(([key,value])=>url.searchParams.set(key,value));let response;try{response=await fetch(url);}catch(error){throw new Error("Google API에 연결하지 못했어요. ("+(error?.message||"네트워크 오류")+")");}let data={};try{data=await response.json();}catch(_){}if(!response.ok){const apiError=data?.error||{},reason=apiError.errors?.[0]?.reason||"reason 정보 없음",message=apiError.message||response.statusText||"Google 오류",status=response.status;let hint="";if(reason==="keyInvalid"||reason==="keyExpired")hint="Google Cloud에서 키가 유효한지 확인하세요.";else if(reason==="accessNotConfigured")hint="YouTube Data API v3를 활성화해야 합니다.";else if(reason==="quotaExceeded"||reason==="dailyLimitExceeded")hint="YouTube Data API 할당량을 초과했습니다.";else if(/referer|referrer|API_KEY_HTTP_REFERRER_BLOCKED/i.test(reason+" "+message))hint="GitHub Pages 도메인을 웹사이트 제한에 등록해야 합니다.";throw new Error("요청 단계: "+endpoint+". HTTP "+status+". Google 오류 코드: "+reason+". 설명: "+message+(hint?" 해결 단서: "+hint:""));}return data;}
async function searchMusic(query){if(!apiKey){openSettings();showToast("먼저 YouTube API 키를 설정해 주세요.");return;}const clean=query.trim();if(!clean){showToast("노래 제목이나 가수를 입력해 주세요.");return;}el.resultsTitle.textContent='"'+clean+'" 검색 결과';el.resultCount.textContent="";showMessage("음악을 찾고 있어요","YouTube 음악 카테고리에서 검색 중입니다.","loading");setLoading(true);try{const searchData=await youtubeRequest("search",{part:"snippet",type:"video",videoCategoryId:"10",videoEmbeddable:"true",maxResults:"25",q:clean,regionCode:"KR",relevanceLanguage:"ko",safeSearch:"moderate",order:"relevance"});const ids=(searchData.items||[]).filter(item=>item.id?.videoId).map(item=>item.id.videoId);if(!ids.length){lastResults=[];el.resultCount.textContent="0곡";showMessage("검색 결과가 없어요","다른 노래 제목이나 가수 이름으로 검색해 보세요.");return;}const details=await youtubeRequest("videos",{part:"snippet,status,contentDetails",id:ids.join(",")}),allowed=new Map((details.items||[]).filter(v=>v.snippet?.categoryId==="10"&&v.status?.embeddable===true).map(v=>[v.id,v]));lastResults=(searchData.items||[]).filter(item=>allowed.has(item.id.videoId)).map(item=>{const v=allowed.get(item.id.videoId),thumbs=v.snippet.thumbnails||item.snippet.thumbnails||{},iso=v.contentDetails?.duration||"PT0S",m=iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/),duration=m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;return{id:v.id,title:v.snippet.title,channelTitle:v.snippet.channelTitle,thumbnail:thumbs.high?.url||thumbs.medium?.url||thumbs.default?.url||"",duration};});el.resultCount.textContent=lastResults.length+"곡";if(!lastResults.length){showMessage("재생 가능한 음악이 없어요","음악 카테고리이면서 외부 재생이 허용된 영상이 없어요. 다른 검색어를 시도해 보세요.");return;}renderResults(lastResults);}catch(error){console.error("Music search failure:",error?.message||error);lastResults=[];el.resultCount.textContent="";showMessage("검색할 수 없어요",error?.message||"알 수 없는 오류가 발생했습니다.","error");}finally{setLoading(false);}}
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
 if(ready){await loadLyrics(video,true);}
 else showToast("Puter 연결을 사용할 수 없어요. 기본 가사 검색은 계속 이용할 수 있어요.");
 aiAssistButton.disabled=false;aiAssistButton.textContent="Puter로 곡 정보 보정 후 다시 검색";
});
updateConnectionStatus();if(!apiKey)showMessage("먼저 검색 연결을 설정해 주세요","오른쪽 위 설정에서 YouTube Data API 키를 입력하면 음악 검색을 시작할 수 있어요.","error");
function registerMusicServiceWorker(){
 if(!("serviceWorker" in navigator)||!/^https?:$/.test(location.protocol))return;
 const hadController=Boolean(navigator.serviceWorker.controller);
 let refreshed=false;
 if(hadController){
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
   if(refreshed)return;
   refreshed=true;
   location.reload();
  });
 }
 window.addEventListener("load",async()=>{
  try{
   const registration=await navigator.serviceWorker.register("./sw.js",{scope:"./",updateViaCache:"none"});
   registration.update().catch(()=>{});
  }catch(error){console.warn("Service worker registration failed:",error);}
 });
}
registerMusicServiceWorker();
