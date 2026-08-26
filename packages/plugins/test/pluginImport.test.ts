import { test } from "node:test";
import assert from "node:assert/strict";
import { describePluginSpec, parseOpenCodePluginJson } from "../widgets/pluginImport.ts";

test("extracts plugins from the exact Otto OpenCode config", () => {
  const result = parseOpenCodePluginJson(JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: ["@otto-assistant/opencode-claude"],
    provider: {
      "claude-code": {
        name: "Claude Code",
      },
    },
  }));
  assert.deepEqual(result.entries, [{ spec: "@otto-assistant/opencode-claude" }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.ignoredKeys, ["provider"]);
});

test("accepts a bare array with strings and option tuples", () => {
  const result = parseOpenCodePluginJson(JSON.stringify([
    "plain-plugin",
    ["configured-plugin", { mode: "strict", retries: 2 }],
  ]));
  assert.deepEqual(result, {
    entries: [
      { spec: "plain-plugin" },
      { spec: "configured-plugin", options: { mode: "strict", retries: 2 } },
    ],
    errors: [],
    ignoredKeys: [],
  });
});

test("accepts an unquoted package spec and deduplicates with last options winning", () => {
  assert.deepEqual(parseOpenCodePluginJson("@scope/plugin"), {
    entries: [{ spec: "@scope/plugin" }],
    errors: [],
    ignoredKeys: [],
  });
  const deduped = parseOpenCodePluginJson(JSON.stringify([
    "same",
    ["same", { enabled: true }],
  ]));
  assert.deepEqual(deduped.entries, [{ spec: "same", options: { enabled: true } }]);
});

test("collects malformed entry errors without throwing", () => {
  assert.match(parseOpenCodePluginJson("{oops").errors[0] ?? "", /not valid JSON/);
  assert.match(parseOpenCodePluginJson("{}").errors[0] ?? "", /plugin.*array/);
  assert.match(parseOpenCodePluginJson("[]").errors[0] ?? "", /no plugin entries/);

  const partial = parseOpenCodePluginJson(JSON.stringify([
    "good",
    "",
    ["bad-options", true],
    ["missing-options"],
  ]));
  assert.deepEqual(partial.entries, [{ spec: "good" }]);
  assert.equal(partial.errors.length, 3);
  assert.match(partial.errors[1] ?? "", /options must be a JSON object/);
  assert.match(partial.errors[2] ?? "", /package spec or/);
});

test("describePluginSpec derives a readable name from scoped and versioned npm specs", () => {
  assert.deepEqual(describePluginSpec("@polyth/opencode-cursor@2.5.0"), {
    name: "opencode-cursor",
    path: "@polyth/opencode-cursor@2.5.0",
    kind: "npm",
    version: "2.5.0",
    description: "npm package · v2.5.0",
  });
  assert.deepEqual(describePluginSpec("@dietrichgebert/ponytail"), {
    name: "ponytail",
    path: "@dietrichgebert/ponytail",
    kind: "npm",
    description: "npm package",
  });
  assert.deepEqual(describePluginSpec("plain-plugin"), {
    name: "plain-plugin",
    path: "plain-plugin",
    kind: "npm",
    description: "npm package",
  });
});

test("describePluginSpec handles file: and https: specs", () => {
  const file = describePluginSpec("file:///home/user/.polyth/plugins/polyth-browser-plugin.js");
  assert.equal(file.kind, "file");
  assert.equal(file.name, "polyth-browser-plugin");
  assert.equal(file.path, "///home/user/.polyth/plugins/polyth-browser-plugin.js");

  const url = describePluginSpec("https://example.com/plugins/thing.js");
  assert.deepEqual(url, {
    name: "thing.js",
    path: "https://example.com/plugins/thing.js",
    kind: "url",
    description: "Remote plugin script",
  });
});
