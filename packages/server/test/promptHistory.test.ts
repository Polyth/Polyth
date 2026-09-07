import test from "node:test";
import assert from "node:assert/strict";
import { promptHistoryRoutes } from "../src/routes/promptHistory.ts";
import type { SpaceContext } from "@polyth/contracts";
import type { Store } from "@polyth/session";

const space: SpaceContext = {
  spaceId: "sp1",
  spaceSlug: "home",
  userId: "u1",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp",
};

test("prompt-history route validates scope, limit, and session ownership without a client space id", async () => {
  const calls: unknown[] = [];
  const store = {
    listPromptHistory: async (opts: unknown) => {
      calls.push(opts);
      return [];
    },
  } as unknown as Store;
  const snapshot = async (id: string) => {
    if (id === "missing") throw Object.assign(new Error("session not found"), { code: "not-found" });
    return { id };
  };
  const handler = promptHistoryRoutes({
    spaces: () => ({ sessions: { snapshot } } as never),
    store,
  });
  const run = async (url: string) => {
    let result: { code: number; body: unknown } | undefined;
    const ok = await handler({
      path: "/api/prompt-history",
      method: "GET",
      url: new URL(url, "http://polyth.local"),
      space,
      json: (code, body) => { result = { code, body }; },
    } as never);
    return { ok, result };
  };

  await assert.rejects(() => run("http://polyth.local/api/prompt-history?scope=nope"), /session or space/);
  await assert.rejects(() => run("http://polyth.local/api/prompt-history?scope=session"), /sessionId is required/);
  await assert.rejects(() => run("http://polyth.local/api/prompt-history?scope=session&sessionId=s1&limit=0"), /1 to 200/);
  await assert.rejects(() => run("http://polyth.local/api/prompt-history?scope=session&sessionId=s1&limit=9999"), /1 to 200/);
  await assert.rejects(() => run("http://polyth.local/api/prompt-history?scope=session&sessionId=missing"), /session not found/);

  const session = await run("http://polyth.local/api/prompt-history?scope=session&sessionId=s1&limit=10");
  assert.equal(session.ok, true);
  assert.equal(session.result?.code, 200);
  assert.deepEqual(calls[0], { spaceId: "sp1", sessionId: "s1", limit: 10 });

  const spaceWide = await run("http://polyth.local/api/prompt-history?scope=space&limit=5");
  assert.equal(spaceWide.ok, true);
  assert.deepEqual(calls[1], { spaceId: "sp1", limit: 5 });

  await assert.rejects(() => run("http://polyth.local/api/prompt-history?scope=server&limit=5"), /session or space/);

  const sneaky = await run("http://polyth.local/api/prompt-history?scope=space&spaceId=other&limit=7");
  assert.equal(sneaky.ok, true);
  assert.deepEqual(calls[2], { spaceId: "sp1", limit: 7 });
});
