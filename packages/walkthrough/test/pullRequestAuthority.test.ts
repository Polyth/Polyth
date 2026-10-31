import test from "node:test";
import assert from "node:assert/strict";
import type { GeneratedWalkthroughDto, SpaceContext, WalkthroughSource } from "@polyth/contracts";
import { walkthroughRoutes } from "../src/serverEntry.ts";

const space = (extra: Partial<SpaceContext> & { instanceOwner?: boolean } = {}): SpaceContext => ({
  spaceId: "spc_a", spaceSlug: "a", userId: "usr_a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/a", ...extra,
} as SpaceContext);

test("pull-request capture uses the host's GitHub login, so only the instance owner on local-trusted may start it", async () => {
  const captured: WalkthroughSource[] = [];
  const job = (source: WalkthroughSource): GeneratedWalkthroughDto => ({ id: "w1", source, sourceDigest: "d", status: "queued", stages: [], createdAt: 1 });
  const routes = walkthroughRoutes({
    store: {} as never,
    broadcast: { event() {} },
    jobs: {
      create: async (source) => { captured.push(source); return job(source); },
      get: () => job({ kind: "pull-request", projectId: "prj", number: 7 }),
      cancel: () => null,
      sourceStatus: async () => { captured.push({ kind: "pull-request", projectId: "prj", number: 7 }); return { stale: false, sourceDigest: "d", currentDigest: "d" }; },
      list: () => [],
    },
    review: { generate: async (_sessionId, source) => { captured.push(source); return { ok: false, reason: "empty" }; } },
  });
  const call = async (rc: { space: SpaceContext; principal?: { kind: string } }, path: string, method: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    await routes({
      path, method, url: new URL(`http://localhost${path}`), body: async () => body,
      json(code: number, value: unknown) { status = code; payload = value; }, ...rc,
    } as never);
    return { status, payload: payload as { code?: string } };
  };
  const pr = { source: { kind: "pull-request", projectId: "prj", number: 7 } };
  const refusedFor = [
    { space: space({ instanceOwner: false }), principal: { kind: "ui-session" } },
    { space: space({ instanceOwner: true, deployment: "server-trusted" }), principal: { kind: "ui-session" } },
    { space: space() },
  ];
  for (const rc of refusedFor) {
    for (const [path, method, body] of [
      ["/api/walkthroughs", "POST", pr],
      ["/api/sessions/s1/review/generate", "POST", pr],
      ["/api/walkthroughs/w1/source-status", "GET", {}],
    ] as const) {
      const result = await call(rc, path, method, body);
      assert.equal(result.status, 409, `${path} for ${JSON.stringify(rc)}`);
      assert.equal(result.payload.code, "git-account-required");
    }
  }
  assert.deepEqual(captured, [], "no gh call was made for anyone else");

  const owner = { space: space({ instanceOwner: true }), principal: { kind: "ui-session" } };
  assert.equal((await call(owner, "/api/walkthroughs", "POST", pr)).status, 200);
  assert.equal((await call(owner, "/api/sessions/s1/review/generate", "POST", pr)).status, 200);
  // A working-tree source never touches GitHub, so anyone may use it.
  const member = refusedFor[0]!;
  assert.equal((await call(member, "/api/walkthroughs", "POST", { source: { kind: "working-tree", projectId: "prj" } })).status, 200);
  assert.equal(captured.length, 3);
});
