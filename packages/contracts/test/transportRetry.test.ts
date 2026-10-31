import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithReadRetry, isNetworkFailure, setConnectionGate, untilReachable } from "../src/transportRetry.ts";

const instant = { sleep: async () => undefined, untilReachable: async () => undefined };
const loadFailed = () => new TypeError("Load failed");

function flakyFetch(failures: number, error: () => unknown = loadFailed) {
  const calls: Array<string | undefined> = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.method);
    if (calls.length <= failures) throw error();
    return new Response("ok");
  }) as typeof fetch;
  return { impl, calls };
}

test("a read that lost its socket is asked again and succeeds", async () => {
  const { impl, calls } = flakyFetch(2);
  const response = await fetchWithReadRetry(impl, "/api/worktrees", undefined, instant);
  assert.equal(await response.text(), "ok");
  assert.equal(calls.length, 3);
});

test("retries are bounded and the last network failure surfaces", async () => {
  const { impl, calls } = flakyFetch(10);
  await assert.rejects(
    () => fetchWithReadRetry(impl, "/api/models", { method: "GET" }, { ...instant, delaysMs: [1, 1] }),
    /Load failed/,
  );
  assert.equal(calls.length, 3);
});

test("a mutation without a response is never replayed", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { impl, calls } = flakyFetch(1);
    await assert.rejects(() => fetchWithReadRetry(impl, "/api/sessions", { method }, instant), /Load failed/);
    assert.equal(calls.length, 1, method);
  }
});

test("HTTP errors and aborts are not network failures", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const { impl, calls } = flakyFetch(5, () => abort);
  await assert.rejects(() => fetchWithReadRetry(impl, "/api/x", undefined, instant), /aborted/);
  assert.equal(calls.length, 1);
  assert.equal(isNetworkFailure(abort), false);
  assert.equal(isNetworkFailure(new Error("HTTP 500")), false);
  assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);

  let served = 0;
  const http = (async () => {
    served++;
    return new Response("nope", { status: 503 });
  }) as typeof fetch;
  assert.equal((await fetchWithReadRetry(http, "/api/x", undefined, instant)).status, 503);
  assert.equal(served, 1);
});

test("an aborted caller stops retrying", async () => {
  const controller = new AbortController();
  const { impl, calls } = flakyFetch(10);
  await assert.rejects(() => fetchWithReadRetry(impl, "/api/x", { signal: controller.signal }, {
    untilReachable: async () => undefined,
    sleep: async () => { controller.abort(); },
  }));
  assert.equal(calls.length, 2);
});

test("a retry waits until the page can reach the network", async () => {
  const order: string[] = [];
  const { impl } = flakyFetch(1);
  await fetchWithReadRetry(impl, "/api/x", undefined, {
    untilReachable: async () => { order.push("reachable"); },
    sleep: async () => { order.push("sleep"); },
  });
  assert.deepEqual(order, ["reachable", "sleep"]);
});

test("a retry waits for the shell's live connection before asking again", async () => {
  const order: string[] = [];
  let reconnect!: () => void;
  setConnectionGate(() => {
    order.push("gate");
    return new Promise<void>((resolve) => { reconnect = resolve; });
  });
  try {
    const { impl, calls } = flakyFetch(1);
    const pending = fetchWithReadRetry(impl, "/api/workflows", undefined, {
      sleep: async () => { order.push("sleep"); },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The link is still coming back: no second attempt has been spent yet.
    assert.equal(calls.length, 1);
    assert.deepEqual(order, ["gate"]);
    reconnect();
    assert.equal(await (await pending).text(), "ok");
    assert.equal(calls.length, 2);
    assert.deepEqual(order, ["gate", "sleep"]);
  } finally {
    setConnectionGate(undefined);
  }
});

test("without a registered gate the default wait only checks the page", async () => {
  setConnectionGate(undefined);
  await untilReachable();
  let gated = 0;
  setConnectionGate(async () => { gated++; });
  try {
    await untilReachable();
    assert.equal(gated, 1);
  } finally {
    setConnectionGate(undefined);
  }
});
