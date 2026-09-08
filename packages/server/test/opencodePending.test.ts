import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier } from "@polyth/backend-opencode";
import { createDeferredConfigApplier, createOpenCodePendingService, physicalRestartKeysFor, restartScopeFor, type PendingTask } from "../src/opencodePending.ts";
import { opencodePendingRoutes } from "../src/routes/opencodePending.ts";
import type { RouteRequest } from "../src/http.ts";
import type { SpaceContext } from "@polyth/contracts";

const lmstudio = () => ({
  id: "local-lmstudio",
  name: "LM Studio",
  protocol: "openai-compatible" as const,
  baseURL: "http://127.0.0.1:1234/v1",
  authMode: "none" as const,
});

const staged = () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-oc-custom-"));
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  const config = createDeferredConfigApplier(createConfigApplier({ configDir: dir }), pending);
  config.enableStaging();
  return { dir, pending, config };
};

test("pending OpenCode changes coalesce by id and clear only after restart", async () => {
  const applied: string[] = [];
  let restarts = 0;
  const pending = createOpenCodePendingService({
    restart: async () => { restarts += 1; return 3; },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "Old MCP state",
    apply: async () => { applied.push("old"); },
  });
  pending.stage({
    id: "mcp",
    kind: "mcp",
    label: "MCP servers",
    apply: async () => { applied.push("latest"); },
  });
  pending.stage({
    id: "agent:review",
    kind: "agent",
    label: "Agent role: review",
    apply: async () => { applied.push("agent"); },
  });

  assert.deepEqual(pending.list(), {
    changes: [
      { id: "mcp", kind: "mcp", label: "MCP servers" },
      { id: "agent:review", kind: "agent", label: "Agent role: review" },
    ],
    count: 2,
  });
  assert.deepEqual(await pending.applyAndRestart(), { applied: 2, restarted: 3 });
  assert.deepEqual(applied, ["latest", "agent"]);
  assert.equal(restarts, 1);
  assert.deepEqual(pending.list(), { changes: [], count: 0 });
});

test("runtime capability settlement requires the exact staged desired revision", () => {
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  pending.stage({
    id: "runtime-capabilities:spc:proj:/work/proj",
    kind: "runtime-capabilities",
    label: "OpenCode runtime capabilities",
    desiredRevision: "R3",
    apply: async () => {},
  });

  pending.settleRuntimeCapabilities({
    spaceId: "spc",
    projectId: "proj",
    cwd: "/work/proj",
    desiredRevision: "R2",
  });
  assert.equal(pending.list().count, 1, "a late R2 receipt must not settle staged R3");

  pending.settleRuntimeCapabilities({
    spaceId: "spc",
    projectId: "proj",
    cwd: "/work/proj",
    desiredRevision: "R3",
  });
  assert.equal(pending.list().count, 0);
});

test("pending OpenCode changes remain queued when restart fails", async () => {
  let applies = 0;
  const pending = createOpenCodePendingService({
    restart: async () => { throw new Error("restart failed"); },
  });
  pending.stage({
    id: "provider-visibility",
    kind: "provider-visibility",
    label: "Provider and model visibility",
    apply: async () => { applies += 1; },
  });

  await assert.rejects(() => pending.applyAndRestart(), /restart failed/);
  assert.equal(applies, 1);
  assert.equal(pending.list().count, 1);
});

test("staged custom provider is projected for inspect and leaves physical config untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-oc-custom-"));
  const pending = createOpenCodePendingService({
    restart: async () => 1,
  });
  const config = createDeferredConfigApplier(createConfigApplier({ configDir: dir }), pending);
  config.enableStaging();
  await config.applyCustomProvider({
    id: "local-lmstudio",
    name: "LM Studio",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:1234/v1",
    authMode: "none",
  });
  const inspect = await config.inspectProvider("local-lmstudio");
  assert.equal(inspect?.id, "local-lmstudio");
  assert.equal(inspect?.baseURL, "http://127.0.0.1:1234/v1");
  assert.equal(inspect?.owned, true);
  await config.addManualModel("local-lmstudio", { id: "llama-3", name: "Llama 3" });
  const after = await config.inspectProvider("local-lmstudio");
  assert.deepEqual(after?.modelIDs, ["llama-3"]);
  assert.equal(existsSync(join(dir, "opencode.json")), false, "physical config is not created while staging");
  assert.equal(pending.list().count, 1, "create + manual model coalesce to one restart marker");
});

