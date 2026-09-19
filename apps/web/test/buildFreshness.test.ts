import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWebBuildId,
  installBuildFreshnessWatcher,
  isBuildFreshnessEnabled,
  parseWebBuildId,
  setBuildFreshnessEnabled,
  WEB_BUILD_QUERY,
} from "../src/buildFreshness.ts";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test.beforeEach(() => setBuildFreshnessEnabled(true));

class FakeWindow extends EventTarget {
  replaced: string[] = [];
  readonly location = {
    href: "https://polyth.test/p/project/s/session",
    reload() {},
    replace: (href: string) => { this.replaced.push(href); },
  };
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

function suspendAndResume(fakeDocument: FakeDocument): void {
  fakeDocument.visibilityState = "hidden";
  fakeDocument.dispatchEvent(new Event("visibilitychange"));
  fakeDocument.visibilityState = "visible";
  fakeDocument.dispatchEvent(new Event("visibilitychange"));
}

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

test("ordinary boot and focus churn never run a freshness check", async () => {
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  let calls = 0;
  let reloads = 0;
  const dispose = installBuildFreshnessWatcher("build-a", {
    windowRef: fakeWindow as unknown as Window,
    documentRef: fakeDocument as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [],
    reload: () => { reloads++; },
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ build: "build-b" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  fakeWindow.dispatchEvent(new Event("pageshow"));
  fakeWindow.dispatchEvent(new Event("focus"));
  await settle();

  assert.equal(calls, 0, "cold pageshow/focus must not tear down hydration");
  assert.equal(reloads, 0);
  dispose();
});

test("build freshness can be disabled and re-enabled programmatically", async () => {
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  let calls = 0;
  let reloads = 0;
  const dispose = installBuildFreshnessWatcher("build-a", {
    windowRef: fakeWindow as unknown as Window,
    documentRef: fakeDocument as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [],
    reload: () => { reloads++; },
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ build: "build-b" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  setBuildFreshnessEnabled(false);
  assert.equal(isBuildFreshnessEnabled(), false);
  suspendAndResume(fakeDocument);
  await settle();
  assert.equal(calls, 0);
  assert.equal(reloads, 0);

  setBuildFreshnessEnabled(true);
  assert.equal(isBuildFreshnessEnabled(), true);
  suspendAndResume(fakeDocument);
  await settle();
  assert.equal(calls, 1);
  assert.equal(reloads, 1);

  dispose();
});

test("a genuinely resumed stale PWA reloads once", async () => {
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  let serverBuild = "build-a";
  let reloads = 0;
  let reloadTarget = "";
  const dispose = installBuildFreshnessWatcher("build-a", {
    windowRef: fakeWindow as unknown as Window,
    documentRef: fakeDocument as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [],
    reload: (build) => { reloads++; reloadTarget = build; },
    fetchImpl: (async () => new Response(JSON.stringify({ build: serverBuild }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await settle();
  assert.equal(reloads, 0);

  serverBuild = "build-b";
  suspendAndResume(fakeDocument);
  await settle();
  assert.equal(reloads, 1);
  assert.equal(reloadTarget, "build-b");

  fakeWindow.dispatchEvent(new Event("pageshow"));
  fakeWindow.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(reloads, 1, "post-resume events cannot issue a second reload");

  dispose();
});

test("a stale shell already navigated to the target build fails stable instead of looping", async () => {
  const fakeWindow = new FakeWindow();
  fakeWindow.location.href = `https://polyth.test/p/project/s/session?${WEB_BUILD_QUERY}=build-b`;
  const fakeDocument = new FakeDocument();
  let reloads = 0;

  const dispose = installBuildFreshnessWatcher("build-a", {
    windowRef: fakeWindow as unknown as Window,
    documentRef: fakeDocument as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [],
    reload: () => { reloads++; },
    fetchImpl: (async () => new Response(JSON.stringify({ build: "build-b" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  suspendAndResume(fakeDocument);
  await settle();
  assert.equal(reloads, 0, "the same target generation is never reloaded forever");

  dispose();
});

test("disabling freshness during an in-flight check suppresses reload", async () => {
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  let reloads = 0;

  const dispose = installBuildFreshnessWatcher("build-a", {
    windowRef: fakeWindow as unknown as Window,
    documentRef: fakeDocument as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [],
    reload: () => { reloads++; },
    fetchImpl: (async () => response) as typeof fetch,
  });

  suspendAndResume(fakeDocument);
  await settle();
  setBuildFreshnessEnabled(false);
  resolveResponse(new Response(JSON.stringify({ build: "build-b" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await settle();

  assert.equal(reloads, 0);
  dispose();
});

test("resume check retries a transient server restart", async () => {
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  let calls = 0;
  let reloads = 0;
  const dispose = installBuildFreshnessWatcher("old-build", {
    windowRef: fakeWindow as unknown as Window,
    documentRef: fakeDocument as unknown as Document,
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

  assert.equal(calls, 0, "watcher is dormant until a real suspend/resume");
  suspendAndResume(fakeDocument);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  assert.equal(reloads, 1);

  dispose();
});
