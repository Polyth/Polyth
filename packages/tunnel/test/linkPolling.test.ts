import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
let visibility = "visible";
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { pollLinkAvailability } = await import("../widgets/index.tsx");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("link status polling pauses while hidden, reads once on show/online, and disposes", async () => {
  let reads = 0;
  visibility = "visible";
  const stop = pollLinkAvailability(() => { reads++; }, 10);
  assert.equal(reads, 1, "one read at start");
  await wait(45);
  const visibleReads = reads;
  assert.ok(visibleReads >= 3, "keeps polling while visible");
  visibility = "hidden";
  document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
  const atHide = reads;
  await wait(45);
  assert.equal(reads, atHide, "no reads while hidden");
  window.dispatchEvent(new dom.Event("online") as unknown as Event);
  assert.equal(reads, atHide, "online while hidden reads nothing");
  visibility = "visible";
  document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
  assert.equal(reads, atHide + 1, "one read on becoming visible");
  window.dispatchEvent(new dom.Event("online") as unknown as Event);
  assert.equal(reads, atHide + 2, "one read when the connection returns");
  stop();
  const atStop = reads;
  await wait(45);
  document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
  window.dispatchEvent(new dom.Event("online") as unknown as Event);
  assert.equal(reads, atStop, "disposed: no timer, no listeners");
  process.exit(0);
});
