import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessContext, OpenCodePluginConfigEntry } from "@polyth/contracts";
import { createConfigApplier } from "../src/config.ts";
import { createOpenCodeNativePlugins, openCodePluginDto, type OpenCodePluginConfig } from "../src/nativePlugins.ts";

const context: HarnessContext = { spaceId: "space-a", projectId: "project-a", cwd: "/srv/project" };

/** The legacy route's applier surface, recording every write. */
function memoryConfig(initial: OpenCodePluginConfigEntry[], fail?: Error) {
  let plugins = structuredClone(initial);
  const writes: string[] = [];
  const config: OpenCodePluginConfig = {
    async listPlugins() { return structuredClone(plugins); },
    async applyPlugins(raw) {
      if (fail) throw fail;
      writes.push(`apply:${JSON.stringify(raw)}`);
      // Like the real applier: an entry replaces the one with the same spec.
      const specOf = (entry: OpenCodePluginConfigEntry) => typeof entry === "string" ? entry : entry[0];
      for (const entry of raw as OpenCodePluginConfigEntry[]) {
        const at = plugins.findIndex((current) => specOf(current) === specOf(entry));
        if (at >= 0) plugins[at] = entry;
        else plugins.push(entry);
      }
      return structuredClone(plugins);
    },
    async removePlugin(spec) {
      if (fail) throw fail;
      writes.push(`remove:${spec}`);
      const next = plugins.filter((entry) => (typeof entry === "string" ? entry : entry[0]) !== spec);
      const removed = next.length !== plugins.length;
      plugins = next;
      return { plugins: structuredClone(plugins), removed };
    },
  };
  return { config, writes };
}

test("OpenCode config entries become native plugin DTOs without leaking options", () => {
  assert.deepEqual(openCodePluginDto("opencode", "@acme/opencode-review@1.2.3"), {
    harnessId: "opencode",
    id: "@acme/opencode-review@1.2.3",
    name: "@acme/opencode-review",
    version: "1.2.3",
    source: { kind: "npm", ref: "@acme/opencode-review@1.2.3" },
    scope: "user",
    enabled: true,
    components: [{ kind: "native-code", count: 1, effect: "active", reason: "OpenCode loads the plugin module in every runtime it starts" }],
    evidence: { stage: "discovered", source: "opencode config plugin" },
  });
  const plain = openCodePluginDto("opencode", "opencode-wakatime");
  assert.equal(plain.name, "opencode-wakatime");
  assert.equal(plain.version, undefined);
  const local = openCodePluginDto("opencode", "file:///home/u/plugins/guard");
  assert.deepEqual(local.source, { kind: "local", ref: "file:///home/u/plugins/guard" });
  assert.equal(local.name, "guard");
  const withOptions = openCodePluginDto("opencode", ["opencode-secret-plugin", { apiKey: "sk-live-should-not-appear" }]);
  assert.equal(withOptions.id, "opencode-secret-plugin");
  assert.match(withOptions.note!, /options/);
  assert.ok(!JSON.stringify(withOptions).includes("sk-live"));
});

