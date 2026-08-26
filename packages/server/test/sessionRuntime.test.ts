import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  Project,
  SessionProjection,
} from "@polyth/contracts";
import { resolveSessionRuntimeBinding } from "../src/sessionRuntime.ts";

test("session runtime binding uses the parent session worktree cwd", async () => {
  const runtime = {} as AgentRuntime;
  const project: Project = {
    id: "project-1",
    name: "demo",
    path: "/repos/demo",
    createdAt: 1,
  };
  const projection: SessionProjection = {
    id: "session-1",
    projectId: project.id,
    title: "Worktree task",
    status: "idle",
    worktreePath: "/repos/demo-worktrees/fix",
    model: { providerID: "provider", modelID: "model" },
    agent: "build",
    createdAt: 1,
    updatedAt: 1,
  };
  const calls: Array<{ projectId: string; cwd?: string }> = [];

  const binding = await resolveSessionRuntimeBinding(projection.id, {
    store: { projection: async (sessionId) => sessionId === projection.id ? projection : undefined },
    projects: { get: async (projectId) => projectId === project.id ? project : undefined },
    runtimes: {
      forProject: async (projectId, cwd) => {
        calls.push({ projectId, cwd });
        return runtime;
      },
    },
  });

  assert.deepEqual(calls, [{
    projectId: project.id,
    cwd: projection.worktreePath,
  }]);
  assert.equal(binding.rt, runtime);
  assert.equal(binding.cwd, projection.worktreePath);
  assert.deepEqual(binding.model, projection.model);
  assert.equal(binding.agent, projection.agent);
});
