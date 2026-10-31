import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import {
  createBrowserService,
  createFakeDriver,
  createFakeProfileDriver,
  createProfileRegistry,
  newChatTabId,
  resetFakeProfileLocks,
} from "../src/index.ts";
import { browserRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

const HOME = "http://127.0.0.1:5173/";

test("agent browser APIs return forbidden for chat tab ids", async () => {
  resetFakeProfileLocks();
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const browser = createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "App", text: "hi" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const agentSession = await browser.create({ projectId: "p1", url: HOME });
  const chatTabId = newChatTabId();
  profiles.registerTab("space:proj", chatTabId, "profile-1");

  const route = browserRoutes({
    browser,
    profiles,
    append: async (_sessionId: string, type: string, data: JsonObject): Promise<SessionEvent> => ({
      id: "e1",
      sessionId: "s",
      seq: 1,
      time: Date.now(),
      type,
      data,
      v: 1,
    }),
    shotsDir: mkdtempSync(join(tmpdir(), "shots-")),
    artifacts: { read: async () => null, remove: async () => false, write: async () => "x" } as never,
  });

  const call = async (sessionId: string) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {},
      url: new URL(`http://localhost/api/browser/sessions/${sessionId}/observe`),
      path: `/api/browser/sessions/${sessionId}/observe`,
      method: "POST",
      body: async () => ({}),
      json: (code: number, body: unknown) => { status = code; payload = body; },
    } as unknown as RouteRequest;
    await route(rc);
    return { status, payload: payload as Record<string, unknown> };
  };

  const blocked = await call(chatTabId);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.payload.error, "forbidden");
  assert.match(String(blocked.payload.message), /chat-workspace-manual-only/);

  const allowed = await call(agentSession.id);
  assert.equal(allowed.status, 200);
});
