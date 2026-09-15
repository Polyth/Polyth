// P1 config preservation (Agent H): every Polyth-supported config change must
// preserve the entire unowned subtree — unknown provider/model/agent/plugin/MCP
// properties at every nesting level, unsupported MCP entries, and unknown
// top-level keys. Import/seed and semantic no-ops perform zero writes so
// untouched files keep their exact bytes (including JSONC comments). Semantic
// preservation is guaranteed; formatting/comments are lost only on a genuine
// write (documented limitation — no JSONC-rewriter dependency exists here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfigAuthority } from "@polyth/contracts";
import { createConfigApplier, projectV2ModelVisibility, type McpApplyBatch, type McpApplyEntry } from "../src/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-cfg-preserve-"));

test("V2 launch projects model blacklists without persisting a second visibility state", async () => {
  const configDir = tmp();
  const path = join(configDir, "opencode.jsonc");
  const raw = '{ // owned curation plus unrelated native settings\n"provider":{"custom":{"blacklist":["hidden"]}},"providers":{"custom":{"models":{"visible":{"disabled":true}}}},"future":{"keep":true}}';
  writeFileSync(path, raw);
  const content = { futureInline: true, providers: { custom: { headers: { "X-Fixture": "yes" }, models: { hidden: { name: "Hidden" } } } } };
  const env = { OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG_CONTENT: JSON.stringify(content) };
  const projected = await projectV2ModelVisibility(env);
  assert.deepEqual(JSON.parse(projected.OPENCODE_CONFIG_CONTENT!), {
    ...content, providers: { custom: { ...content.providers.custom, models: { hidden: { name: "Hidden", disabled: true } } } },
  });
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify(content));
  await createConfigApplier({ configDir }).applyProviderVisibility({ disabledProviders: [], blacklists: {} });
  assert.equal(await projectV2ModelVisibility(env), env, "removing curation restores the original launch input");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.custom.models.visible.disabled, true);
});

// Required regression fixture: unknown provider/model fields that no Polyth
// DTO knows about. Every owned mutation must leave this subtree intact
// (except the explicitly owned per-provider `blacklist` overlay).
const UNKNOWN_FIELDS_FIXTURE = {
  provider: {
    custom: {
      npm: "future-provider",
      futureTopLevelField: {
        doNotTouch: true,
      },
      models: {
        "model-x": {
          name: "Model X",
          reasoning: true,
          modalities: {
            input: ["text", "image", "pdf"],
            output: ["text"],
          },
          limit: {
            context: 1050000,
            input: 922000,
            output: 128000,
          },
          variants: {
            low: { reasoningEffort: "low" },
            max: { reasoningEffort: "max" },
          },
          unknownFutureField: {
            keep: "me",
          },
        },
      },
    },
  },
} as const;

/** Full document: the fixture plus MCP/plugin/agent extras and unknown
 * top-level keys, so every owned operation runs against unowned neighbors. */
const baseDocument = (): Record<string, unknown> => structuredClone({
  $schema: "https://opencode.ai/config.json",
  theme: "dark",
  futureTopLevelBlock: { keep: true, nested: { deep: ["a", 1, null] } },
  ...UNKNOWN_FIELDS_FIXTURE,
  mcp: {
    ctx: {
      type: "local",
      command: ["ctx", "--stdio"],
      enabled: true,
      environment: { KEY: "v", opaqueComplex: { nested: true } },
      timeout: 30,
      futureMcpField: { keep: "me" },
    },
    web: {
      type: "remote",
      url: "https://x.example/mcp",
      enabled: false,
      notes: "disabled but present",
    },
    "sse-thing": { type: "sse", url: "https://sse.example", futureShape: { v: 2 } },
    unparseable: { type: "local", command: "not-an-array", extra: 1 },
  },
  plugin: ["keep-plugin", ["tuple-plugin", { mode: "strict", future: { nested: 1 } }]],
  agent: {
    review: {
      mode: "subagent",
      tools: { write: false },
      futureAgentField: { keep: 1 },
    },
  },
  keybinds: { app_help: "?" },
});

const MCP_OWNED = new Set(["type", "command", "environment", "enabled", "url", "headers"]);

/** Remove everything Polyth owns so before/after comparison covers exactly the
 * unowned subtree. Managed MCP entries are dropped entirely (their unowned
 * fields are asserted separately) because disabled-managed = absent is owned
 * behavior. */
