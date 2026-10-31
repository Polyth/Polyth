// The transcript writes its tail geometry as custom properties while a turn
// streams. An inherited custom property changed on `.timeline` restyles every
// row below it, so each one the transcript writes is registered
// non-inherited, and the elements that read it inherit it explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const styles = read("../src/styles.css");
const timeline = read("../src/components/Timeline.tsx");

const registeredNonInherited = (name: string): boolean =>
  new RegExp(`@property ${name}\\s*\\{[^}]*inherits:\\s*false`).test(styles);

test("every custom property the transcript writes is registered non-inherited", () => {
  const written = [...new Set([...timeline.matchAll(/style\.setProperty\("(--[a-z0-9-]+)"/g)].map((match) => match[1]!))];
  assert.ok(written.includes("--timeline-turn-sheet-space") && written.includes("--timeline-extent-floor"));
  assert.deepEqual(written.filter((name) => !registeredNonInherited(name)), []);
  // Derived from the turn-sheet reserve on `.timeline`, so it must not inherit either.
  assert.ok(registeredNonInherited("--timeline-pad-bottom"));
  assert.ok(registeredNonInherited("--timeline-mask"));
});

test("the runway and the extent floor read the tail geometry by explicit inheritance", () => {
  assert.match(styles, /\.timeline::after\s*\{\s*--timeline-pad-bottom:\s*inherit;[^}]*flex-basis:\s*var\(--timeline-pad-bottom\)/);
  assert.match(styles, /\.timeline > \.timeline-extent-floor\s*\{\s*--timeline-extent-floor:\s*inherit;[^}]*block-size:\s*var\(--timeline-extent-floor\)/);
});

test("prompt visibility writes <body> and notifies only on a change", async () => {
  const dom = new Window({ url: "http://127.0.0.1:4400/" });
  Object.assign(globalThis, { window: dom, document: dom.document, CustomEvent: dom.CustomEvent });
  const { PROMPT_VISIBILITY_EVENT, promptIsVisible, publishPromptVisibility } = await import("../src/promptVisibility.ts");
  let events = 0;
  let records = 0;
  dom.addEventListener(PROMPT_VISIBILITY_EVENT, () => { events += 1; });
  const observer = new dom.MutationObserver((batch) => { records += batch.length; });
  observer.observe(dom.document.body, { attributes: true });
  publishPromptVisibility(true);
  publishPromptVisibility(true);
  publishPromptVisibility(true);
  publishPromptVisibility(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  records += observer.takeRecords().length;
  observer.disconnect();
  assert.equal(events, 2);
  assert.equal(records, 2, "a repeated value is not written again");
  assert.equal(promptIsVisible(), false);
});
