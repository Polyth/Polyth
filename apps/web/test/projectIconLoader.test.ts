import assert from "node:assert/strict";
import test from "node:test";

import {
  __test,
  loadProjectIconSvg,
  prefetchProjectIconSvgs,
  resetProjectIconLoaderForTests,
  searchProjectIcons,
} from "../src/projectIconLoader.ts";
import { inlineIconifySvgDataUrl } from "../src/projectIconPicker.ts";

const originalFetch = globalThis.fetch;
const calls: string[] = [];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetProjectIconLoaderForTests();
  calls.length = 0;
});

test("loader retries throttled upstream responses with backoff", async () => {
  let attempts = 0;
  const inits: RequestInit[] = [];
  globalThis.fetch = (async (input, init) => {
    attempts += 1;
    calls.push(String(input));
    inits.push(init ?? {});
    if (attempts < 3) {
      return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response("<svg></svg>", { status: 200, headers: { "content-type": "image/svg+xml" } });
  }) as typeof fetch;

  const svg = await loadProjectIconSvg("ph:folder");
  assert.equal(svg, "<svg></svg>");
  assert.equal(attempts, 3);
  assert.ok(calls.every((url) => !url.includes("api.iconify.design")));
  assert.match(calls[0]!, /^\/api\/iconify\/ph\/folder\.svg$/);
  assert.ok(inits.every((init) => init.credentials === "same-origin"));
});

test("loader dedupes concurrent svg loads", async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response("<svg></svg>", { status: 200 });
  }) as typeof fetch;

  const [a, b] = await Promise.all([
    loadProjectIconSvg("ph:folder"),
    loadProjectIconSvg("ph:folder"),
  ]);
  assert.equal(a, b);
  assert.equal(attempts, 1);
});

test("loader aborts in-flight search", async () => {
  globalThis.fetch = (async (_input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response(JSON.stringify({ icons: ["ph:folder"] }), { status: 200 });
  }) as typeof fetch;

  const controller = new AbortController();
  const pending = searchProjectIcons("folder", "all", 64, controller.signal);
  controller.abort();
  await assert.rejects(pending);
});

test("save path uses cached proxied svg without direct iconify host", async () => {
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor"/></svg>', { status: 200 });
  }) as typeof fetch;

  const svg = await loadProjectIconSvg("ph:magnifying-glass");
  const cached = await loadProjectIconSvg("ph:magnifying-glass");
  const stored = inlineIconifySvgDataUrl("ph:magnifying-glass", cached, "#B4532A");
  assert.equal(svg, cached);
  assert.match(stored, /^data:image\/svg\+xml;base64,/);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((url) => !url.includes("api.iconify.design")));
});

test("prefetch batches through the json proxy and fills the svg cache", async () => {
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      icons: { folder: { body: '<path fill="currentColor"/>', width: 24, height: 24 } },
    }), { status: 200 });
  }) as typeof fetch;

  await prefetchProjectIconSvgs(["ph:folder"]);
  const svg = await loadProjectIconSvg("ph:folder");
  const stored = inlineIconifySvgDataUrl("ph:folder", svg, "#b4532a");
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(stored, /^data:image\/svg\+xml;base64,/);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^\/api\/iconify\/ph\.json\?icons=/);
  assert.ok(!calls[0]!.includes("api.iconify.design"));
});

test("loader retries network failures then succeeds", async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 2) throw new TypeError("Failed to fetch");
    return new Response("<svg></svg>", { status: 200 });
  }) as typeof fetch;

  assert.equal(await loadProjectIconSvg("ph:house"), "<svg></svg>");
  assert.equal(attempts, 2);
});

test("loader caps concurrent in-flight fetches", async () => {
  let inflight = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inflight -= 1;
    return new Response("<svg></svg>", { status: 200 });
  }) as typeof fetch;

  await Promise.all(["ph:a", "ph:b", "ph:c", "ph:d", "ph:e", "ph:f"].map((name) => loadProjectIconSvg(name)));
  assert.ok(peak <= __test.MAX_CONCURRENT);
  assert.ok(peak >= 2);
});

test("retry helper honors retry-after and retryable statuses", () => {
  assert.equal(__test.shouldRetry(429), true);
  assert.equal(__test.shouldRetry(502), true);
  assert.equal(__test.shouldRetry(404), false);
  assert.equal(__test.retryDelay(0, "2"), 2000);
});