const unownedSubtree = (cfg: Record<string, unknown>, managedMcpNames: string[]): Record<string, unknown> => {
  const out = structuredClone(cfg);
  delete out.disabled_providers;
  delete out.plugin;
  const provider = out.provider as Record<string, Record<string, unknown>> | undefined;
  if (provider) {
    for (const [id, entry] of Object.entries(provider)) {
      delete entry.blacklist;
      // A provider entry holding nothing but the owned blacklist was created
      // by the visibility overlay itself; it is owned, not user data.
      if (Object.keys(entry).length === 0) delete provider[id];
    }
  }
  const agent = out.agent as Record<string, Record<string, unknown>> | undefined;
  if (agent) {
    for (const entry of Object.values(agent)) {
      delete entry.mode;
      delete entry.prompt;
      delete entry.model;
    }
  }
  const mcp = out.mcp as Record<string, unknown> | undefined;
  if (mcp) for (const name of managedMcpNames) delete mcp[name];
  return out;
};

const readCfg = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

const withManaged = (entries: McpApplyEntry[], managedNames: string[]): McpApplyBatch =>
  Object.assign(entries, { managedNames });

const ctxEntry = (args: string[] = ["--stdio"]): McpApplyEntry => ({
  name: "ctx",
  enabled: true,
  transport: { kind: "stdio", command: "ctx", args, env: { KEY: "v" } },
});

test("every owned mutation preserves the entire unowned subtree", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const original = baseDocument();
  writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
  const applier = createConfigApplier({ configDir: dir });
  const managed = ["ctx", "web"];
  const expectUnowned = unownedSubtree(original, managed);

  const checkpoints: string[] = [];
  const check = (label: string) => {
    checkpoints.push(label);
    assert.deepEqual(unownedSubtree(readCfg(file), managed), expectUnowned, `unowned subtree changed after ${label}`);
  };

  await applier.applyProviderVisibility({
    disabledProviders: ["azure"],
    blacklists: { custom: ["model-y"], openai: ["gpt-3.5-turbo"] },
  });
  check("applyProviderVisibility (disable)");

  await applier.applyProviderVisibility({ disabledProviders: [], blacklists: {} });
  check("applyProviderVisibility (re-enable everything)");

  await applier.applyAgent("review", {
    mode: "primary",
    prompt: "Review carefully.",
    model: { providerID: "anthropic", modelID: "claude-sonnet" },
  });
  check("applyAgent");

  await applier.applyPlugins(["added-plugin", ["tuple-plugin", { mode: "loose" }]]);
  check("applyPlugins");

  await applier.replacePlugins(["only-plugin"]);
  check("replacePlugins");

  await applier.removePlugin("only-plugin");
  check("removePlugin");

  await applier.applyMcp(withManaged([ctxEntry(["--stdio", "--v2"])], managed));
  check("applyMcp (edit one managed entry)");

  await applier.applyMcp(withManaged([ctxEntry(["--stdio", "--v2"]), {
    name: "web",
    enabled: true,
    transport: { kind: "http", url: "https://x.example/mcp", headers: {} },
    raw: { notes: "disabled but present" },
  }], managed));
  check("applyMcp (re-enable via retained raw fragment)");

  assert.equal(checkpoints.length, 8, "all operations were exercised");
});

test("unknown provider/model fields survive a visibility mutation verbatim", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const original = baseDocument();
  writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
  const applier = createConfigApplier({ configDir: dir });

  await applier.applyProviderVisibility({
    disabledProviders: ["azure"],
    blacklists: { custom: ["model-y"] },
  });

  const cfg = readCfg(file);
  const custom = (cfg.provider as Record<string, Record<string, unknown>>).custom!;
  assert.deepEqual(custom.blacklist, ["model-y"], "owned blacklist overlay applied");
  const expected = structuredClone(UNKNOWN_FIELDS_FIXTURE.provider.custom) as Record<string, unknown>;
  const actualWithoutOwned = { ...custom };
  delete actualWithoutOwned.blacklist;
  assert.deepEqual(actualWithoutOwned, expected, "fixture subtree byte-for-byte semantically identical");
  const modelX = (custom.models as Record<string, Record<string, unknown>>)["model-x"]!;
  assert.equal(modelX.reasoning, true);
  assert.deepEqual(modelX.modalities, { input: ["text", "image", "pdf"], output: ["text"] });
  assert.deepEqual(modelX.limit, { context: 1050000, input: 922000, output: 128000 });
  assert.deepEqual(modelX.variants, { low: { reasoningEffort: "low" }, max: { reasoningEffort: "max" } });
  assert.deepEqual(modelX.unknownFutureField, { keep: "me" });
});

