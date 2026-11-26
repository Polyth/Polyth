// Pure speech helpers: streaming speakable chunks for TTS, browser voice
// ranking, spoken punctuation for dictation and the energy VAD that ends a
// spoken turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySpokenPunctuation,
  createSpeakableStream,
  createVoiceActivityDetector,
  pickVoice,
  rankVoices,
  sentenceBoundaries,
  speakableLine,
  voiceTier,
} from "../src/speech.ts";

const feed = (deltas: readonly string[], options = {}) => {
  const stream = createSpeakableStream(options);
  const out: string[][] = deltas.map((delta) => stream.push(delta));
  out.push(stream.flush());
  return out;
};

test("a long opening sentence starts at its first clause, when asked to", () => {
  const stream = createSpeakableStream({ firstClauseChars: 60 });
  assert.deepEqual(stream.push("I looked at the failing test,"), [], "too little is waiting to cut a sentence for");
  assert.deepEqual(stream.push(" and the assertion still used the old name of the helper"),
    ["I looked at the failing test,"], "speech starts at the clause while the sentence is still coming");
  assert.deepEqual(stream.push(" that was renamed last week. Next"), ["and the assertion still used the old name of the helper that was renamed last week."],
    "the rest of the sentence follows whole");
  assert.deepEqual(stream.flush(), ["Next"]);

  const short = createSpeakableStream({ firstClauseChars: 60 });
  assert.deepEqual(short.push("Yes, it works. The"), ["Yes, it works."], "a sentence that ends first is not cut");

  const off = createSpeakableStream();
  assert.deepEqual(off.push("I looked at the failing test, and the assertion still used the old name of the helper"), [],
    "without the option the first chunk is a whole sentence");

  const once = createSpeakableStream({ firstClauseChars: 40 });
  once.push("Done. ");
  assert.deepEqual(once.push("After that, the second sentence is long, has commas, and is still streaming along"), [],
    "only the very first chunk is cut early");
});

test("an early first clause never splits a number, a code span or a link", () => {
  const cut = (text: string) => createSpeakableStream({ firstClauseChars: 40 }).push(text);
  assert.deepEqual(cut("The run finished with 1,000,000 rows processed in total and"), [], "a comma inside a number is not a pause");
  assert.deepEqual(cut("I changed `matchVoiceCommand(text, phrases)` so that it also"), [], "a comma inside code is not a pause");
  assert.deepEqual(cut("See [the guide, part two](https://example.com/a, b) for the details and"), [], "…nor one inside a link");
  assert.deepEqual(cut("I changed `matchVoiceCommand`, so that it also accepts a trailing phrase"),
    ["I changed matchVoiceCommand,"], "a closed code span before the comma is fine");
  assert.deepEqual(cut("The short one, and then a much longer tail without any more pauses in it at all"), [],
    "a clause too short to be worth a breath is not released");
  assert.deepEqual(cut("```ts, with a comma and enough characters to pass the length check here"), [], "a fence line waits for its end");
});

test("the first sentence is released while the reply is still streaming", () => {
  const stream = createSpeakableStream();
  assert.deepEqual(stream.push("Sure, I can"), [], "an unfinished sentence waits");
  assert.deepEqual(stream.push(" help with that. Let me"), ["Sure, I can help with that."],
    "speech starts as soon as one sentence ends, before the line does");
  assert.deepEqual(stream.push(" check the file"), []);
  assert.deepEqual(stream.flush(), ["Let me check the file"]);
});

test("later sentences gather into comfortable utterances", () => {
  const chunks = feed([
    "One. Two is here. Three is short. Four follows on. Five is the last sentence of this reply.",
  ], { minChars: 40 }).flat();
  assert.equal(chunks[0], "One.");
  assert.ok(chunks.slice(1, -1).every((chunk) => chunk.length >= 40), JSON.stringify(chunks));
  assert.equal(chunks.join(" "), "One. Two is here. Three is short. Four follows on. Five is the last sentence of this reply.");
});

test("code fences and tables are skipped, with an optional spoken placeholder", () => {
  const chunks = feed([
    "Here is the fix:\n```ts\nconst a = 1;\n",
    "console.log(a);\n```\nThat should work.\n",
    "| a | b |\n|---|---|\n| 1 | 2 |\nDone.",
  ], { codePlaceholder: "Code omitted.", tablePlaceholder: "Table omitted.", minChars: 1 }).flat();
  assert.deepEqual(chunks, ["Here is the fix:", "Code omitted.", "That should work.", "Table omitted.", "Done."]);
  assert.ok(!chunks.some((chunk) => chunk.includes("console")), "code is never read aloud");
});

test("markdown syntax is stripped but the words stay", () => {
  assert.equal(speakableLine("## Next **steps** for `voice.ts`"), "Next steps for voice.ts");
  assert.equal(speakableLine("- [x] Read the [docs](https://example.com/a)"), "Read the docs");
  assert.equal(speakableLine("See https://example.com/x for snake_case _emphasis_"), "See link for snake_case emphasis");
  assert.equal(speakableLine("1. First item"), "First item");
});

