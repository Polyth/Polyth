import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier } from "@polyth/backend-opencode";
import type { RouteRequest } from "../src/http.ts";
import { createDeferredConfigApplier, createOpenCodePendingService } from "../src/opencodePending.ts";
import { opencodePendingRoutes } from "../src/routes/opencodePending.ts";
import { opencodePluginRoutes } from "../../plugins/src/serverEntry.ts";
import type { SpaceContext } from "@polyth/contracts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-oc-plugins-"));

const spaceOf = (dir: string, deployment: SpaceContext["deployment"] = "local-trusted"): SpaceContext => ({
  spaceId: "spc_local",
  spaceSlug: "local",
  userId: "usr_test",
  role: "owner",
  deployment,
  storageDir: dir,
});

const harness = (dir: string) => {
  let restarts = 0;
  const pending = createOpenCodePendingService({
    restart: async () => { restarts += 1; return 2; },
  });
  const config = createDeferredConfigApplier(createConfigApplier({ configDir: dir }), pending);
  config.enableStaging();
  const routes = [opencodePluginRoutes(config), opencodePendingRoutes(pending)];
  const call = async (method: string, path: string, input: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://polyth.test${path}`);
    const request = {
      req: {},
      res: {},
      url,
      path: url.pathname,
      method,
      space: spaceOf(dir),
      body: async () => input,
      json: (code, value) => {
        status = code;
        payload = value;
      },
    } as unknown as RouteRequest;
    let handled = false;
    for (const route of routes) {
      if (await route(request)) {
        handled = true;
        break;
      }
    }
    return { handled, status, payload };
  };
  return { call, restarts: () => restarts };
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
    pendingRestart: true,
  });
  let config = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(config.provider, { "claude-code": { name: "Claude Code" } });
  assert.deepEqual(config.mcp, { docs: { type: "remote", url: "https://docs.example/mcp" } });
  assert.deepEqual(config.plugin, ["existing"], "staged plugins do not touch live config");

  assert.deepEqual((await call("GET", "/api/opencode/pending")).payload, {
    changes: [{ id: "plugins", kind: "plugins", label: "OpenCode plugins" }],
    count: 1,
  });
  assert.deepEqual((await call("POST", "/api/opencode/apply-restart")).payload, {
    applied: 1,
    restarted: 2,
  });
  config = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(config.plugin, [
    "existing",
    "@otto-assistant/opencode-claude",
    ["configured", { mode: "strict" }],
  ]);
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
    pendingRestart: true,
  });
  let config = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(config.provider, { existing: { name: "Existing provider" } });
  assert.equal(config.plugin, undefined);
  await call("POST", "/api/opencode/apply-restart");
  config = JSON.parse(readFileSync(file, "utf8"));
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

test("OpenCode plugin remove stages tuple removal until apply and restart", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({
    plugin: [["@scope/remove", { enabled: true }], "keep"],
    provider: { x: {} },
  }));
  const { call, restarts } = harness(dir);
  const result = await call("DELETE", `/api/plugins/opencode/${encodeURIComponent("@scope/remove")}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    plugins: [{ spec: "keep" }],
    removed: true,
    pendingRestart: true,
  });
  let config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(config.plugin, [["@scope/remove", { enabled: true }], "keep"]);
  await call("POST", "/api/opencode/apply-restart");
  assert.equal(restarts(), 1);
  config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(config.plugin, ["keep"]);
  assert.deepEqual(config.provider, { x: {} });
});
