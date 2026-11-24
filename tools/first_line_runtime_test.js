#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("app.js", "utf8");
const start = source.indexOf("const LYRIC_LEAD_SECONDS=0.04;");
const end = source.indexOf("let lyricPreviewRenderedToken", start);
assert.ok(start >= 0 && end > start, "timing block must exist");
const timingBlock = source.slice(start, end);
const context = {
  lyricOffsetSeconds: 0.3,
  currentVideoId: "TKDpOEkT0cY",
  lyricState: { lines: [{ time: 0, text: "first lyric" }] }
};
vm.createContext(context);
vm.runInContext(timingBlock, context);

assert.equal(context.getVideoFirstLineCalibrationSeconds("TKDpOEkT0cY"), 0.15);
assert.equal(context.getVideoFirstLineCalibrationSeconds("unlisted-video"), 0);
assert.ok(Math.abs(context.getLyricTimelineOffsetSeconds("TKDpOEkT0cY") - 0.11) < 1e-9);
assert.ok(Math.abs(context.getLyricTimelineOffsetSeconds("unlisted-video") - 0.26) < 1e-9);
assert.equal(context.getLyricLineIndexAtPlayerTime(0.15, "TKDpOEkT0cY"), 0,
  "the known late first line should advance by its video-only calibration");
assert.equal(context.getLyricLineIndexAtPlayerTime(0.15, "unlisted-video"), -1,
  "unlisted videos must retain their original first-line timing");
assert.equal(context.getLyricLineIndexAtPlayerTime(0.30, "unlisted-video"), 0,
  "unlisted videos should still render at the original threshold");

console.log("PASS: Love Yourself video-only first-line correction; unrelated videos unchanged.");
