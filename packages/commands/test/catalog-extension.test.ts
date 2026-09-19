import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeCommandDescriptor } from "@polyth/contracts";
import {
  commandPrecedence,
  extensionCommandBinding,
  extensionCommandId,
  parseExtensionCommandId,
  type SlashCommand,
} from "../src/catalog.ts";

const extension = (name: string): SlashCommand => ({
  id: extensionCommandId({ packageId: "com-example-tools", contributionId: name }),
  name,
  description: "extension command",
  prompt: "",
  scope: "builtin",
  owner: "builtin",
});

const command = (name: string, scope: SlashCommand["scope"]): SlashCommand => ({
  name,
  description: `${scope} command`,
  prompt: "x",
  scope,
  owner: scope,
});

const native = (name: string): RuntimeCommandDescriptor => ({
  id: `native:${name}`,
  name,
  description: "native command",
  harnessId: "test",
  owner: "native",
  invocation: "raw-native-input",
});

test("extension command ids round-trip opaque package and contribution ids", () => {
  const binding = { packageId: "com-example/a", contributionId: "review:item" };
  const id = extensionCommandId(binding);
  assert.equal(id, "extension:com-example%2Fa:review%3Aitem");
  assert.deepEqual(parseExtensionCommandId(id), binding);
  assert.equal(parseExtensionCommandId("extension:broken"), null);
  assert.equal(parseExtensionCommandId("not-extension:x:y"), null);
  assert.deepEqual(extensionCommandBinding({ id }), binding);
});

test("extensions never shadow project, user, or builtin commands", () => {
  const ext = extension("review");
  const builtin = command("review", "builtin");
  assert.equal(commandPrecedence("review", [ext, builtin]), builtin);
  const user = command("review", "user");
  assert.equal(commandPrecedence("review", [ext, user]), user);
  const project = command("review", "project");
  assert.equal(commandPrecedence("review", [ext, project]), project);
});

test("extension commands beat native runtime commands but lose to Polyth commands", () => {
  const ext = extension("inspect");
  assert.equal(commandPrecedence("inspect", [native("inspect"), ext]), ext);
  assert.notEqual(commandPrecedence("/inspect", [ext, command("inspect", "builtin")]), ext);
});
