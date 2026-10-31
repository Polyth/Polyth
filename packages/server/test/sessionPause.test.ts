import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentRuntime, RuntimeEvent, SessionEvent } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import type { PermissionService } from "@polyth/permissions";
import { PAUSE_CONTINUE_PROMPT, createSessionService } from "../src/sessions.ts";

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-pause-"));
  const store = createStore(join(dir, "sessions.db"));
  const listeners = new Set<(id: string, event: RuntimeEvent) => void>();
  const emit = (id: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(id, event);
  };
  const prompts: string[] = [];
  let turns = 0;
  const runtime: AgentRuntime = {
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false }),
    models: async () => [], agents: async () => [],
    ensureSession: async (input) => `backend-${input.sessionId}`,
    sessions: async () => [], history: async () => [],
    startTurn: async (input) => {
      prompts.push(input.text);
      emit(input.sessionId, { type: "turn/started", turnId: `turn-${++turns}` });
    },
    // The runtime never reports the stop: Stop's local fallback records it.
    abort: async () => {}, replyPermission: async () => {}, replyQuestion: async () => {},
    onEvent(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    dispose: async () => {},
  };
  const project = { id: "project-pause", name: "Pause", path: dir, spaceId: "space-pause", createdAt: 1 };
  const ended: Array<{ sessionId: string; outcome: string }> = [];
  const sessions = createSessionService({
    store, queue: store,
    projects: {
      get: async (id) => id === project.id ? project : undefined,
      list: async () => [project], add: async () => project,
      create: async () => project, remove: async () => {},
    },
    permissions: { evaluate: () => "allow", addRule() {}, rules: () => [] } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    runtimes: { forProject: async () => runtime },
    notify: {
      attention() {},
      turnStopped() {},
      pauseEnded(sessionId, outcome) { ended.push({ sessionId, outcome }); },
    },
  });
  t.after(async () => {
    sessions.dispose();
    await store.close();
  });
  return { store, sessions, emit, prompts, ended, project };
}

const ofType = (events: readonly SessionEvent[], type: string) => events.filter((event) => event.type === type);

