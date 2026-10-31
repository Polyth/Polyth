import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { retryAfterReconnect, type ReconnectSignal } from "../src/retryAfterReconnect.ts";
import type { SyncStatus } from "../src/sync.ts";

function fakeSync(initial: SyncStatus) {
  let status = initial;
  const listeners = new Set<() => void>();
  let reconnects = 0;
  const signal: ReconnectSignal = {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect: () => { reconnects += 1; },
  };
  const publish = (next: SyncStatus) => {
    if (next === status) return;
    status = next;
    for (const listener of [...listeners]) listener();
  };
  return { signal, publish, listeners, reconnects: () => reconnects };
}

test("retries once, after the socket comes back", () => {
  const sync = fakeSync("connected");
  let retries = 0;
  retryAfterReconnect(sync.signal, () => { retries += 1; });
  assert.equal(sync.reconnects(), 1);
  sync.publish("reconnecting");
  assert.equal(retries, 0);
  sync.publish("connected");
  assert.equal(retries, 1);
  sync.publish("reconnecting");
  sync.publish("connected");
  assert.equal(retries, 1);
  assert.equal(sync.listeners.size, 0);
});

test("a suspended phone waits for its foreground reconnect", () => {
  const sync = fakeSync("suspended");
  let retries = 0;
  retryAfterReconnect(sync.signal, () => { retries += 1; });
  sync.publish("connecting");
  assert.equal(retries, 0);
  sync.publish("connected");
  assert.equal(retries, 1);
});

test("disposing before the reconnect cancels the retry", () => {
  const sync = fakeSync("reconnecting");
  let retries = 0;
  const dispose = retryAfterReconnect(sync.signal, () => { retries += 1; });
  dispose();
  sync.publish("connected");
  assert.equal(retries, 0);
  assert.equal(sync.listeners.size, 0);
});

test("new chat worktree loading reconnects once before showing a connection error", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(
    composer,
    /isTransportFailure\(error\) && branchTransportRetryRef\.current !== locationKey[\s\S]*?retryAfterReconnect\([\s\S]*?setBranchReload/,
  );
  assert.match(composer, /branchTransportRetryRef\.current = null;\s*setLocation\(/);
  assert.match(composer, /cancelRetry\(\);\s*\};\s*\}, \[locationKey,[^\]]*branchReload\]\);/);
});
