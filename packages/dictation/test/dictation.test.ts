import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantReplyTextAt,
  defaultVoicePrefs,
  mergeTranscript,
  parseVoicePrefs,
  recognitionCtor,
  serializeVoicePrefs,
  speakableText,
  speechSupport,
} from "@polyth/dictation";

test("voice prefs parse defaults, clamp rate, round-trip", () => {
  assert.deepEqual(parseVoicePrefs(null), defaultVoicePrefs());
  assert.deepEqual(parseVoicePrefs("{oops"), defaultVoicePrefs());
  assert.equal(parseVoicePrefs('{"rate": 99}').rate, 1);
  assert.equal(parseVoicePrefs('{"rate": 1.5}').rate, 1.5);
  const p = {
    ...defaultVoicePrefs(),
    dictation: false,
    tts: true,
    lang: "de-DE",
    rate: 0.8,
    voice: "Anna",
  };
  assert.deepEqual(parseVoicePrefs(serializeVoicePrefs(p)), p);
});

test("mergeTranscript joins chunks with single spaces", () => {
  assert.equal(mergeTranscript("", "  hello "), "hello");
  assert.equal(mergeTranscript("hello", "world"), "hello world");
  assert.equal(mergeTranscript("hello ", "  "), "hello ");
  assert.equal(mergeTranscript("a sentence.", "And more"), "a sentence. And more");
});

test("speakableText strips markdown syntax and truncates", () => {
  const md = "# Title\nUse `npm test` and see [docs](https://x). \n```js\nlet a = 1;\n```\n**bold** done";
  const spoken = speakableText(md);
  assert.ok(!spoken.includes("#"));
  assert.ok(!spoken.includes("`"));
  assert.ok(!spoken.includes("https://x"));
  assert.ok(spoken.includes("npm test"));
  assert.ok(spoken.includes("code block omitted"));
  assert.equal(speakableText("word ".repeat(1000), 50).length, 51); // 50 + ellipsis
});

test("read-aloud selects the exact assistant reply requested by its message action", () => {
  const events = [
    { seq: 1, type: "user/message", data: { text: "do not read me" } },
    { seq: 2, type: "assistant/message", data: { text: "**First** reply" } },
    { seq: 3, type: "assistant/message", data: { text: "Newest reply" } },
  ];
  assert.equal(assistantReplyTextAt(events, 2), "First reply");
  assert.equal(assistantReplyTextAt(events, 1), "");
  assert.equal(assistantReplyTextAt(events, 99), "");
});

test("speech feature detection is safe outside the browser", () => {
  assert.deepEqual(speechSupport(undefined), { stt: false, tts: false });
  assert.deepEqual(speechSupport({}), { stt: false, tts: false });
  class Fake {}
  const w = { webkitSpeechRecognition: Fake, speechSynthesis: {} };
  assert.deepEqual(speechSupport(w), { stt: true, tts: true });
  assert.equal(recognitionCtor(w), Fake);
  assert.equal(recognitionCtor({}), null);
});
