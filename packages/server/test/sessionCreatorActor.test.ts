import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, ProjectService } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition was not met");
    await sleep(10);
  }
};

function fixture() {
  const store = createStore(":memory:");
  const seen: Array<string | undefined> = [];
  const runtime: AgentRuntime = {
    harnessId: "antigravity-iryna",
    models: async () => [],
    agents: async () => [],
    ensureSession: async ({ sessionId }) => `native-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    async startTurn() {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent: () => ({ dispose: () => {} }),
    dispose: async () => {},
  };
  const projects = {
    get: async (id: string) => id === "p" ? { id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0 } : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store,
    projects,
    // The real pool builds the harness context from the stored projection, so
    // a person's actor must already be durable here.
    runtimes: { forSession: async (projection) => { seen.push(projection.actor?.userId); return runtime; } },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
  });
  return { sessions, store, seen };
}

const relayRoute = { mode: "pinned" as const, harnessId: "antigravity-relay" };
const model = { providerID: "antigravity", modelID: "gemini-4-hydrogen" };

test("a chat's creator is durable before its runtime is acquired", async () => {
  const { sessions, store, seen } = fixture();
  try {
    const ref = await sessions.create({ projectId: "p", harness: relayRoute, model }, { author: { userId: "usr_owner" } });
    assert.deepEqual(seen, ["usr_owner"]);
    assert.equal((await store.projection(ref.id))?.actor?.userId, "usr_owner");
  } finally {
    await store.close();
  }
});

test("a started chat records its first turn's author before provisioning", async () => {
  const { sessions, store, seen } = fixture();
  try {
    // The first turn stays queued behind the runtime, which the provisioning
    // flight acquires: the relay must still resolve for the person who started
    // the chat, not for the server's system identity.
    const started = await sessions.start({
      projectId: "p", harness: relayRoute, model,
      start: { firstTurn: { text: "Hi" } },
      clientOperationId: randomUUID(),
    }, { author: { userId: "usr_owner" } });
    assert.equal((await store.projection(started.id))?.actor?.userId, "usr_owner");
    await waitUntil(() => seen.length > 0);
    assert.ok(seen.every((actor) => actor === "usr_owner"), JSON.stringify(seen));
  } finally {
    await store.close();
  }
});

test("a system-created chat keeps no acting person", async () => {
  const { sessions, store } = fixture();
  try {
    const ref = await sessions.create({ projectId: "p", harness: relayRoute, model });
    assert.equal((await store.projection(ref.id))?.actor, undefined);
  } finally {
    await store.close();
  }
});
