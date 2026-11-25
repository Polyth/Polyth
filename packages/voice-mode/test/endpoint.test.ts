// The pause that ends a spoken turn follows how the words end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAUSE_PROFILES, endpointPauseMs, phraseEnding } from "../src/endpoint.ts";
import { PAUSE_MS } from "../src/prefs.ts";

test("a finished sentence, a question, open words and a phrase that goes on are told apart", () => {
  assert.equal(phraseEnding("Fix the failing test."), "complete");
  assert.equal(phraseEnding("It works!"), "complete");
  assert.equal(phraseEnding("He said “done.”"), "complete", "closing quotes do not hide the full stop");
  assert.equal(phraseEnding("What does it do?"), "question");
  assert.equal(phraseEnding("fix the failing test"), "open", "no punctuation is no evidence of an ending");
  assert.equal(phraseEnding(""), "open");
  assert.equal(phraseEnding("First open the config,"), "continuing");
  assert.equal(phraseEnding("I was thinking…"), "continuing");
  assert.equal(phraseEnding("I was thinking..."), "continuing");
  assert.equal(phraseEnding("Open the file and"), "continuing");
  assert.equal(phraseEnding("Open the file and."), "continuing", "a full stop after a connective is the recognizer's, not the speaker's");
  assert.equal(phraseEnding("Is it because?"), "continuing");
});

test("trailing words are read in the spoken language, and by script when it is unknown", () => {
  assert.equal(phraseEnding("Відкрий файл і", "uk-UA"), "continuing");
  assert.equal(phraseEnding("Запусти тести, а потім", "uk"), "open");
  assert.equal(phraseEnding("Запусти тести.", "uk"), "complete");
  assert.equal(phraseEnding("Zrób to.", "pl"), "complete", "Polish “to” ends a sentence");
  assert.equal(phraseEnding("I want to.", "en"), "continuing");
  assert.equal(phraseEnding("Zrób to.", "auto"), "continuing", "an unknown Latin-script language reads as English");
  assert.equal(phraseEnding("What does it do?", "auto"), "question", "…so another language's connective does not slow English down");
  assert.equal(phraseEnding("Відкрий файл і", "auto"), "continuing", "the script still tells Cyrillic languages apart");
  assert.equal(phraseEnding("Запусти тести.", "multi"), "complete");
  assert.equal(phraseEnding("修好这个测试。", "zh-CN"), "complete");
  assert.equal(phraseEnding("先打开配置，", "zh-CN"), "continuing");
  assert.equal(phraseEnding("这是什么？", "zh-CN"), "question");
});

test("the pause is shorter only where the words say the sentence is over", () => {
  for (const pause of ["quick", "normal", "patient"] as const) {
    const profile = PAUSE_PROFILES[pause];
    assert.equal(profile.open, PAUSE_MS[pause], "words without an ending keep the configured pause");
    assert.ok(profile.complete < profile.open && profile.question <= profile.complete);
    assert.ok(profile.continuing > profile.open);
    assert.equal(endpointPauseMs("run the tests", pause, "en"), profile.open);
    assert.equal(endpointPauseMs("Run the tests.", pause, "en"), profile.complete);
    assert.equal(endpointPauseMs("Did they pass?", pause, "en"), profile.question);
    assert.equal(endpointPauseMs("Run the tests and", pause, "en"), profile.continuing);
  }
  assert.ok(PAUSE_PROFILES.quick.question >= 300, "never shorter than the gap inside a sentence");
});
