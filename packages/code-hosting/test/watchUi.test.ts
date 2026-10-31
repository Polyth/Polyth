// The watch as the person sees it, in Chromium with the shipped CSS: the line
// above the composer comes from the server's view and Stop ends it; the
// timeline facts render each phase, open into their evidence, never link to
// a non-https URL and drop malformed events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import { watchState } from "../widgets/watchState.ts";
import { requestChangeRequestOpen, takeChangeRequestOpen } from "../widgets/openChangeRequest.ts";

const t = (key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ""}`;
const base = {
  id: "w", sessionId: "chat", projectId: "p1", number: 128, title: "Fix", url: "https://github.com/o/r/pull/128", headRef: "fix", headSha: "1a2b3c4",
  state: "watching" as const, checks: { total: 0, running: 0, failed: 0, passed: 0 }, failedChecks: [], heldComments: 0, wakes: 0, maxWakes: 8, startedAt: 0,
};

test("the line's words put failures and their names before what still runs, each in its own ink", () => {
  assert.deepEqual(
    watchState({ ...base, checks: { total: 4, running: 1, failed: 2, passed: 1 }, failedChecks: ["a", "b", "c"] }, t),
    {
      text: 'prwatch.failed{"count":2} · a, b… · prwatch.running{"count":1}', tone: "failure",
      parts: [
        { text: 'prwatch.failed{"count":2}', tone: "failure" },
        { text: "a, b…", tone: "names" },
        { text: 'prwatch.running{"count":1}', tone: "running" },
      ],
    },
  );
  assert.equal(watchState({ ...base, checks: { total: 2, running: 0, failed: 0, passed: 2 } }, t).tone, "success");
  assert.equal(watchState({ ...base, lastError: "offline", checks: { total: 1, running: 0, failed: 1, passed: 0 } }, t).text, "prwatch.retrying");
  assert.equal(watchState({ ...base, waiting: true }, t).text, "prwatch.waitingForChat");
  assert.equal(watchState(base, t).text, "prwatch.noChecks");
});

test("a request to show a change request is taken once, by its provider and project, and goes stale", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  requestChangeRequestOpen({ provider: "github", projectId: "p1", number: 128 });
  assert.equal(takeChangeRequestOpen("gitlab", "p1"), null, "another provider's view leaves it");
  assert.equal(takeChangeRequestOpen("github", "p2"), null, "another project's view leaves it");
  assert.deepEqual(takeChangeRequestOpen("github", "p1"), { number: 128 });
  assert.equal(takeChangeRequestOpen("github", "p1"), null, "taken once");
  requestChangeRequestOpen({ provider: "github", projectId: "p1", number: 7 });
  t.mock.timers.tick(10_001);
  assert.equal(takeChangeRequestOpen("github", "p1"), null, "a later, unrelated open never jumps to an old request");
});

const CHROME = await findChromiumExecutable();
test("the watch line and timeline facts render, open and stop at desktop and phone widths", { skip: !CHROME, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosting-watch-ui-"));
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let watching = true;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname.startsWith("/api/")) {
      let data: unknown = null;
      if (request.method === "POST") {
        let body = ""; for await (const chunk of request) body += chunk;
        writes.push({ path: url.pathname, body: JSON.parse(body) });
        watching = false;
        data = { ...base, state: "ended", ended: { reason: "stopped", at: 1 } };
      } else if (url.pathname === "/api/github/pr/watch" && watching) {
        data = { ...base, checks: { total: 5, running: 1, failed: 1, passed: 3 }, failedChecks: ["test (ubuntu-latest)"], heldComments: 2, wakes: 1 };
      }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, data })); return;
    }
    if (url.pathname === "/") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/watchSmoke.css"><div id="root"></div><script type="module" src="/watchSmoke.js"></script>'); return; }
    if (!["/watchSmoke.js", "/watchSmoke.css"].includes(url.pathname)) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", url.pathname.endsWith(".js") ? "application/javascript" : "text/css");
    response.end(await readFile(join(directory, url.pathname.slice(1))));
  });
  let browser: import("playwright-core").Browser | undefined;
  try {
    await build({ entryPoints: [new URL("./fixtures/watchSmoke.tsx", import.meta.url).pathname], bundle: true, format: "esm", jsx: "automatic", outdir: directory, loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl" }, external: ["/assets/*"], logLevel: "silent" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    for (const [width, mobile] of [[1100, false], [390, true]] as const) {
      watching = true;
      const page = await browser.newPage({ viewport: { width, height: 800 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
      page.setDefaultTimeout(8000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`);
      const line = page.getByRole("status", { name: /^Watching PR #128: 1 failed · test \(ubuntu-latest\) · 1 running$/ });
      await line.waitFor();
      assert.equal(await line.getAttribute("data-tone"), "failure");
      assert.equal(await page.locator(".hosting-watch-held").isVisible(), !mobile, "the held count steps aside on a phone");
      assert.equal(await page.locator('.hosting-watch-state > [data-tone="names"]').isVisible(), !mobile, "a narrow line keeps the failure count, not the names");
      const ink = (tone: string) => page.locator(`.hosting-watch-state > [data-tone="${tone}"]`).evaluate((element) => getComputedStyle(element).color);
      assert.notEqual(await ink("failure"), await ink("running"), "a failure is inked apart from what still runs");
      assert.equal(await page.locator(".hosting-watch-meter > i").count(), 3, "the bar shows passed, failed and running checks");
      await page.locator(".hosting-watch-copy").click();
      assert.equal(await page.evaluate(() => document.body.dataset.opened), "github", "the reference opens the pull request in Polyth");
      const facts = page.locator(".timeline-fixture > *");
      assert.equal(await facts.count(), 3, "a woke event without a number renders nothing");
      assert.match(await facts.nth(0).innerText(), /Watching PR #128/);
      assert.match(await facts.nth(2).innerText(), /PR #128 merged — stopped watching/);
      await page.locator("details.hosting-watch-fact summary").click();
      await page.getByRole("link", { name: "test (ubuntu-latest)", exact: true }).waitFor();
      assert.equal(await page.locator('.hosting-watch-fact-detail a[href^="javascript"]').count(), 0, "only https links");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px overflow`);
      const stop = page.getByRole("button", { name: "Stop watching PR #128" });
      const box = await stop.boundingBox();
      assert.ok(box && box.height >= (mobile ? 44 : 32), `stop target ${box?.height}`);
      await Promise.all([page.waitForResponse(response => response.url().endsWith("/api/github/pr/watch/stop")), stop.click()]);
      await line.waitFor({ state: "detached" });
      assert.deepEqual(writes.at(-1), { path: "/api/github/pr/watch/stop", body: { projectId: "p1", sessionId: "chat" } });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close(); server.closeAllConnections(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
