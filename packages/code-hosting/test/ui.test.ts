import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { summarizeChecks } from "../src/checks.ts";

const chrome = process.env.POLYTH_CHROMIUM_PATH;
test("shared hosting tabs, discussion writes, and provider switching work at desktop/mobile widths", { skip: !chrome || !existsSync(chrome), timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosting-ui-"));
  const calls: string[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const detail = { number: 7, title: "Pipeline failure", state: "OPEN", isDraft: false, author: "dev", updatedAt: "2026-09-10", createdAt: "2026-09-10", url: "https://gitlab.example/project", body: "Fix build", headRefName: "feature", baseRefName: "main", headRefOid: "abc", additions: 1, deletions: 1, changedFiles: 1, mergeable: "MERGEABLE" };
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/api/")) {
      calls.push(url);
      const path = new URL(url, "http://fixture").pathname;
      const checks = [{ id: "1", name: "build", status: "failure" as const }];
      let result: unknown;
      if (request.method === "POST") {
        let body = ""; for await (const chunk of request) body += chunk;
        writes.push({ path, body: JSON.parse(body) });
        result = { ok: true, data: { url: "https://gitlab.example/note" } };
      } else if (path.endsWith("/status")) result = { installed: true, authenticated: true, user: null, repo: { name: "project", owner: "team", url: "https://gitlab.example/project", description: "", defaultBranch: "main", isPrivate: false }, capabilities: { mergeStrategies: ["merge"], reviewEvents: ["COMMENT"], discussions: path.includes("gitlab"), reply: true, resolve: true } };
      else if (path.endsWith("/issues") || path.endsWith("/prs")) result = { ok: true, data: [{ ...detail, title: "Server search result", state: new URL(url, "http://fixture").searchParams.get("state") === "closed" ? "CLOSED" : "OPEN" }] };
      else if (path.endsWith("/pr")) result = { ok: true, data: detail };
      else if (path.endsWith("/files")) result = { ok: true, data: [{ path: "a.ts", additions: 1, deletions: 1 }] };
      else if (path.endsWith("/diff")) result = { ok: true, data: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" };
      else if (path.endsWith("/checks")) result = { ok: true, data: { checks, summary: summarizeChecks(checks) } };
      else if (path.endsWith("/discussions")) result = { ok: true, data: [{ id: "d1", resolved: false, resolvable: true, comments: [{ id: "n1", author: "reviewer", body: "Change this line", kind: "review", path: "a.ts", line: 1 }] }] };
      else result = { ok: true, data: [] };
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result)); return;
    }
    if (url === "/") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/hostingSmoke.css"><div id="root"></div><script type="module" src="/hostingSmoke.js"></script>'); return; }
    if (!["/hostingSmoke.js", "/hostingSmoke.css"].includes(url)) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", url.endsWith(".js") ? "application/javascript" : "text/css");
    response.end(await readFile(join(directory, url.slice(1))));
  });
  let browser: import("playwright-core").Browser | undefined;
  try {
    await build({ entryPoints: [new URL("./fixtures/hostingSmoke.tsx", import.meta.url).pathname], bundle: true, format: "esm", jsx: "automatic", outdir: directory, loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl" }, logLevel: "silent" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
    const page = await browser.newPage(); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`);
      await page.getByRole("heading", { name: /Pipeline failure/ }).waitFor();
      for (const tab of ["Overview", "Files", "Pipeline", "Comments"]) {
        await page.getByRole("tab", { name: new RegExp(tab) }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px ${tab}`);
      }
      const discussion = page.locator(".pr-discussion");
      await discussion.locator("textarea").fill("Please update the test.");
      await Promise.all([page.waitForResponse(response => response.url().endsWith("/discussions/d1/reply")), discussion.getByRole("button", { name: "Reply", exact: true }).click()]);
      assert.equal(writes.at(-1)?.path, "/api/gitlab/pr/7/discussions/d1/reply");
      assert.equal(typeof writes.at(-1)?.body.requestId, "string");
      assert.deepEqual(errors, []);
    }
    await page.getByText("browse", { exact: true }).click();
    await page.getByRole("button", { name: "Closed", exact: true }).click();
    await page.getByRole("button", { name: "Server search result", exact: true }).waitFor();
    const search = page.getByRole("textbox", { name: /Search/ });
    await Promise.all([page.waitForResponse(response => response.url().includes("search=description")), search.fill("description")]);
    await page.getByRole("button", { name: "Server search result", exact: true }).waitFor();
    await page.getByText("browse", { exact: true }).click();
    await page.getByRole("heading", { name: /Pipeline failure/ }).waitFor();
    const before = calls.length;
    await Promise.all([page.waitForResponse(response => response.url().includes("/api/github/pr?")), page.getByText("switch provider", { exact: true }).click()]);
    assert.ok(calls.slice(before).length > 0);
    assert.ok(calls.slice(before).every(path => path.startsWith("/api/github")));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