test("applyMcp patches owned fields only: unsupported entries and unknown fields survive", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const original = baseDocument();
  writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
  const applier = createConfigApplier({ configDir: dir });

  await applier.applyMcp(withManaged([ctxEntry(["--stdio", "--v2"])], ["ctx", "web"]));

  const mcp = readCfg(file).mcp as Record<string, Record<string, unknown>>;
  const ctx = mcp.ctx!;
  // Owned fields regenerated on the managed entry…
  assert.deepEqual(ctx.command, ["ctx", "--stdio", "--v2"]);
  assert.equal(ctx.enabled, true);
  // …its unknown sibling fields survive…
  assert.equal(ctx.timeout, 30);
  assert.deepEqual(ctx.futureMcpField, { keep: "me" });
  // …opaque (non-string) environment values Polyth could never import survive…
  assert.deepEqual(ctx.environment, { KEY: "v", opaqueComplex: { nested: true } });
  // …the disabled managed entry is absent (owned behavior: disabled = absent)…
  assert.equal("web" in mcp, false);
  // …and unsupported entries are untouched at every level.
  assert.deepEqual(mcp["sse-thing"], { type: "sse", url: "https://sse.example", futureShape: { v: 2 } });
  assert.deepEqual(mcp.unparseable, { type: "local", command: "not-an-array", extra: 1 });
});

test("applyMcp restores unknown fields from the retained raw fragment", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  writeFileSync(file, `${JSON.stringify({ mcp: { other: { type: "sse" } } }, null, 2)}\n`);
  const applier = createConfigApplier({ configDir: dir });

  await applier.applyMcp(withManaged([{
    name: "web",
    enabled: true,
    transport: { kind: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer t" } },
    raw: { notes: "kept through disable/enable", futureField: { deep: true } },
  }], ["web"]));

  const mcp = readCfg(file).mcp as Record<string, Record<string, unknown>>;
  assert.deepEqual(mcp.web, {
    notes: "kept through disable/enable",
    futureField: { deep: true },
    type: "remote",
    url: "https://x.example/mcp",
    enabled: true,
    headers: { Authorization: "Bearer t" },
  });
  assert.deepEqual(mcp.other, { type: "sse" }, "unmanaged entry untouched");
});

test("semantic no-op applies keep the file bytes (and JSONC comments) intact", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const raw = `{
  // hand-maintained by the user
  "mcp": {
    "ctx": { "type": "local", "command": ["ctx"], "enabled": true, },
    "sse-thing": { "type": "sse", }, /* unsupported */
  },
  "provider": { "custom": { "npm": "future-provider", }, },
  "plugin": ["keep-plugin"],
}`;
  writeFileSync(file, raw);
  const applier = createConfigApplier({ configDir: dir });

  await applier.applyMcp(withManaged([{
    name: "ctx",
    enabled: true,
    transport: { kind: "stdio", command: "ctx", args: [], env: {} },
  }], ["ctx"]));
  assert.equal(readFileSync(file, "utf8"), raw, "no-op applyMcp preserved bytes");

  await applier.applyProviderVisibility({ disabledProviders: [], blacklists: {} });
  assert.equal(readFileSync(file, "utf8"), raw, "no-op visibility preserved bytes");

  await applier.applyPlugins(["keep-plugin"]);
  assert.equal(readFileSync(file, "utf8"), raw, "no-op plugin merge preserved bytes");
});

test("read-only config authority refuses every write and reads still work", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const original = `${JSON.stringify(baseDocument(), null, 2)}\n`;
  writeFileSync(file, original);
  const authority: RuntimeConfigAuthority = { kind: "read-only" };
  const applier = createConfigApplier({ configDir: dir, authority });

  const writes: Array<[string, () => Promise<unknown>]> = [
    ["applyBehavior", () => applier.applyBehavior("nope")],
    ["applyMcp", () => applier.applyMcp([ctxEntry()])],
    ["applyPlugins", () => applier.applyPlugins(["p"])],
    ["replacePlugins", () => applier.replacePlugins([])],
    ["removePlugin", () => applier.removePlugin("keep-plugin")],
    ["applyProviderVisibility", () => applier.applyProviderVisibility({ disabledProviders: [], blacklists: {} })],
    ["applyAgent", () => applier.applyAgent("review", { mode: "subagent" })],
  ];
  for (const [name, write] of writes) {
    await assert.rejects(write, (e: unknown) => (e as { code?: string }).code === "config-read-only", `${name} must refuse`);
  }
  assert.equal(readFileSync(file, "utf8"), original, "file bytes untouched");
  assert.deepEqual((await applier.readConfig()).theme, "dark", "reads never need authority");
  assert.deepEqual(await applier.listPlugins(), ["keep-plugin", ["tuple-plugin", { mode: "strict", future: { nested: 1 } }]]);
});

