import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  RewindFileChange,
  RewindFileKept,
  RewindFilesOutcome,
  RewindFilesPreview,
  RewindFilesUnavailableReason,
  RewindRestorePreview,
  WorkspaceCheckpointUnavailable,
} from "@polyth/contracts";
import type {
  WorkspaceCheckpointCaptureResult,
  WorkspaceCheckpointService,
  WorkspaceCheckpointTurn,
  WorkspaceRestoreInput,
} from "@polyth/plugins";
import { resolveGitBinary } from "./gitBinary.ts";

export interface WorkspaceCheckpointOptions {
  maxFileBytes?: number;
  keepPerSession?: number;
  now?: () => number;
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB
const DEFAULT_KEEP_PER_SESSION = 200;

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

interface GitExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
  maxBuffer?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface GitExecResult {
  stdout: string;
  stderr: string;
  stdoutRaw: Buffer;
  code: number;
}

function execGit(
  bin: string,
  args: string[],
  opts: GitExecOptions = {},
): Promise<GitExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        timeout: opts.timeoutMs,
        signal: opts.signal,
        encoding: "buffer",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          ...(opts.env ?? {}),
        },
      },
      (err, stdoutBuf, stderrBuf) => {
        const stdout = Buffer.isBuffer(stdoutBuf)
          ? stdoutBuf
          : Buffer.from(stdoutBuf || "");
        const stderr = Buffer.isBuffer(stderrBuf)
          ? stderrBuf.toString("utf8")
          : String(stderrBuf || "");
        if (err) {
          const execErr = err as Error & {
            code?: number | string;
            killed?: boolean;
          };
          reject(
            Object.assign(new Error(stderr || execErr.message), {
              cause: execErr,
              code: execErr.code,
              killed: execErr.killed,
              stderr,
            }),
          );
          return;
        }
        resolvePromise({
          stdout: stdout.toString("utf8"),
          stderr,
          stdoutRaw: stdout,
          code: 0,
        });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.input);
    }
  });
}

const rootMutexes = new Map<string, Promise<unknown>>();

function withRootMutex<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const prev = rootMutexes.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  rootMutexes.set(
    key,
    next.finally(() => {
      if (rootMutexes.get(key) === next) {
        rootMutexes.delete(key);
      }
    }),
  );
  return next;
}

async function resolveGitRoot(bin: string, cwd: string): Promise<string | null> {
  try {
    const res = await execGit(bin, ["rev-parse", "--show-toplevel"], { cwd });
    const trimmed = res.stdout.trim();
    return trimmed ? resolve(trimmed) : null;
  } catch {
    return null;
  }
}

interface TreeSnapshotResult {
  treeSha: string;
  skipped: string[];
}

async function createPrivateSnapshotTree(
  bin: string,
  root: string,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<TreeSnapshotResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "polyth-chk-"));
  const tempIndex = join(tempDir, "index");
  try {
    let copiedRealIndex = false;
    try {
      const gitPathRes = await execGit(
        bin,
        ["rev-parse", "--git-path", "index"],
        { cwd: root, signal },
      );
      const rawGitPath = gitPathRes.stdout.trim();
      const realIndexPath = isAbsolute(rawGitPath)
        ? rawGitPath
        : resolve(root, rawGitPath);
      await copyFile(realIndexPath, tempIndex);
      copiedRealIndex = true;
    } catch {
      copiedRealIndex = false;
    }

    if (!copiedRealIndex) {
      let headExists = false;
      try {
        await execGit(bin, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], {
          cwd: root,
          signal,
        });
        headExists = true;
      } catch {
        headExists = false;
      }
      if (headExists) {
        await execGit(bin, ["read-tree", "HEAD"], {
          cwd: root,
          env: { GIT_INDEX_FILE: tempIndex },
          signal,
        });
      } else {
        await execGit(bin, ["read-tree", "--empty"], {
          cwd: root,
          env: { GIT_INDEX_FILE: tempIndex },
          signal,
        });
      }
    }

    const lsRes = await execGit(
      bin,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: root, signal },
    );
    const untracked = lsRes.stdout.split("\0").filter(Boolean);
    const skipped: string[] = [];

    for (const relPath of untracked) {
      const absPath = resolve(root, relPath);
      try {
        const st = await lstat(absPath);
        if (st.isFile() && st.size > maxFileBytes) {
          skipped.push(relPath);
        }
      } catch {
        // ignore missing or inaccessible files
      }
    }

    if (skipped.length === 0) {
      await execGit(bin, ["add", "-A", "--", "."], {
        cwd: root,
        env: { GIT_INDEX_FILE: tempIndex },
        signal,
      });
    } else {
      const pathspecFile = join(tempDir, "pathspec");
      const pathspecContent =
        ".\0" +
        skipped
          .map((s) => `:(exclude,literal)${s}`)
          .join("\0") +
        "\0";
      await writeFile(pathspecFile, pathspecContent);
      await execGit(
        bin,
        [
          "add",
          "-A",
          `--pathspec-from-file=${pathspecFile}`,
          "--pathspec-file-nul",
        ],
        {
          cwd: root,
          env: { GIT_INDEX_FILE: tempIndex },
          signal,
        },
      );
    }

    const writeTreeRes = await execGit(bin, ["write-tree"], {
      cwd: root,
      env: { GIT_INDEX_FILE: tempIndex },
      signal,
    });
    const treeSha = writeTreeRes.stdout.trim();
    return { treeSha, skipped };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
}

