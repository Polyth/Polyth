import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("worktree session dialog offers checked-out branches as isolation origins", async () => {
  const source = await read("../src/components/WorktreeSessionDialog.tsx");

  assert.match(source, /api\.listWorktrees\(\s*request\.projectId\)/);
  assert.match(source, /startIsolatedSession\(request\.projectId/);
  assert.match(source, /sourceSession && sourceSession.projectId === request.projectId/);
  assert.match(source, /targetBranch: origin/);
  assert.match(source, /tr\("isolation\.workInIsolation"\)/);
  assert.match(source, /!item\.branch\.startsWith\("polyth\/isolate\/"\)/);
  assert.doesNotMatch(source, /remoteBranches/);
  assert.doesNotMatch(source, /origin\/foo/);
});

test("new-session branch picker fetches the remote on open and lists remote branches", async () => {
  const [composer, contextBar] = await Promise.all([
    read("../src/components/Composer.tsx"),
    read("../src/components/mobile/SessionContextBar.tsx"),
  ]);

  assert.match(composer, /const refreshBranchesFromRemote = useCallback/);
  assert.match(composer, /await api\.gitFetch\(projectId\)\.catch\(\(\) => undefined\)/);
  assert.match(composer, /onBranchPickerOpen: refreshBranchesFromRemote/);
  assert.match(composer, /id: "new-worktree"/);
  assert.match(composer, /createDefaultWorktree\(/);
  assert.match(await read("../src/init.ts"), /api\.createWorktree\([\s\S]*?base \|\| undefined,[\s\S]*?true,/);
  assert.match(composer, /!worktree\.branch\?\.startsWith\("polyth\/isolate\/"\)/);
  assert.match(composer, /!candidate\.name\.startsWith\("polyth\/isolate\/"\)/);
  // Isolation only forks from a live checkout.
  assert.match(composer, /target: \{ kind: "isolation", base: currentBranchName \}/);
  assert.match(composer, /target: \{ kind: "isolation", base: name \}/);
  assert.doesNotMatch(composer, /kind: "isolation", base: remote\.ref/);
  // Remote-only branches remain available as ordinary linked worktrees.
  assert.match(composer, /id: `remote:\$\{remote\.ref\}`/);
  assert.match(composer, /target: \{ kind: "branch", branch: remote\.short, base: remote\.ref \}/);
  assert.match(composer, /api\.createWorktree\(\s*activeProjectId,\s*newSessionTarget\.branch,\s*undefined,\s*newSessionTarget\.base,/);

  assert.match(contextBar, /onBranchPickerOpen\?: \(\) => void;/);
  assert.match(contextBar, /onRefreshBranches\?: \(\) => void;/);
  assert.match(contextBar, /worktreesessiondialog\.filterByBranchOrPath/);
  assert.match(contextBar, /footerAction: \{/);
  assert.match(contextBar, /stayOpen: true/);
  assert.match(contextBar, /\{\.\.\.\(onBranchPickerOpen \? \{ onOpen: onBranchPickerOpen \} : \{\}\)\}/);
  assert.match(contextBar, /\{\.\.\.\(onOpen \? \{ onOpen \} : \{\}\)\}/);
  assert.match(contextBar, /className="context-isolation-control"/);
  assert.match(contextBar, /tr\("isolation\.isolate"\)/);
  assert.match(contextBar, /<Switch/);
  assert.doesNotMatch(contextBar, /popoverToggle|picker-toggle|worktreesessiondialog\.newWorktree/);
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

test("git view hides isolation implementation worktrees and branches", async () => {
  const source = await read("../../../packages/git/widgets/GitView.tsx");

  assert.match(source, /const visibleTrees = trees\.filter\(\(tree\) => !tree\.branch\?\.startsWith\("polyth\/isolate\/"\)\)/);
  assert.match(source, /!branch\.name\.startsWith\("polyth\/isolate\/"\)/);
  assert.match(source, /visibleTrees\.length/);
  assert.match(source, /visibleTrees\.map\(\(tree\) =>/);
});
