import test from "node:test";
import assert from "node:assert/strict";
import type { GitStatus } from "@polyth/session/web-api";
import {
  cacheGitStatus,
  gitContextSnapshot,
  peekGitStatus,
  subscribeGitStatus,
} from "../widgets/gitStatusStore.ts";

const repo = (branch: string, extra: Partial<GitStatus> = {}): GitStatus => ({
  branch,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  ...extra,
});

test("git context is null until a repo is known", () => {
  assert.equal(gitContextSnapshot(null), null);
  assert.equal(gitContextSnapshot(repo("main", { isRepo: false })), null);
});

test("git context projects branch and per-project recommendations from cached status", () => {
  const snapshot = gitContextSnapshot(repo("feature/foo", { ahead: 2, behind: 1 }));
  assert.equal(snapshot?.title, "Git");
  assert.deepEqual(snapshot?.items, [
    { label: "Branch", value: "feature/foo" },
    { label: "Sync", value: "2 ahead · 1 behind" },
  ]);
  assert.deepEqual(snapshot?.recommendedWidgetIds, ["git.pending-changes", "git.recent"]);
});

test("cached git status does not leak across projects", () => {
  cacheGitStatus("project-a", repo("main"));
  cacheGitStatus("project-b", repo("feature/bar"));
  let bumps = 0;
  const stop = subscribeGitStatus(() => { bumps += 1; });
  cacheGitStatus("project-a", repo("develop"));
  stop();
  assert.equal(peekGitStatus("project-a")?.branch, "develop");
  assert.equal(peekGitStatus("project-b")?.branch, "feature/bar");
  assert.equal(gitContextSnapshot(peekGitStatus("project-b"))?.items?.[0]?.value, "feature/bar");
  assert.ok(bumps >= 1);
});
