// Turn-admission fence: model-visible work belongs to a turn Polyth admitted.
// A runtime leg that keeps streaming after its turn closed — a stranded turn, a
// replaced runtime, or a harness running its own loop — must not write into the
// canonical log, because that is what makes a session render as idle while it is
// actually being worked on, and what leaves a live-looking turn with no owner for
// agent-control tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent,
  RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  attempts = 200,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await flush(10);
  }
  throw new Error("condition was not reached");
};

const harness = () => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const startedTexts: string[] = [];
  const endpoint: RuntimeEndpoint = {
    authorityId: "fake-runtime",
    continuity: "verified",
    generation: 1,
    url: "http://fake.invalid",
    location: { directory: "/fake" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (canonical) => `be_${canonical.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      startedTexts.push(request.text);
      for (const listener of listeners) {
        listener(request.sessionId, { type: "turn/started", turnId: `native-${startedTexts.length}` });
      }
    },
    abort: async (sessionId) => {
      for (const listener of listeners) {
        listener(sessionId, { type: "turn/stopped", reason: "aborted" });
      }
    },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    endpoint: async () => endpoint,
    reconcile: async (binding: RuntimeSessionBinding & { reconciliationOrdinal?: number }): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "idle", watermark: "1", comparison: { domain: "test", order: 1 } },
      completeness: { events: "partial", permissions: "partial", questions: "partial" },
      permissions: [],
      questions: [],
      events: [],
    }),
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => {},
  };

  const dir = mkdtempSync(join(tmpdir(), "polyth-turn-fence-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "ask", addRule: () => {}, rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => runtime },
  });
  return {
    sessions, store, startedTexts,
    emit: (sessionId: string, ...events: RuntimeEvent[]) => {
      for (const event of events) {
        for (const listener of listeners) listener(sessionId, event);
      }
    },
  };
};

const zombieTurn = (callId: string): RuntimeEvent[] => [
  { type: "assistant/chunk", partId: ":stream:15:0", text: "unowned" },
  { type: "tool/call", callId, tool: "Bash", input: { command: "ls" }, status: "pending" },
  { type: "tool/started", callId, tool: "Bash", input: { command: "ls" } },
  { type: "tool/result", callId, tool: "Bash", output: "files" },
  { type: "assistant/message", partId: ":stream:15:1", text: "unowned answer" },
  { type: "usage/recorded", model: { providerID: "anthropic", modelID: "sonnet" }, tokens: { input: 9, output: 3 } },
  { type: "turn/stopped", turnId: "", reason: "completed" },
];

test("a leg streaming after its turn closed writes nothing into the session", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Zombie" });
  await h.sessions.send(id, { text: "real work" });
  h.emit(id, { type: "assistant/message", partId: "real:stream:0:0", text: "real answer" });
  h.emit(id, { type: "turn/stopped", turnId: "native-1", reason: "completed" });
  await waitFor(async () => (await h.store.events(id)).some((event) => event.type === "turn/stopped"));
  const before = (await h.store.events(id)).length;
  const lastTurnAt = (await h.store.projection(id))?.lastTurnAt;

  h.emit(id, ...zombieTurn("call-zombie"));
  await flush(120);

  const events = await h.store.events(id);
  assert.equal(events.length, before, "no unadmitted event became canonical history");
  assert.ok(!events.some((event) => event.type === "tool/started"), "no orphan tool row");
  assert.ok(!events.some((event) => event.type === "usage/recorded"), "no usage for a turn that never existed");
  const projection = await h.store.projection(id);
  assert.equal(projection?.status, "idle", "the session stays honestly idle");
  assert.equal(projection?.lastTurnAt, lastTurnAt, "unadmitted work never counts as a turn");
  await h.store.close();
});

test("the turn's own marker admits the content that follows it", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Admitted" });

  h.emit(
    id,
    { type: "turn/started", turnId: "op-1" },
    { type: "assistant/chunk", partId: "op-1:stream:0:0", text: "first" },
    { type: "assistant/chunk", partId: "op-1:stream:0:0", text: " second" },
  );
  await waitFor(async () => (await h.store.events(id)).filter((event) => event.type === "assistant/chunk").length === 2);

  const events = await h.store.events(id);
  const chunks = events.filter((event) => event.type === "assistant/chunk");
  assert.equal(chunks.length, 2, "an admitted turn keeps its streamed content");
  assert.deepEqual(
    chunks.map((event) => (event.data as { partId: string }).partId),
    ["op-1:stream:0:0", "op-1:stream:0:0"],
  );
  assert.equal((await h.store.projection(id))?.status, "working");
  await h.store.close();
});

test("every event of a batch dispatched while a turn is live is admitted", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Live" });
  await h.sessions.send(id, { text: "work" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");

  h.emit(
    id,
    { type: "assistant/chunk", partId: "native-1:stream:0:0", text: "live" },
    { type: "tool/started", callId: "call-live", tool: "Bash", input: { command: "ls" } },
    { type: "tool/result", callId: "call-live", tool: "Bash", output: "files" },
    { type: "turn/stopped", turnId: "native-1", reason: "completed" },
  );
  await waitFor(async () => (await h.store.projection(id))?.status === "idle");

  const events = await h.store.events(id);
  assert.ok(events.some((event) => event.type === "tool/result" && event.data.callId === "call-live"));
  assert.equal(events.at(-1)?.type, "turn/stopped", "the admitted turn still closes normally");
  await h.store.close();
});

test("bookkeeping no turn owns still lands while the fence refuses turn content", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Bookkeeping" });

  h.emit(
    id,
    { type: "assistant/chunk", partId: ":stream:3:0", text: "unowned" },
    { type: "session/compacted", backendEventId: "cmp-1" },
  );
  await waitFor(async () => (await h.store.events(id)).some((event) => event.type === "session/compacted"));

  const events = await h.store.events(id);
  assert.ok(!events.some((event) => event.type === "assistant/chunk"), "turn content is still refused");
  assert.ok(
    events.some((event) => event.type === "session/compacted"),
    "a fact that no turn owns is not turn content and survives the fence",
  );
  await h.store.close();
});
