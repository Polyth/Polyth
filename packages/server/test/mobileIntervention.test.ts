import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, JsonObject, Project, ProjectService, SessionProjection } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

test("mobile interventions reattach, stay session-bound, and resolve each request once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-mobile-intervention-"));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "p1", name: "Project", path: dir, createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => undefined,
  };
  const ensureCalls: Array<{ sessionId: string; backendSessionId?: string }> = [];
  const permissionReplies: Array<{ sessionId: string; requestId: string; reply: string; logged: boolean }> = [];
  const questionReplies: Array<{ sessionId: string; requestId: string; answers: JsonObject; logged: boolean }> = [];
  const runtime: AgentRuntime = {
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: true }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => {
      ensureCalls.push({ sessionId: input.sessionId, backendSessionId: input.backendSessionId });
      return input.backendSessionId ?? `backend-${input.sessionId}`;
    },
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => undefined,
    abort: async () => undefined,
    replyPermission: async (sessionId, requestId, reply) => {
      const events = await store.events(sessionId);
      permissionReplies.push({
        sessionId,
        requestId,
        reply,
        logged: events.some((event) =>
          event.type === "permission/resolved"
          && (event.data as { requestId?: string }).requestId === requestId),
      });
    },
    replyQuestion: async (sessionId, requestId, answers) => {
      const events = await store.events(sessionId);
      questionReplies.push({
        sessionId,
        requestId,
        answers,
        logged: events.some((event) =>
          event.type === "question/answered"
          && (event.data as { requestId?: string }).requestId === requestId),
      });
    },
    onEvent: () => ({ dispose: () => undefined }),
    dispose: async () => undefined,
  };
  const permissions = {
    evaluate: () => "ask",
    addRule: () => undefined,
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => undefined, projection: () => undefined };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    runtimes: { forProject: async () => runtime },
  });

  const projection = (id: string): SessionProjection => ({
    id,
    projectId: project.id,
    backendSessionId: `backend-${id}`,
    title: id,
    status: "waiting",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.upsertProjection(projection("original"));
  await store.upsertProjection(projection("other"));
  await store.append("original", "permission/requested", {
    requestId: "per_1",
    permission: "edit",
    patterns: ["src/*"],
  }, { ignorable: true });
  await store.append("original", "question/asked", {
    requestId: "que_1",
    questions: [{ id: "choice", prompt: "Continue?", options: ["yes", "no"] }],
  }, { ignorable: true });

  await assert.rejects(
    () => sessions.replyPermission("other", "per_1", "once"),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
  assert.equal((await store.events("other")).some((event) => event.type === "permission/resolved"), false);

  await sessions.replyPermission("original", "per_1", "once");
  assert.deepEqual(ensureCalls, [{ sessionId: "original", backendSessionId: "backend-original" }]);
  assert.deepEqual(permissionReplies, [{
    sessionId: "original", requestId: "per_1", reply: "once", logged: true,
  }]);
  assert.equal((await store.projection("original"))?.status, "waiting", "the open question still blocks the session");
  await assert.rejects(
    () => sessions.replyPermission("original", "per_1", "reject"),
    (error: Error & { code?: string }) => error.code === "conflict",
  );

  const results = await Promise.allSettled([
    sessions.replyQuestion("original", "que_1", { choice: "yes" }),
    sessions.replyQuestion("original", "que_1", { choice: "no" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal((rejected?.reason as { code?: string }).code, "conflict");
  assert.equal(questionReplies.length, 1);
  assert.equal(questionReplies[0]!.logged, true, "durable answer precedes the runtime reply");
  assert.equal((await store.events("original")).filter((event) => event.type === "question/answered").length, 1);
  assert.equal((await store.projection("original"))?.status, "working");

  await store.close();
});
