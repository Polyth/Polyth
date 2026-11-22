import test from "node:test";
import assert from "node:assert/strict";
import {
  accountErrorText,
  buildLimits,
  defaultPreset,
  invitationText,
  presetChoices,
  presetPlan,
  presetRoleTag,
  presetText,
  shareableAddress,
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

test("presets map to one Space role, Protected mode on top of member", () => {
  assert.deepEqual(presetChoices(true), ["teammate", "protected", "viewer", "admin", "account"]);
  assert.equal(defaultPreset(true), "teammate");
  assert.deepEqual(presetPlan("teammate", true), { role: "member", guarded: false });
  assert.deepEqual(presetPlan("protected", true), { role: "member", guarded: true });
  assert.deepEqual(presetPlan("viewer", true), { role: "viewer", guarded: false });
  assert.deepEqual(presetPlan("admin", true), { role: "admin", guarded: false });
  assert.deepEqual(presetPlan("account", true), { role: null, guarded: false });
  // Owner is never a one-click preset: ownership changes stay on the person's page.
  assert.equal(presetChoices(true).some((preset) => presetPlan(preset, true).role === "owner"), false);
});

test("without membership rights a preset can create the account only", () => {
  assert.deepEqual(presetChoices(false), ["account", "protected"]);
  assert.equal(defaultPreset(false), "account");
  assert.deepEqual(presetPlan("protected", false), { role: null, guarded: true });
  assert.deepEqual(presetPlan("admin", false), { role: null, guarded: false });
});

test("preset copy names the role behind it only when it adds something", () => {
  assert.equal(presetText("teammate", "Home").label, "Teammate");
  assert.match(presetText("account", "Home").detail, /can’t open Home yet/);
  assert.doesNotMatch(presetText("account", null).detail, /\{space\}/);
  assert.equal(presetRoleTag("teammate", true), "Member");
  assert.equal(presetRoleTag("protected", true), "Member · Protected mode");
  assert.equal(presetRoleTag("viewer", true), null);
  assert.equal(presetRoleTag("admin", true), null);
  assert.equal(presetRoleTag("account", true), null);
  assert.equal(presetRoleTag("protected", false), "Protected mode");
});

test("only an address another device can open goes into an invitation", () => {
  assert.equal(shareableAddress("https://polyth.example.org"), "https://polyth.example.org");
  assert.equal(shareableAddress("http://192.168.1.20:4096"), "http://192.168.1.20:4096");
  for (const local of ["http://localhost:4096", "http://127.0.0.1:4096", "http://[::1]:4096", "http://app.localhost", "http://0.0.0.0:80", "file://", "polyth://app", "app://-"]) {
    assert.equal(shareableAddress(local), null, local);
  }
  assert.equal(shareableAddress("not a url"), null);
});

test("the invitation greets by first name and carries the sign-in without a trailing dot on the password", () => {
  const withAddress = invitationText({ name: "Iryna Petrenko", login: "iryna", password: "abcd-efgh-jkmn-pqrs", address: "https://polyth.example.org" });
  assert.match(withAddress, /^Hi Iryna!/);
  assert.match(withAddress, /Open https:\/\/polyth\.example\.org/);
  assert.match(withAddress, /login iryna/);
  assert.match(withAddress, /abcd-efgh-jkmn-pqrs\n/);
  assert.match(withAddress, /choose your own password/);
  const without = invitationText({ name: "Oleh", login: "oleh", password: "x".repeat(8), address: null });
  assert.doesNotMatch(without, /Open /);
});
