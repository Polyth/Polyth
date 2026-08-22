import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, ProjectService } from "@polyth/contracts";
import { createRuntimeCatalog } from "../src/runtimeCatalog.ts";

const projects = {
  list: async () => [{ id: "one", path: "/one", name: "one", createdAt: 1 }],
} as ProjectService;

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
