import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWebBuildId,
  installBuildFreshnessWatcher,
  isBuildFreshnessEnabled,
  isChunkLoadError,
  parseWebBuildId,
  recoverFromChunkLoadFailure,
  setBuildFreshnessEnabled,
  WEB_BUILD_QUERY,
} from "../src/buildFreshness.ts";
import { chunkNamesForBuild, versionUnhashedShellUrls } from "../buildConfig.ts";
import { POLYTH_MARK_SRC } from "../src/brandAsset.ts";

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

// Unlike FakeWindow, replace() advances location.href so the recovery's
// "already targeting this generation" loop guard is exercised for real.
class NavigatingWindow extends EventTarget {
  replaced: string[] = [];
  readonly location = {
    href: "https://polyth.test/p/project/s/session",
    reload() {},
    replace: (next: string) => {
      this.replaced.push(next);
      this.location.href = next;
    },
  };
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
}

const chunkBuildIdFetch = (build: string) => (async () => new Response(
  JSON.stringify({ build }),
  { status: 200, headers: { "content-type": "application/json" } },
)) as typeof fetch;

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

test("Polyth mark URL bypasses a cached failed asset response", () => {
  assert.match(POLYTH_MARK_SRC, /^\/icon-192\.png\?b=[^/]+$/);
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

test("a newer build found while healthy is offered once per build, and reloads only when accepted", async () => {
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  let serverBuild = "build-a";
  const reloads: string[] = [];
  const offers: Array<{ build: string; reload: () => void }> = [];
  const dispose = installBuildFreshnessWatcher("build-a", {
    windowRef: fakeWindow as unknown as Window,
    documentRef: fakeDocument as unknown as Document,
    minCheckIntervalMs: 0,
    retryDelaysMs: [],
    reload: (build) => { reloads.push(build); },
    offerReload: (build, reload) => { offers.push({ build, reload }); },
    fetchImpl: (async () => new Response(JSON.stringify({ build: serverBuild }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  serverBuild = "build-b";
  suspendAndResume(fakeDocument);
  await settle();
  assert.deepEqual(offers.map((offer) => offer.build), ["build-b"]);
  assert.deepEqual(reloads, [], "nothing reloads under the person");

  suspendAndResume(fakeDocument);
  await settle();
  assert.equal(offers.length, 1, "the same build is offered once");

  serverBuild = "build-c";
  suspendAndResume(fakeDocument);
  await settle();
  assert.deepEqual(offers.map((offer) => offer.build), ["build-b", "build-c"], "a newer one is offered again");

  offers[1]!.reload();
  offers[1]!.reload();
  assert.deepEqual(reloads, ["build-c"], "accepting reloads once");

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

test("chunk load failures are recognized by engine message, not by name", () => {
  assert.equal(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /chunks/g-1/ModelDetails-AAAA1111.js")), true);
  assert.equal(isChunkLoadError(new TypeError("error loading dynamically imported module")), true);
  assert.equal(isChunkLoadError(new TypeError("Importing a module script failed.")), true);
  assert.equal(isChunkLoadError(new TypeError("x is not a function")), false);
  assert.equal(isChunkLoadError(undefined), false);
});

test("a lazy chunk from a pruned generation reloads once into the current build", async () => {
  const fakeWindow = new NavigatingWindow();
  let requested = "";
  const reloaded = await recoverFromChunkLoadFailure(
    new TypeError("Failed to fetch dynamically imported module: /chunks/g-83e88d28b4c9/ModelDetails-CYZ6NZOC.js"),
    {
      windowRef: fakeWindow as unknown as Window,
      buildId: "mugwpdc2",
      fetchImpl: (async (input) => {
        requested = String(input);
        return new Response(JSON.stringify({ build: "mugxc7d5" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    },
  );

  assert.equal(reloaded, true);
  assert.equal(requested, "/build-id.json");
  assert.deepEqual(fakeWindow.replaced, ["https://polyth.test/p/project/s/session?__polyth_build=mugxc7d5"]);
});

test("a chunk failure under the current build is left to the error boundary", async () => {
  const fakeWindow = new NavigatingWindow();
  const reloaded = await recoverFromChunkLoadFailure(
    new TypeError("Failed to fetch dynamically imported module: /chunks/g-1/ModelDetails-AAAA1111.js"),
    { windowRef: fakeWindow as unknown as Window, buildId: "mugxc7d5", fetchImpl: chunkBuildIdFetch("mugxc7d5") },
  );

  assert.equal(reloaded, false);
  assert.equal(fakeWindow.replaced.length, 0);
});

test("an unrelated render error never reloads the shell or hits the network", async () => {
  const fakeWindow = new NavigatingWindow();
  let calls = 0;
  const reloaded = await recoverFromChunkLoadFailure(new TypeError("x is not a function"), {
    windowRef: fakeWindow as unknown as Window,
    buildId: "mugwpdc2",
    fetchImpl: (async () => { calls++; return new Response(null, { status: 200 }); }) as typeof fetch,
  });

  assert.equal(reloaded, false);
  assert.equal(calls, 0, "detection happens before any network request");
  assert.equal(fakeWindow.replaced.length, 0);
});

test("a shell already targeting the server build fails stable instead of looping", async () => {
  const fakeWindow = new NavigatingWindow();
  fakeWindow.location.href = `https://polyth.test/p/project/s/session?${WEB_BUILD_QUERY}=mugxc7d5`;
  const reloaded = await recoverFromChunkLoadFailure(
    new TypeError("Failed to fetch dynamically imported module: /chunks/g-1/ModelDetails-AAAA1111.js"),
    { windowRef: fakeWindow as unknown as Window, buildId: "mugwpdc2", fetchImpl: chunkBuildIdFetch("mugxc7d5") },
  );

  assert.equal(reloaded, false);
  assert.equal(fakeWindow.replaced.length, 0);
});

test("chunk recovery respects the freshness switch", async () => {
  setBuildFreshnessEnabled(false);
  const fakeWindow = new NavigatingWindow();
  let calls = 0;
  const reloaded = await recoverFromChunkLoadFailure(
    new TypeError("Failed to fetch dynamically imported module: /chunks/g-1/ModelDetails-AAAA1111.js"),
    {
      windowRef: fakeWindow as unknown as Window,
      buildId: "mugwpdc2",
      fetchImpl: (async () => { calls++; return new Response(JSON.stringify({ build: "mugxc7d5" }), { status: 200 }); }) as typeof fetch,
    },
  );

  assert.equal(reloaded, false);
  assert.equal(calls, 0);
});

// A reloaded shell only boots the new build if its asset URLs change too.
// index.html is served `no-store`, but /main.js, /main.css and the
// importmap-ed /shared/react*.js carry no content hash: a reverse proxy that
// rewrites their `expires` (one openresty deployment served max-age≈8h over the
// server's no-store) pins the previous CSS and bundle for hours.
test("unhashed shell asset URLs are versioned per build, hashed chunks are not", () => {
  const html = [
    '<link rel="stylesheet" href="/main.css" />',
    '<script type="importmap">{"imports":{"react":"/shared/react.js"}}</script>',
    '<link rel="modulepreload" href="/shared/chunks/chunk-ZYQD5IQW.js" />',
    '<link rel="modulepreload" href="/chunks/Contribution-7VUVZXG2.js" />',
    '<link rel="icon" href="data:image/png;base64,AAAA" />',
    '<script type="module" src="/main.js"></script>',
  ].join("\n");

  const out = versionUnhashedShellUrls(html, "mu9uqr9v");

  assert.match(out, /href="\/main\.css\?b=mu9uqr9v"/);
  assert.match(out, /src="\/main\.js\?b=mu9uqr9v"/);
  assert.match(out, /"\/shared\/react\.js\?b=mu9uqr9v"/);
  assert.match(out, /href="\/shared\/chunks\/chunk-ZYQD5IQW\.js"/, "content-hashed chunks stay long-lived");
  assert.match(out, /href="\/chunks\/Contribution-7VUVZXG2\.js"/, "content-hashed chunks stay long-lived");
  assert.doesNotMatch(out, /data:image\/png;base64,AAAA\?b=/, "the inline favicon is not an asset URL");
  assert.equal(versionUnhashedShellUrls(out, "mu9uqr9v"), out, "versioning is idempotent");
});

// Packages import stateful shell modules by absolute, unhashed URL. A cached
// /shell-api/.../store__ts.js from the previous build links to that build's
// store chunk, so packages read a second, empty store (no projects).
test("unhashed shell-api and package modules are remapped to the build through the import map", () => {
  const html = '<script type="importmap">{"imports":{"react":"/shared/react.js"}}</script>';
  const modules = ["/shell-api/apps/web/src/store__ts.js", "/packages/files/entry.js"];

  const out = versionUnhashedShellUrls(html, "mu9uqr9v", modules);
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(out)![1]!) as {
    imports: Record<string, string>;
  };

  assert.deepEqual(map.imports, {
    react: "/shared/react.js?b=mu9uqr9v",
    "/shell-api/apps/web/src/store__ts.js": "/shell-api/apps/web/src/store__ts.js?b=mu9uqr9v",
    "/packages/files/entry.js": "/packages/files/entry.js?b=mu9uqr9v",
  });
  assert.equal(versionUnhashedShellUrls(out, "mu9uqr9v", modules), out, "versioning is idempotent");
});

test("chunk paths change with the build generation and keep the content hash", () => {
  const first = chunkNamesForBuild("build-a");
  assert.equal(chunkNamesForBuild("build-a"), first);
  assert.notEqual(chunkNamesForBuild("build-b"), first);
  assert.match(first, /^chunks\/g-[a-f0-9]{12}\/\[name\]-\[hash\]$/);
  assert.match(chunkNamesForBuild("../unsafe/path"), /^chunks\/g-[a-f0-9]{12}\/\[name\]-\[hash\]$/);
});
