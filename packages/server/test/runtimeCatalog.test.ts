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

test("model context enrichment is refreshed without overriding native metadata", async () => {
  let enrichCalls = 0;
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("commandcode")];
      return [{
        ...snapshot("commandcode", "command-code", "gpt-5.6-sol"),
        catalog: {
          models: [
            { providerID: "command-code", modelID: "gpt-5.6-sol", name: "GPT" },
            { providerID: "command-code", modelID: "native", name: "Native", context: 42 },
          ],
          agents: [],
        },
      }];
    },
    forProject: async () => { throw new Error("unused"); },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({
    projects,
    runtimes,
    enrichModels: async (models) => {
      enrichCalls += 1;
      return models.map((model) => model.context === undefined ? { ...model, context: 1_050_000 } : model);
    },
  });

  assert.deepEqual((await catalog.models()).map((model) => model.context), [1_050_000, 42]);
  await catalog.models();
  assert.equal(enrichCalls, 2, "the enrichment owner decides freshness for each catalog read");
});

test("duplicate model rows retain a native denominator only when metadata agrees", async () => {
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("commandcode")];
      return [{
        ...snapshot("commandcode", "command-code", "gpt"),
        catalog: {
          models: [
            { providerID: "command-code", modelID: "gpt", name: "GPT" },
            { providerID: "command-code", modelID: "gpt", name: "GPT", context: 200_000 },
            { providerID: "command-code", modelID: "clash", name: "Clash", context: 100_000 },
            { providerID: "command-code", modelID: "clash", name: "Clash", context: 300_000 },
          ],
          agents: [],
        },
      }];
    },
    forProject: async () => { throw new Error("unused"); },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({ projects, runtimes });
  const models = await catalog.models();
  assert.equal(models.find((model) => model.modelID === "gpt")?.context, 200_000);
  assert.equal(models.find((model) => model.modelID === "clash")?.context, undefined);
});

test("cached native models reconsult expiring context metadata without repeating discovery", async () => {
  let detailCalls = 0;
  let expired = false;
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("commandcode")];
      detailCalls += 1;
      return [snapshot("commandcode", "command-code", "gpt")];
    },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({
    projects,
    runtimes,
    enrichModels: async (models) => models.map((model) => expired ? model : { ...model, context: 128_000 }),
  });
  assert.equal((await catalog.models())[0]?.context, 128_000);
  expired = true;
  assert.equal((await catalog.models())[0]?.context, undefined, "expired fallback must not become permanent native metadata");
  assert.equal(detailCalls, 1, "native discovery remains cached independently of public metadata");
});

test("native context conflicts survive enrichment while missing/native duplicates prefer native", async () => {
  let enrichCalls = 0;
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("commandcode")];
      return [{
        ...snapshot("commandcode", "command-code", "gpt"),
        catalog: {
          models: [
            { providerID: "command-code", modelID: "known", name: "Known" },
            { providerID: "command-code", modelID: "known", name: "Known", context: 128_000 },
            { providerID: "command-code", modelID: "blocked", name: "Blocked", context: 90_000, contextStatus: "conflict" },
            { providerID: "command-code", modelID: "blocked", name: "Blocked" },
            { providerID: "command-code", modelID: "missing", name: "Missing" },
          ],
          agents: [],
        },
      }];
    },
    forProject: async () => { throw new Error("unused"); },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({
    projects,
    runtimes,
    enrichModels: async (models) => {
      enrichCalls += 1;
      return models.map((model) => model.context === undefined ? { ...model, context: 1_000_000 } : model);
    },
  });
  const models = await catalog.models();
  assert.equal(models.find((model) => model.modelID === "known")?.context, 128_000);
  assert.equal(models.find((model) => model.modelID === "blocked")?.context, undefined);
  assert.equal(models.find((model) => model.modelID === "blocked")?.contextStatus, "conflict");
  assert.equal(models.find((model) => model.modelID === "missing")?.context, 1_000_000);
  assert.equal(enrichCalls, 1);
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

