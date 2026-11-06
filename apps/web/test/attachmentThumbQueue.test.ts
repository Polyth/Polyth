// Tiles load a couple at a time, so a chat's photos cannot take every socket the
// browser has for the app's origin (see attachmentThumbQueue.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createThumbQueue, MAX_THUMB_LOADS } from "../src/attachmentThumbQueue.ts";

const queueWith = (count: number, limit = 2) => {
  const queue = createThumbQueue(limit);
  const started: number[] = [];
  const release = Array.from({ length: count }, (_, index) => queue.request(() => started.push(index)));
  return { started, release };
};

test("tiles leave sockets for the rest of the page", () => {
  // A browser gives one HTTP/1.1 origin six sockets.
  assert.ok(MAX_THUMB_LOADS <= 3, "at least half of the sockets stay free");
});

test("only the limit loads at once, the rest in order as slots free", () => {
  const { started, release } = queueWith(5);
  assert.deepEqual(started, [0, 1]);
  release[0]!();
  assert.deepEqual(started, [0, 1, 2]);
  release[2]!();
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test("a tile that leaves before its turn never starts, and takes no slot", () => {
  const { started, release } = queueWith(4);
  release[2]!();
  release[0]!();
  assert.deepEqual(started, [0, 1, 3], "the waiter that left is skipped");
});

test("giving a slot back twice frees it only once", () => {
  const { started, release } = queueWith(4);
  release[0]!();
  release[0]!();
  assert.deepEqual(started, [0, 1, 2], "a repeated release must not admit an extra load");
});

test("tiles load through the queue, not straight from the attachment's url", async () => {
  const source = await readFile(new URL("../src/components/AttachmentPills.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<img className="att-thumb" src=\{a\.url\}/);
  assert.match(source, /thumbQueue\.request\(/);
  assert.match(source, /onError=\{/, "a dropped transfer tries again");
});
