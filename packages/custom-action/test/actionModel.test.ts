import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_LIMITS,
  ActionInputError,
  actionAvailableIn,
  actionsForProject,
  groupActions,
  moveWithinScope,
  normalizeActionInput,
  readStoredAction,
} from "../src/actionModel.ts";

const fieldOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ActionInputError);
    assert.equal(error.code, "invalid-input");
    return error.field;
  }
  assert.fail("expected a refusal");
};

test("an action input keeps valid choices and falls back to safe defaults", () => {
  assert.deepEqual(normalizeActionInput({ name: "  Run   tests ", command: "npm test\r\n\n" }), {
    name: "Run tests",
    icon: "zap",
    color: "accent",
    command: "npm test",
    mode: "background",
    projectId: null,
  });
  const chat = normalizeActionInput({
    name: "Fix build",
    command: "npm run build",
    icon: "wrench",
    color: "amber",
    mode: "chat",
    projectId: "p1",
    chat: { harnessId: "claude", model: { providerID: "anthropic", modelID: "opus", variant: "high" }, prompt: " Fix it. ", when: "failure" },
  });
  assert.deepEqual(chat, {
    name: "Fix build",
    icon: "wrench",
    color: "amber",
    command: "npm run build",
    mode: "chat",
    projectId: "p1",
    chat: { harnessId: "claude", model: { providerID: "anthropic", modelID: "opus", variant: "high" }, prompt: "Fix it.", when: "failure" },
  });
  // A chat action without options still gets an explicit hand-off.
  assert.deepEqual(normalizeActionInput({ name: "Ask", command: "ls", mode: "chat" }).chat, { prompt: "", when: "always" });
  // "auto" is the absence of a pinned harness.
  assert.equal(normalizeActionInput({ name: "Ask", command: "ls", mode: "chat", chat: { harnessId: "auto" } }).chat?.harnessId, undefined);
  // Unknown glyphs and tints fall back instead of failing a save.
  const fallback = normalizeActionInput({ name: "x", command: "ls", icon: "<svg>", color: "#f00" });
  assert.equal(fallback.icon, "zap");
  assert.equal(fallback.color, "accent");
});

test("refusals name the field the editor should point at", () => {
  assert.equal(fieldOf(() => normalizeActionInput(null)), "action");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "  ", command: "ls" })), "name");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "x".repeat(ACTION_LIMITS.name + 1), command: "ls" })), "name");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "   \n" })), "command");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "echo \0" })), "command");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "x".repeat(ACTION_LIMITS.command + 1) })), "command");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "ls", mode: "popup" })), "mode");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "ls", projectId: "../other" })), "projectId");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "ls", chat: { when: "sometimes" } })), "chat.when");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "ls", chat: { harnessId: "bad id!" } })), "chat.harnessId");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "ls", chat: { model: { providerID: "x" } } })), "chat.model");
  assert.equal(fieldOf(() => normalizeActionInput({ name: "a", command: "ls", chat: { prompt: "x".repeat(ACTION_LIMITS.prompt + 1) } })), "chat.prompt");
});

test("asking before running is optional and keeps a tidy message", () => {
  const base = { name: "Deploy", command: "make deploy" };
  assert.equal("confirm" in normalizeActionInput(base), false, "off unless asked for");
  assert.equal("confirm" in normalizeActionInput({ ...base, confirm: false }), false);
  assert.deepEqual(normalizeActionInput({ ...base, confirm: true }).confirm, { message: "" });
  assert.deepEqual(normalizeActionInput({ ...base, confirm: { message: "  Ships to prod.\r\n" } }).confirm, { message: "Ships to prod." });
  assert.equal(fieldOf(() => normalizeActionInput({ ...base, confirm: "yes" })), "confirm");
  assert.equal(fieldOf(() => normalizeActionInput({ ...base, confirm: { message: "x".repeat(ACTION_LIMITS.confirmMessage + 1) } })), "confirm.message");
  assert.deepEqual(readStoredAction({ id: "a", ...base, confirm: { message: "Sure?" } })?.confirm, { message: "Sure?" });
});

test("stored records are read leniently and broken ones are skipped", () => {
  assert.equal(readStoredAction({ name: "no id", command: "ls" }), null);
  assert.equal(readStoredAction({ id: "a", name: "", command: "ls" }), null);
  assert.deepEqual(readStoredAction({ id: "a", name: "Old", command: "ls", icon: "gone", createdAt: 5 }), {
    id: "a", name: "Old", icon: "zap", color: "accent", command: "ls", mode: "background", projectId: null, createdAt: 5, updatedAt: 5,
  });
});

test("scope: project actions stay in their project, Space-wide actions run anywhere", () => {
  const actions = [
    { id: "g1", projectId: null },
    { id: "a1", projectId: "a" },
    { id: "b1", projectId: "b" },
    { id: "g2", projectId: null },
    { id: "a2", projectId: "a" },
  ];
  assert.equal(actionAvailableIn(actions[1]!, "a"), true);
  assert.equal(actionAvailableIn(actions[1]!, "b"), false);
  assert.equal(actionAvailableIn(actions[0]!, "b"), true);
  assert.equal(actionAvailableIn(actions[0]!, null), false, "nothing runs without a project");
  assert.deepEqual(actionsForProject(actions, "a").map((action) => action.id), ["g1", "a1", "g2", "a2"]);
  const grouped = groupActions(actions, "a");
  assert.deepEqual(grouped.project.map((action) => action.id), ["a1", "a2"]);
  assert.deepEqual(grouped.global.map((action) => action.id), ["g1", "g2"]);
  assert.deepEqual(groupActions(actions, null).project, []);
});

test("moving an action reorders only its scope and leaves the others in place", () => {
  const actions = [
    { id: "g1", projectId: null },
    { id: "a1", projectId: "a" },
    { id: "g2", projectId: null },
    { id: "a2", projectId: "a" },
    { id: "g3", projectId: null },
  ];
  assert.deepEqual(moveWithinScope(actions, "g3", 0), ["g3", "a1", "g1", "a2", "g2"]);
  assert.deepEqual(moveWithinScope(actions, "a1", 5), ["g1", "a2", "g2", "a1", "g3"]);
  assert.deepEqual(moveWithinScope(actions, "missing", 0), ["g1", "a1", "g2", "a2", "g3"]);
});
