const CACHE_PREFIX="music-pwa-";
const CACHE_VERSION="v134";
const CACHE_NAME=CACHE_PREFIX+CACHE_VERSION;
const APP_SHELL=[
 "./",
 "./index.html",
 "./style.css",
 "./app.js?v=134",
 "./manifest.json",
 "./icons/music-icon.svg",
 "./icons/icon-192.svg",
 "./icons/icon-512.svg"
];

self.addEventListener("message",event=>{
 if(event.data?.type==="SKIP_WAITING")self.skipWaiting();
});

self.addEventListener("install",event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE_NAME);
  await Promise.all(APP_SHELL.map(async path=>{
   try{await cache.add(new Request(path,{cache:"reload"}));}catch(error){console.warn("Precache skipped:",path,error);}
  }));
  await self.skipWaiting();
 })());
});

self.addEventListener("activate",event=>{
 event.waitUntil((async()=>{
  const names=await caches.keys();
  await Promise.all(names.filter(name=>name.startsWith(CACHE_PREFIX)&&name!==CACHE_NAME).map(name=>caches.delete(name)));
  await self.clients.claim();
 })());
});

self.addEventListener("fetch",event=>{
 const request=event.request;
 if(request.method!=="GET")return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(request.mode==="navigate"||url.pathname.endsWith("/index.html")){
  event.respondWith((async()=>{
   try{
    const fresh=await fetch(request,{cache:"no-store"});
    const cache=await caches.open(CACHE_NAME);
    cache.put("./index.html",fresh.clone()).catch(()=>{});
    return fresh;
   }catch(_){
    return (await caches.match("./index.html"))||Response.error();
   }
  })());
  return;
 }
 event.respondWith((async()=>{
  try{
   const fresh=await fetch(request,{cache:"no-store"});
   if(fresh.ok){
    const cache=await caches.open(CACHE_NAME);
    cache.put(request,fresh.clone()).catch(()=>{});
   }
   return fresh;
  }catch(_){
   return (await caches.match(request))||Response.error();
  }
 })());
});