async function getTreeEntries(
  bin: string,
  root: string,
  treeish: string,
  signal?: AbortSignal,
): Promise<Map<string, TreeEntry>> {
  const map = new Map<string, TreeEntry>();
  const res = await execGit(bin, ["ls-tree", "-r", "-z", treeish], {
    cwd: root,
    signal,
  });
  const tokens = res.stdout.split("\0").filter(Boolean);
  for (const token of tokens) {
    const tabIdx = token.indexOf("\t");
    if (tabIdx === -1) continue;
    const meta = token.slice(0, tabIdx);
    const path = token.slice(tabIdx + 1);
    const metaParts = meta.split(" ");
    const mode = metaParts[0];
    const type = metaParts[1];
    const oid = metaParts[2];
    if (mode && type && oid && path) {
      map.set(path, { mode, type, oid });
    }
  }
  return map;
}

function parseCommitMessageKeys(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = body.split("\n");
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      result[key] = val;
    }
  }
  return result;
}

function normalizeTouched(
  paths: string[],
  cwd: string,
  root: string,
): Set<string> {
  const set = new Set<string>();
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const normalized = rel.split(sep).join(posix.sep);
    set.add(normalized);
  }
  return set;
}

interface NumstatEntry {
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

async function getNumstat(
  bin: string,
  root: string,
  commitA: string,
  commitB: string,
  signal?: AbortSignal,
): Promise<Map<string, NumstatEntry>> {
  const map = new Map<string, NumstatEntry>();
  const res = await execGit(
    bin,
    ["diff-tree", "-r", "--no-renames", "--numstat", "-z", commitA, commitB],
    { cwd: root, signal },
  );
  const tokens = res.stdout.split("\0").filter(Boolean);
  for (const token of tokens) {
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const add = parts[0];
    const del = parts[1];
    const path = parts.slice(2).join("\t");
    if (!add || !del || !path) continue;
    if (add === "-" && del === "-") {
      map.set(path, { binary: true });
    } else {
      map.set(path, {
        additions: parseInt(add, 10) || 0,
        deletions: parseInt(del, 10) || 0,
      });
    }
  }
  return map;
}

async function getDiffTreePaths(
  bin: string,
  root: string,
  treeA: string,
  treeB: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const set = new Set<string>();
  const res = await execGit(
    bin,
    ["diff-tree", "-r", "--no-renames", "-z", treeA, treeB],
    { cwd: root, signal },
  );
  const tokens = res.stdout.split("\0");
  for (let i = 0; i < tokens.length - 1; i += 2) {
    const meta = tokens[i];
    const path = tokens[i + 1];
    if (meta && path && meta.startsWith(":")) {
      set.add(path);
    }
  }
  return set;
}

interface OtherSessionWindow {
  start: number;
  end: number;
}

async function getOtherSessionWindows(
  bin: string,
  root: string,
  currentSessionId: string,
  nowMs: number,
  signal?: AbortSignal,
): Promise<OtherSessionWindow[]> {
  const windows: OtherSessionWindow[] = [];
  let out = "";
  try {
    const res = await execGit(
      bin,
      [
        "for-each-ref",
        "--format=%(refname)%00%(contents)%00",
        "refs/polyth/checkpoints/",
      ],
      { cwd: root, signal },
    );
    out = res.stdout;
  } catch {
    return windows;
  }

  const tokens = out.split("\0");
  interface RefInfo {
    session: string;
    promptSeq?: number;
    phase?: string;
    at: number;
  }

  const bySession = new Map<string, RefInfo[]>();

  for (let i = 0; i < tokens.length - 1; i += 2) {
    const rawRefname = tokens[i];
    const rawContents = tokens[i + 1];
    if (!rawRefname || rawContents === undefined) continue;
    const refname = rawRefname.trim();
    const contents = rawContents;

    const prefix = "refs/polyth/checkpoints/";
    if (!refname.startsWith(prefix)) continue;
    const rest = refname.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const sess = rest.slice(0, slash);
    if (sess === currentSessionId) continue;

    const keys = parseCommitMessageKeys(contents);
    const recordedRoot = keys["root"] ? resolve(keys["root"]) : null;
    if (recordedRoot !== resolve(root)) continue;

    const at = parseInt(keys["at"] || "0", 10);
    const phase = keys["phase"];
    const promptSeq = keys["prompt"] ? parseInt(keys["prompt"], 10) : undefined;

    let list = bySession.get(sess);
    if (!list) {
      list = [];
      bySession.set(sess, list);
    }
    list.push({ session: sess, promptSeq, phase, at });
  }

  for (const [, list] of bySession) {
    list.sort((a, b) => a.at - b.at);
    const promptMap = new Map<
      number,
      { before?: RefInfo; after?: RefInfo }
    >();

    for (const info of list) {
      if (info.promptSeq !== undefined) {
        let entry = promptMap.get(info.promptSeq);
        if (!entry) {
          entry = {};
          promptMap.set(info.promptSeq, entry);
        }
        if (info.phase === "before") entry.before = info;
        if (info.phase === "after") entry.after = info;
      }
    }

    for (const [, entry] of promptMap) {
      if (entry.before && entry.after) {
        windows.push({ start: entry.before.at, end: entry.after.at });
      } else if (entry.before && !entry.after) {
        const nextCheck = list.find((c) => c.at > entry.before!.at);
        const end = nextCheck ? nextCheck.at : nowMs;
        windows.push({ start: entry.before.at, end });
      }
    }
  }

  return windows;
}

async function matchesTreeEntry(
  bin: string,
  root: string,
  p: string,
  abs: string,
  expected: TreeEntry | undefined,
): Promise<boolean> {
  let st;
  try {
    st = await lstat(abs);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return expected === undefined;
    }
    return false;
  }
  if (expected === undefined) {
    return false;
  }
  if (st.isSymbolicLink()) {
    if (expected.mode !== "120000") return false;
    try {
      const target = await readlink(abs);
      const res = await execGit(bin, ["hash-object", "--stdin"], {
        cwd: root,
        input: target,
      });
      return res.stdout.trim() === expected.oid;
    } catch {
      return false;
    }
  }
  const isExecutable = (st.mode & 0o111) !== 0;
  const expectedExec = expected.mode === "100755";
  if (isExecutable !== expectedExec) return false;
  try {
    const res = await execGit(bin, ["hash-object", `--path=${p}`, abs], {
      cwd: root,
    });
    return res.stdout.trim() === expected.oid;
  } catch {
    return false;
  }
}

