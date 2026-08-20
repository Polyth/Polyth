// WP9: backend config applier — atomic behavior writes and MCP block merges
// that preserve unrelated config keys and refuse to clobber corrupt files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier } from "../src/config.ts";

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
