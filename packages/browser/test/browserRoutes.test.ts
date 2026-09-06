// WP14 route invariants: action-requested appends BEFORE the driver acts;
// observations append BEFORE the payload returns; failures append
// action-failed; unlinked browser sessions append nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { createBrowserArtifactStore, createBrowserService, createFakeDriver } from "@polyth/browser";
import { browserRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

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
    return { sessionId, seq: ++seq, ts: Date.now(), type, data } as unknown as SessionEvent;
  };
  const routes = browserRoutes({
    browser,
    append,
    shotsDir: join(mkdtempSync(join(tmpdir(), "polyth-shots-")), "shots"),
    artifacts: createBrowserArtifactStore(join(mkdtempSync(join(tmpdir(), "polyth-arts-")), "artifacts")),
  });

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

  const nav = await call("POST", `/api/browser/sessions/${id}/navigate`, { url: "http://93.184.216.34/", actor: "agent" });
  assert.equal(nav.status, 403);
  const types = calls.filter((c) => c.kind === "append").map((c) => c.type);
  assert.deepEqual(types, ["browser/action-requested", "browser/action-failed"]);
  assert.equal(calls[1]!.data!.code, "approval-required");
});

test("user navigation returns approval state without a transport failure", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", { projectId: "p1", url: HOME });
  const id = (created.payload as { id: string }).id;

  const navigation = await call("POST", `/api/browser/sessions/${id}/navigate`, {
    actor: "user",
    url: "http://93.184.216.34/",
  });
  assert.equal(navigation.status, 200);
  const pending = navigation.payload as {
    session: { id: string } | null;
    approval: { origin: string; message: string };
  };
  assert.equal(pending.session?.id, id);
  assert.equal(pending.approval.origin, "http://93.184.216.34");
  assert.match(pending.approval.message, /needs.*approval/);

  const approved = await call("POST", "/api/browser/approvals", { origin: "93.184.216.34" });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.payload, { origins: ["http://93.184.216.34"] });
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
  const routes = browserRoutes({
    browser,
    append: async () => { throw new Error("no"); },
    shotsDir: "/tmp/x",
    artifacts: createBrowserArtifactStore(join(mkdtempSync(join(tmpdir(), "polyth-arts-")), "artifacts")),
  });
  let payload: unknown;
  await routes({
    req: {}, res: {}, url: new URL("http://x/api/browser/capability"),
    path: "/api/browser/capability", method: "GET",
    body: async () => ({}), json: (_c: number, b: unknown) => { payload = b; },
  } as unknown as RouteRequest);
  assert.deepEqual(payload, { available: false, engine: null, reason: "browser engine unavailable: nope" });
});

test("context capture returns structured BrowserContext and rejects stale revisions", async () => {
  const { browser, call, calls } = makeHarness();
  const created = await call("POST", "/api/browser/sessions", { projectId: "p1", sessionId: "sess1", url: HOME });
  assert.equal(created.status, 200);
  const id = (created.payload as { id: string }).id;
  const session = browser.get(id)!;
  calls.length = 0;

  const pageCtx = await call("POST", `/api/browser/sessions/${id}/context`, {
    type: "page",
    id: "ctx-page-1",
    expectedRevision: session.revision,
  });
  assert.equal(pageCtx.status, 200);
  const pagePayload = pageCtx.payload as {
    context: { type: string; url: string; textSummary?: string; screenshot?: { id: string } };
  };
  assert.equal(pagePayload.context.type, "page");
  assert.equal(pagePayload.context.url, HOME);
  assert.ok(pagePayload.context.textSummary?.includes("hello"));
  assert.ok(pagePayload.context.screenshot?.id);

  const stale = await call("POST", `/api/browser/sessions/${id}/context`, {
    type: "page",
    id: "ctx-page-stale",
    expectedRevision: session.revision - 1,
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.payload as { error: string }).error, "stale-frame");

  const area = await call("POST", `/api/browser/sessions/${id}/context`, {
    type: "area",
    id: "ctx-area-1",
    expectedRevision: browser.get(id)!.revision,
    region: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 },
  });
  assert.equal(area.status, 200);
  const areaPayload = area.payload as {
    context: { type: string; region?: { pixels: { width: number } }; screenshot?: { id: string }; crop?: { id: string } };
  };
  assert.equal(areaPayload.context.type, "area");
  assert.ok((areaPayload.context.region?.pixels.width ?? 0) > 0);
  assert.equal(areaPayload.context.screenshot, undefined);
  assert.ok(areaPayload.context.crop?.id);

  const element = await call("POST", `/api/browser/sessions/${id}/context`, {
    type: "element",
    id: "ctx-el-1",
    expectedRevision: browser.get(id)!.revision,
    point: { x: 12, y: 18 },
  });
  assert.equal(element.status, 200);
  const elementPayload = element.payload as {
    context: { type: string; screenshot?: { id: string }; crop?: { id: string }; element?: { tag?: string } };
  };
  assert.equal(elementPayload.context.type, "element");
  assert.equal(elementPayload.context.screenshot, undefined);
  assert.ok(elementPayload.context.crop?.id);
  assert.ok(elementPayload.context.element?.tag);

  const text = await call("POST", `/api/browser/sessions/${id}/context`, {
    type: "text",
    id: "ctx-text-1",
    expectedRevision: browser.get(id)!.revision,
    start: { x: 10, y: 10 },
    end: { x: 80, y: 40 },
  });
  assert.equal(text.status, 200);
  const textPayload = text.payload as {
    context: { type: string; quote?: string; screenshot?: { id: string }; crop?: { id: string } };
  };
  assert.equal(textPayload.context.type, "text");
  assert.ok((textPayload.context.quote ?? "").includes("hello"));
  assert.equal(textPayload.context.screenshot, undefined);
  assert.equal(textPayload.context.crop, undefined);
  assert.ok(calls.some((c) => c.kind === "append" && c.type === "browser/context-captured"));
});

