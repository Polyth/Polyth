import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RewindFileChange, RewindFileKept } from "@polyth/contracts";
import { createWorkspaceCheckpoints } from "../src/checkpoints.ts";

const dirs: string[] = [];

function createRepo(initialCommit = true): {
  dir: string;
  git: (...args: string[]) => string;
} {
  const dir = mkdtempSync(join(tmpdir(), "polyth-chk-test-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  if (initialCommit) {
    writeFileSync(join(dir, "README.md"), "# Initial\n");
    git("add", ".");
    git("commit", "-qm", "initial commit");
  }
  return { dir, git };
}

process.on("exit", () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("1. turn modifies a.txt, adds b.txt, deletes c.txt, chmod +x d.sh → preview kinds/counts; apply → all back; HEAD, index bytes unchanged", async () => {
  const { dir, git } = createRepo();
  writeFileSync(join(dir, "a.txt"), "line 1\n");
  writeFileSync(join(dir, "c.txt"), "delete me\n");
  writeFileSync(join(dir, "d.sh"), "echo hi\n");
  chmodSync(join(dir, "d.sh"), 0o644);
  git("add", ".");
  git("commit", "-qm", "base commit");

  const headBefore = git("rev-parse", "HEAD").trim();
  const diffCachedBefore = git("diff", "--cached");
  const indexBytesBefore = readFileSync(join(dir, ".git", "index"));

  const svc = createWorkspaceCheckpoints();
  const capBefore = await svc.capture({
    cwd: dir,
    sessionId: "sess-1",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in capBefore, "capBefore should have commit");

  // Turn edits
  writeFileSync(join(dir, "a.txt"), "line 1\nline 2\n");
  writeFileSync(join(dir, "b.txt"), "added b\n");
  rmSync(join(dir, "c.txt"));
  chmodSync(join(dir, "d.sh"), 0o755);

  const capAfter = await svc.capture({
    cwd: dir,
    sessionId: "sess-1",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in capAfter, "capAfter should have commit");

  const preview = await svc.previewRewind({
    cwd: dir,
    sessionId: "sess-1",
    turns: [
      {
        promptSeq: 1,
        before: capBefore.commit,
        after: capAfter.commit,
        touched: ["a.txt", "b.txt", "c.txt", "d.sh"],
      },
    ],
  });

  assert.equal(preview.available, true);
  assert.equal(preview.keep.length, 0);
  assert.equal(preview.restore.length, 4);

  const aChange = preview.restore.find((r: RewindFileChange) => r.path === "a.txt");
  assert.equal(aChange?.kind, "modified");
  assert.equal(aChange?.additions, 1);
  assert.equal(aChange?.deletions, 0);

  const bChange = preview.restore.find((r: RewindFileChange) => r.path === "b.txt");
  assert.equal(bChange?.kind, "added");
  assert.equal(bChange?.additions, 1);
  assert.equal(bChange?.deletions, 0);

  const cChange = preview.restore.find((r: RewindFileChange) => r.path === "c.txt");
  assert.equal(cChange?.kind, "deleted");
  assert.equal(cChange?.additions, 0);
  assert.equal(cChange?.deletions, 1);

  const dChange = preview.restore.find((r: RewindFileChange) => r.path === "d.sh");
  assert.equal(dChange?.kind, "modified");

  const outcome = await svc.applyRewind({
    cwd: dir,
    sessionId: "sess-1",
    turns: [
      {
        promptSeq: 1,
        before: capBefore.commit,
        after: capAfter.commit,
        touched: ["a.txt", "b.txt", "c.txt", "d.sh"],
      },
    ],
  });

  assert.equal(outcome.mode, "restored");
  assert.equal(outcome.restored, 4);
  assert.equal(outcome.kept, 0);
  assert(outcome.undo, "should have undo ref");
  assert(outcome.rolled, "should have rolled ref");

  // Verify file states
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "line 1\n");
  assert.equal(existsSync(join(dir, "b.txt")), false);
  assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "delete me\n");
  const dStat = readFileSync(join(dir, "d.sh"), "utf8");
  assert.equal(dStat, "echo hi\n");

  // Verify git index and HEAD are byte-identical
  assert.equal(git("rev-parse", "HEAD").trim(), headBefore);
  assert.equal(git("diff", "--cached"), diffCachedBefore);
  const indexBytesAfter = readFileSync(join(dir, ".git", "index"));
  assert.deepEqual(indexBytesAfter, indexBytesBefore);
});

test("2. a file edited after the turn → keep changed-after, content untouched", async () => {
  const { dir, git } = createRepo();
  writeFileSync(join(dir, "f.txt"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "f.txt commit");

  const svc = createWorkspaceCheckpoints();
  const capBefore = await svc.capture({
    cwd: dir,
    sessionId: "s2",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in capBefore);

  writeFileSync(join(dir, "f.txt"), "v2\n");
  const capAfter = await svc.capture({
    cwd: dir,
    sessionId: "s2",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in capAfter);

  // Edit after turn
  writeFileSync(join(dir, "f.txt"), "v3\n");

  const preview = await svc.previewRewind({
    cwd: dir,
    sessionId: "s2",
    turns: [
      {
        promptSeq: 1,
        before: capBefore.commit,
        after: capAfter.commit,
        touched: ["f.txt"],
      },
    ],
  });

  assert.equal(preview.available, false);
  assert.equal(preview.keep.length, 1);
  assert.equal(preview.keep[0]?.path, "f.txt");
  assert.equal(preview.keep[0]?.reason, "changed-after");

  const outcome = await svc.applyRewind({
    cwd: dir,
    sessionId: "s2",
    turns: [
      {
        promptSeq: 1,
        before: capBefore.commit,
        after: capAfter.commit,
        touched: ["f.txt"],
      },
    ],
  });

  assert.equal(outcome.mode, "unavailable");
  assert.equal(outcome.restored, 0);
  assert.equal(outcome.kept, 1);
  assert.equal(outcome.keptFiles?.[0]?.reason, "changed-after");
  assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "v3\n");
});

test("3. untracked file above maxFileBytes is not in the snapshot tree and is reported skipped; a skipped path is kept too-large", async () => {
  const { dir, git } = createRepo();
  const svc = createWorkspaceCheckpoints({ maxFileBytes: 50 });

  writeFileSync(join(dir, "big.txt"), "B".repeat(100));
  const cap = await svc.capture({
    cwd: dir,
    sessionId: "s3",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in cap);
  assert.deepEqual(cap.skipped, ["big.txt"]);

  const lsTree = git("ls-tree", "-r", cap.commit);
  assert.equal(lsTree.includes("big.txt"), false);

  writeFileSync(join(dir, "small.txt"), "small");
  const capAfter = await svc.capture({
    cwd: dir,
    sessionId: "s3",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in capAfter);

  const preview = await svc.previewRewind({
    cwd: dir,
    sessionId: "s3",
    turns: [
      {
        promptSeq: 1,
        before: cap.commit,
        after: capAfter.commit,
        touched: ["small.txt"],
        skipped: ["big.txt"],
      },
    ],
  });

  const keptBig = preview.keep.find((k: RewindFileKept) => k.path === "big.txt");
  assert.equal(keptBig?.reason, "too-large");
});

test("4. two turns, an outside edit between them on a path both touched → between-steps", async () => {
  const { dir, git } = createRepo();
  writeFileSync(join(dir, "shared.txt"), "init\n");
  git("add", ".");
  git("commit", "-qm", "shared commit");

  const svc = createWorkspaceCheckpoints();

  // Turn 1
  const b1 = await svc.capture({
    cwd: dir,
    sessionId: "s4",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in b1);
  writeFileSync(join(dir, "shared.txt"), "turn 1 edit\n");
  const a1 = await svc.capture({
    cwd: dir,
    sessionId: "s4",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in a1);

  // Outside edit between turns
  writeFileSync(join(dir, "shared.txt"), "outside edit\n");

  // Turn 2
  const b2 = await svc.capture({
    cwd: dir,
    sessionId: "s4",
    promptSeq: 2,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in b2);
  writeFileSync(join(dir, "shared.txt"), "turn 2 edit\n");
  const a2 = await svc.capture({
    cwd: dir,
    sessionId: "s4",
    promptSeq: 2,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in a2);

  const preview = await svc.previewRewind({
    cwd: dir,
    sessionId: "s4",
    turns: [
      {
        promptSeq: 1,
        before: b1.commit,
        after: a1.commit,
        touched: ["shared.txt"],
      },
      {
        promptSeq: 2,
        before: b2.commit,
        after: a2.commit,
        touched: ["shared.txt"],
      },
    ],
  });

  const keptShared = preview.keep.find((k: RewindFileKept) => k.path === "shared.txt");
  assert.equal(keptShared?.reason, "between-steps");
});

test("5. a second session's checkpoint window overlapping the turn: untouched changed path → other-chat; same scenario without overlap → restored with byCommand: true; touched path → restored regardless", async () => {
  const { dir, git } = createRepo();
  writeFileSync(join(dir, "touched.txt"), "t0\n");
  writeFileSync(join(dir, "cmd.txt"), "c0\n");
  git("add", ".");
  git("commit", "-qm", "files commit");

  let currentNow = 100000;
  const svc = createWorkspaceCheckpoints({ now: () => currentNow });

  // Session 1 turn
  currentNow = 100000;
  const s1_b1 = await svc.capture({
    cwd: dir,
    sessionId: "s1",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in s1_b1);

  // Overlapping session 2
  currentNow = 101000;
  const s2_b1 = await svc.capture({
    cwd: dir,
    sessionId: "s2",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in s2_b1);

  writeFileSync(join(dir, "touched.txt"), "t1\n");
  writeFileSync(join(dir, "cmd.txt"), "c1\n");

  currentNow = 102000;
  const s1_a1 = await svc.capture({
    cwd: dir,
    sessionId: "s1",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in s1_a1);

  currentNow = 103000;
  const s2_a1 = await svc.capture({
    cwd: dir,
    sessionId: "s2",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in s2_a1);

  // Overlap scenario: touched.txt was touched, cmd.txt was not
  const previewOverlap = await svc.previewRewind({
    cwd: dir,
    sessionId: "s1",
    turns: [
      {
        promptSeq: 1,
        before: s1_b1.commit,
        after: s1_a1.commit,
        touched: ["touched.txt"],
      },
    ],
  });

  const touchedOverlap = previewOverlap.restore.find((r: RewindFileChange) => r.path === "touched.txt");
  assert(touchedOverlap, "touched.txt should be restored");
  assert.equal(touchedOverlap.byCommand, undefined);

  const cmdOverlap = previewOverlap.keep.find((k: RewindFileKept) => k.path === "cmd.txt");
  assert.equal(cmdOverlap?.reason, "other-chat");

  // Now remove session 2's refs and add session 3 with non-overlapping window
  await svc.forget("s2", dir);

  currentNow = 200000;
  const s3_b1 = await svc.capture({
    cwd: dir,
    sessionId: "s3",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in s3_b1);
  currentNow = 201000;
  const s3_a1 = await svc.capture({
    cwd: dir,
    sessionId: "s3",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in s3_a1);

  // Without overlap: cmd.txt is attributed with byCommand: true
  const previewNoOverlap = await svc.previewRewind({
    cwd: dir,
    sessionId: "s1",
    turns: [
      {
        promptSeq: 1,
        before: s1_b1.commit,
        after: s1_a1.commit,
        touched: ["touched.txt"],
      },
    ],
  });

  const touchedNoOverlap = previewNoOverlap.restore.find((r: RewindFileChange) => r.path === "touched.txt");
  assert(touchedNoOverlap, "touched.txt should be restored");

  const cmdNoOverlap = previewNoOverlap.restore.find((r: RewindFileChange) => r.path === "cmd.txt");
  assert(cmdNoOverlap, "cmd.txt should be restored");
  assert.equal(cmdNoOverlap.byCommand, true);
});

test("6. redo: applyRewind then applyRestore puts the pre-rollback content back; a file edited after rollback is kept changed-after", async () => {
  const { dir, git } = createRepo();
  writeFileSync(join(dir, "f1.txt"), "orig1\n");
  writeFileSync(join(dir, "f2.txt"), "orig2\n");
  git("add", ".");
  git("commit", "-qm", "files commit");

  const svc = createWorkspaceCheckpoints();
  const b = await svc.capture({
    cwd: dir,
    sessionId: "s6",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in b);

  writeFileSync(join(dir, "f1.txt"), "turn1\n");
  writeFileSync(join(dir, "f2.txt"), "turn2\n");

  const a = await svc.capture({
    cwd: dir,
    sessionId: "s6",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in a);

  const rewindOutcome = await svc.applyRewind({
    cwd: dir,
    sessionId: "s6",
    turns: [
      {
        promptSeq: 1,
        before: b.commit,
        after: a.commit,
        touched: ["f1.txt", "f2.txt"],
      },
    ],
  });

  assert.equal(rewindOutcome.mode, "restored");
  assert.equal(rewindOutcome.restored, 2);
  assert.equal(readFileSync(join(dir, "f1.txt"), "utf8"), "orig1\n");
  assert.equal(readFileSync(join(dir, "f2.txt"), "utf8"), "orig2\n");

  // Edit f2 after rollback
  writeFileSync(join(dir, "f2.txt"), "user_edit\n");

  const prevRestore = await svc.previewRestore({
    cwd: dir,
    undo: rewindOutcome.undo!,
    rolled: rewindOutcome.rolled!,
    paths: rewindOutcome.paths!,
  });

  assert.equal(prevRestore.restore, 1);
  const keptF2 = prevRestore.keep.find((k: RewindFileKept) => k.path === "f2.txt");
  assert.equal(keptF2?.reason, "changed-after");

  const restoreOutcome = await svc.applyRestore({
    cwd: dir,
    undo: rewindOutcome.undo!,
    rolled: rewindOutcome.rolled!,
    paths: rewindOutcome.paths!,
  });

  assert.equal(restoreOutcome.restored, 1);
  assert.equal(restoreOutcome.kept, 1);
  assert.equal(restoreOutcome.keptFiles[0]?.path, "f2.txt");
  assert.equal(restoreOutcome.keptFiles[0]?.reason, "changed-after");

  // f1 is restored back to turn1
  assert.equal(readFileSync(join(dir, "f1.txt"), "utf8"), "turn1\n");
  // f2 is left as user_edit
  assert.equal(readFileSync(join(dir, "f2.txt"), "utf8"), "user_edit\n");
});

test("7. a parent directory replaced by a symlink to a dir outside the repo → kept unsupported, nothing written outside", async () => {
  const { dir } = createRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), "polyth-outside-"));
  dirs.push(outsideDir);
  writeFileSync(join(outsideDir, "sentinel.txt"), "safe\n");

  const svc = createWorkspaceCheckpoints();
  const b = await svc.capture({
    cwd: dir,
    sessionId: "s7",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in b);

  // Turn creates sub/nested.txt
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "nested.txt"), "turn content\n");

  const a = await svc.capture({
    cwd: dir,
    sessionId: "s7",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in a);

  // Replace sub with a symlink to outsideDir
  rmSync(join(dir, "sub"), { recursive: true, force: true });
  symlinkSync(outsideDir, join(dir, "sub"));

  const outcome = await svc.applyRewind({
    cwd: dir,
    sessionId: "s7",
    turns: [
      {
        promptSeq: 1,
        before: b.commit,
        after: a.commit,
        touched: ["sub/nested.txt"],
      },
    ],
  });

  assert.equal(outcome.mode, "unavailable");
  assert.equal(outcome.kept, 1);
  assert.equal(outcome.keptFiles?.[0]?.path, "sub/nested.txt");
  assert.equal(outcome.keptFiles?.[0]?.reason, "unsupported");

  // Verify outside dir was untouched
  assert.equal(existsSync(join(outsideDir, "sentinel.txt")), true);
  assert.equal(existsSync(join(outsideDir, "nested.txt")), false);
});

test("8. not a repo → not-git; branch switched between checkpoint and preview → branch-changed; refs created only under refs/polyth/checkpoints and forget() removes them", async () => {
  const notRepoDir = mkdtempSync(join(tmpdir(), "polyth-not-git-"));
  dirs.push(notRepoDir);

  const svc = createWorkspaceCheckpoints();
  const capNotGit = await svc.capture({
    cwd: notRepoDir,
    sessionId: "s8",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert.equal("unavailable" in capNotGit && capNotGit.unavailable, "not-git");

  const prevNotGit = await svc.previewRewind({
    cwd: notRepoDir,
    sessionId: "s8",
    turns: [],
  });
  assert.equal(prevNotGit.available, false);
  assert.equal(prevNotGit.reason, "not-git");

  // Branch switched test
  const { dir, git } = createRepo();
  const b = await svc.capture({
    cwd: dir,
    sessionId: "s8",
    promptSeq: 1,
    phase: "before",
    budgetMs: 10000,
  });
  assert("commit" in b);

  git("checkout", "-b", "feature");

  const prevBranch = await svc.previewRewind({
    cwd: dir,
    sessionId: "s8",
    turns: [
      {
        promptSeq: 1,
        before: b.commit,
        after: b.commit,
        touched: [],
      },
    ],
  });
  assert.equal(prevBranch.available, false);
  assert.equal(prevBranch.reason, "branch-changed");

  // Switch back to main to test refs & forget
  git("checkout", "main");
  const a = await svc.capture({
    cwd: dir,
    sessionId: "s8",
    promptSeq: 1,
    phase: "after",
    budgetMs: 10000,
  });
  assert("commit" in a);

  const allRefs = git("for-each-ref", "--format=%(refname)");
  const lines = allRefs.split("\n").filter(Boolean);
  const checkpointRefs = lines.filter((r) => r.startsWith("refs/polyth/checkpoints/"));
  assert(checkpointRefs.length >= 2, "checkpoint refs should exist");

  // Forget session s8
  await svc.forget("s8", dir);

  const refsAfter = git("for-each-ref", "--format=%(refname)", "refs/polyth/checkpoints/s8/");
  assert.equal(refsAfter.trim(), "");
});

test("9. invalid sessionId throws with code invalid-input", async () => {
  const { dir } = createRepo();
  const svc = createWorkspaceCheckpoints();

  await assert.rejects(
    async () => {
      await svc.capture({
        cwd: dir,
        sessionId: "invalid/session/id",
        promptSeq: 1,
        phase: "before",
        budgetMs: 5000,
      });
    },
    (err: any) => err.code === "invalid-input",
  );
});

test("10. retention drops lowest promptSeq first and protects undo/rolled refs", async () => {
  const { dir, git } = createRepo();
  let currentNow = 10000;
  const svc = createWorkspaceCheckpoints({
    keepPerSession: 4,
    now: () => currentNow,
  });

  // Create prompt 1 before & after
  currentNow = 10000;
  const b1 = await svc.capture({ cwd: dir, sessionId: "ret-test", promptSeq: 1, phase: "before", budgetMs: 10000 });
  assert("commit" in b1);
  currentNow = 11000;
  const a1 = await svc.capture({ cwd: dir, sessionId: "ret-test", promptSeq: 1, phase: "after", budgetMs: 10000 });
  assert("commit" in a1);

  // Create prompt 2 before & after
  currentNow = 12000;
  const b2 = await svc.capture({ cwd: dir, sessionId: "ret-test", promptSeq: 2, phase: "before", budgetMs: 10000 });
  assert("commit" in b2);
  currentNow = 13000;
  const a2 = await svc.capture({ cwd: dir, sessionId: "ret-test", promptSeq: 2, phase: "after", budgetMs: 10000 });
  assert("commit" in a2);

  // Total 4 refs now: 1-before, 1-after, 2-before, 2-after
  let refs = git("for-each-ref", "--format=%(refname)", "refs/polyth/checkpoints/ret-test/").trim().split("\n");
  assert.equal(refs.length, 4);

  // Create prompt 3 before: total 5 refs -> exceeds keepPerSession (4), drops lowest promptSeq (1-before)
  currentNow = 14000;
  const b3 = await svc.capture({ cwd: dir, sessionId: "ret-test", promptSeq: 3, phase: "before", budgetMs: 10000 });
  assert("commit" in b3);

  refs = git("for-each-ref", "--format=%(refname)", "refs/polyth/checkpoints/ret-test/").trim().split("\n");
  assert.equal(refs.length, 4);
  assert.equal(refs.includes("refs/polyth/checkpoints/ret-test/1-before"), false);
  assert.equal(refs.includes("refs/polyth/checkpoints/ret-test/3-before"), true);
});

// Regression: each path is compared and restored against the turns that
// changed it, never the range's outer snapshots. An edit someone made between
// two of the chat's turns must survive a rollback of both turns.
test("12. an outside edit between turns survives: first-change and last-change snapshots are per path", async () => {
  const { dir, git } = createRepo();
  writeFileSync(join(dir, "x.txt"), "x0\n");
  writeFileSync(join(dir, "p.txt"), "p0\n");
  writeFileSync(join(dir, "q.txt"), "q0\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const svc = createWorkspaceCheckpoints();
  const cap = async (promptSeq: number, phase: "before" | "after") => {
    const result = await svc.capture({ cwd: dir, sessionId: "per-path", promptSeq, phase, budgetMs: 10000 });
    assert.ok("commit" in result);
    return result.commit;
  };

  const b1 = await cap(1, "before");
  writeFileSync(join(dir, "x.txt"), "x1 agent\n");
  writeFileSync(join(dir, "q.txt"), "q1 agent\n");
  const a1 = await cap(1, "after");

  // Between the turns a person edits p.txt (never touched by turn 1) and q.txt
  // (which turn 1 changed and turn 2 leaves alone).
  writeFileSync(join(dir, "p.txt"), "p0 person\n");
  writeFileSync(join(dir, "q.txt"), "q1 agent + person\n");

  const b2 = await cap(3, "before");
  writeFileSync(join(dir, "p.txt"), "p0 person\np2 agent\n");
  const a2 = await cap(3, "after");

  const turns = [
    { promptSeq: 1, before: b1, after: a1, touched: ["x.txt", "q.txt"] },
    { promptSeq: 3, before: b2, after: a2, touched: ["p.txt"] },
  ];
  const outcome = await svc.applyRewind({ cwd: dir, sessionId: "per-path", turns });
  assert.equal(outcome.mode, "restored");
  // x.txt: changed only by turn 1, untouched since → back to x0.
  assert.equal(readFileSync(join(dir, "x.txt"), "utf8"), "x0\n");
  // p.txt: first changed by turn 2 → back to the person's version, not p0.
  assert.equal(readFileSync(join(dir, "p.txt"), "utf8"), "p0 person\n");
  // q.txt: the person edited it after turn 1 left it → stays as it is.
  assert.equal(readFileSync(join(dir, "q.txt"), "utf8"), "q1 agent + person\n");
  assert.ok(outcome.keptFiles?.some((kept) => kept.path === "q.txt" && kept.reason === "changed-after"));
});
