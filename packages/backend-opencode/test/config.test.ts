// WP9: backend config applier — atomic behavior writes and MCP block merges
// that preserve unrelated config keys and refuse to clobber corrupt files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier, stripJsonc } from "../src/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-cfg-"));

test("applyBehavior writes the instruction file atomically", async () => {
  const dir = tmp();
  const applier = createConfigApplier({ configDir: dir });
  const n = await applier.applyBehavior("Always answer in haiku.\n");
  assert.equal(n, Buffer.byteLength("Always answer in haiku.\n"));
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "Always answer in haiku.\n");
  assert.equal(applier.behaviorPath(), join(dir, "AGENTS.md"));
});

test("applyMcp merges into existing config without touching other keys", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ theme: "dark", model: "a/b" }));
  const applier = createConfigApplier({ configDir: dir });
  await applier.applyMcp([
    { name: "ctx", enabled: true, transport: { kind: "stdio", command: "ctx", args: ["--stdio"], env: { KEY: "v" } } },
    { name: "web", enabled: false, transport: { kind: "http", url: "https://x.example/mcp", headers: {} } },
  ]);
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.theme, "dark");
  assert.equal(cfg.model, "a/b");
  assert.deepEqual(cfg.mcp.ctx, { type: "local", command: ["ctx", "--stdio"], enabled: true, environment: { KEY: "v" } });
  assert.deepEqual(cfg.mcp.web, { type: "remote", url: "https://x.example/mcp", enabled: false });
});

test("applyMcp refuses to overwrite a corrupt backend config", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), "{corrupt");
  const applier = createConfigApplier({ configDir: dir });
  await assert.rejects(() => applier.applyMcp([]));
  assert.equal(readFileSync(join(dir, "opencode.json"), "utf8"), "{corrupt", "corrupt file untouched");
});

test("applyPlugins merges and deduplicates string and tuple entries by spec", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: ["existing", ["configured", { old: true }]],
    mcp: { ctx: { type: "local", command: ["ctx"] } },
    provider: { anthropic: { name: "Anthropic" } },
    agent: { review: { mode: "subagent" } },
  }));
  const applier = createConfigApplier({ configDir: dir });
  const plugins = await applier.applyPlugins([
    "@otto-assistant/opencode-claude",
    ["configured", { old: false, mode: "strict" }],
    "@otto-assistant/opencode-claude",
  ]);
  assert.deepEqual(plugins, [
    "existing",
    ["configured", { old: false, mode: "strict" }],
    "@otto-assistant/opencode-claude",
  ]);
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(cfg.mcp, { ctx: { type: "local", command: ["ctx"] } });
  assert.deepEqual(cfg.provider, { anthropic: { name: "Anthropic" } });
  assert.deepEqual(cfg.agent, { review: { mode: "subagent" } });
  assert.deepEqual(cfg.plugin, plugins);
});

test("plugin edits parse JSONC and remove tuple entries atomically", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.jsonc");
  writeFileSync(file, `{
    // user-owned config
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["keep", ["remove-me", { "enabled": true, }],],
    "provider": { "claude-code": { "name": "Claude Code", }, },
  }`);
  const applier = createConfigApplier({ configDir: dir });
  assert.deepEqual(await applier.listPlugins(), ["keep", ["remove-me", { enabled: true }]]);
  const result = await applier.removePlugin("remove-me");
  assert.equal(result.removed, true);
  assert.deepEqual(result.plugins, ["keep"]);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(cfg.plugin, ["keep"]);
  assert.deepEqual(cfg.provider, { "claude-code": { name: "Claude Code" } });
});

test("replacePlugins applies an exact validated list and preserves other config", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify({
    plugin: ["old"],
    provider: { anthropic: { name: "Anthropic" } },
  }));
  const applier = createConfigApplier({ configDir: dir });
  await applier.replacePlugins([["configured", { mode: "strict" }], "next"]);
  let cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(cfg.plugin, [["configured", { mode: "strict" }], "next"]);
  assert.deepEqual(cfg.provider, { anthropic: { name: "Anthropic" } });

  await applier.replacePlugins([]);
  cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("plugin" in cfg, false);
  assert.deepEqual(cfg.provider, { anthropic: { name: "Anthropic" } });
});

test("applyPlugins validates every entry before leaving config untouched", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const original = JSON.stringify({ plugin: ["keep"], provider: { x: {} } });
  writeFileSync(file, original);
  const applier = createConfigApplier({ configDir: dir });
  await assert.rejects(
    () => applier.applyPlugins(["valid", ["broken", "options-must-be-an-object"]]),
    /must be a package spec or/,
  );
  assert.equal(readFileSync(file, "utf8"), original);
});

