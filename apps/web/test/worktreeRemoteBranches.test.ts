import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("worktree session dialog can fetch the remote and offer server-only branches", async () => {
  const source = await read("../src/components/WorktreeSessionDialog.tsx");

  // A refresh control that pulls the remote before re-reading the branch list.
  assert.match(source, /import \{ Button, Dialog, RefreshIcon, Select, TextInput \}/);
  assert.match(source, /const refresh = async \(\) => \{/);
  assert.match(source, /await api\.gitFetch\(request\.projectId\)/);
  assert.match(source, /onClick=\{\(\) => void refresh\(\)\}/);
  assert.match(source, /tr\("gitview\.fetchRemoteBranches"\)/);
  assert.match(source, /tr\("gitview\.remoteUnreachableShowingCached"\)/);

  // Remote-only branches are merge targets for Work in isolation.
  assert.match(source, /const remoteBranches = useMemo/);
  assert.match(source, /remoteBranches\.map\(\(item\) => \(\{ value: item\.ref/);
  assert.match(source, /startIsolatedSession\(request\.projectId/);
  assert.match(source, /targetBranch: origin/);
  assert.match(source, /tr\("isolation\.workInIsolation"\)/);
});

test("new-session branch picker fetches the remote on open and lists remote branches", async () => {
  const [composer, contextBar] = await Promise.all([
    read("../src/components/Composer.tsx"),
    read("../src/components/mobile/SessionContextBar.tsx"),
  ]);

  assert.match(composer, /const refreshBranchesFromRemote = useCallback/);
  assert.match(composer, /await api\.gitFetch\(projectId\)\.catch\(\(\) => undefined\)/);
  assert.match(composer, /onBranchPickerOpen: refreshBranchesFromRemote/);
  // Remote-only branches become picker rows in both normal and "new worktree" mode.
  assert.match(composer, /id: `remote:\$\{remote\.ref\}`/);
  assert.match(composer, /target: \{ kind: "branch", branch: remote\.short, base: remote\.ref \}/);
  assert.match(composer, /target: \{ kind: "new-worktree", base: remote\.ref \}/);
  // The chosen base flows through to worktree creation.
  assert.match(composer, /api\.createWorktree\(\s*activeProjectId,\s*newSessionTarget\.branch,\s*undefined,\s*newSessionTarget\.base,/);

  assert.match(contextBar, /onBranchPickerOpen\?: \(\) => void;/);
  assert.match(contextBar, /\{\.\.\.\(onBranchPickerOpen \? \{ onOpen: onBranchPickerOpen \} : \{\}\)\}/);
  assert.match(contextBar, /\{\.\.\.\(onOpen \? \{ onOpen \} : \{\}\)\}/);
});

test("git catalog defines the remote-branch refresh strings", async () => {
  const [en, de] = await Promise.all([
    read("../../../packages/git/src/i18n/en.ts"),
    read("../../../packages/git/src/i18n/de.ts"),
  ]);
  for (const catalog of [en, de]) {
    assert.match(catalog, /"gitview\.fetchRemoteBranches":/);
    assert.match(catalog, /"gitview\.fetchingRemoteBranches":/);
    assert.match(catalog, /"gitview\.remoteUnreachableShowingCached":/);
    assert.match(catalog, /"worktreesessiondialog\.aNewCheckoutWillTrack": ".*\{branch\}.*\{remote\}/);
  }
});
