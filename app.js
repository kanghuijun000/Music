const API_BASE = "https://www.googleapis.com/youtube/v3";
const STORAGE_KEY = "musiq_youtube_api_key_v1";
const el = Object.fromEntries(["searchForm","searchInput","searchButton","resultsTitle","resultCount","resultsList","messageState","playerFrame","nowTitle","nowChannel","connectionStatus","settingsButton","settingsDialog","apiKeyInput","saveKeyButton","removeKeyButton"].map(id => [id,document.getElementById(id)]));
let apiKey = localStorage.getItem(STORAGE_KEY) || "";
let currentVideoId = "";
let lastResults = [];
let toastTimer;

function updateConnectionStatus(){const ready=Boolean(apiKey);el.connectionStatus.classList.toggle("ready",ready);el.connectionStatus.innerHTML=ready?"<i></i> 검색 연결됨":"<i></i> API 미설정";}
function showToast(message){let toast=document.querySelector(".toast");if(!toast){toast=document.createElement("div");toast.className="toast";toast.setAttribute("role","status");document.body.appendChild(toast);}toast.textContent=message;toast.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove("show"),2600);}
function openSettings(){el.apiKeyInput.value=apiKey;el.settingsDialog.showModal();}
function setLoading(loading){el.searchButton.disabled=loading;el.searchButton.innerHTML=loading?'<span>검색 중…</span>':'<span>검색</span><svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';}
function showMessage(title,description,kind="empty"){el.resultsList.replaceChildren();el.messageState.hidden=false;el.messageState.replaceChildren();const heading=document.createElement("h3");heading.textContent=title;const paragraph=document.createElement("p");paragraph.textContent=description;const art=document.createElement("div");art.className="empty-art";art.innerHTML=kind==="empty"?'<span class="disc"></span><span class="disc-hole"></span><span class="note">♪</span>':'<span class="note">!</span>';el.messageState.append(art,heading,paragraph);}
function setPlayer(video){currentVideoId=video.id;const frame=document.createElement("iframe");frame.title="YouTube 음악 플레이어";frame.src="https://www.youtube-nocookie.com/embed/"+encodeURIComponent(video.id)+"?autoplay=1&controls=1&playsinline=1&rel=0";frame.allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";frame.referrerPolicy="strict-origin-when-cross-origin";frame.allowFullscreen=true;el.playerFrame.replaceChildren(frame);el.nowTitle.textContent=video.title;el.nowChannel.textContent=video.channelTitle+" · YouTube";renderResults(lastResults);}
function renderResults(items){el.resultsList.replaceChildren();el.messageState.hidden=items.length>0;if(!items.length)return;const fragment=document.createDocumentFragment();items.forEach((video,index)=>{const row=document.createElement("article");row.className="track"+(video.id===currentVideoId?" active":"");const image=document.createElement("img");image.className="track-thumb";image.src=video.thumbnail;image.alt="";image.loading=index>5?"lazy":"eager";const info=document.createElement("div");info.className="track-info";const title=document.createElement("div");title.className="track-title";title.textContent=video.title;const channel=document.createElement("div");channel.className="track-channel";channel.textContent=video.channelTitle;const badge=document.createElement("div");badge.className="track-badge";badge.textContent="MUSIC CATEGORY";info.append(title,channel,badge);const play=document.createElement("button");play.type="button";play.className="play-track";play.setAttribute("aria-label",video.title+" 재생");play.innerHTML='<svg viewBox="0 0 24 24"><path d="M7 4.8c0-.8.9-1.3 1.6-.9l10.2 7.2c.6.4.6 1.3 0 1.8L8.6 20.1c-.7.5-1.6 0-1.6-.9V4.8Z"/></svg>';play.addEventListener("click",()=>setPlayer(video));row.addEventListener("click",event=>{if(!event.target.closest("button"))setPlayer(video);});row.append(image,info,play);fragment.append(row);});el.resultsList.append(fragment);}

/* Keep Google's exact error reason and message visible. The API key itself is never shown. */
async function youtubeRequest(endpoint,params){
  const url=new URL(API_BASE+"/"+endpoint);
  Object.entries({...params,key:apiKey}).forEach(([key,value])=>url.searchParams.set(key,value));
  let response;
  try{response=await fetch(url);}
  catch(error){
    const detail=error?.message||"브라우저 네트워크 오류";
    throw new Error("Google API에 연결하지 못했어요. ("+detail+") 네트워크 또는 브라우저의 요청 차단 여부를 확인해야 합니다.");
  }
  let data={};
  try{data=await response.json();}catch(_){}
  if(!response.ok){
    const apiError=data?.error||{};
    const reason=apiError.errors?.[0]?.reason||"reason 정보 없음";
    const message=apiError.message||response.statusText||"Google에서 오류 설명을 반환하지 않았습니다.";
    const status=response.status;
    let hint="";
    if(reason==="keyInvalid"||reason==="keyExpired")hint="Google Cloud에서 키가 삭제·만료되지 않았는지, 앱에 전체 키가 저장됐는지 확인하세요.";
    else if(reason==="accessNotConfigured")hint="이 API 키가 속한 바로 그 Google Cloud 프로젝트에서 YouTube Data API v3를 활성화해야 합니다.";
    else if(reason==="quotaExceeded"||reason==="dailyLimitExceeded")hint="프로젝트의 YouTube Data API 할당량을 초과했습니다. 추가 검색을 멈추고 할당량 화면을 확인하세요.";
    else if(/referer|referrer|API_KEY_HTTP_REFERRER_BLOCKED/i.test(reason+" "+message))hint="웹사이트 제한에 실제 GitHub Pages 도메인을 등록해야 합니다.";
    else if(status===403)hint="403만으로는 키 오류라고 판단할 수 없습니다. 아래 reason과 Google 메시지로 원인을 구분해야 합니다.";
    throw new Error("요청 단계: "+endpoint+". HTTP "+status+". Google 오류 코드: "+reason+". 설명: "+message+(hint?" 해결 단서: "+hint:""));
  }
  return data;
}
async function searchMusic(query){
  if(!apiKey){openSettings();showToast("먼저 YouTube API 키를 설정해 주세요.");return;}
  const clean=query.trim();if(!clean){showToast("노래 제목이나 가수를 입력해 주세요.");return;}
  el.resultsTitle.textContent='"'+clean+'" 검색 결과';el.resultCount.textContent="";
  showMessage("음악을 찾고 있어요","YouTube 음악 카테고리에서 검색 중입니다.","loading");setLoading(true);
  try{
    const searchData=await youtubeRequest("search",{part:"snippet",type:"video",videoCategoryId:"10",videoEmbeddable:"true",maxResults:"25",q:clean,regionCode:"KR",relevanceLanguage:"ko",safeSearch:"moderate",order:"relevance"});
    const ids=(searchData.items||[]).filter(item=>item.id?.videoId).map(item=>item.id.videoId);
    if(!ids.length){lastResults=[];el.resultCount.textContent="0곡";showMessage("검색 결과가 없어요","다른 노래 제목이나 가수 이름으로 검색해 보세요.");return;}
    const detailData=await youtubeRequest("videos",{part:"snippet,status",id:ids.join(",")});
    const allowed=new Map((detailData.items||[]).filter(video=>video.snippet?.categoryId==="10"&&video.status?.embeddable===true).map(video=>[video.id,video]));
    lastResults=(searchData.items||[]).filter(item=>allowed.has(item.id.videoId)).map(item=>{const video=allowed.get(item.id.videoId);const thumbs=video.snippet.thumbnails||item.snippet.thumbnails||{};return{id:video.id,title:video.snippet.title,channelTitle:video.snippet.channelTitle,thumbnail:thumbs.medium?.url||thumbs.high?.url||thumbs.default?.url||""};});
    el.resultCount.textContent=lastResults.length+"곡";
    if(!lastResults.length){showMessage("재생 가능한 음악이 없어요","검색은 성공했지만 음악 카테고리(10)이면서 외부 재생이 허용된 영상이 없어요. 다른 검색어를 시도해 보세요.");return;}
    renderResults(lastResults);
  }catch(error){
    console.error("MUSIQ search failure:",error?.message||error);
    lastResults=[];el.resultCount.textContent="";
    showMessage("검색할 수 없어요",error?.message||"알 수 없는 오류가 발생했습니다.","error");
  }finally{setLoading(false);}
}
el.searchForm.addEventListener("submit",event=>{event.preventDefault();searchMusic(el.searchInput.value);});
document.querySelectorAll("[data-query]").forEach(button=>button.addEventListener("click",()=>{el.searchInput.value=button.dataset.query;searchMusic(button.dataset.query);}));
el.settingsButton.addEventListener("click",openSettings);
el.saveKeyButton.addEventListener("click",()=>{const value=el.apiKeyInput.value.trim();if(!value){showToast("API 키를 입력해 주세요.");return;}apiKey=value;localStorage.setItem(STORAGE_KEY,apiKey);updateConnectionStatus();el.settingsDialog.close();showToast("API 키를 이 기기에 저장했어요.");});
el.removeKeyButton.addEventListener("click",()=>{apiKey="";localStorage.removeItem(STORAGE_KEY);el.apiKeyInput.value="";updateConnectionStatus();el.settingsDialog.close();showToast("저장된 API 키를 삭제했어요.");});
el.settingsDialog.addEventListener("click",event=>{if(event.target===el.settingsDialog)el.settingsDialog.close();});
updateConnectionStatus();if(!apiKey)showMessage("먼저 검색 연결을 설정해 주세요","오른쪽 위 설정에서 YouTube Data API 키를 입력하면 음악 검색을 시작할 수 있어요.","error");
