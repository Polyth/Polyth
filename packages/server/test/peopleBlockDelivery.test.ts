// The model learns who is speaking from a block persisted before delivery, and a
// retried operation resends exactly what was recorded (Spaces §14.6).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRuntime, CanonicalTurnRequest, ProjectService, RuntimeCapabilities } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { createSessionService, type MemoryRuntimeService } from "../src/sessions.ts";

function fixture(t: test.TestContext, memory?: MemoryRuntimeService, options: { steering?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "polyth-people-block-"));
  const security = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true });
  security.control.transaction(() => {
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    for (const [id, name, role] of [["usr_olia", "Оля", "owner"], ["usr_taras", "Тарас", "member"]] as const) {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home',?,?,1)", id, role);
    }
    security.control.run(`INSERT INTO resources(id,kind,org_id,space_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
      VALUES('p','project','org_home','spc_home','usr_olia','usr_olia','space','active',1,1)`);
  });
  const binding = bindCanonicalSecurity(security);
  t.after(() => { binding.dispose(); security.close(); rmSync(root, { recursive: true, force: true }); });

  const store = createStore(":memory:");
  const requests: CanonicalTurnRequest[] = [];
  const steered: string[] = [];
  const runtime = {
    harnessId: "fake",
    capabilities: async () => ({ steering: options.steering === true, streaming: true, permissions: false, questions: false, compaction: false, subagents: false }) as RuntimeCapabilities,
    commands: async () => [],
    models: async () => [],
    agents: async () => [],
    ensureSession: async ({ sessionId }: { sessionId: string }) => `native-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    async startTurn(request: CanonicalTurnRequest) { requests.push(request); },
    ...(options.steering ? { steer: async (_sessionId: string, text: string) => { steered.push(text); return true; } } : {}),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent: () => ({ dispose: () => {} }),
    dispose: async () => {},
  } as unknown as AgentRuntime;
  const projects = {
    get: async (id: string) => id === "p" ? { id: "p", name: "p", path: "/tmp", spaceId: "spc_home", createdAt: 0 } : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store,
    projects,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    ...(memory ? { memory } : {}),
    queue: store,
    harnesses: {
      staticFeatures: () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }),
    },
  } as never);
  const openResource = (id: string, visibility: string, owner = "usr_olia") => {
    security.control.transaction(() => security.control.run(`INSERT INTO resources(id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
      VALUES(?,'session','org_home','spc_home','p',?,?,?,'active',1,1)`, id, owner, owner, visibility));
  };
  return { sessions, store, requests, steered, openResource };
}

const OLIA = { userId: "usr_olia", name: "Оля" };

test("a turn tells the model who speaks and who reads, before the prompt leaves", async (t) => {
  const f = fixture(t);
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  f.openResource(id, "inherit");
  await f.sessions.send(id, { text: "Що на вечерю?", clientOperationId: "op-1" }, { author: OLIA });
  const events = await f.store.events(id);
  const prepared = events.find((event) => event.type === "context/people-prepared")!;
  assert.ok(prepared, "persisted");
  const block = (prepared.data as { modelVisibleText: string }).modelVisibleText;
  assert.match(block, /Speaking now: "Оля"/);
  assert.match(block, /read by: "Оля", "Тарас"/);
  assert.match(block, /shared project memory only/);
  assert.ok(f.requests[0]!.text.includes(block), "delivered exactly as recorded");
});

test("a private chat says only its owner reads it", async (t) => {
  const f = fixture(t);
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  f.openResource(id, "private");
  await f.sessions.send(id, { text: "Мої аналізи", clientOperationId: "op-1" }, { author: OLIA });
  assert.match(f.requests[0]!.text, /Only "Оля" can read this chat/);
  assert.match(f.requests[0]!.text, /personal notes/);
});

test("a personal note reaching the model marks the chat before delivery", async (t) => {
  const contribution = {
    status: "selected", selected: [{ memoryId: "m1", revision: 1, digest: "d", reason: "fts", text: "Feritin", layer: "person" }],
    modelVisibleText: "<polyth-project-memory>[m1 rev 1 · personal]\nFerritin\n</polyth-project-memory>",
    omittedCount: 0, estimate: { bytes: 1, estimated: true }, dataRevision: "1", settingsRevision: "1", generation: "g", digest: "d", reasons: [],
  };
  const f = fixture(t, { recall: () => contribution, checkFence: () => true } as never);
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  f.openResource(id, "private");
  assert.equal((await f.store.projection(id))?.personalContext, undefined);
  await f.sessions.send(id, { text: "Ferritin?", clientOperationId: "op-1" }, { author: OLIA });
  assert.equal((await f.store.projection(id))?.personalContext, true);
});

test("one person's Space gets no block", async (t) => {
  const f = fixture(t);
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "Hello", clientOperationId: "op-1" });
  // No canonical row for this chat: nothing says who reads it, so nothing is claimed.
  assert.ok(!f.requests[0]!.text.includes("<polyth-people>"));
});

test("someone joining another person's running turn is named, and the line is recorded first", async (t) => {
  const f = fixture(t, undefined, { steering: true });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  f.openResource(id, "inherit");
  await f.sessions.send(id, { text: "Що на вечерю?", clientOperationId: "op-1" }, { author: OLIA });
  await new Promise((resolve) => setImmediate(resolve));
  await f.sessions.send(id, { text: "Без горіхів", delivery: "steer" }, { author: { userId: "usr_taras", name: "Тарас" } });
  assert.equal(f.steered.length, 1);
  assert.match(f.steered[0]!, /Speaking now: "Тарас"/);
  assert.ok(f.steered[0]!.endsWith("Без горіхів"), "the person's words arrive unchanged");
  const events = await f.store.events(id);
  const message = events.find((event) => event.type === "user/message" && (event.data as { delivery?: unknown }).delivery === "steer")!;
  assert.equal((message.data as { text: string }).text, "Без горіхів", "history keeps the plain words");
  assert.equal((message.data as { author: { userId: string } }).author.userId, "usr_taras");
  const line = events.filter((event) => event.type === "context/people-prepared").at(-1)!;
  assert.ok(f.steered[0]!.startsWith((line.data as { modelVisibleText: string }).modelVisibleText));
});

test("a turn's own person steering it, or a chat with one reader, adds nothing", async (t) => {
  const f = fixture(t, undefined, { steering: true });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  f.openResource(id, "inherit");
  await f.sessions.send(id, { text: "Що на вечерю?", clientOperationId: "op-1" }, { author: OLIA });
  await new Promise((resolve) => setImmediate(resolve));
  await f.sessions.send(id, { text: "Швидко", delivery: "steer" }, { author: OLIA });
  assert.deepEqual(f.steered, ["Швидко"]);

  const own = await f.sessions.create({ projectId: "p", title: "Own" });
  f.openResource(own.id, "private");
  await f.sessions.send(own.id, { text: "Мої аналізи", clientOperationId: "op-2" }, { author: OLIA });
  await new Promise((resolve) => setImmediate(resolve));
  await f.sessions.send(own.id, { text: "Ще одне", delivery: "steer" }, { author: { userId: "usr_taras", name: "Тарас" } });
  assert.equal(f.steered.at(-1), "Ще одне");
});
