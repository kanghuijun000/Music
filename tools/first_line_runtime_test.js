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

// Lock down the existing per-line word-anchor behavior before adding any new layer.
const lineAt50ms = {
  time: 10.0, text: "hello world",
  words: [
    { text: "hello", start: 10.05, end: 10.18 },
    { text: "world", start: 10.22, end: 10.48 }
  ]
};
assert.ok(Math.abs(context.getLyricLineStartTime(lineAt50ms) - 10.05) < 1e-9,
  "a validated 50ms first-word anchor should remain measurable");

const lineAt200ms = {
  time: 10.0, text: "hello world",
  words: [
    { text: "hello", start: 10.20, end: 10.34 },
    { text: "world", start: 10.42, end: 10.70 }
  ]
};
assert.ok(Math.abs(context.getLyricLineStartTime(lineAt200ms) - 10.20) < 1e-9,
  "a 200ms anchor requires and accepts two consecutive matching word tokens");

const lineAt310ms = {
  time: 10.0, text: "hello world",
  words: [
    { text: "hello", start: 10.31, end: 10.42 },
    { text: "world", start: 10.50, end: 10.72 }
  ]
};
assert.equal(context.getLyricLineStartTime(lineAt310ms), 10.0,
  "adjustments beyond the existing 300ms safety bound must be rejected");

const mismatchedWord = {
  time: 10.0, text: "hello world",
  words: [
    { text: "wrong", start: 10.05, end: 10.18 },
    { text: "world", start: 10.22, end: 10.48 }
  ]
};
assert.equal(context.getLyricLineStartTime(mismatchedWord), 10.0,
  "word timing must not adjust a line when the text prefix does not match");

const invalidGap = {
  time: 10.0, text: "hello world",
  words: [
    { text: "hello", start: 10.05, end: 10.18 },
    { text: "world", start: 11.70, end: 11.90 }
  ]
};
assert.equal(context.getLyricLineStartTime(invalidGap), 10.0,
  "implausible gaps between the first two words must be rejected");

const evidence = context.getLyricWordTimingEvidence([lineAt50ms], 1);
assert.equal(evidence.length, 1);
assert.equal(evidence[0].wordCount, 2);
assert.equal(evidence[0].firstWords[0].start, 10.05);
assert.equal(evidence[0].appliedWordAnchorDelta, 0.05,
  "QA evidence must expose the actual applied word-anchor delta");
assert.ok(Math.abs(context.getLyricLineStartTime(lineAt200ms) - 10.20) < 1e-9);

console.log("PASS: video-only calibration isolation, existing word-anchor safeguards, and read-only QA evidence.");
