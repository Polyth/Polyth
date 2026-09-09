import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentRuntime,
  HarnessSnapshot,
  Project,
  ProjectService,
} from "@polyth/contracts";
import type { RuntimePool } from "../src/sessions.ts";
import { createRuntimeCatalog } from "../src/runtimeCatalog.ts";

const projects = {
  list: async () => [{ id: "one", path: "/one", name: "one", createdAt: 1 }],
} as ProjectService;

const projectsOf = (items: Project[]) => ({ list: async () => items }) as ProjectService;

const snapshot = (
  harnessId: string,
  providerID: string,
  modelID: string,
  agent = "build",
  enabled = true,
): HarnessSnapshot => ({
  identity: { id: harnessId, name: harnessId, integration: "test" },
  availability: {
    harnessId,
    installed: true,
    authenticated: true,
    healthy: true,
    state: "ready",
    checkedAt: 1,
  },
  policy: { enabled, priority: 0, autoSelect: true },
  catalog: {
    models: [{ providerID, modelID, name: modelID }],
    agents: [{ name: agent, mode: "primary" }],
  },
  context: {
    spaceId: "space",
    projectId: "one",
    cwd: "/one",
    revision: "1",
    fetchedAt: 1,
  },
});

const summary = (harnessId: string, enabled = true): HarnessSnapshot => {
  const value = snapshot(harnessId, harnessId, "summary", "summary", enabled);
  return { ...value, catalog: undefined };
};

test("models and agents share one enabled-harness metadata load", async () => {
  const calls: string[] = [];
  const runtimes = {
    async harnessSnapshots(
      projectId: string,
      cwd?: string,
      options?: { harnessId?: string; detail?: boolean },
    ) {
      assert.equal(projectId, "one");
      assert.equal(cwd, "/one");
      if (!options?.harnessId) {
        calls.push("summary");
        return [summary("opencode"), summary("codex"), summary("claude", false)];
      }
      calls.push(`detail:${options.harnessId}`);
      assert.equal(options.detail, true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options.harnessId === "opencode") return [snapshot("opencode", "openai", "gpt")];
      if (options.harnessId === "codex") return [snapshot("codex", "openai", "codex")];
      throw new Error("disabled harness must not be detailed");
    },
    forProject: async () => { throw new Error("snapshot seam should own production catalog loading"); },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({ projects, runtimes });

  const [models, agents] = await Promise.all([catalog.models(), catalog.agents()]);
  assert.deepEqual(calls, ["summary", "detail:opencode", "detail:codex"]);
  assert.deepEqual(models.map((model) => model.harnessId).sort(), ["codex", "opencode"]);
  assert.deepEqual(agents.map((agent) => agent.harnessId).sort(), ["codex", "opencode"]);

  await catalog.models();
  await catalog.agents();
  assert.deepEqual(calls, ["summary", "detail:opencode", "detail:codex"], "warm metadata reads stay in memory");
});

test("snapshot catalog keeps same-name roles isolated by harness", async () => {
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("opencode"), summary("codex")];
      return options.harnessId === "opencode"
        ? [snapshot("opencode", "openai", "gpt", "build")]
        : [snapshot("codex", "openai", "codex", "build")];
    },
    forProject: async () => { throw new Error("unused"); },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({ projects, runtimes });

  await catalog.agents();
  catalog.patchAgent({ harnessId: "opencode", name: "build", mode: "subagent" });
  const agents = await catalog.agents();
  assert.equal(agents.find((agent) => agent.harnessId === "opencode")?.mode, "subagent");
  assert.equal(agents.find((agent) => agent.harnessId === "codex")?.mode, "primary");
});

test("model invalidation fences a stale in-flight detail response", async () => {
  let detailCalls = 0;
  let release!: () => void;
  const firstGate = new Promise<void>((resolve) => { release = resolve; });
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("opencode")];
      detailCalls += 1;
      if (detailCalls === 1) {
        await firstGate;
        return [snapshot("opencode", "old", "m")];
      }
      return [snapshot("opencode", "new", "m")];
    },
    forProject: async () => { throw new Error("unused"); },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({ projects, runtimes });

  const stale = catalog.models();
  await new Promise<void>((resolve) => setImmediate(resolve));
  catalog.invalidateModels();
  release();
  assert.equal((await stale)[0]?.providerID, "old", "the original caller may finish with its own response");

  const fresh = await catalog.models();
  assert.equal(fresh[0]?.providerID, "new");
  assert.equal(detailCalls, 2, "stale completion must not repopulate the invalidated model cache");
});

test("legacy runtime pools fall back to bounded project aggregation", async () => {
  let runtimeCalls = 0;
  const runtime = {
    harnessId: "opencode",
    models: async () => [{ providerID: "openai", modelID: "gpt", name: "GPT" }],
    agents: async () => [{ name: "build", mode: "primary" as const }],
  } as AgentRuntime;
  const runtimes = {
    forProject: async () => { runtimeCalls += 1; return runtime; },
  } as RuntimePool;
  const catalog = createRuntimeCatalog({
    projects: projectsOf([
      { id: "one", path: "/one", name: "one", createdAt: 1 },
      { id: "two", path: "/two", name: "two", createdAt: 1 },
      { id: "three", path: "/three", name: "three", createdAt: 1 },
    ]),
    runtimes,
  });

  assert.equal((await catalog.models())[0]?.harnessId, "opencode");
  assert.equal(runtimeCalls, 1, "fallback must not scale with unrelated Auto projects");
});
