// Unit 2: Stop pressed during turn preparation must never reach the provider.
//
// The regression these tests exist for: `abort()` queues behind the same
// per-session lock that `admitTurn` holds for its entire pre-flight, so a Stop
// issued 1–2 s after submit only landed after the runtime request was already
// in flight. The fix is a lock-free latch checked immediately before dispatch.
//
// `hooks.beforeTurn` is a real preparation step (it runs after command
// expansion, model validation, workspace instructions and epoch planning, and
// before any durable append), so delaying it is a faithful stand-in for slow
// pre-flight I/O rather than a synthetic pause bolted onto the send path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentDescriptor,
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

/** A runtime that records every dispatched prompt so token spend is auditable. */
function recordingRuntime() {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const dispatched: string[] = [];
  const aborted: string[] = [];
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
      steering: false,
    }),
    models: async () => [],
    agents: async (): Promise<AgentDescriptor[]> => [],
    ensureSession: async (input) => `backend_${input.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (input) => {
      dispatched.push(input.text);
      emit(input.sessionId, { type: "turn/started", turnId: `turn_${input.sessionId}` });
    },
    abort: async (sessionId) => {
      aborted.push(sessionId);
      emit(sessionId, { type: "turn/stopped", reason: "aborted" });
    },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); } };
    },
    dispose: async () => {},
  };
  return { runtime, dispatched, aborted, emit };
}

async function makeApp(options: { prepareDelayMs?: number; recallDelayMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-early-abort-"));
  const projectRows: Project[] = [
    { id: "p1", path: join(dir, "one"), name: "One", createdAt: 1, spaceId: "space-1" },
  ];
  const projects: ProjectService = {
    list: async () => projectRows,
    get: async (id) => projectRows.find((row) => row.id === id),
    add: async () => projectRows[0]!,
    create: async () => projectRows[0]!,
    remove: async () => {},
  };
  const store = createStore(join(dir, "sessions.db"));
  const fake = recordingRuntime();
  const pool = { forProject: async () => fake.runtime, forSession: async () => fake.runtime };
  const permissions = {
    evaluate: () => "ask",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const prepareDelayMs = options.prepareDelayMs ?? 0;
  /** Resolved once preparation is known to be in flight. */
  let preparing: () => void = () => {};
  const preparingReached = new Promise<void>((resolve) => { preparing = resolve; });
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    runtimes: pool,
    broadcast,
    queue: store,
    org: store,
    ...(options.recallDelayMs !== undefined
      ? {
        // Recall runs after the durable user/message is prepared, so a Stop
        // during it can only be caught by the gate inside the claim.
        memory: {
          recall: async () => {
            preparing();
            await new Promise((resolve) => setTimeout(resolve, options.recallDelayMs));
            return {
              status: "empty" as const,
              selected: [],
              omittedCount: 0,
              estimate: { bytes: 0, estimated: true },
              dataRevision: "d1",
              settingsRevision: "s1",
              generation: "g1",
              digest: "x",
              reasons: [],
            };
          },
          checkFence: () => true,
        },
      }
      : {}),
    ...(prepareDelayMs > 0
      ? {
        hooks: {
          beforeTurn: async () => {
            preparing();
            // The artificial pre-flight window a real slow git/index read
            // would produce. `abort()` cannot take the session lock during it.
            await new Promise((resolve) => setTimeout(resolve, prepareDelayMs));
            return null;
          },
        },
      }
      : {}),
  });
  const session = await sessions.create({ projectId: "p1", title: "Stop race" });
  return {
    sessions,
    store,
    sessionId: session.id,
    dispatched: fake.dispatched,
    aborted: fake.aborted,
    waitForPreparation: () => preparingReached,
    close: async () => { await store.close(); },
  };
}

test("Stop during a slow turn preparation dispatches nothing to the provider", async () => {
  const app = await makeApp({ prepareDelayMs: 1000 });
  try {
    const send = app.sessions.send(app.sessionId, { text: "run the test suite" }).then(
      () => "resolved" as const,
      (error: Error & { code?: string; status?: number }) => `${error.code}:${error.status}`,
    );
    await app.waitForPreparation();
    // Stop arrives while preparation holds the per-session lock.
    await app.sessions.abort(app.sessionId, { source: "composer" });
    // 409, not a masked 500 the client would treat as an unknown outcome.
    assert.equal(await send, "turn-cancelled:409", "send must report an early cancel, not success");
    assert.deepEqual(app.dispatched, [], "0 tokens may be sent to the provider");
  } finally {
    await app.close();
  }
});

test("an early cancel leaves no user message in canonical history", async () => {
  const app = await makeApp({ prepareDelayMs: 1000 });
  try {
    const send = app.sessions.send(app.sessionId, { text: "run the test suite" }).catch(
      (error: Error & { code?: string }) => error.code,
    );
    await app.waitForPreparation();
    await app.sessions.abort(app.sessionId, { source: "composer" });
    await send;
    const events = await app.store.events(app.sessionId);
    assert.equal(
      events.filter((event) => event.type === "user/message").length,
      0,
      "a cancelled pre-dispatch turn must not log a prompt",
    );
    // A deliberate Stop is not a failure: no turn/failed either.
    assert.equal(events.some((event) => event.type === "turn/failed"), false);
    assert.deepEqual(app.dispatched, []);
  } finally {
    await app.close();
  }
});

test("the cancelled turn leaves no blocking durable operation behind", async () => {
  const app = await makeApp({ prepareDelayMs: 1000 });
  try {
    const send = app.sessions.send(app.sessionId, { text: "run the test suite" }).catch(
      (error: Error & { code?: string }) => error.code,
    );
    await app.waitForPreparation();
    await app.sessions.abort(app.sessionId, { source: "composer" });
    await send;
    // A stranded `unknown`/`prepared` turn-submit would block every later send
    // behind the reconciliation barrier.
    const blocking = (await app.store.operations(app.sessionId)).filter((operation) =>
      operation.mutationKind === "turn-submit"
      && ["prepared", "executing", "unknown", "fenced"].includes(operation.state));
    assert.deepEqual(blocking, [], `stranded operations: ${JSON.stringify(blocking)}`);
  } finally {
    await app.close();
  }
});

test("the session is not left in a working state", async () => {
  const app = await makeApp({ prepareDelayMs: 1000 });
  try {
    const send = app.sessions.send(app.sessionId, { text: "run the test suite" }).catch(
      (error: Error & { code?: string }) => error.code,
    );
    await app.waitForPreparation();
    await app.sessions.abort(app.sessionId, { source: "composer" });
    await send;
    const projection = await app.store.projection(app.sessionId);
    assert.notEqual(projection?.status, "working", "session must not be stuck working");
    assert.notEqual(projection?.status, "failed", "a user Stop is not a failure");
  } finally {
    await app.close();
  }
});

test("a prompt submitted right after an early abort runs normally", async () => {
  const app = await makeApp({ prepareDelayMs: 1000 });
  try {
    const first = app.sessions.send(app.sessionId, { text: "first prompt" }).catch(
      (error: Error & { code?: string }) => error.code,
    );
    await app.waitForPreparation();
    await app.sessions.abort(app.sessionId, { source: "composer" });
    assert.equal(await first, "turn-cancelled");

    // The latch must not survive into the next turn.
    await app.sessions.send(app.sessionId, { text: "second prompt" });
    assert.deepEqual(app.dispatched, ["second prompt"]);
    const userMessages = (await app.store.events(app.sessionId))
      .filter((event) => event.type === "user/message");
    assert.equal(userMessages.length, 1);
    assert.equal((userMessages[0]!.data as { text?: string }).text, "second prompt");
  } finally {
    await app.close();
  }
});

test("a prompt submitted without an interleaved Stop still dispatches", async () => {
  const app = await makeApp({ prepareDelayMs: 1000 });
  try {
    await app.sessions.send(app.sessionId, { text: "uninterrupted prompt" });
    assert.deepEqual(app.dispatched, ["uninterrupted prompt"]);
  } finally {
    await app.close();
  }
});

test("Stop after dispatch is an ordinary provider abort, not an early cancel", async () => {
  const app = await makeApp();
  try {
    await app.sessions.send(app.sessionId, { text: "streaming prompt" });
    assert.deepEqual(app.dispatched, ["streaming prompt"]);
    await app.sessions.abort(app.sessionId, { source: "composer" });
    assert.deepEqual(app.aborted, [app.sessionId]);
    // The prompt was already admitted, so it stays in history.
    const userMessages = (await app.store.events(app.sessionId))
      .filter((event) => event.type === "user/message");
    assert.equal(userMessages.length, 1);
  } finally {
    await app.close();
  }
});

test("Stop after the durable prepare is caught at the claim gate as a proven rejection", async () => {
  const app = await makeApp({ recallDelayMs: 1000 });
  try {
    const send = app.sessions.send(app.sessionId, { text: "remember this" }).then(
      () => "resolved",
      (error: Error & { code?: string; status?: number }) => `${error.code}:${error.status}`,
    );
    await app.waitForPreparation();
    await app.sessions.abort(app.sessionId, { source: "composer" });
    assert.equal(await send, "turn-cancelled:409");
    assert.deepEqual(app.dispatched, [], "the runtime must never be called");
    const submits = (await app.store.operations(app.sessionId))
      .filter((operation) => operation.mutationKind === "turn-submit");
    assert.deepEqual(submits.map((operation) => [operation.state, operation.code]), [["rejected", "turn-cancelled"]]);
    const events = await app.store.events(app.sessionId);
    assert.equal(events.some((event) => event.type === "turn/failed"), false);
    // The next prompt is not blocked by the cancelled one.
    await app.sessions.send(app.sessionId, { text: "next" });
    assert.deepEqual(app.dispatched.map((text) => text.endsWith("next")), [true]);
  } finally {
    await app.close();
  }
});
