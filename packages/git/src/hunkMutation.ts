import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { hunkDigest, splitHunks } from "./hunks.ts";

export type GitHunkOperation = "stage" | "unstage" | "discard";

export interface GitHunkMutationInput {
  path: string;
  hunkIndex: number;
  hunkDigest: string;
  expectedSnapshotDigest: string;
  ignoreWhitespace?: boolean;
}

/** Structural subset of GitService so the mutation logic is independently
 * testable while canonical GitService remains the source of current diffs. */
export interface HunkDiffSource {
  diff(
    root: string,
    opts?: { path?: string; staged?: boolean; ignoreWhitespace?: boolean },
  ): Promise<{ path: string | null; diff: string }>;
}

export interface HunkPatchRunner {
  apply(root: string, args: string[], patch: string): Promise<void>;
}

const stale = (): Error => Object.assign(
  new Error("These changes changed since you opened the diff. Refresh and review the current version."),
  { code: "stale-hunk" },
);

const unsupported = (message: string): Error => Object.assign(
  new Error(message),
  { code: "unsupported-diff" },
);

export function gitDiffSnapshotDigest(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

function assertTextPatch(diff: string): void {
  if (/^GIT binary patch$/m.test(diff) || /^Binary files .+ differ$/m.test(diff)) {
    throw unsupported("Binary changes cannot be mutated by hunk.");
  }
  // Rename/copy metadata applies at file identity level rather than hunk level.
  // Submodules similarly have no safe textual working-tree patch semantics.
  if (/^(rename|copy) (from|to) /m.test(diff) || /^Subproject commit /m.test(diff)) {
    throw unsupported("Rename, copy, and submodule changes must be handled at file level.");
  }
}

function patchForHunk(diff: string, index: number, expectedDigest: string): string {
  assertTextPatch(diff);
  const hunks = splitHunks(diff);
  const hunk = hunks[index];
  if (!hunk || hunkDigest(hunk) !== expectedDigest) throw stale();

  // Preserve the exact Git-produced bytes for the selected hunk rather than
  // reconstructing them from parsed lines. This retains CRLF/no-newline marker
  // details while still sharing one canonical parser for hunk identity.
  const matches = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm)];
  const start = matches[index]?.index;
  if (start === undefined || matches[0]?.index === undefined) throw stale();
  const end = matches[index + 1]?.index ?? diff.length;
  return `${diff.slice(0, matches[0].index)}${diff.slice(start, end)}`;
}

/** argv-only + stdin patch application. No user input is interpolated into a
 * shell command; GIT_TERMINAL_PROMPT remains disabled like the core Git runner. */
export function createHunkPatchRunner(
  gitBin = process.env.POLYTH_GIT_BIN ?? "git",
): HunkPatchRunner {
  return {
    apply(root, args, patch) {
      return new Promise<void>((resolve, reject) => {
        const child = execFile(
          gitBin,
          args,
          {
            cwd: root,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            maxBuffer: 8 * 1024 * 1024,
          },
          (error, _stdout, stderr) => {
            if (!error) {
              resolve();
              return;
            }
            reject(Object.assign(
              new Error(String(stderr || error.message).trim() || "Git could not apply this hunk."),
              { code: "git-failed" },
            ));
          },
        );
        child.stdin?.end(patch);
      });
    },
  };
}

/** Reconstruct the authoritative current diff, verify exact snapshot + exact
 * indexed hunk identity, and only then mutate index/worktree state. */
export async function mutateGitHunk(
  source: HunkDiffSource,
  root: string,
  operation: GitHunkOperation,
  input: GitHunkMutationInput,
  runner: HunkPatchRunner = createHunkPatchRunner(),
): Promise<{ snapshotDigest: string }> {
  if (
    !Number.isSafeInteger(input.hunkIndex)
    || input.hunkIndex < 0
    || !/^[0-9a-f]{8}$/.test(input.hunkDigest)
    || !/^[0-9a-f]{64}$/.test(input.expectedSnapshotDigest)
  ) {
    throw Object.assign(new Error("invalid hunk identity"), { code: "invalid-input" });
  }

  const staged = operation === "unstage";
  const current = await source.diff(root, {
    path: input.path,
    staged,
    ...(input.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
  });
  const snapshotDigest = gitDiffSnapshotDigest(current.diff);
  if (snapshotDigest !== input.expectedSnapshotDigest) throw stale();

  const patch = patchForHunk(current.diff, input.hunkIndex, input.hunkDigest);
  const args = ["apply", "--whitespace=nowarn"];
  if (operation === "stage") args.push("--cached");
  if (operation === "unstage") args.push("--cached", "--reverse");
  if (operation === "discard") args.push("--reverse");
  args.push("-");
  await runner.apply(root, args, patch);
  return { snapshotDigest };
}
