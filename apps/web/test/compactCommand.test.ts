import test from "node:test";
import assert from "node:assert/strict";
import type { SlashCommand } from "@polyth/commands/catalog";
import type { RuntimeCommandDescriptor } from "@polyth/contracts";
import {
  compactBlockReason,
  isCompactCommand,
  isNothingToCompactError,
} from "../src/composer/compactCommand.ts";

const builtinCompact: SlashCommand = { name: "compact", description: "", prompt: "p", scope: "builtin" };
const projectCompact: SlashCommand = { name: "compact", description: "", prompt: "p", scope: "project" };
const nativeCompact: RuntimeCommandDescriptor = {
  id: "native:compact",
  name: "compact",
  owner: "native",
  harnessId: "opencode",
  invocation: "raw-native-input",
};

test("a typed builtin /compact is intercepted, with or without trailing space", () => {
  const catalog = [builtinCompact];
  assert.equal(isCompactCommand("/compact", catalog), true);
  assert.equal(isCompactCommand("/compact ", catalog), true);
  assert.equal(isCompactCommand("  /compact", catalog), false);
  assert.equal(isCompactCommand("/compact\t", catalog), true);
});

test("project and user overrides keep their prompt transport", () => {
  assert.equal(isCompactCommand("/compact", [projectCompact]), false);
  assert.equal(isCompactCommand("/compact", [projectCompact, builtinCompact]), false);
});

test("the builtin action wins by precedence but an explicit native pick stays native", () => {
  const catalog = [builtinCompact, nativeCompact];
  assert.equal(isCompactCommand("/compact", catalog), true);
  assert.equal(isCompactCommand("/compact", catalog, nativeCompact), false);
});

test("an explicit builtin selection wins over a same-named native command", () => {
  const catalog = [nativeCompact, builtinCompact];
  assert.equal(isCompactCommand("/compact", catalog, builtinCompact), true);
});

test("other commands and extra prompt lines are not compaction", () => {
  const catalog = [builtinCompact];
  assert.equal(isCompactCommand("/summary", catalog), false);
  assert.equal(isCompactCommand("/compactly", catalog), false);
  assert.equal(isCompactCommand("/compact now", catalog), false);
  assert.equal(isCompactCommand("/compact\nkeep working", catalog), false);
});

test("an empty or unbound chat cannot compact", () => {
  assert.equal(compactBlockReason({ sessionId: null, hasConversation: false }), "new-chat");
  assert.equal(compactBlockReason({ sessionId: "s1", hasConversation: false }), "empty");
  assert.equal(compactBlockReason({ sessionId: "s1", backendSessionId: "b1", hasConversation: false }), "empty");
  assert.equal(compactBlockReason({ sessionId: "s1", hasConversation: true }), "empty");
  assert.equal(compactBlockReason({ sessionId: "s1", backendSessionId: "b1", hasConversation: true }), null);
});

test("only the no-native-context refusal maps to nothing-to-compact", () => {
  assert.equal(isNothingToCompactError(new Error("session has no native context to compact")), true);
  assert.equal(isNothingToCompactError({ code: "conflict", message: "session has no native context to compact" }), true);
  assert.equal(isNothingToCompactError(new Error("cannot compact while the session is working")), false);
  assert.equal(isNothingToCompactError("network down"), false);
});
