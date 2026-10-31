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
  // Recall is personal: the signed-in person, never a client value, filters it.
  assert.deepEqual(calls[0], { spaceId: "sp1", sessionId: "s1", limit: 10, personId: "u1" });

  const spaceWide = await run("http://polyth.local/api/prompt-history?scope=space&limit=5");
  assert.equal(spaceWide.ok, true);
  assert.deepEqual(calls[1], { spaceId: "sp1", limit: 5, personId: "u1" });

  await assert.rejects(() => run("http://polyth.local/api/prompt-history?scope=server&limit=5"), /session or space/);

  const sneaky = await run("http://polyth.local/api/prompt-history?scope=space&spaceId=other&personId=u2&limit=7");
  assert.equal(sneaky.ok, true);
  assert.deepEqual(calls[2], { spaceId: "sp1", limit: 7, personId: "u1" });
});

test("navigation validates cursors and denies known foreign sessions before reading previews", async () => {
  const calls: unknown[] = [];
  const store = { listSessionPrompts: async (opts: unknown) => {
    calls.push(opts);
    return { prompts: [{ id: "p", seq: 10, preview: "prompt" }], beforeSeq: null };
  } } as unknown as Store;
  const handler = promptHistoryRoutes({ store, spaces: () => ({ sessions: { snapshot: async (id: string) => {
    if (id === "foreign" || id === "unknown") throw Object.assign(new Error("session not found"), { code: "not-found" });
    return { id };
  } } } as never) });
  const run = async (params: string) => {
    let body: unknown;
    await handler({ path: "/api/prompt-history/navigation", method: "GET", space,
      url: new URL(`http://polyth.local/api/prompt-history/navigation?${params}`),
      json: (code: number, result: unknown) => { assert.equal(code, 200); body = result; },
    } as never);
    return body;
  };
  await assert.rejects(() => run(""), /sessionId is required/);
  for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992", ""]) {
    await assert.rejects(() => run(`sessionId=s&beforeSeq=${value}`), /positive safe integer/);
  }
  for (const value of ["0", "201", "1.5"]) await assert.rejects(() => run(`sessionId=s&limit=${value}`), /integer/);
  for (const id of ["foreign", "unknown"]) {
    await assert.rejects(() => run(`sessionId=${id}`), (error: unknown) => (error as { code: string }).code === "not-found");
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await run("sessionId=s&limit=40&beforeSeq=30&spaceId=other"), { prompts: [{ id: "p", seq: 10, preview: "prompt" }], beforeSeq: null });
  assert.deepEqual(calls, [{ spaceId: "sp1", sessionId: "s", limit: 40, beforeSeq: 30 }]);
});
