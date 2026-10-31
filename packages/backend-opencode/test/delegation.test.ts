import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeOpenCodeV2DelegationConfigContent,
  OPENCODE_V2_DELEGATION_PLUGIN_SOURCE,
} from "../src/delegation.ts";

test("V2 delegation config appends a final global deny and the Polyth agent transform last", () => {
  const pluginPath = "/private/runtime/polyth-delegation-v2.mjs";
  const merged = JSON.parse(mergeOpenCodeV2DelegationConfigContent(JSON.stringify({
    permissions: [
      { action: "subagent", resource: "reviewer", effect: "allow" },
    ],
    plugins: ["user-plugin", pluginPath],
    future: { untouched: true },
  }), pluginPath)) as {
    permissions: Array<{ action: string; resource: string; effect: string }>;
    plugins: unknown[];
    future: { untouched: boolean };
  };

  assert.deepEqual(merged.permissions.at(-1), {
    action: "subagent",
    resource: "*",
    effect: "deny",
  });
  assert.equal(merged.plugins.at(-1), pluginPath);
  assert.equal(merged.plugins.filter((entry) => entry === pluginPath).length, 1);
  assert.deepEqual(merged.future, { untouched: true });
});

test("V2 delegation plugin denies subagent and beta workspace mutations after configured agent rules evaluate", () => {
  assert.match(OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, /ctx\.permission\.hook\("evaluate"/);
  assert.match(OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, /POLYTH_AGENT_BETA/);
  assert.match(OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, /event\.action === "edit"/);
  assert.match(OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, /event\.action === "bash"/);
  assert.match(OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, /event\.action !== "subagent"/);
  assert.match(OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, /event\.effect = "deny"/);
  assert.match(OPENCODE_V2_DELEGATION_PLUGIN_SOURCE, /use agent\.spawn/);
});