test("readConfig returns {} for a missing file and parses an existing one", async () => {
  const dir = tmp();
  const applier = createConfigApplier({ configDir: dir });
  assert.deepEqual(await applier.readConfig(), {});
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ theme: "dark", mcp: { ctx: { type: "local" } } }));
  const cfg = await applier.readConfig();
  assert.equal(cfg.theme, "dark");
  assert.deepEqual(cfg.mcp, { ctx: { type: "local" } });
  assert.equal(applier.configPath(), join(dir, "opencode.json"));
});

test("readConfig throws on corrupt JSON instead of returning garbage", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), "{corrupt");
  const applier = createConfigApplier({ configDir: dir });
  await assert.rejects(() => applier.readConfig());
});

// OpenCode itself rewrites opencode.json as JSONC (observed live: it left
// `{"$schema": …,}` behind). Strict parsing would wrongly reject the file
// and break every visibility toggle, so the reader must tolerate JSONC.
test("readConfig tolerates JSONC: trailing commas and comments", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), `{
  // written by opencode
  "$schema": "https://opencode.ai/config.json",
  "provider": { "openai": { "blacklist": ["a", "b",], }, }, /* trailing */
}`);
  const applier = createConfigApplier({ configDir: dir });
  const cfg = await applier.readConfig();
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(cfg.provider, { openai: { blacklist: ["a", "b"] } });
});

test("stripJsonc never mangles commas, braces, or slashes inside strings", () => {
  const raw = JSON.stringify({ note: 'a,} // not-a-comment /* neither */ "quoted\\"', url: "https://x" });
  assert.deepEqual(JSON.parse(stripJsonc(raw)), JSON.parse(raw));
});

test("applyProviderVisibility round-trips a JSONC config written by opencode", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), '{\n  "$schema": "https://opencode.ai/config.json",}');
  const applier = createConfigApplier({ configDir: dir });
  await applier.applyProviderVisibility({ disabledProviders: ["azure"], blacklists: {} });
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(cfg.disabled_providers, ["azure"]);
});

test("applyProviderVisibility merges disabled_providers and blacklists, preserving other keys", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({
    theme: "dark",
    mcp: { ctx: { type: "local", command: ["ctx"] } },
    provider: { openai: { apiKey: "sk-test", baseURL: "https://x" } },
  }));
  const applier = createConfigApplier({ configDir: dir });
  await applier.applyProviderVisibility({
    disabledProviders: ["ollama", "azure"],
    blacklists: { openai: ["gpt-3.5-turbo"], anthropic: ["claude-2"] },
  });
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.theme, "dark", "unrelated top-level keys preserved");
  assert.deepEqual(cfg.mcp, { ctx: { type: "local", command: ["ctx"] } }, "mcp block untouched");
  assert.deepEqual(cfg.disabled_providers, ["azure", "ollama"]);
  assert.equal(cfg.provider.openai.apiKey, "sk-test", "unrelated provider keys preserved");
  assert.equal(cfg.provider.openai.baseURL, "https://x");
  assert.deepEqual(cfg.provider.openai.blacklist, ["gpt-3.5-turbo"]);
  assert.deepEqual(cfg.provider.anthropic, { blacklist: ["claude-2"] });
});

test("applyProviderVisibility clears stale entries when everything is re-enabled", async () => {
  const dir = tmp();
  const applier = createConfigApplier({ configDir: dir });
  await applier.applyProviderVisibility({
    disabledProviders: ["ollama"],
    blacklists: { openai: ["gpt-4o-mini"] },
  });
  await applier.applyProviderVisibility({ disabledProviders: [], blacklists: {} });
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal("disabled_providers" in cfg, false);
  assert.equal("provider" in cfg, false, "empty provider entries removed");
});

test("applyProviderVisibility refuses to overwrite a corrupt backend config", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), "{corrupt");
  const applier = createConfigApplier({ configDir: dir });
  await assert.rejects(() => applier.applyProviderVisibility({ disabledProviders: [], blacklists: {} }));
  assert.equal(readFileSync(join(dir, "opencode.json"), "utf8"), "{corrupt", "corrupt file untouched");
});

test("role and visibility edits preserve plugins in an existing opencode.jsonc", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.jsonc");
  writeFileSync(file, `{
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["commandcode@latest", "other-plugin"],
    "agent": { "review": { "tools": { "write": false } } },
  }`);
  const applier = createConfigApplier({ configDir: dir });
  assert.equal(applier.configPath(), file);
  await applier.applyAgent("review", {
    mode: "subagent",
    prompt: "Review carefully.",
    model: { providerID: "anthropic", modelID: "claude-sonnet" },
  });
  await applier.applyProviderVisibility({ disabledProviders: ["ollama"], blacklists: {} });
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(cfg.plugin, ["commandcode@latest", "other-plugin"]);
  assert.equal(cfg.agent.review.tools.write, false);
  assert.equal(cfg.agent.review.mode, "subagent");
  assert.equal(cfg.agent.review.model, "anthropic/claude-sonnet");
});