test("create then inspect before restart sees the projected provider", async () => {
  const { config, dir } = staged();
  await config.applyCustomProvider(lmstudio());
  const inspect = await config.inspectProvider("local-lmstudio");
  assert.equal(inspect?.baseURL, "http://127.0.0.1:1234/v1");
  assert.equal(existsSync(join(dir, "opencode.json")), false);
});

test("create then discover then manual model inspects before restart", async () => {
  const { config } = staged();
  await config.applyCustomProvider(lmstudio());
  await config.mergeDiscoveredModels("local-lmstudio", [{ id: "auto", name: "Auto" }]);
  await config.addManualModel("local-lmstudio", { id: "hand", name: "Hand" });
  const inspect = await config.inspectProvider("local-lmstudio");
  assert.deepEqual(inspect?.modelIDs.sort(), ["auto", "hand"]);
});

test("create then edit twice: final projected state wins", async () => {
  const { config } = staged();
  await config.applyCustomProvider(lmstudio());
  await config.applyCustomProvider({ ...lmstudio(), name: "LM 1", baseURL: "http://127.0.0.1:1/v1" });
  await config.applyCustomProvider({ ...lmstudio(), name: "LM 2", baseURL: "http://127.0.0.1:2/v1" });
  const inspect = await config.inspectProvider("local-lmstudio");
  assert.equal(inspect?.name, "LM 2");
  assert.equal(inspect?.baseURL, "http://127.0.0.1:2/v1");
});

test("create then remove before restart leaves no provider after apply", async () => {
  const { config, dir, pending } = staged();
  await config.applyCustomProvider(lmstudio());
  await config.removeCustomProvider("local-lmstudio");
  assert.equal(await config.inspectProvider("local-lmstudio"), undefined);
  await pending.applyAndRestart();
  const disk = existsSync(join(dir, "opencode.json"))
    ? JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as { provider?: Record<string, unknown> }
    : {};
  assert.equal(disk.provider?.["local-lmstudio"], undefined);
});

test("create then two manual models both survive apply", async () => {
  const { config, dir, pending } = staged();
  await config.applyCustomProvider(lmstudio());
  await config.addManualModel("local-lmstudio", { id: "a", name: "A" });
  await config.addManualModel("local-lmstudio", { id: "b", name: "B" });
  assert.deepEqual((await config.inspectProvider("local-lmstudio"))?.modelIDs.sort(), ["a", "b"]);
  await pending.applyAndRestart();
  const disk = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as {
    provider: Record<string, { models?: Record<string, unknown> }>;
  };
  assert.ok(disk.provider["local-lmstudio"]?.models?.a);
  assert.ok(disk.provider["local-lmstudio"]?.models?.b);
});

test("staged provider mutation and unrelated plugin write both survive apply", async () => {
  const { config, dir, pending } = staged();
  writeFileSync(join(dir, "opencode.json"), `${JSON.stringify({ plugin: ["keep-plugin"], theme: "dark" }, null, 2)}\n`);
  await config.applyCustomProvider(lmstudio());
  await config.replacePlugins(["keep-plugin", "new-plugin"]);
  await pending.applyAndRestart();
  const disk = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as {
    plugin: unknown;
    theme: string;
    provider: Record<string, unknown>;
  };
  assert.deepEqual(disk.plugin, ["keep-plugin", "new-plugin"]);
  assert.equal(disk.theme, "dark");
  assert.ok(disk.provider["local-lmstudio"]);
});

test("failed restart keeps staged provider projection after the apply barrier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-oc-custom-"));
  const pending = createOpenCodePendingService({
    restart: async () => { throw new Error("restart failed"); },
  });
  const config = createDeferredConfigApplier(createConfigApplier({ configDir: dir }), pending);
  config.enableStaging();
  await config.applyCustomProvider(lmstudio());
  await assert.rejects(() => pending.applyAndRestart(), /restart failed/);
  assert.equal((await config.inspectProvider("local-lmstudio"))?.id, "local-lmstudio");
  assert.equal(pending.list().count, 1);
});