async function isSafePath(root: string, p: string): Promise<boolean> {
  if (isAbsolute(p)) return false;
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = p.split(posix.sep);
  if (parts.includes("..")) return false;

  const parentParts = parts.slice(0, -1);
  let cur = root;
  for (const part of parentParts) {
    cur = join(cur, part);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return false;
      }
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== "ENOENT") {
        return false;
      }
    }
  }
  return true;
}

interface RewindPlan {
  available: boolean;
  reason?: RewindFilesUnavailableReason;
  restore: RewindFileChange[];
  keep: RewindFileKept[];
  root: string;
  beforeFirstEntries: Map<string, TreeEntry>;
  afterLastEntries: Map<string, TreeEntry>;
  uEntries: Map<string, TreeEntry>;
  /** Per restorable path: the snapshot commit holding its pre-agent content. */
  sourceCommits: Map<string, string>;
}

async function computeRewindPlan(
  bin: string,
  input: {
    cwd: string;
    sessionId: string;
    turns: WorkspaceCheckpointTurn[];
  },
  maxFileBytes: number,
  nowMs: number,
  signal?: AbortSignal,
): Promise<RewindPlan> {
  const root = await resolveGitRoot(bin, input.cwd);
  if (!root) {
    return {
      available: false,
      reason: "not-git",
      restore: [],
      keep: [],
      root: input.cwd,
      beforeFirstEntries: new Map(),
      afterLastEntries: new Map(),
      uEntries: new Map(),
      sourceCommits: new Map(),
    };
  }

  const firstTurn = input.turns[0];
  const lastTurn = input.turns[input.turns.length - 1];
  if (!firstTurn || !lastTurn) {
    return {
      available: false,
      reason: "no-changes",
      restore: [],
      keep: [],
      root,
      beforeFirstEntries: new Map(),
      afterLastEntries: new Map(),
      uEntries: new Map(),
      sourceCommits: new Map(),
    };
  }

  for (const turn of input.turns) {
    try {
      await execGit(bin, ["rev-parse", "--verify", "-q", `${turn.before}^{commit}`], {
        cwd: root,
        signal,
      });
      await execGit(bin, ["rev-parse", "--verify", "-q", `${turn.after}^{commit}`], {
        cwd: root,
        signal,
      });
    } catch {
      return {
        available: false,
        reason: "no-snapshot",
        restore: [],
        keep: [],
        root,
        beforeFirstEntries: new Map(),
        afterLastEntries: new Map(),
        uEntries: new Map(),
        sourceCommits: new Map(),
      };
    }
  }

  const firstBeforeLog = await execGit(
    bin,
    ["log", "-1", "--format=%B", firstTurn.before],
    { cwd: root, signal },
  );
  const firstBeforeKeys = parseCommitMessageKeys(firstBeforeLog.stdout);
  const recordedBranch = firstBeforeKeys["branch"] ?? "";

  let currentBranch = "";
  try {
    const symRes = await execGit(bin, ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd: root,
      signal,
    });
    currentBranch = symRes.stdout.trim();
  } catch {
    currentBranch = "";
  }

  if (currentBranch !== recordedBranch) {
    return {
      available: false,
      reason: "branch-changed",
      restore: [],
      keep: [],
      root,
      beforeFirstEntries: new Map(),
      afterLastEntries: new Map(),
      uEntries: new Map(),
      sourceCommits: new Map(),
    };
  }

  const uSnapshot = await createPrivateSnapshotTree(
    bin,
    root,
    maxFileBytes,
    signal,
  );
  const uEntries = await getTreeEntries(bin, root, uSnapshot.treeSha, signal);
  // Each path is compared and restored against the turns that actually
  // changed it: its content before the FIRST turn that touched it, and what
  // the LAST turn that touched it left. Using the range's outer snapshots
  // instead would fold someone else's edit made between turns into "the
  // agent's work" and erase it.
  const entriesCache = new Map<string, Map<string, TreeEntry>>();
  const entriesOf = async (commit: string): Promise<Map<string, TreeEntry>> => {
    let entries = entriesCache.get(commit);
    if (!entries) {
      entries = await getTreeEntries(bin, root, commit, signal);
      entriesCache.set(commit, entries);
    }
    return entries;
  };
  const beforeFirstEntries = new Map<string, TreeEntry>();
  const afterLastEntries = new Map<string, TreeEntry>();
  const sourceCommits = new Map<string, string>();

  const D: Array<Set<string>> = [];
  for (let i = 0; i < input.turns.length; i++) {
    const turn = input.turns[i];
    if (!turn) continue;
    const changed = await getDiffTreePaths(
      bin,
      root,
      turn.before,
      turn.after,
      signal,
    );
    D.push(changed);
  }

  const G: Array<Set<string>> = [];
  for (let k = 0; k < input.turns.length - 1; k++) {
    const turnK = input.turns[k];
    const turnNext = input.turns[k + 1];
    if (!turnK || !turnNext) continue;
    const changed = await getDiffTreePaths(
      bin,
      root,
      turnK.after,
      turnNext.before,
      signal,
    );
    G.push(changed);
  }

  const allPaths = new Set<string>();
  for (const dSet of D) {
    for (const p of dSet) allPaths.add(p);
  }
  for (const turn of input.turns) {
    if (turn.skipped) {
      for (const p of turn.skipped) allPaths.add(p);
    }
  }

  const normalizedTouchedPerTurn: Array<Set<string>> = input.turns.map((t) =>
    normalizeTouched(t.touched ?? [], input.cwd, root),
  );

  const turnWindows: Array<{ start: number; end: number }> = [];
  for (const turn of input.turns) {
    let start = 0;
    let end = 0;
    try {
      const bLog = await execGit(bin, ["log", "-1", "--format=%B", turn.before], {
        cwd: root,
        signal,
      });
      const bKeys = parseCommitMessageKeys(bLog.stdout);
      start = parseInt(bKeys["at"] || "0", 10);
    } catch {
      start = 0;
    }
    try {
      const aLog = await execGit(bin, ["log", "-1", "--format=%B", turn.after], {
        cwd: root,
        signal,
      });
      const aKeys = parseCommitMessageKeys(aLog.stdout);
      end = parseInt(aKeys["at"] || "0", 10);
    } catch {
      end = 0;
    }
    turnWindows.push({ start, end });
  }

  let otherWindows: OtherSessionWindow[] | null = null;
  const getOtherWindows = async (): Promise<OtherSessionWindow[]> => {
    if (!otherWindows) {
      otherWindows = await getOtherSessionWindows(
        bin,
        root,
        input.sessionId,
        nowMs,
        signal,
      );
    }
    return otherWindows;
  };

  const numstatCache = new Map<string, Map<string, NumstatEntry>>();
  const numstatOf = async (from: string, to: string): Promise<Map<string, NumstatEntry>> => {
    const key = `${from}..${to}`;
    let stats = numstatCache.get(key);
    if (!stats) {
      stats = await getNumstat(bin, root, from, to, signal);
      numstatCache.set(key, stats);
    }
    return stats;
  };

  const restore: RewindFileChange[] = [];
  const keep: RewindFileKept[] = [];

  for (const p of allPaths) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < input.turns.length; i++) {
      const dSet = D[i];
      if (dSet && dSet.has(p)) {
        if (first === -1) first = i;
        last = i;
      }
    }

    if (first !== -1 && last !== -1) {
      let gapConflict = false;
      for (let k = first; k < last; k++) {
        const gSet = G[k];
        if (gSet && gSet.has(p)) {
          gapConflict = true;
          break;
        }
      }
      if (gapConflict) {
        keep.push({ path: p, reason: "between-steps" });
        continue;
      }
    }

    const inSkipped = input.turns.some((t) => t.skipped?.includes(p));
    if (inSkipped) {
      keep.push({ path: p, reason: "too-large" });
      continue;
    }

    const firstTurnOfPath = input.turns[first];
    const lastTurnOfPath = input.turns[last];
    if (!firstTurnOfPath || !lastTurnOfPath) {
      keep.push({ path: p, reason: "unsupported" });
      continue;
    }
    const beforeFirstEntry = (await entriesOf(firstTurnOfPath.before)).get(p);
    const afterLastEntry = (await entriesOf(lastTurnOfPath.after)).get(p);
    const uEntry = uEntries.get(p);

    if (
      beforeFirstEntry?.mode === "160000" ||
      afterLastEntry?.mode === "160000" ||
      uEntry?.mode === "160000"
    ) {
      keep.push({ path: p, reason: "unsupported" });
      continue;
    }

    const safe = await isSafePath(root, p);
    if (!safe) {
      keep.push({ path: p, reason: "unsupported" });
      continue;
    }

    let attributedByTouch = false;
    for (let j = 0; j < input.turns.length; j++) {
      const dSet = D[j];
      const touchedSet = normalizedTouchedPerTurn[j];
      if (dSet && touchedSet && dSet.has(p) && touchedSet.has(p)) {
        attributedByTouch = true;
        break;
      }
    }

    let byCommand = false;
    if (!attributedByTouch) {
      const windows = await getOtherWindows();
      let overlapsOther = false;
      for (let j = 0; j < input.turns.length; j++) {
        const dSet = D[j];
        if (!dSet || !dSet.has(p)) continue;
        const tw = turnWindows[j];
        if (!tw) continue;
        for (const ow of windows) {
          if (Math.max(ow.start, tw.start) <= Math.min(ow.end, tw.end)) {
            overlapsOther = true;
            break;
          }
        }
        if (overlapsOther) break;
      }
      if (overlapsOther) {
        keep.push({ path: p, reason: "other-chat" });
        continue;
      }
      byCommand = true;
    }

    const afterMatchesU =
      (afterLastEntry === undefined && uEntry === undefined) ||
      (afterLastEntry !== undefined &&
        uEntry !== undefined &&
        afterLastEntry.mode === uEntry.mode &&
        afterLastEntry.oid === uEntry.oid);

    if (!afterMatchesU) {
      keep.push({ path: p, reason: "changed-after" });
      continue;
    }

    const beforeMatchesU =
      (beforeFirstEntry === undefined && uEntry === undefined) ||
      (beforeFirstEntry !== undefined &&
        uEntry !== undefined &&
        beforeFirstEntry.mode === uEntry.mode &&
        beforeFirstEntry.oid === uEntry.oid);

    if (beforeMatchesU) {
      continue;
    }

    let kind: "modified" | "added" | "deleted";
    if (beforeFirstEntry === undefined && afterLastEntry !== undefined) {
      kind = "added";
    } else if (beforeFirstEntry !== undefined && afterLastEntry === undefined) {
      kind = "deleted";
    } else {
      kind = "modified";
    }

    if (beforeFirstEntry) beforeFirstEntries.set(p, beforeFirstEntry);
    if (afterLastEntry) afterLastEntries.set(p, afterLastEntry);
    sourceCommits.set(p, firstTurnOfPath.before);
    const ns = (await numstatOf(firstTurnOfPath.before, lastTurnOfPath.after)).get(p);
    const change: RewindFileChange = {
      path: p,
      kind,
      ...(ns?.binary
        ? { binary: true }
        : { additions: ns?.additions ?? 0, deletions: ns?.deletions ?? 0 }),
      ...(byCommand ? { byCommand: true } : {}),
    };
    restore.push(change);
  }

  restore.sort((a, b) => a.path.localeCompare(b.path));
  keep.sort((a, b) => a.path.localeCompare(b.path));

  const available = restore.length > 0;
  const reason: RewindFilesUnavailableReason | undefined =
    !available && keep.length === 0 ? "no-changes" : undefined;

  return {
    available,
    reason,
    restore,
    keep,
    root,
    beforeFirstEntries,
    afterLastEntries,
    uEntries,
    sourceCommits,
  };
}

