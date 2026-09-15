import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTemporaryWorktreeBranch,
  randomWorktreeSlug,
  semanticWorktreeBranch,
  suggestWorktreeBranch,
  temporaryWorktreeBranch,
  worktreeLabel,
  worktreeSlug,
} from "../src/worktreeSessions.ts";

test("worktree branch suggestion expands template tokens and sanitizes titles", () => {
  const now = new Date("2026-08-20T06:00:00.000Z");
  assert.equal(worktreeSlug(" Fix déjà-vu / auth! "), "fix-deja-vu-auth");
  assert.equal(
    suggestWorktreeBranch("feat/{date}/{slug}", "Fix déjà-vu / auth!", [], now),
    "feat/2026-08-20/fix-deja-vu-auth",
  );
});

test("worktree branch suggestion avoids existing branches deterministically", () => {
  const now = new Date("2026-08-20T06:00:00.000Z");
  assert.equal(
    suggestWorktreeBranch("feat/{slug}", "Session", ["feat/session", "feat/session-2"], now),
    "feat/session-3",
  );
  assert.equal(suggestWorktreeBranch("", "", [], now), "feat/session");
});

test("worktree labels prefer branch and fall back to the checkout folder", () => {
  assert.equal(worktreeLabel("feat/auth", "/tmp/repo-auth"), "feat/auth");
  assert.equal(worktreeLabel(null, "/tmp/repo-auth/"), "repo-auth");
});

test("random worktree defaults are branch-safe", () => {
  assert.match(randomWorktreeSlug(), /^[a-z]+-[a-z]+-\d{4}$/);
  const first = temporaryWorktreeBranch([], () => 0, () => 1);
  const second = temporaryWorktreeBranch([first], () => 0, () => 1);
  assert.equal(first, "temp/red-panther-1000");
  assert.equal(second, "temp/iron-dawn-1001");
  assert.equal(isTemporaryWorktreeBranch(first), true);
  assert.equal(isTemporaryWorktreeBranch("feat/red-panther-1000"), false);
  assert.equal(isTemporaryWorktreeBranch("temp/custom-name-1234"), false);
});

test("model titles become unique conventional worktree branches", () => {
  assert.equal(semanticWorktreeBranch("Fix login crash", []), "fix/login-crash");
  assert.equal(
    semanticWorktreeBranch("Add branch picker", ["feat/branch-picker"]),
    "feat/branch-picker-2",
  );
});
