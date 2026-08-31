import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, ProjectService } from "@polyth/contracts";
import { createRuntimeCatalog } from "../src/runtimeCatalog.ts";

const projects = {
  list: async () => [{ id: "one", path: "/one", name: "one", createdAt: 1 }],
} as ProjectService;

const projectsOf = (ids: string[]) =>
  ({ list: async () => ids.map((id) => ({ id, path: `/${id}`, name: id, createdAt: 1 })) }) as ProjectService;

test("runtime catalog single-flights and reuses expensive OpenCode discovery", async () => {
  let modelCalls = 0;
  let agentCalls = 0;
  const runtime = {
    models: async () => {
      modelCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ providerID: "commandcode", modelID: "fast", name: "Fast" }];
    },
    agents: async () => {
      agentCalls += 1;
      return [{ name: "build", mode: "primary" as const }];
    },
  } as AgentRuntime;
  const catalog = createRuntimeCatalog({
    projects,
    runtimes: { forProject: async () => runtime },
  });

  const [first, second] = await Promise.all([catalog.models(), catalog.models()]);
  assert.equal(first, second);
  await catalog.models();
  assert.equal(modelCalls, 1);

  await catalog.agents();
  await catalog.agents();
  assert.equal(agentCalls, 1);
  catalog.patchAgent({ name: "build", mode: "subagent", prompt: "Delegate." });
  assert.equal((await catalog.agents())[0]?.mode, "subagent");
});

test("a partial cold-boot fan-out is not frozen; the catalog re-aggregates until every project answers", async () => {
  let ready = false;
  const good = { models: async () => [{ providerID: "openai", modelID: "gpt", name: "GPT" }] } as AgentRuntime;
  const runtimes = {
    forProject: async (id: string) => {
      // "warming" starts unreachable (still spawning), then comes up.
      if (id === "warming" && !ready) throw new Error("runtime still spawning");
      return good;
    },
  };
  const catalog = createRuntimeCatalog({ projects: projectsOf(["stable", "warming"]), runtimes });

  const cold = await catalog.models();
  assert.deepEqual(cold.map((m) => m.providerID), ["openai"], "partial result is still returned");

  ready = true;
  const warm = await catalog.models();
  assert.deepEqual(warm.map((m) => m.providerID), ["openai"]);

  // Now that it cached a complete fan-out, later reads are frozen even if a
  // project goes away again.
  ready = false;
  const frozen = await catalog.models();
  assert.equal(frozen, warm, "a complete snapshot is reused for the server lifetime");
});

test("a fan-out that never completes is frozen after a bounded number of attempts", async () => {
  const good = { models: async () => [{ providerID: "opencode", modelID: "zen", name: "Zen" }] } as AgentRuntime;
  const runtimes = {
    forProject: async (id: string) => {
      if (id === "dead") throw new Error("SSH host unreachable");
      return good;
    },
  };
  const catalog = createRuntimeCatalog({ projects: projectsOf(["local", "dead"]), runtimes });

  let last: unknown;
  for (let i = 0; i < 8; i += 1) last = await catalog.models();
  const afterCap = await catalog.models();
  assert.equal(afterCap, last, "stops re-fanning-out once the retry cap is hit");
});
