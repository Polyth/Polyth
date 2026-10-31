// Dictation writes into the draft as it hears it, and the microphone is the
// only thing that says so. These cover the span arithmetic that keeps a live
// transcript from eating a sent message or a typed word, plus the source
// contracts that keep status text out of the composer rail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyTranscriptSpan,
  beginTranscriptSpan,
} from "../src/composer/transcriptSpan.ts";
import { drainInserts, requestComposerDictation, requestComposerSubmit } from "../src/composerInsert.ts";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("a live transcript rewrites its own span instead of appending", () => {
  const span = beginTranscriptSpan("run-1", "");
  assert.equal(applyTranscriptSpan(span, "", "hello"), "hello");
  assert.equal(applyTranscriptSpan(span, "hello", "hello wor"), "hello wor");
  // Providers re-punctuate and recapitalize as they finalize; the span must
  // follow that instead of leaving both spellings in the draft.
  assert.equal(applyTranscriptSpan(span, "hello wor", "Hello, world."), "Hello, world.");
});

test("dictation appends after an existing draft with exactly one separator", () => {
  const span = beginTranscriptSpan("run-1", "look at");
  assert.equal(applyTranscriptSpan(span, "look at", "this"), "look at this");
  assert.equal(applyTranscriptSpan(span, "look at this", "this file"), "look at this file");

  const spaced = beginTranscriptSpan("run-2", "look at ");
  assert.equal(applyTranscriptSpan(spaced, "look at ", "this"), "look at this");
});

test("a send clears the draft without the next partial resurrecting it", () => {
  const span = beginTranscriptSpan("run-1", "");
  assert.equal(applyTranscriptSpan(span, "", "first thought"), "first thought");
  // Send empties the composer while the run is still open.
  assert.equal(applyTranscriptSpan(span, "", "first thought and a second"), "and a second");
  assert.equal(applyTranscriptSpan(span, "and a second", "first thought and a second one"),
    "and a second one");
});

test("typing during dictation is kept and only new words are added after it", () => {
  const span = beginTranscriptSpan("run-1", "");
  assert.equal(applyTranscriptSpan(span, "", "check"), "check");
  // The user typed into the draft between two partials.
  assert.equal(applyTranscriptSpan(span, "check src/a.ts", "check the tests"),
    "check src/a.ts the tests");
});

test("an unconsumed final still queues for the next composer, interim does not", () => {
  drainInserts(); // isolate
  // Node has no window, so nothing consumes either event.
  assert.equal(requestComposerDictation({ runId: "r", text: "half a sen", final: false }), false);
  assert.deepEqual(drainInserts(), [], "a transcript nothing can show is not replayed later");
  assert.equal(requestComposerDictation({ runId: "r", text: " done speaking ", final: true }), false);
  assert.deepEqual(drainInserts(), ["done speaking"]);
});

test("the composer treats an empty update as a release, never as a blank draft", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const handler = composer.slice(
    composer.indexOf("const dictate = (update: ComposerDictationUpdate)"),
    composer.indexOf("const queuedReplacement ="),
  );
  assert.ok(handler.length > 0, "the composer consumes dictation updates");
  assert.ok(
    handler.indexOf("if (!update.text) return;") < handler.indexOf("applyTranscriptSpan"),
    "a provider reconnect resetting its transcript cannot blank the draft",
  );
  assert.match(handler, /h\.isComposing\(\) && !update\.final/,
    "an IME composition is never interrupted by an interim transcript");
  assert.match(handler, /replaceText\(next, \{ anchor: next\.length \}\)/,
    "the caret follows the words as they land");
});

test("a hands-free submit is never queued for a later composer", () => {
  drainInserts(); // isolate
  // Node has no window: no composer can take the request.
  assert.equal(requestComposerSubmit(), false);
  assert.deepEqual(drainInserts(), [], "nothing replays a spoken turn later on its own");
});

test("the composer sends a voice turn through its own Send path, once", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const handler = composer.slice(
    composer.indexOf("const submit = (e: Event) =>"),
    composer.indexOf("window.addEventListener(COMPOSER_DICTATION, dictation);"),
  );
  assert.ok(handler.length > 0, "the composer listens for voice submits");
  assert.match(handler, /e\.defaultPrevented/, "only the first mounted composer acts on a request");
  assert.match(handler, /input\.isComposing\(\)/, "an IME composition in progress refuses the submit");
  assert.match(handler, /sendRef\.current\(undefined, /, "it is the same send as the Send control");
  assert.match(handler, /delivery === "queue" \|\| delivery === "steer" \|\| delivery === "interrupt" \? delivery : undefined/,
    "a requested follow-up delivery is validated; anything else follows the user's setting");
  assert.match(composer, /window\.removeEventListener\(COMPOSER_SUBMIT, submit\)/, "unmount stops listening");
});

test("only an explicit discard takes a dictation run's words back out of the draft", async () => {
  const composer = await read("../src/components/Composer.tsx");
  assert.match(composer, /if \(!update\.text && !update\.discard\) return;/,
    "an empty update still says nothing (a reconnecting provider never blanks the draft)");
  assert.match(composer, /applyTranscriptSpan\(run, h\.getText\(\), update\.discard \? "" : update\.text\)/);
  const insert = await read("../src/composerInsert.ts");
  assert.match(insert, /update\.final && !update\.discard && update\.text\.trim\(\)/,
    "a discarded run is never queued for a later composer");
});