test("install/uninstall go through the shared applier and report pending restart only for real changes", async () => {
  const { config, writes } = memoryConfig(["opencode-wakatime"]);
  const manager = createOpenCodeNativePlugins({ harnessId: "opencode", config });
  assert.deepEqual(manager.support(context), {
    actions: ["install", "uninstall"], installScopes: ["user"],
    installHint: "npm-package[@version] or file:///absolute/path", applies: "runtime-restart", marketplaces: false, installOptions: true,
  });

  assert.deepEqual(await manager.mutate!(context, { action: "install", plugin: "opencode-review@2", scope: "user" }, { operationId: "a" }),
    { kind: "confirmed", value: { pendingRestart: true, message: "opencode-review@2 is staged for the next OpenCode runtime." } });
  assert.deepEqual(await manager.mutate!(context, { action: "install", plugin: "opencode-wakatime" }, { operationId: "b" }),
    { kind: "confirmed", value: { pendingRestart: false, message: "opencode-wakatime is already in the OpenCode config; nothing changed." } });
  assert.deepEqual(await manager.mutate!(context, { action: "uninstall", plugin: "opencode-wakatime" }, { operationId: "c" }),
    { kind: "confirmed", value: { pendingRestart: true, message: "opencode-wakatime is staged for removal with the next OpenCode runtime." } });
  assert.deepEqual(await manager.mutate!(context, { action: "uninstall", plugin: "opencode-wakatime" }, { operationId: "d" }),
    { kind: "rejected", code: "not-found", message: "opencode-wakatime is not in the OpenCode config." });
  assert.deepEqual(writes, ["apply:[\"opencode-review@2\"]", "remove:opencode-wakatime", "remove:opencode-wakatime"]);
  assert.deepEqual((await manager.list(context)).plugins.map((plugin) => plugin.id), ["opencode-review@2"]);
});

test("refusals: unsupported actions and scopes, invalid refs, remote hosts and applier refusals", async () => {
  const { config, writes } = memoryConfig([]);
  const manager = createOpenCodeNativePlugins({ harnessId: "opencode", config });
  const code = async (input: Parameters<NonNullable<typeof manager.mutate>>[1], ctx = context) =>
    (await manager.mutate!(ctx, input, { operationId: "x" }) as { code?: string }).code;
  assert.equal(await code({ action: "enable", plugin: "a" }), "unsupported");
  assert.equal(await code({ action: "update", plugin: "a" }), "unsupported");
  assert.equal(await code({ action: "install", plugin: "a", scope: "project" }), "invalid-input");
  assert.equal(await code({ action: "install", plugin: "--registry=evil" }), "invalid-input");
  assert.equal(await code({ action: "install", plugin: "a b" }), "invalid-input");
  assert.equal(await code({ action: "install", plugin: "a" }, { ...context, remote: true }), "unsupported");
  assert.deepEqual(writes, []);

  const remote = await manager.list({ ...context, remote: true });
  assert.deepEqual(remote.plugins, []);
  assert.deepEqual(remote.support.actions, []);
  assert.equal(remote.support.installOptions, undefined);
  assert.match(remote.warnings?.[0] ?? "", /remote OpenCode host/);

  const readOnly = createOpenCodeNativePlugins({
    harnessId: "opencode",
    config: memoryConfig([], Object.assign(new Error("applyPlugins refused: config authority is read-only"), { code: "config-read-only" })).config,
  });
  assert.deepEqual(await readOnly.mutate!(context, { action: "install", plugin: "a" }, { operationId: "x" }),
    { kind: "rejected", code: "config-read-only", message: "applyPlugins refused: config authority is read-only" });
  const broken = createOpenCodeNativePlugins({ harnessId: "opencode", config: memoryConfig([], new Error("EACCES")).config });
  assert.equal((await broken.mutate!(context, { action: "install", plugin: "a" }, { operationId: "x" }) as { code: string }).code, "config-write-failed");
});

