import test from "node:test";
import assert from "node:assert/strict";
import { actionConfig } from "../widgets/actionConfig.ts";

test("custom action config keeps valid choices and falls back safely", () => {
  assert.deepEqual(actionConfig({}), {
    label: "Run action",
    command: "",
    icon: "terminal",
    output: "terminal",
  });
  assert.deepEqual(actionConfig({ label: "  Tests  ", command: "npm test", icon: "play", output: "popup" }), {
    label: "Tests",
    command: "npm test",
    icon: "play",
    output: "popup",
  });
  assert.equal(actionConfig({ icon: "unknown", output: "unknown" }).icon, "terminal");
});