test("a bounded-age read re-reads an old server copy; ordinary reads keep it", async () => {
  let detailCalls = 0;
  let modelID = "opus-before-update";
  let clock = 1_000;
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("claude")];
      detailCalls += 1;
      return [snapshot("claude", "anthropic", modelID)];
    },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({ projects, runtimes, now: () => clock });
  const ids = async (options?: { maxAgeMs?: number }) => (await catalog.models(options)).map((model) => model.modelID);

  assert.deepEqual(await ids(), ["opus-before-update"]);
  // The harness updated; nothing invalidated the server copy.
  modelID = "opus-after-update";
  clock += 30_000;
  assert.deepEqual(await ids({ maxAgeMs: 60_000 }), ["opus-before-update"], "a young copy answers");
  assert.equal(detailCalls, 1);
  clock += 31_000;
  assert.deepEqual(await ids(), ["opus-before-update"], "ordinary reads keep the server-lifetime copy");
  assert.deepEqual(await ids({ maxAgeMs: 60_000 }), ["opus-after-update"], "an old copy is re-read first");
  assert.equal(detailCalls, 2);
  // The re-read refreshed the shared copy for every reader.
  assert.deepEqual(await ids(), ["opus-after-update"]);
  assert.equal(detailCalls, 2);
});

test("a copy built from a still-revalidating registry entry is re-read by the next bounded read", async () => {
  let revalidated = false;
  let detailCalls = 0;
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("claude")];
      detailCalls += 1;
      // The registry serves its last catalog while it revalidates in the background.
      return revalidated
        ? [snapshot("claude", "anthropic", "new")]
        : [{ ...snapshot("claude", "anthropic", "old"), stale: true }];
    },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({ projects, runtimes, now: () => 1_000 });
  const ids = async (options?: { maxAgeMs?: number }) => (await catalog.models(options)).map((model) => model.modelID);

  assert.deepEqual(await ids({ maxAgeMs: 60_000 }), ["old"]);
  revalidated = true;
  assert.deepEqual(await ids(), ["old"], "a partial copy still serves ordinary readers");
  assert.deepEqual(await ids({ maxAgeMs: 60_000 }), ["new"], "no time passed, but the copy was incomplete");
  assert.deepEqual(await ids({ maxAgeMs: 60_000 }), ["new"]);
  assert.equal(detailCalls, 2, "a complete copy inside the bound is not re-read");
});

test("a bounded re-read that finds nothing keeps the last good list", async () => {
  let down = false;
  let clock = 1_000;
  const runtimes = {
    harnessSnapshots: async (_projectId: string, _cwd?: string, options?: { harnessId?: string }) => {
      if (!options?.harnessId) return [summary("claude")];
      if (down) throw new Error("discovery unavailable");
      return [snapshot("claude", "anthropic", "kept")];
    },
  } as unknown as RuntimePool;
  const catalog = createRuntimeCatalog({ projects, runtimes, now: () => clock });
  assert.deepEqual((await catalog.models()).map((model) => model.modelID), ["kept"]);
  clock += 120_000;
  down = true;
  assert.deepEqual((await catalog.models({ maxAgeMs: 60_000 })).map((model) => model.modelID), ["kept"]);
});

test("a stale-model signal drops caches and forces one rediscovery per harness window", async () => {
  const calls: string[] = [];
  let modelID = "retired";
  const runtimes = {
    async harnessSnapshots(projectId: string, _cwd?: string, options?: { harnessId?: string; force?: boolean; detail?: boolean }) {
      if (!options?.harnessId) return [summary("opencode")];
      calls.push(`${projectId}:${options.harnessId}:${options.force ? "force" : "cached"}`);
      return [snapshot("opencode", "openai", modelID)];
    },
  } as unknown as RuntimePool;
  const invalidated: string[] = [];
  let clock = 1_000;
  const catalog = createRuntimeCatalog({
    projects,
    runtimes,
    invalidateHarness: (harnessId) => { invalidated.push(harnessId); },
    now: () => clock,
  });
  assert.deepEqual((await catalog.models()).map((model) => model.modelID), ["retired"]);
  calls.length = 0;

  // The provider retired the model and added a new one.
  modelID = "current";
  assert.equal(catalog.modelsStale({ harnessId: "opencode", projectId: "other", reason: "turn-model-unavailable" }), true);
  assert.deepEqual(invalidated, ["opencode"]);
  // The next read is answered from rediscovery, never the cached list.
  assert.deepEqual((await catalog.models()).map((model) => model.modelID), ["current"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Forced in the failing project and in the catalog authority.
  assert.ok(calls.includes("other:opencode:force"));
  assert.ok(calls.includes("one:opencode:force"));

  // Repeats inside the window are absorbed; another harness is independent.
  calls.length = 0;
  assert.equal(catalog.modelsStale({ harnessId: "opencode", reason: "preflight-invalid-model" }), false);
  assert.equal(catalog.modelsStale({ harnessId: "codex", reason: "preflight-invalid-model" }), true);
  clock += 60_000;
  assert.equal(catalog.modelsStale({ harnessId: "opencode", reason: "preflight-invalid-model" }), true);
});
