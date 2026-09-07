import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier } from "@polyth/backend-opencode";
import { createDeferredConfigApplier, createOpenCodePendingService } from "../src/opencodePending.ts";

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

