import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntime, Project, ProjectService, RuntimeEvent } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
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

test("package context appended between turns reaches the next prompt once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-package-context-"));
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
  const permissions = { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast,
    runtimes: { forProject: async () => fake.runtime },
  });
  try {
    const { id } = await sessions.create({ projectId: project.id });
    await sessions.send(id, { text: "Plan the change" });
    await flush();
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    assert.equal(fake.turns[0]!.text, "Plan the change");

    // A workflow launched from this chat settles between turns.
    await store.append(id, "package/context", {
      packageId: "workflow",
      sourceId: "run:r1",
      title: "Workflow \"Review\" result",
      text: "Status: done\n\nResult:\nReviewer found no blocking issues.",
    });
    await sessions.send(id, { text: "Apply the review" });
    await flush();
    assert.match(fake.turns[1]!.text, /<polyth-package-context>/);
    assert.match(fake.turns[1]!.text, /Reviewer found no blocking issues\./);
    assert.match(fake.turns[1]!.text, /\n\nApply the review$/);
    const prompt = (await store.events(id)).filter((event) => event.type === "user/message")[1]!;
    assert.equal((prompt.data as { text?: string }).text, "Apply the review", "visible text stays undecorated");
    assert.match(String((prompt.data as { recoveryContext?: string }).recoveryContext), /Reviewer found no blocking issues/);

    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();
    await sessions.send(id, { text: "Thanks" });
    await flush();
    assert.equal(fake.turns[2]!.text, "Thanks");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