async function pruneSessionRefs(
  bin: string,
  root: string,
  sessionId: string,
  keepPerSession: number,
  signal?: AbortSignal,
): Promise<void> {
  let out = "";
  try {
    const res = await execGit(
      bin,
      [
        "for-each-ref",
        "--format=%(refname)%00%(contents)%00",
        `refs/polyth/checkpoints/${sessionId}/`,
      ],
      { cwd: root, signal },
    );
    out = res.stdout;
  } catch {
    return;
  }

  const tokens = out.split("\0");
  interface SessionRefRecord {
    refname: string;
    promptSeq?: number;
    phase?: string;
    isRollback?: boolean;
    epochMs?: number;
    at?: number;
  }

  const records: SessionRefRecord[] = [];
  const prefix = `refs/polyth/checkpoints/${sessionId}/`;

  for (let i = 0; i < tokens.length - 1; i += 2) {
    const rawRefname = tokens[i];
    const rawContents = tokens[i + 1];
    if (!rawRefname || rawContents === undefined) continue;
    const refname = rawRefname.trim();
    const contents = rawContents;

    if (!refname.startsWith(prefix)) continue;
    const sub = refname.slice(prefix.length);
    const keys = parseCommitMessageKeys(contents);
    const at = parseInt(keys["at"] || "0", 10);

    const promptMatch = sub.match(/^(\d+)-(before|after)$/);
    if (promptMatch && promptMatch[1] && promptMatch[2]) {
      records.push({
        refname,
        promptSeq: parseInt(promptMatch[1], 10),
        phase: promptMatch[2],
        at,
      });
      continue;
    }

    const rollbackMatch = sub.match(/^(undo|rolled)-(\d+)$/);
    if (rollbackMatch && rollbackMatch[1] && rollbackMatch[2]) {
      records.push({
        refname,
        isRollback: true,
        epochMs: parseInt(rollbackMatch[2], 10),
        at,
      });
      continue;
    }

    records.push({ refname, at });
  }

  if (records.length <= keepPerSession) {
    return;
  }

  const toDropCount = records.length - keepPerSession;

  const promptSeqs = Array.from(
    new Set(
      records
        .map((r) => r.promptSeq)
        .filter((s): s is number => s !== undefined),
    ),
  ).sort((a, b) => b - a);

  const newest20PromptSeqs = new Set(promptSeqs.slice(0, 20));
  let minAtOfNewest20 = Infinity;
  for (const r of records) {
    if (
      r.promptSeq !== undefined &&
      newest20PromptSeqs.has(r.promptSeq) &&
      r.at
    ) {
      if (r.at < minAtOfNewest20) minAtOfNewest20 = r.at;
    }
  }
  if (minAtOfNewest20 === Infinity) minAtOfNewest20 = 0;

  const dropCandidates: SessionRefRecord[] = [];

  const promptRecords = records
    .filter((r) => r.promptSeq !== undefined)
    .sort((a, b) => {
      if (a.promptSeq! !== b.promptSeq!) {
        return a.promptSeq! - b.promptSeq!;
      }
      return (a.at ?? 0) - (b.at ?? 0);
    });
  dropCandidates.push(...promptRecords);

  const olderRollbackRecords = records
    .filter((r) => r.isRollback && (r.epochMs ?? 0) < minAtOfNewest20)
    .sort((a, b) => (a.epochMs ?? 0) - (b.epochMs ?? 0));
  dropCandidates.push(...olderRollbackRecords);

  const toDrop = dropCandidates.slice(0, toDropCount);
  for (const item of toDrop) {
    try {
      await execGit(bin, ["update-ref", "-d", item.refname], {
        cwd: root,
        signal,
      });
    } catch {
      // ignore deletion failures
    }
  }
}