/** The runtime's events reach the service asynchronously. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function running(h: ReturnType<typeof harness>, text = "do the delegated work", id?: string) {
  const sessionId = id ?? (await h.sessions.create({ projectId: h.project.id, title: "child" })).id;
  await h.sessions.send(sessionId, { text });
  await until(async () => (await h.store.projection(sessionId))?.status === "working", "the turn to start");
  return sessionId;
}

test("Pause records a paused stop and Continue picks the work up on the same history", async (t) => {
  const h = harness(t);
  const id = await running(h);

  await h.sessions.pause!(id, { source: "subagent-dock" });
  const events = await h.store.events(id);
  const request = ofType(events, "turn/abort-requested").at(-1);
  assert.deepEqual(request?.data, { reason: "user", source: "subagent-dock", pause: true });
  const stop = ofType(events, "turn/stopped").at(-1);
  assert.equal(stop?.data.reason, "aborted", "old readers still read an interrupted turn");
  assert.equal(stop?.data.paused, true);
  const paused = await h.store.projection(id);
  assert.equal(paused?.status, "idle");
  assert.deepEqual(paused?.paused, { at: stop!.time, stopSeq: stop!.seq });

  // Pausing again changes nothing; a keep-alive would lift the held queue.
  await h.sessions.pause!(id);
  assert.equal(ofType(await h.store.events(id), "turn/abort-requested").length, 1);
  await assert.rejects(h.sessions.send(id, { text: "ok", keepAlive: true }), /paused session/);

  await h.sessions.continuePaused!(id);
  await until(async () => (await h.store.projection(id))?.status === "working", "the continued turn");
  const after = await h.store.events(id);
  const ended = ofType(after, "session/pause-ended");
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0]!.data, { outcome: "continued", stopSeq: stop!.seq });
  const resumed = ofType(after, "user/message").at(-1);
  assert.equal(resumed?.data.text, PAUSE_CONTINUE_PROMPT);
  assert.equal(resumed?.data.autoResume, true, "the continuation is hidden from chat bubbles");
  assert.equal(h.prompts.at(-1), PAUSE_CONTINUE_PROMPT);
  const continued = await h.store.projection(id);
  assert.equal(continued?.paused, undefined);
  assert.equal(continued?.status, "working");
  assert.deepEqual(h.ended, [{ sessionId: id, outcome: "continued" }]);

  await assert.rejects(h.sessions.continuePaused!(id), /not paused/);
});

test("Stop on a paused session ends the pause for good", async (t) => {
  const h = harness(t);
  const id = await running(h);
  await h.sessions.pause!(id);

  await h.sessions.abort(id, { source: "subagent-dock" });
  const events = await h.store.events(id);
  assert.equal(ofType(events, "turn/stopped").length, 1, "the paused stop stays the only stop");
  assert.deepEqual(ofType(events, "session/pause-ended").map((event) => event.data.outcome), ["stopped"]);
  assert.equal((await h.store.projection(id))?.paused, undefined);
  assert.deepEqual(h.ended, [{ sessionId: id, outcome: "stopped" }]);
});

test("a plain Stop after Pause wins, and nothing idle can be paused", async (t) => {
  const h = harness(t);
  const idle = await h.sessions.create({ projectId: h.project.id, title: "idle" });
  await assert.rejects(h.sessions.pause!(idle.id), /nothing is running/);

  const id = await running(h);
  await h.sessions.abort(id);
  const stop = ofType(await h.store.events(id), "turn/stopped").at(-1);
  assert.equal(stop?.data.paused, undefined);
  assert.equal((await h.store.projection(id))?.paused, undefined);
});

test("a person writing to a paused chat continues it", async (t) => {
  const h = harness(t);
  const id = await running(h);
  await h.sessions.pause!(id);

  await running(h, "carry on, but skip the tests", id);
  assert.deepEqual(ofType(await h.store.events(id), "session/pause-ended").map((event) => event.data.outcome), ["continued"]);
  assert.equal((await h.store.projection(id))?.paused, undefined);
  assert.equal(h.prompts.at(-1), "carry on, but skip the tests");
});

test("a paused session holds its queue until Continue, which runs ahead of it", async (t) => {
  const h = harness(t);
  const id = await running(h);
  const queued = await h.sessions.send(id, { text: "the next step" });
  assert.equal(queued.queued, true, "a message sent while it works waits in the queue");

  await h.sessions.pause!(id);
  // Like a Stop, the pause holds what was queued before it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((await h.store.projection(id))?.paused, "the queue does not lift the pause");
  assert.equal(ofType(await h.store.events(id), "user/message").length, 1, "the queued message waits");

  await h.sessions.continuePaused!(id);
  await until(async () => (await h.store.projection(id))?.status === "working", "the continued turn");
  assert.equal(h.prompts.at(-1), PAUSE_CONTINUE_PROMPT, "Continue picks the paused work up first");
  assert.equal((await h.store.projection(id))?.paused, undefined);
  assert.deepEqual((await h.store.queueList(id)).map((item) => item.text), ["the next step"],
    "the follow-up waits for the continued work");
  assert.deepEqual((await h.store.queueList(id)).map((item) => item.text), ["the next step"],
    "the follow-up waits for the continued work");
});

test("automatic hidden work waits behind a pause instead of continuing it", async (t) => {
  const h = harness(t);
  const id = await running(h);
  await h.sessions.pause!(id);

  // A harness's background wake or a delegated request is hidden work.
  const wake = await h.sessions.send(id, { text: "[polyth] background task finished", hiddenUserMessage: true });
  assert.equal(wake.queued, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((await h.store.projection(id))?.paused, "the person's pause stands");
  assert.equal(h.prompts.length, 1, "nothing reached the runtime");

  // Stop ends the pause; the held wake is then as after any Stop.
  await h.sessions.abort(id);
  await until(async () => h.prompts.length === 2, "the held wake after Stop");
  assert.equal(h.prompts.at(-1), "[polyth] background task finished");
});
