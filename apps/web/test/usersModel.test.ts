import test from "node:test";
import assert from "node:assert/strict";
import {
  accountErrorText,
  buildLimits,
  generatePassphrase,
  limitsChanged,
  limitsDraftFrom,
  limitsProblem,
  limitsSummary,
  makeFirst,
  suggestLogin,
  toggleId,
  usageLine,
} from "../src/components/settings/usersModel.ts";

test("limits draft round-trips; 'all' and no caps save as no limits", () => {
  assert.equal(buildLimits(limitsDraftFrom(null)), null);
  const limits = { projects: ["a"], harnesses: ["claude", "codex"], messagesPerDay: 40, chatsPerDay: null };
  assert.deepEqual(buildLimits(limitsDraftFrom(limits)), limits);
  // Switching scope back to "all" keeps the earlier selection in the draft only.
  const draft = { ...limitsDraftFrom(limits), projectScope: "all" as const };
  assert.deepEqual(buildLimits(draft), { ...limits, projects: null });
  assert.deepEqual(draft.projects, ["a"]);
});

test("changes compare projects as a set and assistants in order", () => {
  const base = limitsDraftFrom({ projects: ["a", "b"], harnesses: ["x", "y"], messagesPerDay: null, chatsPerDay: null });
  assert.equal(limitsChanged({ ...base, projects: ["b", "a"] }, base), false);
  assert.equal(limitsChanged({ ...base, harnesses: ["y", "x"] }, base), true);
  assert.equal(limitsChanged({ ...base, messagesPerDay: 5 }, base), true);
  assert.equal(limitsChanged(limitsDraftFrom(null), { ...limitsDraftFrom(null), projects: ["z"] }), false);
});

test("an empty 'only selected' list is a problem, not a lockout", () => {
  assert.match(limitsProblem({ ...limitsDraftFrom(null), projectScope: "selected" })!, /at least one project/);
  assert.match(limitsProblem({ ...limitsDraftFrom(null), harnessScope: "selected" })!, /at least one assistant/);
  assert.equal(limitsProblem(limitsDraftFrom(null)), null);
});

test("ordered selection helpers", () => {
  assert.deepEqual(toggleId(["a"], "b", true), ["a", "b"]);
  assert.deepEqual(toggleId(["a", "b"], "a", false), ["b"]);
  assert.deepEqual(makeFirst(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(makeFirst(["a"], "z"), ["a"]);
});

test("summaries and usage read as plain sentences", () => {
  assert.deepEqual(limitsSummary(null), []);
  assert.deepEqual(
    limitsSummary({ projects: ["a", "b"], harnesses: ["claude"], messagesPerDay: 50, chatsPerDay: 1 }, (id) => id === "claude" ? "Claude Code" : id),
    ["2 projects", "Claude Code only", "50 messages a day", "1 new chats a day"],
  );
  assert.deepEqual(limitsSummary({ projects: null, harnesses: ["a", "b", "c"], messagesPerDay: null, chatsPerDay: null }), ["3 assistants"]);
  assert.equal(usageLine({ day: "2026-10-04", messages: 3, chats: 1 }, 50, "message", "messages"), "3 of 50 messages today");
  assert.equal(usageLine({ day: "2026-10-04", messages: 3, chats: 1 }, null, "chat", "chats"), "1 chat today");
});

test("login suggestions and generated passphrases", () => {
  assert.equal(suggestLogin("  Mária Kovalenko"), "maria");
  assert.equal(suggestLogin("Олена"), "");
  const pass = generatePassphrase();
  assert.match(pass, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
  assert.notEqual(generatePassphrase(), pass);
});

test("errors become one human sentence", () => {
  assert.equal(accountErrorText(Object.assign(new Error("invalid credentials"), { code: "invalid-credentials" })), "That password isn't right. Try again.");
  assert.equal(accountErrorText(Object.assign(new Error("Login name is already in use"), { code: "conflict" })), "That login is already taken. Choose another.");
  assert.equal(accountErrorText(new Error("guardrails changed")), "Guardrails changed.");
});