test("abbreviations, initials and decimals do not end a sentence", () => {
  assert.deepEqual(sentenceBoundaries("Use e.g. this. Version 3.5 works."), [15]);
  assert.deepEqual(sentenceBoundaries("Ask Dr. Smith or J. Doe! Then"), [25]);
  assert.deepEqual(sentenceBoundaries("你好。世界！"), [3, 6]);
});

test("an over-long sentence is split at a natural pause", () => {
  const long = `${"word ".repeat(40)}and, after the pause, ${"more ".repeat(40)}end.`;
  const chunks = feed([long], { maxChars: 120, minChars: 1 }).flat();
  assert.ok(chunks.every((chunk) => chunk.length <= 121), JSON.stringify(chunks.map((chunk) => chunk.length)));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.trim().replace(/\s+/g, " "));
});

test("list items become separate spoken sentences", () => {
  const chunks = feed(["Changes:\n- Added tests\n- Fixed lint\n"], { minChars: 1000 }).flat();
  assert.deepEqual(chunks, ["Changes:", "Added tests. Fixed lint"],
    "the first line speaks at once; the items gather into one utterance");
});

test("the best natural voice for the language wins automatically", () => {
  const voices = [
    { name: "Albert", lang: "en-US", localService: true },
    { name: "Samantha", lang: "en-US", localService: true, default: true },
    { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US", localService: false },
    { name: "Google UK English Female", lang: "en-GB", localService: false },
    { name: "Anna", lang: "de-DE", localService: true },
  ];
  assert.equal(pickVoice(voices, "en-US")?.name, "Microsoft Aria Online (Natural) - English (United States)");
  assert.equal(rankVoices(voices, "en-US").at(-1)?.name, "Albert", "novelty voices rank last");
  assert.equal(pickVoice(voices, "de")?.name, "Anna", "a base language matches any region");
  assert.equal(pickVoice(voices, "en-US", "Samantha")?.name, "Samantha", "an explicit choice wins");
  assert.equal(pickVoice(voices, "en-US", "Gone")?.name, "Microsoft Aria Online (Natural) - English (United States)",
    "a missing explicit voice falls back to the best one");
  assert.equal(pickVoice(voices, "ja-JP"), null);
  assert.equal(voiceTier(voices[2]!), "natural");
  assert.equal(voiceTier({ name: "Ava (Enhanced)", lang: "en-US" }), "enhanced");
});

test("spoken punctuation commands become punctuation in English", () => {
  assert.equal(applySpokenPunctuation("hello comma world period how are you question mark", "en-US"),
    "hello, world. How are you?");
  assert.equal(applySpokenPunctuation("first line new line second new paragraph third", "en-GB"),
    "first line\nSecond\n\nThird");
  assert.equal(applySpokenPunctuation("wait period period", "en"), "wait.", "a repeated mark collapses");
  assert.equal(applySpokenPunctuation("open node.js and 3.5", "en-US"), "open node.js and 3.5",
    "existing dotted words are left alone");
  assert.equal(applySpokenPunctuation("hola coma mundo", "es-ES"), "hola coma mundo", "other languages pass through");
  assert.equal(applySpokenPunctuation("  period  ", "en"), ".");
});

test("the VAD ends a turn after a pause and ignores short clicks", () => {
  const vad = createVoiceActivityDetector({ onsetMs: 100, hangoverMs: 600 });
  const events: Array<[number, string]> = [];
  let now = 0;
  const run = (rms: number, ms: number) => {
    for (let t = 0; t < ms; t += 20) {
      now += 20;
      const event = vad.push(rms, now);
      if (event) events.push([now, event]);
    }
  };
  run(0.004, 400); // room tone
  run(0.2, 40);    // a click shorter than the onset
  run(0.004, 200);
  assert.equal(events.length, 0, "a click is not speech");
  run(0.12, 800);  // talking
  run(0.004, 300); // a breath inside the sentence
  run(0.12, 300);
  run(0.004, 800); // done
  assert.deepEqual(events.map(([, event]) => event), ["speech-start", "speech-end"]);
  assert.ok(vad.floor < 0.01, "the floor tracks the quiet room, not the speech");
  assert.equal(vad.level(0.004), 0);
  assert.ok(vad.level(0.12) > 0.4);
});

test("the VAD adapts to a noisy room", () => {
  const vad = createVoiceActivityDetector({ onsetMs: 100, hangoverMs: 400 });
  let now = 0;
  let started = false;
  for (let i = 0; i < 200; i++) {
    now += 20;
    if (vad.push(0.03 + (i % 2) * 0.004, now) === "speech-start") started = true;
  }
  assert.equal(started, false, "steady fan noise above the absolute minimum is learned as the floor");
  for (let i = 0; i < 20; i++) {
    now += 20;
    if (vad.push(0.15, now) === "speech-start") started = true;
  }
  assert.equal(started, true, "speech well above the learned floor still starts a turn");
});
