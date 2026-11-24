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
  "getTrackVersionKey",
  "extractVideoTitleMetadata",
  "lyricCacheVersionMatches",
  "lyricCacheNormalize",
  "getSongLyricCacheKeys",
  "canonicalArtistIdentity",
  "artistIdentityMatches",
  "getLyricsIdentity",
  "expectedTrackIdentity",
  "selectIdentifiedTrack",
  "selectTrackStart",
  "cachedArtistIdentityNames",
  "sharedLyricCacheMatches",
  "restoreTimedLineSpacing",
  "normalizeTimedLyricsSpacing",
  "preserveTimedTextSpacing",
  "finiteTimestampSeconds",
  "normalizeVideoBoundLyricsToSongTimeline",
  "getVideoLyricOffset",
  "getLyricLineStartTime",
];
const code = `const LYRIC_WORD_ANCHOR_MAX_ADJUSTMENT_SECONDS = 0.30;\nconst LYRIC_WORD_ANCHOR_LEGACY_SECONDS = 0.12;\nconst ARTIST_IDENTITY_ALIASES = [["버즈", "buzz"], ["카더가든", "car the garden"], ["너드커넥션", "nerd connection"], ["범진", "beomjin", "beom jin", "beom-jin"]];\n` + names.map(extractFunction).join("\n") + String.raw`
const missingOffsetLines = normalizeVideoBoundLyricsToSongTimeline([{time:10,text:"line"}], null);
if (missingOffsetLines.length !== 0) throw new Error("A missing video-to-song offset must not promote video-bound lyrics");
const normalizedWithMissingWord = normalizeVideoBoundLyricsToSongTimeline([
 {time:null,text:"missing line"},
 {time:10,text:"valid line",words:[{text:"missing",start:null,end:null},{text:"valid",start:10.1,end:10.3}]}
], 5);
if (normalizedWithMissingWord.length !== 1 || normalizedWithMissingWord[0].time !== 5) throw new Error("Missing line timestamps must be rejected during timeline normalization");
if (normalizedWithMissingWord[0].words[0].start !== null) throw new Error("Missing word timestamps must not be rewritten to zero during normalization");
if (Math.abs(normalizedWithMissingWord[0].words[1].start - 5.1) > 1e-9) throw new Error("Valid word timestamps must still be normalized by the detected offset");
if (getVideoLyricOffset("video", null) !== null) throw new Error("A missing TrackID offset must not become a zero-second offset");
if (getVideoLyricOffset("video", "") !== null) throw new Error("An empty TrackID offset must remain missing");
if (getVideoLyricOffset("video", 0) !== 0) throw new Error("A genuine zero-second TrackID offset must remain valid");
const missingTimestamp = {time:null,text:"누락된 시간",words:[]};
if (!Number.isNaN(getLyricLineStartTime(missingTimestamp))) throw new Error("A missing line timestamp must not be coerced to zero");
const nullWordTimestamp = {time:0.2,text:"hello world",words:[
 {text:"hello",start:null,end:0.1},{text:"world",start:0.3,end:0.48}
]};
if (getLyricLineStartTime(nullWordTimestamp)!==0.2) throw new Error("A missing first-word timestamp shifted the line to zero");
const noWordTiming = {time:2.0,text:"가사 한 줄",words:[]};
if (getLyricLineStartTime(noWordTiming)!==2.0) throw new Error("Lines without word timing must retain their original timestamp");
const alignedWordTiming = {time:2.0,text:"첫 음절로 시작",words:[
 {text:"첫",start:2.075,end:2.18},{text:" 음절로",start:2.22,end:2.55},{text:" 시작",start:2.58,end:2.9}
]};
if (getLyricLineStartTime(alignedWordTiming)!==2.075) throw new Error("A trusted first-word anchor within 120ms was not applied");
const earlyWordTiming = {time:2.1,text:"첫 음절로 시작",words:[
 {text:"첫",start:2.0,end:2.08},{text:" 음절로",start:2.12,end:2.4}
]};
if (getLyricLineStartTime(earlyWordTiming)!==2.0) throw new Error("A trusted early word anchor was not applied");
const moderateWordDelta = {...alignedWordTiming,words:alignedWordTiming.words.map(word=>({...word,start:word.start+0.20,end:word.end+0.20}))};
if (getLyricLineStartTime(moderateWordDelta)!==2.275) throw new Error("A text-verified first-word anchor within 300ms was not applied");
const largeWordDelta = {...alignedWordTiming,words:alignedWordTiming.words.map(word=>({...word,start:word.start+0.31,end:word.end+0.31}))};
if (getLyricLineStartTime(largeWordDelta)!==2.0) throw new Error("A word anchor beyond the 300ms safety bound changed the base timestamp");
const mismatchedWordText = {...alignedWordTiming,words:[
 {text:"다른",start:2.05,end:2.2},{text:" 내용",start:2.25,end:2.5}
]};
if (getLyricLineStartTime(mismatchedWordText)!==2.0) throw new Error("A mismatched first word changed the base timestamp");
const legacySingleTokenAnchor = {...alignedWordTiming,words:[
 {text:"첫",start:2.05,end:2.2},{text:" 엉뚱한",start:2.25,end:2.5}
]};
if (getLyricLineStartTime(legacySingleTokenAnchor)!==2.05) throw new Error("The previous 120ms first-word behavior regressed");
const mismatchedSecondWordText = {...alignedWordTiming,words:[
 {text:"첫",start:2.20,end:2.3},{text:" 엉뚱한",start:2.35,end:2.5}
]};
if (getLyricLineStartTime(mismatchedSecondWordText)!==2.0) throw new Error("A mismatched second word was accepted in the expanded timing window");
const closeAdjacentLines = [
 {time:2.0,text:"앞 줄",words:[{text:"앞",start:1.9,end:1.98},{text:" 줄",start:1.99,end:2.08}]},
 {time:2.1,text:"첫 음절로 시작",words:[
  {text:"첫",start:2.04,end:2.08},{text:" 음절로",start:2.12,end:2.4}
 ]}
];
if (getLyricLineStartTime(closeAdjacentLines[1],closeAdjacentLines,1)!==2.1) {
 throw new Error("Micro timing crossed the midpoint and could reorder adjacent lyric lines");
}
const singleWordTiming = {...alignedWordTiming,words:[alignedWordTiming.words[0]]};
if (getLyricLineStartTime(singleWordTiming)!==2.0) throw new Error("A single word timestamp was treated as a reliable anchor");
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
const alreadySpacedLines = [
  {time: 1.25, text: "안녕 오늘도"},
  {time: 3.5, text: "좋은 하루 보내"}
];
const idempotentSpacingResult = normalizeTimedLyricsSpacing(alreadySpacedLines, "안녕 오늘도\n좋은 하루 보내");
if (idempotentSpacingResult.unsafe || idempotentSpacingResult.lines.length !== alreadySpacedLines.length ||
    idempotentSpacingResult.lines.some((line, index) => line.time !== alreadySpacedLines[index].time || line.text !== alreadySpacedLines[index].text)) {
  throw new Error("already-correct Korean lyric spacing was modified");
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
if (homeSweetHomeLyricIdentity.title !== "Home Sweet Home" || homeSweetHomeLyricIdentity.artist !== "카더가든" || !homeSweetHomeLyricIdentity.artistKnown || !homeSweetHomeLyricIdentity.queries.some(query=>query.artist==="Car, the garden")) {
  throw new Error("Home Sweet Home lyric-upload artist/title parsing failed");
}
const homeSweetHomeOfficialIdentity = getLyricsIdentity({id:"home-sweet-home-official",title:"Home Sweet Home",channelTitle:"Car, the garden",description:"Provided to YouTube by FLUXUS\nHome Sweet Home · Car, the garden\nAPARTMENT"});
const homeSweetHomeIdentifiedIdentity = getLyricsIdentity({id:"home-sweet-home-identified",title:"Home Sweet Home"}, {title:"Home Sweet Home",artist:"Car, the garden"});
if (!(homeSweetHomeIdentifiedIdentity.artistAliases || []).includes("카더가든") || !homeSweetHomeIdentifiedIdentity.queries.some(query=>query.artist==="카더가든")) {
  throw new Error("Audio-identified Car, the garden track lost its Korean alias");
}
if (!artistIdentityMatches("Car, the garden", "카더가든")) {
  throw new Error("Car, the garden Korean/English identity alias was not recognized");
}
if (!artistIdentityMatches("너드커넥션", "Nerd Connection") || artistIdentityMatches("너드커넥션", "Nerdcore")) {
  throw new Error("Nerd Connection Korean/English identity alias was not recognized strictly");
}
if (homeSweetHomeOfficialIdentity.title !== "Home Sweet Home" || homeSweetHomeOfficialIdentity.artist !== "Car, the garden" || !homeSweetHomeOfficialIdentity.artistKnown || homeSweetHomeOfficialIdentity.artistAliases.includes("Car") || homeSweetHomeOfficialIdentity.artistAliases.includes("the garden") || !homeSweetHomeOfficialIdentity.artistAliases.includes("카더가든") || !homeSweetHomeOfficialIdentity.queries.some(query=>query.artist==="카더가든")) {
  throw new Error("Home Sweet Home auto-generated song · artist credit parsing failed");
}
const homeSweetHomeTopicIdentity = getLyricsIdentity({id:"home-sweet-home-topic",title:"Home Sweet Home",channelTitle:"Car, the garden - Topic"});
if (homeSweetHomeTopicIdentity.title !== "Home Sweet Home" || homeSweetHomeTopicIdentity.artist !== "Car, the garden" || !homeSweetHomeTopicIdentity.artistKnown) {
  throw new Error("Home Sweet Home Topic-channel identity parsing failed");
}

const soldOutOriginalVideoIdentity = getLyricsIdentity({
  id: "sold-out-original-video",
  title: "Hawk Nelson- Sold Out (Lyrics Video)",
  channelTitle: "Music Terminal",
  description: "OriginalMusicVideo: • Hawk Nelson - Sold Out (Official Lyric Video)"
});
if (soldOutOriginalVideoIdentity.title !== "Sold Out" || soldOutOriginalVideoIdentity.artist !== "Hawk Nelson" ||
    !soldOutOriginalVideoIdentity.artistKnown || !soldOutOriginalVideoIdentity.queries.some(query => query.artist === "Hawk Nelson")) {
  throw new Error("Sold Out original-video credit did not identify Hawk Nelson and the track");
}
const quietConnectionIdentity = getLyricsIdentity({
  id: "quiet-connection-video",
  title: "너드커넥션(Nerd Connection) - 조용히 완전히 영원히(Silently Completely Eternally) _ Official Lyrics Video",
  channelTitle: "Your Summer"
});
if (quietConnectionIdentity.title !== "조용히 완전히 영원히" ||
    !artistIdentityMatches(quietConnectionIdentity.artist, "Nerd Connection")) {
  throw new Error("Underscore-separated lyric-video suffix broke Nerd Connection track identity");
}
const compactSoldOutIdentity = getLyricsIdentity({
  id: "sold-out-compact-hyphen",
  title: "Hawk Nelson- Sold Out (Lyrics Video)",
  channelTitle: "Music Terminal"
});
if (compactSoldOutIdentity.title !== "Sold Out" || compactSoldOutIdentity.artist !== "Hawk Nelson" ||
    !compactSoldOutIdentity.artistKnown) {
  throw new Error("Compact hyphen in Hawk Nelson lyric-video title was not parsed");
}
const younhaMvIdentity = getLyricsIdentity({
  id: "younha-official-mv",
  title: "윤하(YOUNHA) - 사건의 지평선 M/V",
  channelTitle: "YOUNHA"
});
if (younhaMvIdentity.title !== "사건의 지평선" || younhaMvIdentity.artist !== "윤하" ||
    !(younhaMvIdentity.artistAliases || []).includes("YOUNHA")) {
  throw new Error("Official M/V suffix leaked into the YOUNHA song title");
}
const dynamiteOfficialIdentity = getLyricsIdentity({
  id: "bts-dynamite-official",
  title: "BTS (방탄소년단) 'Dynamite' Official MV",
  channelTitle: "HYBE LABELS"
});
if (dynamiteOfficialIdentity.title !== "Dynamite" || dynamiteOfficialIdentity.artist !== "BTS") {
  throw new Error("Quoted artist/title parsing failed for an official music video");
}
const dittoPerformanceIdentity = getLyricsIdentity({
  id: "newjeans-ditto-performance",
  title: "NewJeans (뉴진스) 'Ditto' Performance Video",
  channelTitle: "HYBE LABELS"
});
if (dittoPerformanceIdentity.title !== "Ditto" || dittoPerformanceIdentity.artist !== "NewJeans") {
  throw new Error("Quoted artist/title parsing failed for a performance video");
}
const buzzIdentity = getLyricsIdentity({id:"buzz-video",title:"[가사]버즈2집 비망록",channelTitle:"Won Just"});
if (buzzIdentity.title !== "비망록" || buzzIdentity.artist !== "버즈" || !(buzzIdentity.artistAliases || []).includes("Buzz")) {
  throw new Error("Buzz album-prefix title parsing failed");
}

const buzzTargetVideo = {id:"buzz-video",title:"[가사]버즈2집 비망록",channelTitle:"Won Just"};
const correctBuzzCache = {
  trackName:"비망록",artistName:"Buzz",videoMetadata:buzzTargetVideo,
  lines:[{time:0,text:"검증용 가사"},{time:3,text:"다음 줄"}]
};
if (!sharedLyricCacheMatches(correctBuzzCache,buzzTargetVideo)) {
  throw new Error("Previously working Buzz memoir track no longer matches its own verified cache");
}
const wrongBuzzTitleCache = {...correctBuzzCache,trackName:"스물의 노래"};
if (sharedLyricCacheMatches(wrongBuzzTitleCache,buzzTargetVideo)) {
  throw new Error("Buzz memoir accepted lyrics from the different song 스물의 노래");
}
const metadataCredits = extractVideoTitleMetadata("TICK TOCK (Feat. ZICO) (Prod. by ZICO, Crush) [쇼미더머니 12 Episode 1]ㅣLyrics/가사");
if (!metadataCredits.featuredArtists.includes("ZICO") || !metadataCredits.producerNames.includes("ZICO") ||
    !metadataCredits.producerNames.includes("Crush") || !metadataCredits.contextTags.includes("쇼미더머니 12 Episode 1")) {
  throw new Error("Featured artist, producer, or program context was lost during title analysis");
}
const tickTockIdentity = getLyricsIdentity({id:"ticktock-context",title:"TICK TOCK (Feat. ZICO) (Prod. by ZICO, Crush) [쇼미더머니 12 Episode 1]ㅣLyrics/가사",channelTitle:"알파"});
if (tickTockIdentity.title !== "TICK TOCK" || !tickTockIdentity.searchTerms.some(term=>term.includes("ZICO")) ||
    !tickTockIdentity.searchTerms.some(term=>term.includes("쇼미더머니 12 Episode 1"))) {
  throw new Error("Contextual title search variants were not generated for a lyric upload");
}
const shortTopicIdentity = getLyricsIdentity({id:"short-song",title:"인사",channelTitle:"가수 - Topic"});
if (shortTopicIdentity.title !== "인사" || shortTopicIdentity.artist !== "가수" || !shortTopicIdentity.artistKnown) {
  throw new Error("Short-title Topic-channel artist identity was not preserved");
}
const originalVersionVideo = {id:"original-version",title:"Artist - Song",channelTitle:"Artist - Topic"};
const remixVersionVideo = {id:"remix-version",title:"Artist - Song (Remix)",channelTitle:"Artist - Topic"};
const originalVersionCache = {trackName:"Song",artistName:"Artist",videoMetadata:originalVersionVideo};
if (lyricCacheVersionMatches(originalVersionCache,remixVersionVideo)) throw new Error("Original and remix versions shared a lyric cache");
const matchingRemixCache = {...originalVersionCache,videoMetadata:remixVersionVideo};
if (!lyricCacheVersionMatches(matchingRemixCache,remixVersionVideo)) throw new Error("Matching remix version cache was rejected");
if (sharedLyricCacheMatches(originalVersionCache,remixVersionVideo)) throw new Error("Original recording lyrics were reused for a remix");
if (!sharedLyricCacheMatches(matchingRemixCache,remixVersionVideo)) throw new Error("Same-version remix cache was not reusable");
const originalKeys=getSongLyricCacheKeys(originalVersionVideo);
const remixKeys=getSongLyricCacheKeys(remixVersionVideo);
if (originalKeys.some(key=>remixKeys.includes(key))) throw new Error("Original and remix cache keys were not isolated");
if (getTrackVersionKey("Artist - Live") !== "") throw new Error("A song titled Live was misclassified as a live recording");
const featureX=extractVideoTitleMetadata("Feat. X Ambassadors");
if (!featureX.featuredArtists.includes("X Ambassadors")) throw new Error("X Ambassadors was incorrectly split as a separator");
const beomjinVideo={id:"bbqr6NkJ88A",title:"범진 - 인사 [가사/Lyrics]",channelTitle:"웅키",duration:215};
const beomjinIdentity=getLyricsIdentity(beomjinVideo);
if (beomjinIdentity.title!=="인사"||beomjinIdentity.artist!=="범진"||!beomjinIdentity.artistKnown) throw new Error("Beomjin short-title identity parsing failed");
if (!artistIdentityMatches("Beomjin",beomjinIdentity.artist,1)) throw new Error("Romanized Beomjin artist alias was not recognized");
const koreanSuffixIdentity=getLyricsIdentity({id:"korean-label",title:"Artist - 인사 ㅣ가사",channelTitle:"Lyrics Channel"});
if (koreanSuffixIdentity.title!=="인사"||koreanSuffixIdentity.artist!=="Artist") throw new Error("Unbracketed Korean 가사 suffix blocked artist/title parsing");
const officialAudioIdentity=getLyricsIdentity({id:"official-audio",title:"Artist - Song (Official Audio)",channelTitle:"Music Channel"});
if (officialAudioIdentity.title!=="Song"||officialAudioIdentity.artist!=="Artist"||officialAudioIdentity.titles.includes("Official Audio")) throw new Error("Official Audio metadata blocked song identity parsing");
const quotedAudioIdentity=getLyricsIdentity({id:"quoted-audio",title:"BTS 'Dynamite' Official Audio",channelTitle:"Music Channel"});
if (quotedAudioIdentity.title!=="Dynamite"||quotedAudioIdentity.artist!=="BTS") throw new Error("Quoted Official Audio title parsing failed");
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
const trackVideo = sourceVideo;
const missingStartTrack = {title:"오래된 노래",artist:"스탠딩 에그",confidence:0.95,duration:230,timestamp:null};
if (selectTrackStart([missingStartTrack], trackVideo) !== null) {
  throw new Error("TrackID accepted a missing timestamp as a zero-second song start");
}
if (selectIdentifiedTrack([missingStartTrack], trackVideo) !== null) {
  throw new Error("Audio identification accepted a missing timestamp as a zero-second song start");
}
const zeroStartTrack = {...missingStartTrack,timestamp:0};
if (selectTrackStart([zeroStartTrack], trackVideo)?.timestamp !== 0) {
  throw new Error("A genuine zero-second TrackID start was incorrectly rejected");
}
if (selectIdentifiedTrack([zeroStartTrack], trackVideo)?.timestamp !== 0) {
  throw new Error("A genuine zero-second audio-identification start was incorrectly rejected");
}
console.log("PASS: cross-upload cache identity and strict TrackID timestamp validation");
`;
vm.runInNewContext(code, {console});
