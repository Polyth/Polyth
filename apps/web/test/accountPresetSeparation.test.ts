import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path: string): string => readFileSync(resolve(root, path), "utf8");

test("model picker has no account or preset ownership", () => {
  const picker = source("packages/models/widgets/ModelPicker.tsx");
  assert.equal(/AgentProfile|accountId|executionProfileControl|useProfiles/.test(picker), false);

  const harness = source("packages/harness-runtime/widgets/index.tsx");
  const modelHeaderRegistration = harness.split("\n").find((line) => line.includes('slot: "modelPicker.header"')) ?? "";
  assert.ok(modelHeaderRegistration, "harness model-picker header contribution exists");
  assert.equal(modelHeaderRegistration.includes("executionProfileControl"), false, "preset is not injected into model picker");
  const presetRegistration = harness.split("\n").find((line) => line.includes('id: "harnesses.agent-preset"')) ?? "";
  assert.ok(presetRegistration.includes('slot: "composer.execution"'));
  assert.ok(presetRegistration.includes("executionProfileControl"));
});

test("legacy favorites migration cannot manufacture agent presets", () => {
  const profiles = source("apps/web/src/profiles.ts");
  assert.equal(profiles.includes("planFavoriteMigration"), false);
  assert.equal(profiles.includes("createProfile("), false);
  assert.equal(profiles.includes("@polyth/models/web-prefs"), false);
});
