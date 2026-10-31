import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { SessionEvent } from "@polyth/contracts";
import { streamHistoryResponse } from "../src/historyResponse.ts";

test("legacy history JSON waits for socket drain, fixes the boundary, and cancels on close", async () => {
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false,
    writeHead() { this.headersSent = true; }, write(body: string) { bodies.push(body); return false; }, end() {} });
  const bodies: string[] = [];
  const reads: Array<[number, number | undefined]> = [];
  const stream = streamHistoryResponse(res as unknown as ServerResponse, async (cursor, highWater) => {
    reads.push([cursor, highWater]);
    return { events: [{ seq: cursor + 1 } as SessionEvent], cursor: cursor + 1, highWater: highWater ?? 3, complete: cursor === 2 };
  }, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 1);
  res.emit("drain");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, [[0, undefined], [1, 3]]);
  res.destroyed = true; res.emit("close");
  await stream;
  assert.equal(reads.length, 2);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.listenerCount("drain"), 0);
});