export function createWorkspaceCheckpoints(
  options: WorkspaceCheckpointOptions = {},
): WorkspaceCheckpointService {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const keepPerSession = options.keepPerSession ?? DEFAULT_KEEP_PER_SESSION;
  const now = options.now ?? Date.now;
  const bin = resolveGitBinary();

  return {
    async capture(input: {
      cwd: string;
      sessionId: string;
      promptSeq: number;
      phase: "before" | "after";
      budgetMs: number;
    }): Promise<WorkspaceCheckpointCaptureResult> {
      if (!SESSION_ID_RE.test(input.sessionId)) {
        throw Object.assign(new Error(`Invalid sessionId: ${input.sessionId}`), {
          code: "invalid-input",
        });
      }

      const root = await resolveGitRoot(bin, input.cwd);
      if (!root) {
        return { unavailable: "not-git" };
      }

      return withRootMutex(root, async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), input.budgetMs);
        try {
          const snapshot = await createPrivateSnapshotTree(
            bin,
            root,
            maxFileBytes,
            ac.signal,
          );

          let branch = "";
          try {
            const symRes = await execGit(
              bin,
              ["symbolic-ref", "--short", "-q", "HEAD"],
              { cwd: root, signal: ac.signal },
            );
            branch = symRes.stdout.trim();
          } catch {
            branch = "";
          }

          let head = "";
          try {
            const headRes = await execGit(
              bin,
              ["rev-parse", "--verify", "-q", "HEAD^{commit}"],
              { cwd: root, signal: ac.signal },
            );
            head = headRes.stdout.trim();
          } catch {
            head = "";
          }

          const epochMs = now();
          const message = [
            "polyth checkpoint",
            "",
            `session: ${input.sessionId}`,
            `prompt: ${input.promptSeq}`,
            `phase: ${input.phase}`,
            `root: ${root}`,
            `branch: ${branch}`,
            `head: ${head}`,
            `at: ${epochMs}`,
          ].join("\n") + "\n";

          const commitTreeArgs = [
            "commit-tree",
            "--no-gpg-sign",
            ...(head ? ["-p", head] : []),
            "-F",
            "-",
            snapshot.treeSha,
          ];

          const commitRes = await execGit(bin, commitTreeArgs, {
            cwd: root,
            input: message,
            signal: ac.signal,
            env: {
              GIT_AUTHOR_NAME: "Polyth",
              GIT_AUTHOR_EMAIL: "checkpoints@polyth.invalid",
              GIT_COMMITTER_NAME: "Polyth",
              GIT_COMMITTER_EMAIL: "checkpoints@polyth.invalid",
            },
          });
          const commit = commitRes.stdout.trim();

          const refName = `refs/polyth/checkpoints/${input.sessionId}/${input.promptSeq}-${input.phase}`;
          await execGit(bin, ["update-ref", refName, commit], {
            cwd: root,
            signal: ac.signal,
          });

          await pruneSessionRefs(
            bin,
            root,
            input.sessionId,
            keepPerSession,
            ac.signal,
          );

          const skipped50 = snapshot.skipped.slice(0, 50);
          const skippedMore =
            snapshot.skipped.length > 50
              ? snapshot.skipped.length - 50
              : undefined;

          return {
            commit,
            root,
            skipped: skipped50,
            ...(skippedMore !== undefined ? { skippedMore } : {}),
          };
        } catch (err: unknown) {
          if (
            ac.signal.aborted ||
            (err as { killed?: boolean })?.killed ||
            (err as { code?: string })?.code === "ABORT_ERR"
          ) {
            return { unavailable: "timeout" as WorkspaceCheckpointUnavailable };
          }
          return { unavailable: "error" as WorkspaceCheckpointUnavailable };
        } finally {
          clearTimeout(timer);
        }
      });
    },

    async previewRewind(input: {
      cwd: string;
      sessionId: string;
      turns: WorkspaceCheckpointTurn[];
    }): Promise<Omit<RewindFilesPreview, "turnRunning">> {
      const root = await resolveGitRoot(bin, input.cwd);
      if (!root) {
        return { available: false, reason: "not-git", restore: [], keep: [] };
      }

      return withRootMutex(root, async () => {
        const plan = await computeRewindPlan(bin, input, maxFileBytes, now());
        return {
          available: plan.available,
          reason: plan.reason,
          restore: plan.restore,
          keep: plan.keep,
        };
      });
    },

    async applyRewind(input: {
      cwd: string;
      sessionId: string;
      turns: WorkspaceCheckpointTurn[];
    }): Promise<RewindFilesOutcome> {
      const root = await resolveGitRoot(bin, input.cwd);
      if (!root) {
        return {
          mode: "unavailable",
          reason: "not-git",
          restored: 0,
          kept: 0,
          keptFiles: [],
        };
      }

      return withRootMutex(root, async () => {
        const plan = await computeRewindPlan(bin, input, maxFileBytes, now());
        if (!plan.available) {
          return {
            mode: "unavailable",
            reason: plan.reason ?? "no-changes",
            restored: 0,
            kept: plan.keep.length,
            keptFiles: plan.keep.slice(0, 200),
          };
        }

        const undoMs = now();
        const undoSnapshot = await createPrivateSnapshotTree(
          bin,
          root,
          maxFileBytes,
        );
        const undoMsg = [
          "polyth checkpoint",
          "",
          `session: ${input.sessionId}`,
          "phase: undo",
          `root: ${root}`,
          `at: ${undoMs}`,
        ].join("\n") + "\n";

        let head = "";
        try {
          const headRes = await execGit(
            bin,
            ["rev-parse", "--verify", "-q", "HEAD^{commit}"],
            { cwd: root },
          );
          head = headRes.stdout.trim();
        } catch {
          head = "";
        }

        const undoCommitRes = await execGit(
          bin,
          [
            "commit-tree",
            "--no-gpg-sign",
            ...(head ? ["-p", head] : []),
            "-F",
            "-",
            undoSnapshot.treeSha,
          ],
          {
            cwd: root,
            input: undoMsg,
            env: {
              GIT_AUTHOR_NAME: "Polyth",
              GIT_AUTHOR_EMAIL: "checkpoints@polyth.invalid",
              GIT_COMMITTER_NAME: "Polyth",
              GIT_COMMITTER_EMAIL: "checkpoints@polyth.invalid",
            },
          },
        );
        const undoCommit = undoCommitRes.stdout.trim();
        await execGit(
          bin,
          [
            "update-ref",
            `refs/polyth/checkpoints/${input.sessionId}/undo-${undoMs}`,
            undoCommit,
          ],
          { cwd: root },
        );

        const restoredPaths: string[] = [];
        const keptFiles: RewindFileKept[] = [...plan.keep];

        for (const item of plan.restore) {
          const p = item.path;
          const abs = resolve(root, p);

          const safe = await isSafePath(root, p);
          if (!safe) {
            keptFiles.push({ path: p, reason: "unsupported" });
            continue;
          }

          const stillMatchesU = await matchesTreeEntry(
            bin,
            root,
            p,
            abs,
            plan.uEntries.get(p),
          );
          if (!stillMatchesU) {
            keptFiles.push({ path: p, reason: "changed-after" });
            continue;
          }

          let tmpCreated: string | null = null;
          try {
            const beforeEntry = plan.beforeFirstEntries.get(p);
            const sourceCommit = plan.sourceCommits.get(p);
            if (!sourceCommit) {
              keptFiles.push({ path: p, reason: "write-failed" });
              continue;
            }

            if (!beforeEntry) {
              try {
                await unlink(abs);
              } catch (err: unknown) {
                if ((err as { code?: string })?.code !== "ENOENT") throw err;
              }
              let dir = dirname(abs);
              while (dir !== root && dir.startsWith(root)) {
                try {
                  await rmdir(dir);
                  dir = dirname(dir);
                } catch {
                  break;
                }
              }
            } else if (beforeEntry.mode === "120000") {
              await mkdir(dirname(abs), { recursive: true });
              const res = await execGit(
                bin,
                ["cat-file", "blob", `${sourceCommit}:${p}`],
                { cwd: root },
              );
              const target = res.stdout;
              const tmpLink = join(dirname(abs), `.tmp-${randomUUID()}`);
              tmpCreated = tmpLink;
              await symlink(target, tmpLink);
              await rename(tmpLink, abs);
              tmpCreated = null;
            } else {
              await mkdir(dirname(abs), { recursive: true });
              const res = await execGit(
                bin,
                ["cat-file", "--filters", `${sourceCommit}:${p}`],
                { cwd: root },
              );
              const tmpFile = join(dirname(abs), `.tmp-${randomUUID()}`);
              tmpCreated = tmpFile;
              await writeFile(tmpFile, res.stdoutRaw);
              await chmod(
                tmpFile,
                beforeEntry.mode === "100755" ? 0o755 : 0o644,
              );
              await rename(tmpFile, abs);
              tmpCreated = null;
            }
            restoredPaths.push(p);
          } catch {
            if (tmpCreated && existsSync(tmpCreated)) {
              try {
                await unlink(tmpCreated);
              } catch {
                // ignore
              }
            }
            keptFiles.push({ path: p, reason: "write-failed" });
          }
        }

        const rolledMs = now();
        const rolledSnapshot = await createPrivateSnapshotTree(
          bin,
          root,
          maxFileBytes,
        );
        const rolledMsg = [
          "polyth checkpoint",
          "",
          `session: ${input.sessionId}`,
          "phase: rolled",
          `root: ${root}`,
          `at: ${rolledMs}`,
        ].join("\n") + "\n";

        const rolledCommitRes = await execGit(
          bin,
          [
            "commit-tree",
            "--no-gpg-sign",
            ...(head ? ["-p", head] : []),
            "-F",
            "-",
            rolledSnapshot.treeSha,
          ],
          {
            cwd: root,
            input: rolledMsg,
            env: {
              GIT_AUTHOR_NAME: "Polyth",
              GIT_AUTHOR_EMAIL: "checkpoints@polyth.invalid",
              GIT_COMMITTER_NAME: "Polyth",
              GIT_COMMITTER_EMAIL: "checkpoints@polyth.invalid",
            },
          },
        );
        const rolledCommit = rolledCommitRes.stdout.trim();
        await execGit(
          bin,
          [
            "update-ref",
            `refs/polyth/checkpoints/${input.sessionId}/rolled-${rolledMs}`,
            rolledCommit,
          ],
          { cwd: root },
        );

        const restored = restoredPaths.length;
        const totalKept = keptFiles.length;

        return {
          mode: restored > 0 ? "restored" : "unavailable",
          reason: restored > 0 ? undefined : "error",
          restored,
          kept: totalKept,
          undo: undoCommit,
          rolled: rolledCommit,
          root,
          paths: restoredPaths.slice(0, 500),
          keptFiles: keptFiles.slice(0, 200),
        };
      });
    },

    async previewRestore(
      input: WorkspaceRestoreInput,
    ): Promise<RewindRestorePreview> {
      const root = await resolveGitRoot(bin, input.cwd);
      if (!root) {
        return { restore: 0, keep: [] };
      }

      return withRootMutex(root, async () => {
        let rolledEntries: Map<string, TreeEntry>;
        try {
          rolledEntries = await getTreeEntries(bin, root, input.rolled);
        } catch {
          return {
            restore: 0,
            keep: input.paths.map((p: string) => ({
              path: p,
              reason: "changed-after" as const,
            })),
          };
        }

        let restoreCount = 0;
        const keep: RewindFileKept[] = [];

        for (const p of input.paths) {
          const abs = resolve(root, p);
          const matches = await matchesTreeEntry(
            bin,
            root,
            p,
            abs,
            rolledEntries.get(p),
          );
          if (matches) {
            restoreCount++;
          } else {
            keep.push({ path: p, reason: "changed-after" });
          }
        }

        return { restore: restoreCount, keep };
      });
    },

    async applyRestore(
      input: WorkspaceRestoreInput,
    ): Promise<{
      restored: number;
      kept: number;
      keptFiles: RewindFileKept[];
    }> {
      const root = await resolveGitRoot(bin, input.cwd);
      if (!root) {
        return { restored: 0, kept: 0, keptFiles: [] };
      }

      return withRootMutex(root, async () => {
        let undoEntries: Map<string, TreeEntry>;
        let rolledEntries: Map<string, TreeEntry>;
        try {
          undoEntries = await getTreeEntries(bin, root, input.undo);
          rolledEntries = await getTreeEntries(bin, root, input.rolled);
        } catch {
          return {
            restored: 0,
            kept: input.paths.length,
            keptFiles: input.paths.slice(0, 200).map((p: string) => ({
              path: p,
              reason: "write-failed" as const,
            })),
          };
        }

        let restoredCount = 0;
        const keptFiles: RewindFileKept[] = [];

        for (const p of input.paths) {
          const abs = resolve(root, p);

          const safe = await isSafePath(root, p);
          if (!safe) {
            keptFiles.push({ path: p, reason: "unsupported" });
            continue;
          }

          const stillMatchesRolled = await matchesTreeEntry(
            bin,
            root,
            p,
            abs,
            rolledEntries.get(p),
          );
          if (!stillMatchesRolled) {
            keptFiles.push({ path: p, reason: "changed-after" });
            continue;
          }

          let tmpCreated: string | null = null;
          try {
            const undoEntry = undoEntries.get(p);
            if (!undoEntry) {
              try {
                await unlink(abs);
              } catch (err: unknown) {
                if ((err as { code?: string })?.code !== "ENOENT") throw err;
              }
              let dir = dirname(abs);
              while (dir !== root && dir.startsWith(root)) {
                try {
                  await rmdir(dir);
                  dir = dirname(dir);
                } catch {
                  break;
                }
              }
            } else if (undoEntry.mode === "120000") {
              await mkdir(dirname(abs), { recursive: true });
              const res = await execGit(
                bin,
                ["cat-file", "blob", `${input.undo}:${p}`],
                { cwd: root },
              );
              const target = res.stdout;
              const tmpLink = join(dirname(abs), `.tmp-${randomUUID()}`);
              tmpCreated = tmpLink;
              await symlink(target, tmpLink);
              await rename(tmpLink, abs);
              tmpCreated = null;
            } else {
              await mkdir(dirname(abs), { recursive: true });
              const res = await execGit(
                bin,
                ["cat-file", "--filters", `${input.undo}:${p}`],
                { cwd: root },
              );
              const tmpFile = join(dirname(abs), `.tmp-${randomUUID()}`);
              tmpCreated = tmpFile;
              await writeFile(tmpFile, res.stdoutRaw);
              await chmod(
                tmpFile,
                undoEntry.mode === "100755" ? 0o755 : 0o644,
              );
              await rename(tmpFile, abs);
              tmpCreated = null;
            }
            restoredCount++;
          } catch {
            if (tmpCreated && existsSync(tmpCreated)) {
              try {
                await unlink(tmpCreated);
              } catch {
                // ignore
              }
            }
            keptFiles.push({ path: p, reason: "write-failed" });
          }
        }

        return {
          restored: restoredCount,
          kept: keptFiles.length,
          keptFiles: keptFiles.slice(0, 200),
        };
      });
    },

    async forget(sessionId: string, cwd?: string): Promise<void> {
      if (!cwd || !SESSION_ID_RE.test(sessionId)) return;
      const root = await resolveGitRoot(bin, cwd);
      if (!root) return;

      return withRootMutex(root, async () => {
        try {
          const res = await execGit(
            bin,
            [
              "for-each-ref",
              "--format=%(refname)",
              `refs/polyth/checkpoints/${sessionId}/`,
            ],
            { cwd: root },
          );
          const refs = res.stdout.split("\n").map((r) => r.trim()).filter(Boolean);
          for (const ref of refs) {
            try {
              await execGit(bin, ["update-ref", "-d", ref], { cwd: root });
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      });
    },
  };
}
