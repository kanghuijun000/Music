#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("app.js", "utf8");

function extractFunction(name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("Missing app function: " + name);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unclosed app function: " + name);
}

const names = [
  "trackText",
  "trackSimilarity",
  "canonicalArtistIdentity",
  "artistIdentityMatches",
  "getLyricsIdentity",
  "cachedArtistIdentityNames",
  "sharedLyricCacheMatches",
  "restoreTimedLineSpacing",
  "normalizeTimedLyricsSpacing",
  "preserveTimedTextSpacing",
];
const code = `const ARTIST_IDENTITY_ALIASES = [["버즈", "buzz"]];\n` + names.map(extractFunction).join("\n") + String.raw`
const ttmlSpaced = preserveTimedTextSpacing("오래된 노래를 다시 불러", "오래된노래를다시불러");
if (ttmlSpaced !== "오래된 노래를 다시 불러") throw new Error("TTML source whitespace was not preserved");
const ttmlNoSpace = preserveTimedTextSpacing("오래된노래를다시불러", "오래된노래를다시불러");
if (ttmlNoSpace !== "오래된노래를다시불러") throw new Error("TTML source text was unexpectedly modified");
const ttmlMismatch = preserveTimedTextSpacing("다른 가사", "오래된노래");
if (ttmlMismatch !== "오래된노래") throw new Error("TTML spacing helper accepted mismatched text");
const spacedLines = [
  {time:0,text:"오래전그날"},
  {time:3,text:"너와함께걷던길"},
  {time:6,text:"기억하고있니"}
];
const spacedPlain = "오래전 그날\n너와 함께 걷던 길\n기억하고 있니";
const restoredLines = restoreTimedLineSpacing(spacedLines, spacedPlain);
if (restoredLines === spacedLines || restoredLines.map(x=>x.text).join("|") !== "오래전 그날|너와 함께 걷던 길|기억하고 있니") {
  throw new Error("Korean spacing restoration from same-song plain lyrics failed");
}
if (restoredLines[0].time !== 0 || restoredLines[1].time !== 3 || restoredLines[2].time !== 6) {
  throw new Error("Spacing restoration changed synced timestamps");
}
const freshCandidate = normalizeTimedLyricsSpacing(spacedLines, spacedPlain);
if (freshCandidate.unsafe || freshCandidate.lines.map(x=>x.text).join("|") !== "오래전 그날|너와 함께 걷던 길|기억하고 있니") {
  throw new Error("Fresh provider candidate did not receive verified Korean spacing restoration");
}
const malformedCandidate = [
  {time:0,text:"오래된노래를다시불러"},
  {time:3,text:"너와함께걷던길을걸어"},
  {time:6,text:"기억속에남아있는그날"}
];
const rejectedCandidate = normalizeTimedLyricsSpacing(malformedCandidate, "");
if (!rejectedCandidate.unsafe || rejectedCandidate.lines.length !== 0) {
  throw new Error("Unverified unspaced Korean synced lyrics were not blocked");
}
const shortLegitimateLine = normalizeTimedLyricsSpacing([{time:0,text:"사랑해"}], "");
if (shortLegitimateLine.unsafe || shortLegitimateLine.lines.length !== 1) {
  throw new Error("A short Korean lyric line was incorrectly blocked");
}
const unrelatedPlain = "전혀 다른 노래의 가사입니다\n아무런 연관이 없는 문장";
if (restoreTimedLineSpacing(spacedLines, unrelatedPlain) !== spacedLines) {
  throw new Error("Spacing restoration accepted unrelated lyrics");
}
const alreadySpaced = [{time:0,text:"이미 띄어쓰기가 있는 가사"}];
if (restoreTimedLineSpacing(alreadySpaced, "이미 띄어쓰기가 있는 가사") !== alreadySpaced) {
  throw new Error("Spacing restoration unnecessarily modified already-spaced lyrics");
}
const sourceVideo = {
  id: "source-video",
  title: "스탠딩 에그(Standing Egg) - 오래된 노래 [가사/Lyrics]",
  channelTitle: "웅키",
  duration: 272
};
const targetVideo = {
  id: "topic-video",
  title: "오래된 노래",
  channelTitle: "Standing Egg - Topic",
  duration: 272
};
const homeSweetHomeLyricIdentity = getLyricsIdentity({id:"home-sweet-home-lyrics",title:"카더가든 - Home Sweet Home(가사.lyrics)",channelTitle:"한구PLAYLIST"});
if (homeSweetHomeLyricIdentity.title !== "Home Sweet Home" || homeSweetHomeLyricIdentity.artist !== "카더가든" || !homeSweetHomeLyricIdentity.artistKnown) {
  throw new Error("Home Sweet Home lyric-upload artist/title parsing failed");
}
const homeSweetHomeOfficialIdentity = getLyricsIdentity({id:"home-sweet-home-official",title:"Home Sweet Home",channelTitle:"Car, the garden",description:"Provided to YouTube by FLUXUS\nHome Sweet Home · Car, the garden\nAPARTMENT"});
if (homeSweetHomeOfficialIdentity.title !== "Home Sweet Home" || homeSweetHomeOfficialIdentity.artist !== "Car, the garden" || !homeSweetHomeOfficialIdentity.artistKnown) {
  throw new Error("Home Sweet Home auto-generated song · artist credit parsing failed");
}
const homeSweetHomeTopicIdentity = getLyricsIdentity({id:"home-sweet-home-topic",title:"Home Sweet Home",channelTitle:"Car, the garden - Topic"});
if (homeSweetHomeTopicIdentity.title !== "Home Sweet Home" || homeSweetHomeTopicIdentity.artist !== "Car, the garden" || !homeSweetHomeTopicIdentity.artistKnown) {
  throw new Error("Home Sweet Home Topic-channel identity parsing failed");
}

const buzzIdentity = getLyricsIdentity({id:"buzz-video",title:"[가사]버즈2집 비망록",channelTitle:"Won Just"});
if (buzzIdentity.title !== "비망록" || buzzIdentity.artist !== "버즈" || !(buzzIdentity.artistAliases || []).includes("Buzz")) {
  throw new Error("Buzz album-prefix title parsing failed");
}
const dittoIdentity = getLyricsIdentity({id:"ditto-video",title:"NewJeans 'Ditto' Lyrics (뉴진스 Ditto 가사) (Color Coded Lyrics)",channelTitle:"Jaeguchi"});
if (dittoIdentity.title !== "Ditto" || dittoIdentity.artist !== "NewJeans") {
  throw new Error("Quoted artist/title lyric-video parsing failed");
}
if (dittoIdentity.titles.length !== 1 || dittoIdentity.titles[0] !== "Ditto") {
  throw new Error("Quoted lyric metadata leaked into song-title aliases");
}
const identity = getLyricsIdentity(sourceVideo);
if (identity.title !== "오래된 노래") throw new Error("Source title parsing failed");
if (identity.artist !== "스탠딩 에그") throw new Error("Source artist parsing failed");
if (!(identity.artistAliases || []).includes("Standing Egg")) throw new Error("English artist alias was lost");

const correctCache = {
  trackName: "오래된 노래",
  artistName: "스탠딩 에그",
  videoMetadata: sourceVideo
};
if (!sharedLyricCacheMatches(correctCache, targetVideo)) {
  throw new Error("Same-song cache did not match the verified English artist alias");
}
const wrongArtistCache = {...correctCache, artistName: "IU"};
if (sharedLyricCacheMatches(wrongArtistCache, targetVideo)) {
  throw new Error("Cache accepted an unrelated provider artist");
}
const wrongTitleVideo = {...targetVideo, id: "wrong-title", title: "다른 노래"};
if (sharedLyricCacheMatches(correctCache, wrongTitleVideo)) {
  throw new Error("Cache accepted a different song title");
}
console.log("PASS: cross-upload artist alias reuse remains title- and artist-verified");
`;
vm.runInNewContext(code, {console});
