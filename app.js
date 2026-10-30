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
  }else {showLyricsMessage("이 곡의 가사를 찾지 못했어요");lyricState.lastIndex=-3;}
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
 showLyricsMessage("무료 가사 데이터에서 검색하고 있어요…");
 const cacheKey=video.id;
 if(lyricCache.has(cacheKey)){
  const cached=lyricCache.get(cacheKey);
  lyricState.lines=cached.lines;lyricState.plain=cached.plain;lyricState.wordSynced=cached.wordSynced;
  renderLyrics();return;
 }
 const headers={"X-User-Agent":"Music/1.0 (https://kanghuijun000.github.io/)"};
 const duration=video.duration||0;
 const cleanTitle=String(video.title||"")
  .replace(/\[[^\]]*\]|\([^)]*\)/g," ")
  .replace(/\\s*[-–|]\\s*(official|lyrics?|audio|video|visuali[sz]er|mv|topic)\\b/gi," ")
  .replace(/\\s+/g," ").trim();
 const normalize=value=>String(value||"").toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g," ").replace(/\\s*[-–|]\\s*(official|lyrics?|audio|video|visuali[sz]er|mv|topic)\\b/gi," ").replace(/[^\\p{L}\\p{N}]+/gu," ").trim();
 const wanted=normalize(cleanTitle);
 const channel=String(video.channelTitle||"").replace(/\\s*-\\s*Topic$/i,"").trim();
 const splitTitle=cleanTitle.split(/\\s+[-–|]\\s+/).map(value=>value.trim()).filter(Boolean);
 const trackCandidates=[cleanTitle,splitTitle[0],video.title].filter((value,index,array)=>value&&array.indexOf(value)===index);
 const artistCandidates=[splitTitle.length>1?splitTitle.slice(1).join(" - "):"",channel].filter((value,index,array)=>value&&array.indexOf(value)===index);
 let candidates=[];
 const seen=new Set();
 let transientErrors=[];
 const addResults=items=>{
  for(const item of (Array.isArray(items)?items:[])){
   if(item&&item.id&&!seen.has(item.id)){seen.add(item.id);candidates.push(item);}
  }
 };
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function requestWithRetry(url){
  let response=await fetch(url,{headers});
  if(response.status===503||response.status===429){
   const retryAfter=Number(response.headers.get("Retry-After")||1);
   if(Number.isFinite(retryAfter)&&retryAfter>0&&retryAfter<=3){
    await wait(retryAfter*1000);
    response=await fetch(url,{headers});
   }
  }
  return response;
 }
 try{
  // 제목 전체와 제목/가수 분리 검색을 시도한다. 일시적인 서버 오류는 다른 검색어를 막지 않는다.
  const queries=[...new Set([cleanTitle,splitTitle[0],video.title].filter(Boolean))];
  for(const query of queries){
   const search=new URL(LYRIC_API+"/search");
   search.searchParams.set("q",query);
   try{
    const response=await requestWithRetry(search);
    if(response.status===429||response.status===503){
     transientErrors.push("HTTP "+response.status);
     continue;
    }
    if(!response.ok)continue;
    addResults(await response.json());
    if(candidates.some(item=>normalize(item.trackName||item.name)===normalize(splitTitle[0]||cleanTitle)))break;
   }catch(error){
    transientErrors.push(error?.message||"네트워크 오류");
   }
  }
  // 제목이 '곡명 - 가수명' 형태라면 실제 곡명과 가수명 조합으로도 검색한다.
  for(const trackName of trackCandidates.slice(0,2)){
   for(const artistName of artistCandidates.slice(0,2)){
    const search=new URL(LYRIC_API+"/search");
    search.searchParams.set("track_name",trackName);
    search.searchParams.set("artist_name",artistName);
    try{
     const response=await requestWithRetry(search);
     if(response.status===429||response.status===503){transientErrors.push("HTTP "+response.status);continue;}
     if(response.ok)addResults(await response.json());
    }catch(error){transientErrors.push(error?.message||"네트워크 오류");}
   }
  }
  const wantedTitles=[normalize(cleanTitle),normalize(splitTitle[0]||"")].filter(Boolean);
  const ranked=candidates.map(item=>{
   const title=normalize(item.trackName||item.name);
   const titleMatch=wantedTitles.some(target=>title&&(title===target||title.includes(target)||target.includes(title)));
   const durationDifference=item.duration&&duration?Math.abs(item.duration-duration):9999;
   const score=(item.syncedLyrics?100:0)+(item.plainLyrics?10:0)+(titleMatch?100:-100)+(durationDifference<=2?55:durationDifference<=8?30:durationDifference<=20?5:-30);
   return {...item,_score:score,_durationDifference:durationDifference};
  }).sort((a,b)=>b._score-a._score);
  let selected=ranked.find(item=>(item.syncedLyrics||item.plainLyrics)&&item._score>0);
  // 검색 API에서 찾지 못했을 때 메타데이터 기반 직접 조회를 보조로 사용한다.
  if(!selected&&duration>0){
   for(const trackName of trackCandidates.slice(0,2)){
    for(const artistName of artistCandidates.slice(0,2)){
     const exact=new URL(LYRIC_API+"/get");
     exact.searchParams.set("track_name",trackName);
     exact.searchParams.set("artist_name",artistName);
     exact.searchParams.set("duration",String(duration));
     try{
      const response=await requestWithRetry(exact);
      if(response.status===429||response.status===503){transientErrors.push("HTTP "+response.status);continue;}
      if(response.ok){
       const exactItem=await response.json();
       if(exactItem&&(exactItem.syncedLyrics||exactItem.plainLyrics)){selected=exactItem;break;}
      }
     }catch(error){transientErrors.push(error?.message||"네트워크 오류");}
    }
    if(selected)break;
   }
  }
  if(!selected){
   if(transientErrors.length){
    showLyricsMessage("가사 서버가 일시적으로 바빠요. 잠시 후 다시 시도해 주세요.");
   }else{
    showLyricsMessage("이 곡의 가사를 무료 데이터베이스에서 찾지 못했어요");
   }
   return;
  }
  const wordLines=selected.hasWordSync?parseLyricsfile(selected.lyricsfile):[];
  const hasWords=wordLines.some(item=>item.words.length>0);
  lyricState.lines=hasWords?wordLines:parseLrc(selected.syncedLyrics||"");
  lyricState.plain=selected.plainLyrics||"";
  lyricState.wordSynced=hasWords;
  lyricState.lastIndex=-1;lyricState.lastWordIndex=-1;
  if(!lyricState.lines.length&&!lyricState.plain){
   showLyricsMessage("이 곡의 가사 데이터가 비어 있어요");return;
  }
  lyricCache.set(cacheKey,{lines:lyricState.lines,plain:lyricState.plain,wordSynced:hasWords});
  renderLyrics();
 }catch(error){
  console.warn("Lyrics lookup failed:",error);
  showLyricsMessage(error?.message||"무료 가사 검색에 실패했어요. 잠시 후 다시 시도해 주세요.");
 }
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