test("install options are validated, staged as a [spec, options] tuple and never echoed", async () => {
  const SECRET = "sk-live-should-not-appear";
  const { config, writes } = memoryConfig(["opencode-wakatime", ["opencode-keyed", { apiKey: "old-key-not-shown" }]]);
  const manager = createOpenCodeNativePlugins({ harnessId: "opencode", config });
  const outcomes: unknown[] = [];
  const mutate = async (input: Parameters<NonNullable<typeof manager.mutate>>[1]) => {
    const outcome = await manager.mutate!(context, input, { operationId: "x" });
    outcomes.push(outcome);
    return outcome;
  };

  assert.deepEqual(await mutate({ action: "install", plugin: "opencode-secret", options: { apiKey: SECRET, nested: { retries: 2 } } }),
    { kind: "confirmed", value: { pendingRestart: true, message: "opencode-secret is staged for the next OpenCode runtime." } });
  assert.deepEqual(writes.at(-1), `apply:${JSON.stringify([["opencode-secret", { apiKey: SECRET, nested: { retries: 2 } }]])}`);

  // Re-installing without options, or with the same options in another key order, changes nothing.
  for (const options of [undefined, { nested: { retries: 2 }, apiKey: SECRET }]) {
    assert.deepEqual(await mutate({ action: "install", plugin: "opencode-secret", ...(options ? { options } : {}) }),
      { kind: "confirmed", value: { pendingRestart: false, message: "opencode-secret is already in the OpenCode config; nothing changed." } });
  }
  // Different options replace the existing entry's options.
  assert.deepEqual(await mutate({ action: "install", plugin: "opencode-keyed", options: { apiKey: SECRET } }),
    { kind: "confirmed", value: { pendingRestart: true, message: "New options for opencode-keyed are staged for the next OpenCode runtime." } });
  assert.equal(writes.length, 2);
  assert.deepEqual((await config.listPlugins()).map((entry) => typeof entry === "string" ? entry : entry[0]), ["opencode-wakatime", "opencode-keyed", "opencode-secret"]);

  const invalidWrites = writes.length;
  const tooLarge = { blob: "x".repeat(16 * 1024) };
  let deep: Record<string, unknown> = { leaf: SECRET };
  for (let i = 0; i < 40; i += 1) deep = { deep };
  for (const options of [[SECRET], "string", null, 42, tooLarge, { fn: (() => SECRET) as unknown }, { n: Number.NaN }, new Date(), deep]) {
    const outcome = await mutate({ action: "install", plugin: "opencode-bad", options: options as Record<string, unknown> });
    assert.equal(outcome.kind, "rejected");
    assert.equal((outcome as { code: string }).code, "invalid-input");
  }
  assert.equal((await mutate({ action: "uninstall", plugin: "opencode-secret", options: { apiKey: SECRET } }) as { code: string }).code, "invalid-input");
  assert.equal(writes.length, invalidWrites, "refused options never reach the config");

  const list = await manager.list(context);
  const keyed = list.plugins.find((plugin) => plugin.id === "opencode-keyed");
  assert.match(keyed!.note ?? "", /options/);
  for (const text of [JSON.stringify(list), JSON.stringify(outcomes)]) {
    assert.ok(!text.includes(SECRET) && !text.includes("old-key-not-shown") && !text.includes("retries"), "option values never leave the adapter");
  }
});

test("with the real config applier the plugin array changes and every other key survives", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-opencode-native-plugins-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "opencode.json"), JSON.stringify({ model: "a/b", plugin: ["opencode-wakatime"] }));
  const manager = createOpenCodeNativePlugins({ harnessId: "opencode", config: createConfigApplier({ configDir: dir }) });
  assert.equal((await manager.mutate!(context, { action: "install", plugin: "file:///opt/guard" }, { operationId: "a" })).kind, "confirmed");
  assert.equal((await manager.mutate!(context, { action: "uninstall", plugin: "opencode-wakatime" }, { operationId: "b" })).kind, "confirmed");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")), { model: "a/b", plugin: ["file:///opt/guard"] });
  assert.deepEqual((await manager.list(context)).plugins.map((plugin) => [plugin.id, plugin.source.kind]), [["file:///opt/guard", "local"]]);

  // Options are written as OpenCode's tuple form, and new options replace old ones.
  assert.equal((await manager.mutate!(context, { action: "install", plugin: "opencode-keyed", options: { apiKey: "a" } }, { operationId: "c" })).kind, "confirmed");
  assert.equal((await manager.mutate!(context, { action: "install", plugin: "opencode-keyed", options: { apiKey: "b" } }, { operationId: "d" })).kind, "confirmed");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")).plugin, ["file:///opt/guard", ["opencode-keyed", { apiKey: "b" }]]);
});
