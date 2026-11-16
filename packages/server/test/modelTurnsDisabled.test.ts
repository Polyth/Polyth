// Agent-beta test servers refuse every provider turn unless they opt in with
// POLYTH_AGENT_BETA_MODEL_TURNS=1. The refusal is the one admission gate, so a
// person's send and an automatic continuation take the same path.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, CanonicalTurnRequest, ProjectService, RuntimeCapabilities } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, MODEL_TURNS_DISABLED_MESSAGE } from "../src/sessions.ts";

const fixture = (modelTurnsDisabled: boolean) => {
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
    get: async (id: string) => id === "p" ? { id: "p", name: "p", path: "/tmp", spaceId: "s", createdAt: 0 } : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store, projects,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    ...(modelTurnsDisabled ? { modelTurnsDisabled: true } : {}),
    harnesses: { staticFeatures: () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }) },
  } as never);
  return { sessions, store, requests };
};

const types = async (f: ReturnType<typeof fixture>, id: string) => (await f.store.events(id)).map((event) => event.type);

test("a person's send is refused with a visible error and starts nothing", async (t) => {
  const f = fixture(true);
  t.after(() => { f.sessions.dispose(); return f.store.close(); });
  const { id } = await f.sessions.create({ projectId: "p", title: "Beta" });
  const before = await types(f, id);
  await assert.rejects(f.sessions.send(id, { text: "hello" }), (error: Error) => error.message === MODEL_TURNS_DISABLED_MESSAGE);
  assert.match(MODEL_TURNS_DISABLED_MESSAGE, /POLYTH_AGENT_BETA_MODEL_TURNS=1/);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.store.projection(id))?.status, "idle");
  assert.deepEqual(await types(f, id), before, "nothing claims a turn ran");
  assert.deepEqual(await f.store.queueList(id), []);
});

test("an automatic continuation is refused the same way", async (t) => {
  const f = fixture(true);
  t.after(() => { f.sessions.dispose(); return f.store.close(); });
  const { id } = await f.sessions.create({ projectId: "p", title: "Beta auto" });
  const before = await types(f, id);
  await assert.rejects(f.sessions.send(id, { text: "continue", autoResume: true, hiddenUserMessage: true }), { code: "forbidden" });
  assert.equal(f.requests.length, 0);
  assert.equal((await f.store.projection(id))?.status, "idle");
  assert.deepEqual(await types(f, id), before);
});

test("without the beta gate a send starts a turn as usual", async (t) => {
  const f = fixture(false);
  t.after(() => { f.sessions.dispose(); return f.store.close(); });
  const { id } = await f.sessions.create({ projectId: "p", title: "Normal" });
  await f.sessions.send(id, { text: "hello" });
  assert.equal(f.requests.length, 1);
  assert.ok((await types(f, id)).includes("user/message"));
});
