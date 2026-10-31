import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionCommandId } from "@polyth/commands/catalog";
import { isHostOnlyExtensionCommand } from "../src/composer/extensionCommandGate.ts";

test("only valid reserved extension ids bypass model admission", () => {
  assert.equal(isHostOnlyExtensionCommand({
    id: extensionCommandId({ packageId: "com-example-tools", contributionId: "review" }),
  }), true);
  assert.equal(isHostOnlyExtensionCommand({ id: "extension:broken" }), false);
  assert.equal(isHostOnlyExtensionCommand({ id: "native:review" }), false);
  assert.equal(isHostOnlyExtensionCommand(undefined), false);
});
