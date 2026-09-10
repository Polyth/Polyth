import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { registerCoachCapabilities } from "../src/capabilities.ts";
import { buildCoachContext, COACH_CONTEXT_MAX_CHARS } from "../src/context.ts";
import { createCoachStore } from "../src/index.ts";

const fresh = () => createCoachStore(join(mkdtempSync(join(tmpdir(), "polyth-coach-cap-")), "coach.db"));
const projectId = "__polyth_pkg_0123456789abcdef0123456789abcdef";
const context = {
  spaceId: "space-a",
  projectId,
  cwd: "/tmp/space-a/packages/personal-coach/workspace",
};

test("Coach capabilities resolve only on their package workspace project", async () => {
  const store = fresh();
  const registry = createCapabilityContributionRegistry();
  const set = registerCoachCapabilities({
    registry,
    space: { spaceId: "space-a" },
    projectId,
    store,
  });

  const resolved = registry.resolve(context);
  assert.ok(resolved.some((item) => item.kind === "instruction"));
  assert.ok(resolved.some((item) => item.kind === "tool" && item.name === "coach_read_context"));
  assert.equal(registry.resolve({ ...context, projectId: "ordinary-project" }).length, 0);
  assert.equal(registry.resolve({ ...context, spaceId: "space-b" }).length, 0);
  assert.equal(new Set(set.ids).size, set.ids.length);

  await set.dispose();
  assert.equal(registry.resolve(context).length, 0);
  store.close();
});

test("read context is bounded valid JSON and proposals do not silently mutate goals", async () => {
  const store = fresh();
  store.createGoal({ title: "Existing goal", priority: 3 });
  for (let i = 0; i < 10; i++) {
    store.recordReflection({ text: `Reflection ${i}: ${"x".repeat(7_000)}` });
  }
  const registry = createCapabilityContributionRegistry();
  const set = registerCoachCapabilities({ registry, space: { spaceId: "space-a" }, projectId, store });
  const read = registry.resolve(context).find((item) => item.kind === "tool" && item.name === "coach_read_context")!;
  const readResult = await registry.executor(read.id)!({}, { sessionId: "s1", ...context });
  assert.ok(readResult.output.length <= COACH_CONTEXT_MAX_CHARS);
  assert.doesNotThrow(() => JSON.parse(readResult.output));

  const propose = registry.resolve(context).find((item) => item.kind === "tool" && item.name === "coach_propose_goal")!;
  const beforeGoals = store.listGoals().length;
  const result = await registry.executor(propose.id)!({
    title: "New proposed goal",
    desiredOutcome: "Observable outcome",
    priority: 2,
  }, { sessionId: "s1", ...context });
  const proposal = JSON.parse(result.output) as { status: string; type: string };
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.type, "goal");
  assert.equal(store.listGoals().length, beforeGoals, "proposal must not create a goal");
  assert.equal(store.listProposals("pending").length, 1);

  await set.dispose();
  store.close();
});

test("deterministic mutation tools are target-guarded", async () => {
  const store = fresh();
  const commitment = store.createCommitment({ title: "Finish API" });
  const registry = createCapabilityContributionRegistry();
  const set = registerCoachCapabilities({ registry, space: { spaceId: "space-a" }, projectId, store });
  const complete = registry.resolve(context).find((item) => item.kind === "tool" && item.name === "coach_complete_commitment")!;
  const execute = registry.executor(complete.id)!;

  await assert.rejects(
    () => execute({ id: commitment.id }, { sessionId: "s1", ...context, projectId: "ordinary-project" }),
    (cause: Error & { code?: string }) => cause.code === "forbidden",
  );
  assert.equal(store.getCommitment(commitment.id)?.status, "open");

  await execute({ id: commitment.id }, { sessionId: "s1", ...context });
  assert.equal(store.getCommitment(commitment.id)?.status, "done");

  await set.dispose();
  store.close();
});
