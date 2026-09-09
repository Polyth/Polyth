import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, HarnessProvider, SessionProjection } from "@polyth/contracts";
import { createHarnessPool, createHarnessRegistry } from "../src/index.ts";

const projection: SessionProjection = {
  id: "session-a",
  projectId: "project-a",
  title: "session",
  createdAt: 0,
  updatedAt: 0,
  status: "idle",
};

test("replacement runtime is reprovisioned before native construction with the same resolved context", async () => {
  const registry = createHarnessRegistry();
  const events: string[] = [];
  let created = 0;
  const provider: HarnessProvider = {
    descriptor: { id: "fixture", name: "Fixture", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "fixture", installed: true, authenticated: true, healthy: true }),
    createRuntime: async (context) => {
      created += 1;
      events.push(`create:${created}:${context.spaceId}:${context.projectId}:${context.sessionId}:${context.cwd}`);
      return { dispose: async () => { events.push(`dispose:${created}`); } } as AgentRuntime;
    },
  };
  registry.register(provider);
  const pool = createHarnessPool({
    registry,
    legacyHarnessId: "fixture",
    context: async (projectId, cwd, sessionId) => ({
      spaceId: "space-a",
      projectId,
      sessionId,
      cwd: cwd ?? "/workspace/a",
    }),
    beforeCreate: async (selected, context) => {
      events.push(`provision:${selected.descriptor.id}:${context.spaceId}:${context.projectId}:${context.sessionId}:${context.cwd}`);
    },
  });

  await pool.forSession({ ...projection, resolvedHarnessId: "fixture" }, "/workspace/a");
  await pool.retireSession(projection.id);
  await pool.forSession({ ...projection, resolvedHarnessId: "fixture" }, "/workspace/a");

  assert.deepEqual(events.filter((event) => event.startsWith("provision:")), [
    "provision:fixture:space-a:project-a:session-a:/workspace/a",
    "provision:fixture:space-a:project-a:session-a:/workspace/a",
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("create:")), [
    "create:1:space-a:project-a:session-a:/workspace/a",
    "create:2:space-a:project-a:session-a:/workspace/a",
  ]);
  assert.ok(events.indexOf("provision:fixture:space-a:project-a:session-a:/workspace/a")
    < events.indexOf("create:1:space-a:project-a:session-a:/workspace/a"));
  const secondProvision = events.lastIndexOf("provision:fixture:space-a:project-a:session-a:/workspace/a");
  assert.ok(secondProvision < events.indexOf("create:2:space-a:project-a:session-a:/workspace/a"));

  await pool.dispose();
});