// --- Hole B: target-specific OpenCode restart scoping ---

const rcTask = (over: Partial<PendingTask> & Pick<PendingTask, "id" | "kind" | "label">): PendingTask => ({
  apply: async () => {},
  ...over,
});

test("restartScopeFor: a runtime-capabilities-only batch scopes to the union of task restartKeys", () => {
  assert.equal(restartScopeFor([]), undefined);
  const scoped = restartScopeFor([
    rcTask({ id: "a", kind: "runtime-capabilities", label: "a", restartKeys: ["opencode:local:p1:/a"] }),
    rcTask({ id: "b", kind: "runtime-capabilities", label: "b", restartKeys: ["opencode:local:p1:/a", "opencode:local:p2:/b"] }),
  ]);
  assert.deepEqual([...(scoped ?? [])].sort(), ["opencode:local:p1:/a", "opencode:local:p2:/b"]);
});

test("restartScopeFor: any non runtime-capabilities task in the batch forces a global restart", () => {
  const scope = restartScopeFor([
    rcTask({ id: "a", kind: "runtime-capabilities", label: "a", restartKeys: ["k1"] }),
    rcTask({ id: "mcp", kind: "mcp", label: "MCP servers" }),
  ]);
  assert.equal(scope, undefined);
});

test("restartScopeFor: a runtime-capabilities task with no declared scope forces a global restart", () => {
  const scope = restartScopeFor([rcTask({ id: "a", kind: "runtime-capabilities", label: "a" })]);
  assert.equal(scope, undefined);
});

test("physicalRestartKeysFor matches live restarters synchronously including remote keys", () => {
  const local = "opencode:local:proj-p:/work/p";
  const remote = "opencode:conn-1:proj-p:/work/p";
  const other = "opencode:local:proj-c:/work/c";
  assert.deepEqual(
    physicalRestartKeysFor([local, other], "proj-p", "/work/p", local),
    [local],
  );
  assert.deepEqual(
    physicalRestartKeysFor([remote, other], "proj-p", "/work/p", local),
    [remote],
  );
  assert.deepEqual(
    physicalRestartKeysFor([other], "proj-p", "/work/p", local),
    [local],
  );
});

test("applyAndRestart scopes a runtime-capabilities-only batch to its declared restart keys", async () => {
  const seen: Array<ReadonlySet<string> | undefined> = [];
  const pending = createOpenCodePendingService({
    canRestart: async (_state, keys) => { seen.push(keys); return { safe: true }; },
    captureRestartState: async (keys) => ({ keys }),
    restart: async (_state, keys) => { seen.push(keys); return keys?.size ?? 0; },
  });
  const keyP = "opencode:local:proj-p:/work/p";
  pending.stage(rcTask({
    id: "runtime-capabilities:spc:proj-p:/work/p",
    kind: "runtime-capabilities",
    label: "OpenCode runtime capabilities",
    restartKeys: [keyP],
  }));
  const result = await pending.applyAndRestart();
  assert.equal(seen.length, 2, "both canRestart and restart receive the scope");
  for (const keys of seen) assert.deepEqual([...(keys ?? [])], [keyP]);
  assert.equal(result.restarted, 1);
});

test("applyAndRestart restarts globally when the batch mixes a shared config write with runtime-capabilities", async () => {
  const seen: Array<ReadonlySet<string> | undefined> = [];
  const pending = createOpenCodePendingService({
    restart: async (_state, keys) => { seen.push(keys); return 1; },
  });
  pending.stage(rcTask({
    id: "runtime-capabilities:spc:proj-p:/work/p",
    kind: "runtime-capabilities",
    label: "OpenCode runtime capabilities",
    restartKeys: ["opencode:local:proj-p:/work/p"],
  }));
  pending.stage(rcTask({ id: "mcp", kind: "mcp", label: "MCP servers" }));
  await pending.applyAndRestart();
  assert.equal(seen[0], undefined, "a batch with any non runtime-capabilities change restarts every runtime");
});

