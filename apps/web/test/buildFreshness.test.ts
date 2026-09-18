import test from "node:test";
import assert from "node:assert/strict";
import { Window as HappyWindow } from "happy-dom";
import {
  fetchWebBuildId,
  installBuildFreshnessWatcher,
  parseWebBuildId,
} from "../src/buildFreshness.ts";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("build id parsing is strict", () => {
  assert.equal(parseWebBuildId({ build: "abc" }), "abc");
  assert.equal(parseWebBuildId({ build: "  abc  " }), "abc");
  assert.equal(parseWebBuildId({ build: "" }), null);
  assert.equal(parseWebBuildId({ build: 123 }), null);
  assert.equal(parseWebBuildId(null), null);
});

test("server build id is fetched without cache", async () => {
  let request: { input?: string; init?: RequestInit } = {};
  const build = await fetchWebBuildId((async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({ build: "server-build" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  assert.equal(build, "server-build");
  assert.equal(request.input, "/build-id.json");
  assert.equal(request.init?.cache, "no-store");
  assert.equal(request.init?.credentials, "same-origin");
});

test("matching build stays mounted and a resumed stale PWA reloads once", async () => {
  const dom = new HappyWindow({ url: "https://polyth.test/p/project/s/session" });
  let serverBuild = "build-a";
  let reloads = 0;
  const dispose = installBuildFreshnessWatcher("build-a", {
    windowRef: dom as unknown as Window,
    documentRef: dom.document as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [],
    reload: () => { reloads++; },
    fetchImpl: (async () => new Response(JSON.stringify({ build: serverBuild }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await settle();
  assert.equal(reloads, 0);

  serverBuild = "build-b";
  dom.dispatchEvent(new dom.Event("pageshow"));
  await settle();
  assert.equal(reloads, 1);

  dom.dispatchEvent(new dom.Event("focus"));
  await settle();
  assert.equal(reloads, 1, "one stale resume issues exactly one reload");

  dispose();
  dom.close();
});

test("resume check retries a transient server restart", async () => {
  const dom = new HappyWindow({ url: "https://polyth.test/" });
  let calls = 0;
  let reloads = 0;
  const dispose = installBuildFreshnessWatcher("old-build", {
    windowRef: dom as unknown as Window,
    documentRef: dom.document as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [1],
    reload: () => { reloads++; },
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) throw new TypeError("server restarting");
      return new Response(JSON.stringify({ build: "new-build" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  assert.equal(reloads, 1);

  dispose();
  dom.close();
});
