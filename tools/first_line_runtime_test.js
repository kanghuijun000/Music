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

context.lyricState.lines = [{ time: 0.10, text: "first lyric" }];
assert.equal(context.getLyricLineIndexAtPlayerTime(0.21, "TKDpOEkT0cY"), 0,
  "the calibrated video must use the same adjusted timeline for its first-line threshold");

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

const nullWordStart = {
  time: 0.20, text: "hello world",
  words: [
    { text: "hello", start: null, end: 0.10 },
    { text: "world", start: 0.30, end: 0.48 }
  ]
};
assert.equal(context.getLyricLineStartTime(nullWordStart), 0.20,
  "a missing word timestamp must never be coerced to time zero and shift a lyric early");
assert.ok(Number.isNaN(context.finiteTimestampSeconds(null)),
  "a missing timestamp must remain invalid");
assert.ok(Number.isNaN(context.finiteTimestampSeconds("   ")),
  "a blank timestamp must remain invalid");
assert.ok(Number.isNaN(context.finiteTimestampSeconds(false)),
  "a boolean must not become a zero-second timestamp");
assert.equal(context.finiteTimestampSeconds(0), 0,
  "a genuine zero-second timestamp must remain valid");
assert.equal(context.finiteTimestampSeconds("0.05"), 0.05,
  "numeric timestamp strings must retain millisecond-scale precision");
assert.ok(Number.isNaN(context.getLyricLineStartTime({ time: null, text: "missing", words: [] })),
  "a missing lyric line timestamp must not become time zero");
assert.ok(Number.isNaN(context.providerMillisecondsToSeconds(null)),
  "a missing provider timestamp must remain missing");
assert.ok(Number.isNaN(context.providerMillisecondsToSeconds("")),
  "an empty provider timestamp must remain missing");
assert.ok(Number.isNaN(context.providerMillisecondsToSeconds("   ")),
  "a whitespace-only provider timestamp must remain missing");
assert.ok(Number.isNaN(context.providerMillisecondsToSeconds(false)),
  "a boolean must not be coerced into a zero timestamp");
assert.equal(context.providerMillisecondsToSeconds(0), 0,
  "a real zero-millisecond timestamp must remain valid");
assert.equal(context.providerMillisecondsToSeconds(50), 0.05,
  "provider milliseconds must convert without losing 50ms precision");

const parserStart = source.indexOf("function parseYamlText(");
const parserEnd = source.indexOf("function showLyricsMessage(", parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart, "lyricsfile parser block must exist");
const parserContext = {
  providerMillisecondsToSeconds: context.providerMillisecondsToSeconds,
  isCreditMetadata: () => false
};
vm.createContext(parserContext);
vm.runInContext(source.slice(parserStart, parserEnd), parserContext);
const parsedLyricsfile = parserContext.parseLyricsfile(`lines:
  - text: hello world
    start_ms: 200
    end_ms: 500
    words:
      - text: hello
        start_ms:
        end_ms: 300
      - text: world
        start_ms: 350
        end_ms: 500
`);
assert.equal(parsedLyricsfile.length, 1);
assert.equal(parsedLyricsfile[0].time, 0.2);
assert.equal(parsedLyricsfile[0].words.length, 1,
  "lyricsfile parser must discard a word whose start_ms is missing");
assert.equal(parsedLyricsfile[0].words[0].text, "world");
assert.equal(parsedLyricsfile[0].words[0].start, 0.35);

const normalizeStart = source.indexOf("function normalizeVideoBoundLyricsToSongTimeline(");
const normalizeEnd = source.indexOf("async function resolveReferenceVideoSongOffset(", normalizeStart);
assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, "video timeline normalizer must exist");
const normalizeContext = { finiteTimestampSeconds: context.finiteTimestampSeconds };
vm.createContext(normalizeContext);
vm.runInContext(source.slice(normalizeStart, normalizeEnd), normalizeContext);
const normalizedVideoLines = normalizeContext.normalizeVideoBoundLyricsToSongTimeline([
  { time: null, text: "missing line time", words: [] },
  { time: 5, text: "valid line", words: [
    { text: "missing word start", start: null, end: 6 },
    { text: "valid word", start: 5.2, end: 5.5 }
  ] }
], 2);
assert.equal(normalizedVideoLines.length, 1,
  "video normalization must discard a line with a missing timestamp");
assert.equal(normalizedVideoLines[0].time, 3);
assert.equal(normalizedVideoLines[0].words[0].start, null,
  "video normalization must preserve missing word times instead of converting them to zero");
assert.equal(normalizedVideoLines[0].words[1].start, 3.2);

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
assert.equal(context.getLyricTextFingerprint("Hello world"), context.getLyricTextFingerprint("hello-world"),
  "normalized lyric fingerprints must match equivalent text without storing lyric text");
assert.ok(evidence[0].textFingerprint);
assert.equal(Object.hasOwn(evidence[0], "text"), false,
  "QA evidence must not export lyric line text");
assert.equal(Object.hasOwn(evidence[0].firstWords[0], "text"), false,
  "QA evidence must not export lyric word text");
assert.equal(evidence[0].firstWords[0].start, 10.05);
const nullEvidence = context.getLyricWordTimingEvidence([nullWordStart], 1);
assert.equal(nullEvidence[0].firstWords[0].start, null,
  "QA must preserve missing word timestamps rather than reporting false zero values");
assert.equal(evidence[0].appliedWordAnchorDelta, 0.05,
  "QA evidence must expose the actual applied word-anchor delta");
assert.ok(Math.abs(context.getLyricLineStartTime(lineAt200ms) - 10.20) < 1e-9);

console.log("PASS: video-only calibration isolation, existing word-anchor safeguards, and read-only QA evidence.");
