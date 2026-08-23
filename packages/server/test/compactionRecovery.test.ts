import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEvent,
  SessionService,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import {
  activePinnedMessages,
  compactionRecoveryText,
  createStore,
  unrestoredCompactionSeq,
} from "@polyth/session";
import { contextRoutes } from "../src/routes/context.ts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Emit = (sessionId: string, event: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const turns: Array<{ sessionId: string; text: string }> = [];
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: true, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => input.backendSessionId ?? `backend_${input.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      turns.push({ sessionId: request.sessionId, text: request.text });
      emit(request.sessionId, { type: "turn/started", turnId: `turn_${turns.length}` });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: async () => {},
  };
  return { runtime, turns, emit };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

test("next admitted turn restores active goal and pins once per compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-compaction-"));
  const store = createStore(join(dir, "sessions.db"));
  const fake = fakeRuntime();
  const project: Project = { id: "p1", name: "P", path: dir, createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    runtimes: { forProject: async () => fake.runtime },
    hooks: {
      beforeTurn: async (_sessionId, events) => {
        const compactionSeq = unrestoredCompactionSeq(events);
        if (compactionSeq === null) return null;
        const pinned = activePinnedMessages(events);
        return {
          recoveryContext: compactionRecoveryText({
            compactionSeq,
            objective: "Ship compaction resilience",
            pinned,
          }),
          compactionSeq,
          goalRestored: true,
          pinnedSourceSeqs: pinned.map((item) => item.sourceEventSeq),
        };
      },
    },
  });

  try {
    const { id } = await sessions.create({ projectId: project.id });
    await sessions.send(id, { text: "Remember the API contract" });
    await flush();
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    const source = (await store.events(id)).find((event) => event.type === "user/message")!;
    await sessions.pinContext!(id, source.seq);

    fake.emit(id, {
      type: "compaction/part-recorded",
      partId: "part_compaction",
      messageId: "message_summary",
      auto: true,
    });
    fake.emit(id, { type: "session/compacted", backendEventId: "evt_compacted" });
    await flush();

    await sessions.send(id, { text: "Continue now" });
    await flush();
    assert.match(fake.turns[1]!.text, /Ship compaction resilience/);
    assert.match(fake.turns[1]!.text, /Remember the API contract/);
    assert.match(fake.turns[1]!.text, /\n\nContinue now$/);

    let events = await store.events(id);
    const recovered = events.filter((event) => event.type === "user/message")[1]!;
    assert.equal(
      (recovered.data as { text?: string }).text,
      "Continue now",
      "visible message text stays undecorated",
    );
    const compaction = events.find((event) => event.type === "session/compacted")!;
    assert.equal(
      (recovered.data as { compactionRecovery?: { compactionSeq?: number } })
        .compactionRecovery?.compactionSeq,
      compaction.seq,
    );
    assert.equal(events.filter((event) => event.type === "goal/context-restored").length, 1);
    assert.equal(events.filter((event) => event.type === "context/restored").length, 1);
    assert.equal(events.filter((event) => event.type === "compaction/part-recorded").length, 1);

    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    await sessions.send(id, { text: "No duplicate" });
    await flush();
    assert.equal(fake.turns[2]!.text, "No duplicate");
    events = await store.events(id);
    assert.equal(events.filter((event) => event.type === "goal/context-restored").length, 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context route delegates pin and unpin by source event sequence", async () => {
  const calls: string[] = [];
  const sessions = {
    pinContext: async (_sessionId: string, seq: number) => {
      calls.push(`pin:${seq}`);
      return { id: "e1", sessionId: "s1", seq: 4, time: 1, type: "context/pinned", data: { sourceEventSeq: seq }, v: 1 as const };
    },
    unpinContext: async (_sessionId: string, seq: number) => {
      calls.push(`unpin:${seq}`);
      return { id: "e2", sessionId: "s1", seq: 5, time: 2, type: "context/unpinned", data: { sourceEventSeq: seq }, v: 1 as const };
    },
  } as SessionService;
  const route = contextRoutes(sessions);
  let response: unknown;
  const base = {
    req: {} as never,
    res: {} as never,
    url: new URL("http://local"),
    body: async () => ({}),
    json: (_code: number, value: unknown) => { response = value; },
  };
  assert.equal(await route({ ...base, path: "/api/sessions/s1/context/pins/3", method: "POST" }), true);
  assert.equal((response as { type: string }).type, "context/pinned");
  assert.equal(await route({ ...base, path: "/api/sessions/s1/context/pins/3", method: "DELETE" }), true);
  assert.deepEqual(calls, ["pin:3", "unpin:3"]);
});
