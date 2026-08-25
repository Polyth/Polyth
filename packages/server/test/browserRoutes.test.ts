// WP14 route invariants: action-requested appends BEFORE the driver acts;
// observations append BEFORE the payload returns; failures append
// action-failed; unlinked browser sessions append nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { createBrowserService, createFakeDriver } from "@polyth/browser";
import { browserRoutes } from "../src/routes/browser.ts";
import type { RouteRequest } from "../src/http.ts";

const HOME = "http://127.0.0.1:5173/";

interface Call { kind: "append" | "acted"; type?: string; data?: JsonObject }

function makeHarness() {
  const calls: Call[] = [];
  let seq = 0;
  const driver = createFakeDriver({
    pages: {
      [HOME]: { title: "App", text: "hello secret-token=sk-12345678abc", links: { "a#next": `${HOME}next` } },
      [`${HOME}next`]: { title: "Next", text: "next page" },
    },
  });
  // wrap the driver so the test can see when page work actually happens
  const spied = {
    engine: driver.engine,
    close: () => driver.close(),
    open: async (opts: Parameters<typeof driver.open>[0]) => {
      const page = await driver.open(opts);
      const origClick = page.click.bind(page);
      page.click = async (t) => { calls.push({ kind: "acted" }); return origClick(t); };
      return page;
    },
  };
  const browser = createBrowserService({
    driver: spied,
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const append = async (sessionId: string, type: string, data: JsonObject): Promise<SessionEvent> => {
    calls.push({ kind: "append", type, data });
    return { sessionId, seq: ++seq, ts: Date.now(), type, data } as SessionEvent;
  };
  const routes = browserRoutes({ browser, append, shotsDir: join(mkdtempSync(join(tmpdir(), "polyth-shots-")), "shots") });

  const call = async (method: string, path: string, body: Record<string, unknown> = {}, query = "") => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {},
      url: new URL(`http://x${path}${query}`),
      path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };

  return { browser, calls, call };
}

test("action-requested appends before the driver acts; completed after", async () => {
  const { calls, call } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", { projectId: "p1", sessionId: "sess1", url: HOME });
  assert.equal(created.status, 200);
  const id = (created.payload as { id: string }).id;
  calls.length = 0;

  const acted = await call("POST", `/api/browser/sessions/${id}/actions`, {
    actor: "agent",
    action: { kind: "click", target: { selector: "a#next" } },
  });
  assert.equal(acted.status, 200);
  const kinds = calls.map((c) => c.kind === "append" ? c.type : "acted");
  assert.deepEqual(kinds, ["browser/action-requested", "acted", "browser/action-completed"]);
  const requested = calls[0]!.data!;
  assert.equal(requested.actor, "agent");
  assert.match(String(requested.actionSummary), /click a#next/);
});

test("create and action routes apply viewport and color-scheme emulation", async () => {
  const { calls, call } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", {
    projectId: "p1",
    sessionId: "sess1",
    url: HOME,
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
  });
  assert.equal(created.status, 200);
  const initial = created.payload as {
    id: string;
    viewport: { width: number; height: number };
    colorScheme: string;
  };
  assert.deepEqual(initial.viewport, { width: 390, height: 844, deviceScaleFactor: 1 });
  assert.equal(initial.colorScheme, "dark");
  calls.length = 0;

  const recolored = await call("POST", `/api/browser/sessions/${initial.id}/actions`, {
    actor: "user",
    action: { kind: "color-scheme", colorScheme: "light" },
  });
  assert.equal(recolored.status, 200);
  assert.equal((recolored.payload as { session: { colorScheme: string } }).session.colorScheme, "light");
  assert.match(String(calls[0]?.data?.actionSummary), /light color scheme/);

  const revision = (recolored.payload as { session: { revision: number } }).session.revision;
  calls.length = 0;
  const pointed = await call("POST", `/api/browser/sessions/${initial.id}/actions`, {
    actor: "user",
    action: { kind: "point", target: { point: { x: 10, y: 20 }, frameRevision: revision } },
  });
  assert.equal(pointed.status, 200);
  assert.equal((pointed.payload as { result: { selector: string } }).result.selector, "main");
  assert.match(String(calls[0]?.data?.actionSummary), /point at/);
});

test("screenshot observation logs the persisted ref before returning UI-only pixels", async () => {
  const { calls, call } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", { projectId: "p1", sessionId: "sess1", url: HOME });
  const id = (created.payload as { id: string }).id;
  calls.length = 0;

  const obs = await call("POST", `/api/browser/sessions/${id}/observe`, { includeScreenshot: true });
  assert.equal(obs.status, 200);
  const appended = calls.find((c) => c.kind === "append" && c.type === "browser/observation");
  assert.ok(appended, "observation event appended");
  const response = obs.payload as {
    text: string;
    screenshotRef?: string;
    screenshot?: { mime: string; data: string };
  };
  const text = String(response.text);
  assert.ok(!text.includes("sk-12345678abc"));
  assert.equal(String(appended!.data!.text), text); // logged exactly what was returned
  assert.match(response.screenshotRef ?? "", /\.webp$/);
  assert.equal(response.screenshot?.mime, "image/webp");
  assert.ok(response.screenshot?.data);
  assert.equal("screenshot" in appended!.data!, false, "raw pixels stay out of the event log");
});

test("failed actions append action-failed with the policy code", async () => {
  const { calls, call } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", { projectId: "p1", sessionId: "sess1", url: HOME });
  const id = (created.payload as { id: string }).id;
  calls.length = 0;

  const nav = await call("POST", `/api/browser/sessions/${id}/navigate`, { url: "http://10.0.0.1/", actor: "agent" });
  assert.equal(nav.status, 403);
  const types = calls.filter((c) => c.kind === "append").map((c) => c.type);
  assert.deepEqual(types, ["browser/action-requested", "browser/action-failed"]);
  assert.equal(calls[1]!.data!.code, "blocked-private");
});

test("browser sessions without a linked polyth session append nothing", async () => {
  const { calls, call } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", { projectId: "p1", url: HOME });
  const id = (created.payload as { id: string }).id;
  calls.length = 0;
  await call("POST", `/api/browser/sessions/${id}/actions`, { actor: "user", action: { kind: "press", key: "Enter" } });
  await call("POST", `/api/browser/sessions/${id}/observe`, {});
  assert.deepEqual(calls.filter((c) => c.kind === "append"), []);
});

test("capability endpoint reports honest unavailable state", async () => {
  const browser = createBrowserService({ driver: null, unavailableReason: "browser engine unavailable: nope" });
  const routes = browserRoutes({ browser, append: async () => { throw new Error("no"); }, shotsDir: "/tmp/x" });
  let payload: unknown;
  await routes({
    req: {}, res: {}, url: new URL("http://x/api/browser/capability"),
    path: "/api/browser/capability", method: "GET",
    body: async () => ({}), json: (_c: number, b: unknown) => { payload = b; },
  } as unknown as RouteRequest);
  assert.deepEqual(payload, { available: false, engine: null, reason: "browser engine unavailable: nope" });
});

test("frame endpoint supports afterRevision resume and 204 when caught up", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", { projectId: "p1", url: HOME });
  const id = (created.payload as { id: string }).id;
  const f1 = await call("GET", `/api/browser/sessions/${id}/frame`);
  assert.equal(f1.status, 200);
  const rev = (f1.payload as { revision: number }).revision;
  const caught = await call("GET", `/api/browser/sessions/${id}/frame`, {}, `?afterRevision=${rev}`);
  assert.equal(caught.status, 204);
});