test("scoped restart against a fake restarter map mirroring production keys: P restarts, C is never called, C being busy does not block P", async () => {
  const keyP = "opencode:local:proj-p:/work/p";
  const keyC = "opencode:local:proj-c:/work/c";
  const restarters = new Map<string, { called: number; busy: boolean }>([
    [keyP, { called: 0, busy: false }],
    [keyC, { called: 0, busy: true }],
  ]);
  const pending = createOpenCodePendingService({
    canRestart: async (_state, keys) => {
      for (const [key, restarter] of restarters) {
        // A scoped restart must not safety-check (or fail on) targets
        // outside its scope — an unrelated project's busy session must
        // never defer a restart it has nothing to do with.
        if (keys && !keys.has(key)) continue;
        if (restarter.busy) return { safe: false as const, reason: `runtime ${key} is busy` };
      }
      return { safe: true as const };
    },
    restart: async (_state, keys) => {
      const entries = keys ? [...restarters].filter(([key]) => keys.has(key)) : [...restarters];
      for (const [, restarter] of entries) restarter.called += 1;
      return entries.length;
    },
  });
  pending.stage(rcTask({
    id: "runtime-capabilities:spc:proj-p:/work/p",
    kind: "runtime-capabilities",
    label: "OpenCode runtime capabilities",
    restartKeys: [keyP],
  }));
  const result = await pending.applyAndRestart();
  assert.equal(restarters.get(keyP)!.called, 1, "P is restarted");
  assert.equal(restarters.get(keyC)!.called, 0, "C is never called");
  assert.equal(result.restarted, 1);
});

test("deferred restart leaves staged provider state intact and physical config unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-oc-custom-"));
  const pending = createOpenCodePendingService({
    canRestart: async () => ({ safe: false, reason: "busy" }),
    restart: async () => 1,
  });
  const config = createDeferredConfigApplier(createConfigApplier({ configDir: dir }), pending);
  config.enableStaging();
  await config.applyCustomProvider(lmstudio());
  await assert.rejects(() => pending.applyAndRestart(), /deferred/);
  assert.equal(existsSync(join(dir, "opencode.json")), false);
  assert.equal((await config.inspectProvider("local-lmstudio"))?.id, "local-lmstudio");
  assert.equal(pending.list().count, 1);
});

test("OpenCode pending restart routes are local-trusted only", async () => {
  const pending = createOpenCodePendingService({ restart: async () => 1 });
  pending.stage({
    id: "runtime-capabilities:spc_a:/abs/secret-cwd",
    kind: "runtime-capabilities",
    label: "OpenCode runtime capabilities",
    apply: async () => {},
  });
  const route = opencodePendingRoutes(pending);
  const call = async (deployment: SpaceContext["deployment"], method: "GET" | "POST", path: string) => {
    let status = 0;
    let payload: unknown;
    const request = {
      req: {},
      res: {},
      url: new URL(`http://polyth.test${path}`),
      path,
      method,
      space: {
        spaceId: "spc_b",
        spaceSlug: "b",
        userId: "usr_b",
        role: "owner",
        deployment,
        storageDir: "/tmp/space-b",
      },
      body: async () => ({}),
      json: (code: number, value: unknown) => {
        status = code;
        payload = value;
      },
    } as unknown as RouteRequest;
    return { run: () => route(request), status: () => status, payload: () => payload };
  };

  const hostedGet = await call("multi-tenant-sandboxed", "GET", "/api/opencode/pending");
  await assert.rejects(hostedGet.run, (error: unknown) => (error as { code?: string }).code === "not-found");
  const hostedApply = await call("server-trusted", "POST", "/api/opencode/apply-restart");
  await assert.rejects(hostedApply.run, (error: unknown) => (error as { code?: string }).code === "not-found");
  assert.equal(pending.list().count, 1, "hosted denial must not apply or leak the queued task");

  const localGet = await call("local-trusted", "GET", "/api/opencode/pending");
  assert.equal(await localGet.run(), true);
  assert.equal(localGet.status(), 200);
});

