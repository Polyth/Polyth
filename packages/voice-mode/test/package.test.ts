// Voice mode's pure parts: what of an agent turn is spoken, preference
// parsing, and the locale catalogs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES } from "@polyth/contracts";
import {
  VOICE_MODE_STRINGS,
  bargeInEnabled,
  createReplyTracker,
  defaultVoiceModePrefs,
  formatVoiceString,
  isAppleMobile,
  parseVoiceModePrefs,
  sameUtterance,
  voiceModeStrings,
} from "../src/index.ts";

const event = (type: string, data: Record<string, unknown>, seq = 1) => ({ sessionId: "s1", seq, type, data });

test("a reply that never streams is spoken from its final message", () => {
  const tracker = createReplyTracker();
  const update = tracker.accept(event("assistant/message", { partId: "p1", text: "Done. Two files changed." }));
  assert.deepEqual(update.speak, ["Done.", "Two files changed."]);
  assert.deepEqual(tracker.accept(event("assistant/message", { partId: "p1", text: "Done. Two files changed." })).speak, [],
    "a repeated final message is not read twice");
});

test("a final message only adds what the stream had not delivered", () => {
  const tracker = createReplyTracker();
  assert.deepEqual(tracker.accept(event("assistant/chunk", { partId: "p1", text: "Checking now. Then" })).speak, ["Checking now."]);
  assert.deepEqual(
    tracker.accept(event("assistant/message", { partId: "p1", text: "Checking now. Then I will report back." })).speak,
    ["Then I will report back."],
  );
  assert.deepEqual(tracker.accept(event("assistant/chunk", { partId: "p1", text: " late" })).speak, [],
    "a finalized part ignores late chunks");
});

test("a provider rewrite in the final message is not re-read from the top", () => {
  const tracker = createReplyTracker();
  tracker.accept(event("assistant/chunk", { partId: "p1", text: "Hello there. " }));
  const update = tracker.accept(event("assistant/message", { partId: "p1", text: "Hi! Something else entirely." }));
  assert.deepEqual(update.speak, []);
});

test("tools, requests and the turn end become status, never speech", () => {
  const tracker = createReplyTracker({ codePlaceholder: "Code is on screen." });
  assert.deepEqual(tracker.accept(event("turn/started", { turnId: "t" })).activity, { kind: "thinking" });
  tracker.accept(event("assistant/chunk", { partId: "p1", text: "Let me look\n```ts\nconst x = 1;\n```\n" }));
  const tool = tracker.accept(event("tool/call", { callId: "c", tool: "read", status: "running", input: {} }));
  assert.deepEqual(tool.activity, { kind: "tool", tool: "read" });
  assert.deepEqual(tracker.accept(event("question/asked", { requestId: "q", questions: [] })).activity, { kind: "needs-input" });
  const done = tracker.accept(event("turn/stopped", { reason: "error", error: "boom" }));
  assert.deepEqual(done.activity, { kind: "done", reason: "error", error: "boom" });
  assert.deepEqual(tracker.accept(event("assistant/reasoning-chunk", { partId: "p2", text: "secret thoughts. " })).speak, []);
});

test("the spoken transcript matches its canonical user message", () => {
  assert.equal(sameUtterance("fix the  test", "Fix the test"), true);
  assert.equal(sameUtterance("add a test", "Context first.\nadd a test"), true, "typed words before the dictation are fine");
  assert.equal(sameUtterance("", "anything"), false);
  assert.equal(sameUtterance("deploy", "something else"), false);
});

test("preferences parse defensively", () => {
  assert.deepEqual(parseVoiceModePrefs(null), defaultVoiceModePrefs());
  assert.deepEqual(parseVoiceModePrefs("{bad json"), defaultVoiceModePrefs());
  const parsed = parseVoiceModePrefs(JSON.stringify({ turnTaking: "manual", pause: "patient", bargeIn: "off", captions: false, presentation: "weird" }));
  assert.equal(parsed.turnTaking, "manual");
  assert.equal(parsed.pause, "patient");
  assert.equal(parsed.bargeIn, "off");
  assert.equal(parsed.captions, false);
  assert.equal(parsed.presentation, "compact", "unknown values fall back to the default");
  assert.equal(defaultVoiceModePrefs().presentation, "compact", "voice mode is not full screen by default");
  assert.equal(parseVoiceModePrefs(JSON.stringify({ presentation: "auto" })).presentation, "compact",
    "the retired automatic layout no longer opens full screen on phones");
  assert.equal(parseVoiceModePrefs(JSON.stringify({ presentation: "immersive" })).presentation, "immersive");
});

test("automatic barge-in stays off on Apple mobile WebKit", () => {
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 };
  const ipad = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 };
  const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 };
  assert.equal(isAppleMobile(iphone), true);
  assert.equal(isAppleMobile(ipad), true, "iPadOS reports a desktop user agent");
  assert.equal(isAppleMobile(mac), false);
  assert.equal(bargeInEnabled({ bargeIn: "auto" }, iphone), false);
  assert.equal(bargeInEnabled({ bargeIn: "auto" }, mac), true);
  assert.equal(bargeInEnabled({ bargeIn: "on" }, iphone), true, "an explicit choice wins");
  assert.equal(bargeInEnabled({ bargeIn: "off" }, mac), false);
});

test("every Polyth locale has a complete, non-empty voice mode catalog", () => {
  const keys = Object.keys(VOICE_MODE_STRINGS.en).sort();
  for (const locale of LOCALES) {
    const catalog = VOICE_MODE_STRINGS[locale];
    assert.deepEqual(Object.keys(catalog).sort(), keys, `${locale} has exactly the English keys`);
    for (const [key, value] of Object.entries(catalog)) assert.ok(value.trim(), `${locale}.${key} is not empty`);
    assert.match(catalog.workingOn, /\{tool\}/, `${locale}.workingOn keeps its placeholder`);
  }
  assert.equal(voiceModeStrings("xx").title, "Voice mode", "an unknown locale falls back to English");
  assert.equal(formatVoiceString("Working: {tool}", { tool: "edit" }), "Working: edit");
});