test("artifact endpoint serves managed browser captures", async () => {
  const browser = createBrowserService({
    driver: createFakeDriver({
      pages: { [HOME]: { title: "App", text: "hello" } },
    }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const artifacts = createBrowserArtifactStore(join(mkdtempSync(join(tmpdir(), "polyth-arts-")), "artifacts"));
  const routes = browserRoutes({
    browser,
    append: async () => ({ sessionId: "x", seq: 1, ts: Date.now(), type: "x", data: {} }) as never,
    shotsDir: join(mkdtempSync(join(tmpdir(), "polyth-shots-")), "shots"),
    artifacts,
  });
  const session = await browser.create({ projectId: "p1", url: HOME });
  const ctx = await browser.captureContext(session.id, {
    type: "page",
    id: "ctx-art",
    expectedRevision: session.revision,
  }, artifacts);
  assert.ok(ctx.screenshot?.id);

  let artStatus = 0;
  let artHeaders: Record<string, string> = {};
  let artBody: Buffer | undefined;
  const handled = await routes({
    req: {},
    res: {
      writeHead: (code: number, h: Record<string, string>) => { artStatus = code; artHeaders = h; },
      end: (buf: Buffer) => { artBody = buf; },
    },
    url: new URL(`http://x/api/browser/artifacts?id=${encodeURIComponent(ctx.screenshot!.id)}`),
    path: "/api/browser/artifacts",
    method: "GET",
    body: async () => ({}),
    json: () => {},
  } as unknown as RouteRequest);
  assert.equal(handled, true);
  assert.equal(artStatus, 200);
  assert.match(artHeaders["content-type"] ?? "", /image\//);
  assert.ok(artBody && artBody.length > 0);

  let delStatus = 0;
  let delPayload: unknown;
  const deleted = await routes({
    req: {},
    res: { writeHead: () => {}, end: () => {} },
    url: new URL(`http://x/api/browser/artifacts?id=${encodeURIComponent(ctx.screenshot!.id)}`),
    path: "/api/browser/artifacts",
    method: "DELETE",
    body: async () => ({}),
    json: (code: number, payload: unknown) => { delStatus = code; delPayload = payload; },
  } as unknown as RouteRequest);
  assert.equal(deleted, true);
  assert.equal(delStatus, 200);
  assert.equal((delPayload as { ok?: boolean }).ok, true);
  assert.equal(await artifacts.read(ctx.screenshot!.id), null);

  const kept = await browser.captureContext(session.id, {
    type: "page",
    id: "ctx-kept",
    expectedRevision: browser.get(session.id)!.revision,
  }, artifacts);
  assert.ok(kept.screenshot?.id);
  await artifacts.commit([kept.screenshot.id]);
  let retainStatus = 0;
  let retainPayload: unknown;
  await routes({
    req: {},
    res: { writeHead: () => {}, end: () => {} },
    url: new URL(`http://x/api/browser/artifacts?id=${encodeURIComponent(kept.screenshot.id)}`),
    path: "/api/browser/artifacts",
    method: "DELETE",
    body: async () => ({}),
    json: (code: number, payload: unknown) => { retainStatus = code; retainPayload = payload; },
  } as unknown as RouteRequest);
  assert.equal(retainStatus, 200);
  assert.equal((retainPayload as { retained?: boolean }).retained, true);
  assert.ok(await artifacts.read(kept.screenshot.id));
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
