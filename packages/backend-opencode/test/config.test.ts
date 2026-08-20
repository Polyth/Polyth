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
