import test from "node:test";
import assert from "node:assert/strict";
import type { AccountGuardrails } from "@polyth/contracts";
import {
  __setGuardrailsForTest,
  getGuardrails,
  guardedAutoApproveAllowed,
  guardedMayAllow,
  guardedMayAlways,
  guardedModelSwitcherVisible,
  guardedProjectAddAllowed,
  guardedSettingsPageVisible,
  guardedShellAllowed,
  resetGuardrails,
} from "../src/guardrails.ts";

const model = (id: string) => ({ harnessId: "h", modelId: id }) as unknown as AccountGuardrails["models"][number];
const guarded = (over: Partial<AccountGuardrails> = {}): AccountGuardrails =>
  ({ grants: [], models: [], approvals: "none", ...over });

test("an unrestricted account sees every control", () => {
  assert.equal(guardedShellAllowed(null), true);
  assert.equal(guardedAutoApproveAllowed(null), true);
  assert.equal(guardedProjectAddAllowed(null), true);
  assert.equal(guardedMayAllow(null), true);
  assert.equal(guardedMayAlways(null), true);
  assert.equal(guardedModelSwitcherVisible(null), true);
  assert.equal(guardedSettingsPageVisible(null, "packages"), true);
});

test("a guarded account loses shell, auto-approve, always and project add", () => {
  const g = guarded({ approvals: "once" });
  assert.equal(guardedShellAllowed(g), false);
  assert.equal(guardedAutoApproveAllowed(g), false);
  assert.equal(guardedProjectAddAllowed(g), false);
  assert.equal(guardedMayAlways(g), false);
});

test("Allow follows the approvals ceiling", () => {
  assert.equal(guardedMayAllow(guarded({ approvals: "none" })), false);
  assert.equal(guardedMayAllow(guarded({ approvals: "once" })), true);
});

test("the model switcher needs a real choice", () => {
  assert.equal(guardedModelSwitcherVisible(guarded()), false);
  assert.equal(guardedModelSwitcherVisible(guarded({ models: [model("a")] })), false);
  assert.equal(guardedModelSwitcherVisible(guarded({ models: [model("a"), model("b")] })), true);
});

test("owner/admin settings pages are hidden, personal ones stay", () => {
  const g = guarded();
  for (const id of ["harnesses", "packages", "users", "tunnel", "models"]) {
    assert.equal(guardedSettingsPageVisible(g, id), false, id);
  }
  for (const id of ["general", "appearance", "chat", "about"]) {
    assert.equal(guardedSettingsPageVisible(g, id), true, id);
  }
});

test("reset forgets the previous account's guardrails", () => {
  __setGuardrailsForTest(guarded());
  assert.notEqual(getGuardrails(), null);
  resetGuardrails();
  assert.equal(getGuardrails(), null);
});
