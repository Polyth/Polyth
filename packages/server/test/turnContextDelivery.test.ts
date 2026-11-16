// Package turn-context blocks ride an admitted user message: recorded before
// delivery, resent unchanged on retry, absent when nothing is admitted.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, CanonicalTurnRequest, ProjectService, RuntimeCapabilities } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";
import { createTurnContextRegistry } from "../src/turnContext.ts";

function fixture() {
  const store = createStore(":memory:");
  const requests: CanonicalTurnRequest[] = [];
  const runtime = {
    harnessId: "fake",
    capabilities: async () => ({ steering: false, streaming: true, permissions: false, questions: false, compaction: false, subagents: false }) as RuntimeCapabilities,
    commands: async () => [], models: async () => [], agents: async () => [],
    ensureSession: async ({ sessionId }: { sessionId: string }) => `native-${sessionId}`,
    sessions: async () => [], history: async () => [],
    async startTurn(request: CanonicalTurnRequest) { requests.push(request); },
    abort: async () => {}, replyPermission: async () => {}, replyQuestion: async () => {},
    onEvent: () => ({ dispose: () => {} }), dispose: async () => {},
  } as unknown as AgentRuntime;
  const projects = {
    get: async (id: string) => id === "p" ? { id: "p", name: "p", path: "/tmp", spaceId: "spc_home", createdAt: 0 } : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const seen: Array<{ spaceId: string; projectId: string; sessionId: string; userId: string | undefined }> = [];
  const registry = createTurnContextRegistry({
    space: (spaceId) => ({ spaceId, spaceSlug: spaceId, userId: "system", role: "owner", deployment: "local-trusted", storageDir: "/tmp" }),
    log: () => {},
  });
  registry.register(({ space, projectId, sessionId, userId }) => {
    seen.push({ spaceId: space.spaceId, projectId, sessionId, userId });
    return "<polyth-running-actions>\nDev — running 1m\n</polyth-running-actions>";
  });
  const sessions = createSessionService({
    store, projects,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store, turnContext: registry,
    harnesses: { staticFeatures: () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }) },
  } as never);
  return { sessions, store, requests, seen };
}

test("an admitted message carries the block, recorded before delivery", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "Start the dev server", clientOperationId: "op-1" }, { author: { userId: "usr_a", name: "A" } });
  const recorded = (await f.store.events(id)).find((event) => event.type === "context/turn-prepared");
  assert.ok(recorded, "persisted");
  const block = (recorded!.data as { modelVisibleText: string }).modelVisibleText;
  assert.ok(f.requests[0]!.text.includes(block));
  assert.deepEqual(f.seen, [{ spaceId: "spc_home", projectId: "p", sessionId: id, userId: "usr_a" }]);
});

test("a turn Polyth does not admit gets no block and no contributor call", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(f.sessions.send("ses_missing", { text: "hi", clientOperationId: "op-2" }));
  assert.equal(f.seen.length, 0);
  assert.equal((await f.store.events(id)).some((event) => event.type === "context/turn-prepared"), false);
  assert.equal(f.requests.length, 0);
});

test("a slow or failing contributor is skipped; output is capped at 2 KB", async () => {
  const warnings: string[] = [];
  const registry = createTurnContextRegistry({
    space: (spaceId) => ({ spaceId }) as never, budgetMs: 20, maxBytes: 200, log: (m) => { warnings.push(m); },
  });
  registry.register(() => new Promise<string>((resolve) => setTimeout(() => resolve("<polyth-a>late</polyth-a>"), 200)));
  registry.register(() => { throw new Error("boom"); });
  registry.register(() => "<polyth-b>ok</polyth-b>");
  registry.register(() => `<polyth-c>${"x".repeat(500)}</polyth-c>`);
  const call = { spaceId: "s", sessionId: "x", projectId: "p", userId: "u", worktreePath: undefined };
  assert.equal(await registry.collect(call), "<polyth-b>ok</polyth-b>");
  await registry.collect(call);
  assert.equal(warnings.length, 2, "each failing contributor is logged once");
});
