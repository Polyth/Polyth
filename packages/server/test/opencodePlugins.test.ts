import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier } from "@polyth/backend-opencode";
import type { RouteRequest } from "../src/http.ts";
import { opencodePluginRoutes } from "../src/routes/opencodePlugins.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-oc-plugins-"));

const harness = (dir: string) => {
  const route = opencodePluginRoutes(createConfigApplier({ configDir: dir }));
  const call = async (method: string, path: string, input: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://polyth.test${path}`);
    const handled = await route({
      req: {},
      res: {},
      url,
      path: url.pathname,
      method,
      body: async () => input,
      json: (code, value) => {
        status = code;
        payload = value;
      },
    } as unknown as RouteRequest);
    return { handled, status, payload };
  };
  return { call };
};

test("OpenCode plugin routes list strings and option tuples", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({
    plugin: ["plain", ["configured", { mode: "strict" }]],
  }));
  const { call } = harness(dir);
  const result = await call("GET", "/api/plugins/opencode");
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    plugins: [
      { spec: "plain" },
      { spec: "configured", options: { mode: "strict" } },
    ],
  });
});

test("OpenCode plugin import merges once and preserves unrelated config", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: ["existing"],
    provider: { "claude-code": { name: "Claude Code" } },
    mcp: { docs: { type: "remote", url: "https://docs.example/mcp" } },
  }));
  const { call } = harness(dir);
  const result = await call("POST", "/api/plugins/opencode/import", {
    plugins: [
      "@otto-assistant/opencode-claude",
      ["configured", { mode: "strict" }],
      "@otto-assistant/opencode-claude",
    ],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    plugins: [
      { spec: "existing" },
      { spec: "@otto-assistant/opencode-claude" },
      { spec: "configured", options: { mode: "strict" } },
    ],
    imported: ["@otto-assistant/opencode-claude", "configured"],
    restartRequired: true,
  });
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(config.provider, { "claude-code": { name: "Claude Code" } });
  assert.deepEqual(config.mcp, { docs: { type: "remote", url: "https://docs.example/mcp" } });
});

test("OpenCode plugin import accepts a pasted OpenCode config object", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify({
    provider: { existing: { name: "Existing provider" } },
  }));
  const { call } = harness(dir);
  const result = await call("POST", "/api/plugins/opencode/import", {
    $schema: "https://opencode.ai/config.json",
    plugin: ["@otto-assistant/opencode-claude"],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    plugins: [{ spec: "@otto-assistant/opencode-claude" }],
    imported: ["@otto-assistant/opencode-claude"],
    restartRequired: true,
  });
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(config.provider, { existing: { name: "Existing provider" } });
  assert.deepEqual(config.plugin, ["@otto-assistant/opencode-claude"]);
});

test("OpenCode plugin import rejects the whole request before writing", async () => {
  const dir = tmp();
  const file = join(dir, "opencode.json");
  const original = JSON.stringify({ plugin: ["keep"], provider: { x: {} } });
  writeFileSync(file, original);
  const { call } = harness(dir);
  await assert.rejects(
    () => call("POST", "/api/plugins/opencode/import", {
      plugins: ["valid", ["invalid-options", true]],
    }),
    /must be a package spec or/,
  );
  assert.equal(readFileSync(file, "utf8"), original);
});

test("OpenCode plugin remove matches tuple spec and reports restart", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({
    plugin: [["@scope/remove", { enabled: true }], "keep"],
    provider: { x: {} },
  }));
  const { call } = harness(dir);
  const result = await call("DELETE", `/api/plugins/opencode/${encodeURIComponent("@scope/remove")}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    plugins: [{ spec: "keep" }],
    removed: true,
    restartRequired: true,
  });
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(config.plugin, ["keep"]);
  assert.deepEqual(config.provider, { x: {} });
});