test("writable authority must match the exact config target", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  writeFileSync(file, "{}\n");

  const mismatched = createConfigApplier({
    configDir: dir,
    authority: { kind: "writable", targetId: "some-other-target" },
  });
  await assert.rejects(
    () => mismatched.applyProviderVisibility({ disabledProviders: ["azure"], blacklists: {} }),
    (e: unknown) => (e as { code?: string }).code === "config-target-mismatch",
  );
  assert.equal(readFileSync(file, "utf8"), "{}\n");

  const probe = createConfigApplier({ configDir: dir });
  const exactTarget = probe.configTargetId!();
  assert.equal(exactTarget, file, "default target identity is the config file path");
  const matching = createConfigApplier({
    configDir: dir,
    authority: { kind: "writable", targetId: exactTarget },
  });
  await matching.applyProviderVisibility({ disabledProviders: ["azure"], blacklists: {} });
  assert.deepEqual(readCfg(file).disabled_providers, ["azure"], "exact writable target may write");
});

test("custom provider writes preserve sibling providers and unknown fields", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const original = baseDocument();
  writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
  const applier = createConfigApplier({ configDir: dir });

  await applier.applyCustomProvider({
    id: "local-lmstudio",
    name: "LM Studio",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:1234/v1",
    authMode: "none",
  });

  const afterCreate = readCfg(file);
  assert.deepEqual(
    (afterCreate.provider as Record<string, unknown>).custom,
    (original.provider as Record<string, unknown>).custom,
    "external custom provider stanza survived a sibling write",
  );
  assert.equal(afterCreate.theme, "dark");
  assert.deepEqual(afterCreate.futureTopLevelBlock, original.futureTopLevelBlock);
  const created = (afterCreate.provider as Record<string, Record<string, unknown>>)["local-lmstudio"]!;
  assert.equal(created.npm, "@ai-sdk/openai-compatible");
  assert.equal(created.name, "LM Studio");
  assert.equal("polyth" in created, false, "OpenCode config must not carry Polyth metadata");
  created.keepMe = { nested: true };

  writeFileSync(file, `${JSON.stringify(afterCreate, null, 2)}\n`);
  await applier.applyCustomProvider({
    id: "local-lmstudio",
    name: "LM Studio local",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:1234/v1",
    models: { "manual-one": { name: "Manual" } },
  });
  const afterUpdate = readCfg(file);
  const updated = (afterUpdate.provider as Record<string, Record<string, unknown>>)["local-lmstudio"]!;
  assert.deepEqual(updated.keepMe, { nested: true }, "unknown fields on the owned entry survive");
  assert.equal(updated.name, "LM Studio local");
  assert.equal("polyth" in updated, false);

  await applier.applyCustomProvider({
    id: "local-lmstudio",
    name: "LM Studio local",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:1234/v1",
    headerPatch: { set: { "X-Test": "secret-value" } },
  });
  await applier.applyCustomProvider({
    id: "local-lmstudio",
    name: "LM Studio renamed",
    protocol: "openai-compatible",
    baseURL: "http://10.0.0.8:1234/v1",
  });
  const afterHeaderPreserve = readCfg(file);
  const preserved = (afterHeaderPreserve.provider as Record<string, { options?: { headers?: Record<string, string>; baseURL?: string } }>)["local-lmstudio"]!;
  assert.equal(preserved.options?.baseURL, "http://10.0.0.8:1234/v1");
  assert.equal(preserved.options?.headers?.["X-Test"], "secret-value");

  await applier.mergeDiscoveredModels("local-lmstudio", [{ id: "discovered-a", name: "A" }]);
  const afterDiscover = readCfg(file);
  const models = ((afterDiscover.provider as Record<string, Record<string, unknown>>)["local-lmstudio"]!.models) as Record<string, unknown>;
  assert.ok("manual-one" in models, "manual model survived discovery");
  assert.ok("discovered-a" in models);

  await applier.removeCustomProvider("local-lmstudio");
  const afterRemove = readCfg(file);
  assert.equal("local-lmstudio" in (afterRemove.provider as object), false);
  assert.deepEqual(
    (afterRemove.provider as Record<string, unknown>).custom,
    (original.provider as Record<string, unknown>).custom,
  );
});

test("failed custom provider write cannot leave a torn opencode.json", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  writeFileSync(file, `${JSON.stringify({ theme: "dark", provider: { keep: { npm: "x" } } }, null, 2)}\n`);
  const before = readFileSync(file, "utf8");
  const applier = createConfigApplier({
    configDir: dir,
    authority: { kind: "read-only" },
  });
  await assert.rejects(
    () => applier.applyCustomProvider({
      id: "broken",
      name: "Broken",
      protocol: "openai-compatible",
      baseURL: "http://127.0.0.1:9/v1",
    }),
  );
  assert.equal(readFileSync(file, "utf8"), before);
});
