import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDCODE_BRIDGE_SOURCE } from "../src/bridgeSource.ts";

const launchKeys = [
  "POLYTH_COMMANDCODE_BINDING_FILE",
  "POLYTH_COMMANDCODE_TITLE",
  "POLYTH_COMMANDCODE_OPERATION_ID",
  "POLYTH_COMMANDCODE_CONTROL_FILE",
  "POLYTH_COMMANDCODE_CONTROL_TOKEN",
  "POLYTH_COMMANDCODE_BIN",
  "POLYTH_COMMANDCODE_BRIDGE_PATH",
] as const;

test("Command Code bridge captures required launch state then scrubs it from process.env", () => {
  const scrub = COMMANDCODE_BRIDGE_SOURCE.indexOf("delete process.env[key]");
  assert.ok(scrub > 0, "bridge must scrub launch-only environment values");

  for (const key of launchKeys) {
    const keyInScrubList = COMMANDCODE_BRIDGE_SOURCE.lastIndexOf(`\"${key}\"`, scrub);
    assert.ok(keyInScrubList >= 0, `${key} is included in the scrub list`);
  }

  for (const capture of [
    "const bindingPath = process.env.POLYTH_COMMANDCODE_BINDING_FILE",
    "const requestedTitle = process.env.POLYTH_COMMANDCODE_TITLE",
    "const requestedOperationId = process.env.POLYTH_COMMANDCODE_OPERATION_ID",
    "const controlPath = process.env.POLYTH_COMMANDCODE_CONTROL_FILE",
    "const controlToken = process.env.POLYTH_COMMANDCODE_CONTROL_TOKEN",
  ]) {
    const captureIndex = COMMANDCODE_BRIDGE_SOURCE.indexOf(capture);
    assert.ok(captureIndex >= 0 && captureIndex < scrub, `${capture} is captured before scrubbing`);
  }
});

test("control token is retained only in the Mod closure after environment scrubbing", () => {
  const scrub = COMMANDCODE_BRIDGE_SOURCE.indexOf("delete process.env[key]");
  const afterScrub = COMMANDCODE_BRIDGE_SOURCE.slice(scrub);
  assert.match(afterScrub, /request\?\.token !== controlToken/);
  assert.doesNotMatch(afterScrub, /process\.env\.POLYTH_COMMANDCODE_CONTROL_TOKEN/);
});
