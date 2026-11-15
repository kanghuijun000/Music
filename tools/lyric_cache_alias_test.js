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
];
const code = "const ARTIST_IDENTITY_ALIASES = [[\"버즈\", \"buzz\"]];\\n" + names.map(extractFunction).join("\\n") + String.raw`
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
