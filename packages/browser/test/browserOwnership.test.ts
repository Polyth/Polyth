// Spaces §14.6: a browser belongs to the person who opened it (or the person
// an agent turn acts for). It may hold their hand-entered sign-ins, so nobody
// else in the Space can list, watch or drive it, and an agent turn for one
// person never uses another person's tab. Work with no person gets its own
// ownerless tab and never borrows anyone's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { createBrowserArtifactStore, createBrowserService, createFakeDriver } from "../src/index.ts";
import { createBrowserAgentTool } from "../src/agentTool.ts";
import { browserRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

const HOME = "http://127.0.0.1:5173/";

const makeBrowser = () => createBrowserService({
  driver: createFakeDriver({ pages: { [HOME]: { title: "Home", text: "Signed in as Alice" } } }),
  allowedOrigins: () => ["http://127.0.0.1:5173"],
});

function routesFor(browser: ReturnType<typeof makeBrowser>, userId?: string) {
  const append = async (sessionId: string, type: string, data: JsonObject): Promise<SessionEvent> =>
    ({ sessionId, seq: 1, ts: 0, type, data }) as unknown as SessionEvent;
  const routes = browserRoutes({
    browser,
    append,
    ...(userId ? { userId } : {}),
    // Both people can open the project and the shared chat.
    canAccess: async () => true,
    shotsDir: join(mkdtempSync(join(tmpdir(), "polyth-own-shots-")), "shots"),
    artifacts: createBrowserArtifactStore(join(mkdtempSync(join(tmpdir(), "polyth-own-arts-")), "artifacts")),
  });
  return async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    await routes({
      req: {}, res: {}, url: new URL(`http://x${path}`), path, method,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest);
    return { status, payload };
  };
}

test("a person's browser is not-found to every other member, even in a shared chat", async () => {
  const browser = makeBrowser();
  const alice = routesFor(browser, "alice");
  const bob = routesFor(browser, "bob");
  try {
    const created = await alice("POST", "/api/browser/sessions", { projectId: "p", sessionId: "shared-chat", url: HOME });
    assert.equal(created.status, 200);
    const id = (created.payload as { id: string }).id;
    assert.equal(browser.ownerOf(id), "alice");

    assert.equal(((await alice("GET", "/api/browser/sessions")).payload as unknown[]).length, 1);
    assert.deepEqual((await bob("GET", "/api/browser/sessions")).payload, []);
    for (const [method, path] of [
      ["GET", `/api/browser/sessions/${id}`],
      ["POST", `/api/browser/sessions/${id}/navigate`],
      ["POST", `/api/browser/sessions/${id}/actions`],
      ["POST", `/api/browser/sessions/${id}/observe`],
      ["GET", `/api/browser/sessions/${id}/frame`],
      ["DELETE", `/api/browser/sessions/${id}`],
    ] as const) {
      assert.equal((await bob(method, path, { url: HOME })).status, 404, `${method} ${path}`);
    }
    assert.equal((await bob("POST", "/api/browser/approvals", { browserSessionId: id, origin: "https://x.example" })).status, 404);
    assert.equal(browser.get(id)?.status === "closed", false, "bob's DELETE did not close alice's browser");
    assert.equal((await alice("GET", `/api/browser/sessions/${id}`)).status, 200);

    // Ownerless (server) browsers keep following chat/project access.
    const system = await browser.create({ projectId: "p", sessionId: "shared-chat" });
    assert.equal(browser.ownerOf(system.id), undefined);
    assert.equal(((await bob("GET", "/api/browser/sessions")).payload as Array<{ id: string }>)[0]?.id, system.id);
  } finally { await browser.closeAll(); }
});

test("an agent turn uses only the acting person's tabs; no actor never borrows one", async () => {
  const browser = makeBrowser();
  const execute = createBrowserAgentTool(browser).execute!;
  const base = { spaceId: "spc_a", projectId: "p", sessionId: "shared-chat", cwd: process.cwd() };
  try {
    const forAlice = JSON.parse((await execute({ action: "browser.open", parameters: { url: HOME } }, { ...base, actorUserId: "alice" })).output);
    assert.equal(browser.ownerOf(forAlice.browserSessionId), "alice");
    // Alice signs in by hand in her tab; Bob's next turn in the same chat:
    await assert.rejects(
      execute({ action: "browser.snapshot" }, { ...base, actorUserId: "bob" }),
      /No controlled browser is open/,
    );
    await assert.rejects(
      execute({ action: "browser.snapshot", parameters: { browserSessionId: forAlice.browserSessionId } }, { ...base, actorUserId: "bob" }),
      /not found/,
    );
    const forBob = JSON.parse((await execute({ action: "browser.open", parameters: { url: HOME } }, { ...base, actorUserId: "bob" })).output);
    assert.notEqual(forBob.browserSessionId, forAlice.browserSessionId);
    assert.equal(browser.ownerOf(forBob.browserSessionId), "bob");

    // A turn nobody started: its own ephemeral, ownerless tab.
    await assert.rejects(execute({ action: "browser.snapshot" }, base), /No controlled browser is open/);
    const system = JSON.parse((await execute({ action: "browser.open", parameters: { url: HOME } }, base)).output);
    assert.equal(browser.ownerOf(system.browserSessionId), undefined);
    assert.equal(new Set([forAlice.browserSessionId, forBob.browserSessionId, system.browserSessionId]).size, 3);

    // Alice's next turn finds her own tab again.
    const again = JSON.parse((await execute({ action: "browser.snapshot" }, { ...base, actorUserId: "alice" })).output);
    assert.equal(again.browserSessionId, forAlice.browserSessionId);
  } finally { await browser.closeAll(); }
});
