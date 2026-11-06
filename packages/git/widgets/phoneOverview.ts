// DOM-free decisions behind the phone Source Control overview (GitPhoneView):
// what changed, which state that puts the checkout in, and what a commit from
// the phone stages first. The view renders these and owns nothing about Git.
import type { GitFileEntry, GitStatus } from "@polyth/session/web-api";
import type { DiffLineStats } from "./PendingChangesBar.tsx";

/** One changed path. Git reports a partly staged file twice; a phone lists it once. */
export interface PhoneChange {
  path: string;
  origPath?: string;
  /** Status to draw: the index's view when it has one. */
  status: string;
  conflicted: boolean;
  /** The file's entry in the index, when any of it is staged. */
  staged?: GitFileEntry;
  /** Its unstaged, untracked or conflicted entry. */
  working?: GitFileEntry;
  /** Both entries summed; absent until a diff has been read. */
  stats?: DiffLineStats;
}

export function phoneChanges(
  status: GitStatus | null,
  statsFor: (file: GitFileEntry) => DiffLineStats | undefined,
): PhoneChange[] {
  if (!status || status.isRepo === false) return [];
  const byPath = new Map<string, PhoneChange>();
  const add = (file: GitFileEntry, slot: "staged" | "working") => {
    const current = byPath.get(file.path);
    const stats = statsFor(file);
    const summed = stats || current?.stats
      ? {
        additions: (current?.stats?.additions ?? 0) + (stats?.additions ?? 0),
        deletions: (current?.stats?.deletions ?? 0) + (stats?.deletions ?? 0),
      }
      : undefined;
    const conflicted = (current?.conflicted ?? false) || file.status === "conflicted";
    byPath.set(file.path, {
      path: file.path,
      ...(file.origPath ?? current?.origPath ? { origPath: file.origPath ?? current?.origPath } : {}),
      status: conflicted ? "conflicted" : current?.staged?.status ?? file.status,
      conflicted,
      ...(current?.staged ? { staged: current.staged } : {}),
      ...(current?.working ? { working: current.working } : {}),
      [slot]: file,
      ...(summed ? { stats: summed } : {}),
    });
  };
  for (const file of status.conflicted) add(file, "working");
  for (const file of status.staged) add(file, "staged");
  for (const file of status.unstaged) add(file, "working");
  for (const file of status.untracked) add(file, "working");
  return [...byPath.values()].sort((left, right) =>
    Number(right.conflicted) - Number(left.conflicted) || left.path.localeCompare(right.path));
}

/** Which entry a tap on the row opens: what is not staged yet, else the index. */
export function phoneChangeEntry(change: PhoneChange): GitFileEntry {
  return (change.working ?? change.staged)!;
}

export const isPartlyStaged = (change: PhoneChange): boolean => Boolean(change.staged && change.working);

/** Explicit include/exclude choices, by path. Everything else follows the default. */
export type CommitPicks = ReadonlyMap<string, boolean>;

/**
 * The commit starts from what the index already says. An empty index means
 * nobody chose yet, so everything goes in; a non-empty one was chosen on
 * purpose (hunks staged here, a desktop session, an agent), so only those files
 * do. A conflicted file can never be committed.
 */
export function isChangeIncluded(change: PhoneChange, changes: readonly PhoneChange[], picks: CommitPicks): boolean {
  if (change.conflicted) return false;
  const pick = picks.get(change.path);
  if (pick !== undefined) return pick;
  return changes.some((candidate) => candidate.staged) ? Boolean(change.staged) : true;
}

export function includedChanges(changes: readonly PhoneChange[], picks: CommitPicks): PhoneChange[] {
  return changes.filter((change) => isChangeIncluded(change, changes, picks));
}

/**
 * What to do to the index so a plain commit records exactly the included files.
 * A partly staged file keeps its staged part: that hunk selection is the choice
 * someone made, and the row says so. Excluding a file unstages it.
 */
export function commitStagePlan(changes: readonly PhoneChange[], picks: CommitPicks): { stage: string[]; unstage: string[] } {
  const stage: string[] = [];
  const unstage: string[] = [];
  for (const change of changes) {
    if (change.conflicted) continue;
    const included = isChangeIncluded(change, changes, picks);
    if (included && !change.staged) stage.push(change.path);
    if (!included && change.staged) unstage.push(change.path);
  }
  return { stage, unstage };
}

export type PhoneOverviewState =
  /** A checkout stopped mid-merge, or an isolated chat whose landing conflicts. */
  | { kind: "conflict"; source: "merge" | "isolation"; count: number }
  /** Uncommitted work. */
  | { kind: "changes"; files: number; additions: number; deletions: number }
  /** An isolated branch with committed work to integrate. */
  | { kind: "ready"; commits: number; files: number; additions: number; deletions: number }
  /** An ordinary branch out of step with its upstream. */
  | { kind: "remote"; ahead: number; behind: number }
  /** An isolated branch whose comparison has not answered yet. */
  | { kind: "checking" }
  | { kind: "clean" };

export interface BranchDiffSummary {
  ahead: number;
  files: readonly { additions?: number; deletions?: number }[];
}

export function phoneOverviewState(input: {
  changes: readonly PhoneChange[];
  status: Pick<GitStatus, "ahead" | "behind"> | null;
  isolated: boolean;
  /** Files of an isolation conflict; null while none is recorded. */
  isolationConflict: number | null;
  /** Isolated chats only; null until it answers. */
  branchDiff: BranchDiffSummary | null;
  branchDiffPending: boolean;
}): PhoneOverviewState {
  const { changes, status, isolated, isolationConflict, branchDiff, branchDiffPending } = input;
  const merge = changes.filter((change) => change.conflicted).length;
  if (merge > 0) return { kind: "conflict", source: "merge", count: merge };
  if (isolationConflict !== null) return { kind: "conflict", source: "isolation", count: isolationConflict };
  if (changes.length > 0) {
    return {
      kind: "changes",
      files: changes.length,
      additions: changes.reduce((sum, change) => sum + (change.stats?.additions ?? 0), 0),
      deletions: changes.reduce((sum, change) => sum + (change.stats?.deletions ?? 0), 0),
    };
  }
  if (isolated && branchDiff && branchDiff.files.length > 0) {
    return {
      kind: "ready",
      commits: branchDiff.ahead,
      files: branchDiff.files.length,
      additions: branchDiff.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: branchDiff.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    };
  }
  if (isolated && !branchDiff && branchDiffPending) return { kind: "checking" };
  if (status && (status.ahead > 0 || status.behind > 0)) return { kind: "remote", ahead: status.ahead, behind: status.behind };
  return { kind: "clean" };
}
