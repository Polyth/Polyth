import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestWorktreeBranch, worktreeLabel, worktreeSlug } from "../src/worktreeSessions.ts";

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
