// Shared process plumbing for harness-native plugin managers.
//
// Each backend owns its plugin CLI's argv and output parsing; this module owns
// the process: argument-array execution (never a shell, except the Windows
// .cmd/.bat shim), bounded output, timeout/abort, outcome classification and
// per-harness serialization. Mutations are never retried here: a timeout or an
// abort after the command started is an unknown outcome the caller re-reads.
// A call does not resolve while the command's process group is still known to
// run, so the per-harness mutex is never released under a live command.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { MutationOutcome } from "@polyth/contracts";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 20_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 180_000;
const MESSAGE_LIMIT = 500;

export interface NativePluginCliInput {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NativePluginCliOutput {
  stdout: string;
  stderr: string;
}

const windowsShim = (command: string): boolean =>
  process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** cmd.exe re-parses a shim's command line, so these would escape the argv. */
const SHIM_METACHARACTERS = /[&|<>^%"!()]/;

/** Validates a native plugin reference before it reaches any argv. Returns a
 * user-facing reason, or undefined when the reference is acceptable. */
export function nativePluginRefError(ref: string): string | undefined {
  if (typeof ref !== "string" || ref.length === 0) return "Plugin reference is required.";
  if (ref.length > 512) return "Plugin reference is too long.";
  // Whitespace and control characters never belong in a package, marketplace
  // or path reference, and would split or corrupt the argument.
  if (/[\s\u0000-\u001f\u007f]/u.test(ref)) return "Plugin reference must not contain whitespace or control characters.";
  if (ref.startsWith("-")) return "Plugin reference must not start with \"-\".";
  return undefined;
}

/** Last part of the command's own diagnostics, without terminal escapes. */
const diagnosticTail = (stderr: string, stdout: string): string => {
  const text = (stderr.trim() || stdout.trim())
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  return text.length > MESSAGE_LIMIT ? `…${text.slice(-(MESSAGE_LIMIT - 1))}` : text;
};

interface ExecFailure {
  stdout: string;
  stderr: string;
  /** The process never started. */
  missing?: boolean;
  /** Exited on its own with a non-zero status. */
  exitCode?: number;
  /** Timed out, aborted or killed by a signal: completion is unknown. */
  interrupted?: boolean;
  /** Refused before any process started, with this code. */
  refused?: string;
  message: string;
}

type ExecResult = { ok: true; stdout: string; stderr: string } | ({ ok: false } & ExecFailure);

// The command runs as its own process group (POSIX) so that stopping it stops
// everything it started. These bound how long Polyth waits for that group to
// go away before it stops claiming anything about it.
const GROUP_TERM_GRACE_MS = 2_000;
const GROUP_KILL_CONFIRM_MS = 2_000;
const GROUP_POLL_MS = 25;
/** After the group is gone, the pipes close as soon as the last writer does. */
const STDIO_DRAIN_MS = 1_000;

const STILL_RUNNING = "It may still be running.";

type StopReason = "timeout" | "abort" | "overflow";

const STOP_MESSAGES: Record<StopReason, string> = {
  timeout: "The command did not finish in time.",
  abort: "Cancelled while the command was running.",
  overflow: "The command produced more output than Polyth accepts.",
};

/** Linux: whether any member of the group is still a live (non-zombie)
 * process. Orphans are reparented to the nearest subreaper (e.g. the Polyth
 * process supervisor), which may never reap them; a zombie executes nothing
 * and keeps its pid, so its group id cannot be reused while it exists. */
const linuxGroupHasLiveMember = (pgid: number): boolean => {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // exited while scanning
    }
    // "pid (comm) state ppid pgrp ..."; comm may contain spaces and parens.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
};

/** True only once the group is verified to run nothing: no member at all
 * (ESRCH) or, on Linux, only unreaped zombies. EPERM means a member exists
 * that Polyth may not signal. */
const posixGroupEmpty = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  return process.platform === "linux" && !linuxGroupHasLiveMember(pgid);
};

const waitUntil = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await delay(GROUP_POLL_MS);
  }
  return true;
};

/** SIGTERM to the whole group, a short grace, then SIGKILL. Resolves true only
 * when the group is verified empty; false means something may still run. A
 * group verified empty is never signalled again (its id could be reused). */
const terminatePosixGroup = async (pgid: number): Promise<boolean> => {
  for (const [signal, waitMs] of [["SIGTERM", GROUP_TERM_GRACE_MS], ["SIGKILL", GROUP_KILL_CONFIRM_MS]] as const) {
    if (posixGroupEmpty(pgid)) return true;
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (await waitUntil(() => posixGroupEmpty(pgid), waitMs)) return true;
  }
  return false;
};

/** Windows has no process groups: taskkill walks the tree from the leader.
 * Release is claimed only when taskkill succeeded and the leader's exit was
 * observed; descendants cannot be verified independently. */
const terminateWindowsTree = async (pid: number, exited: Promise<unknown>): Promise<boolean> => {
  const killed = await new Promise<boolean>((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: GROUP_TERM_GRACE_MS }, (error) => resolve(!error));
  });
  const leaderGone = await Promise.race([exited.then(() => true), delay(GROUP_KILL_CONFIRM_MS).then(() => false)]);
  return killed && leaderGone;
};

const startFailure = (input: NativePluginCliInput, error: NodeJS.ErrnoException): ExecResult => {
  if (error.code === "ENOENT" || error.code === "EACCES") {
    return { ok: false, stdout: "", stderr: "", missing: true, message: `${input.command} is not installed or not executable.` };
  }
  // No process exists, so nothing can have run: a known failure, not unknown.
  return { ok: false, stdout: "", stderr: "", message: `${input.command} could not be started: ${error.message}` };
};

const execute = async (input: NativePluginCliInput, defaultTimeoutMs: number): Promise<ExecResult> => {
  const shell = windowsShim(input.command);
  if (shell && input.args.some((arg) => SHIM_METACHARACTERS.test(arg))) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      refused: "invalid-input",
      message: "This argument cannot be passed safely to a Windows command shim.",
    };
  }
  if (input.signal?.aborted) {
    return { ok: false, stdout: "", stderr: "", refused: "cancelled", message: "Cancelled before the command started." };
  }
  const posix = process.platform !== "win32";
  let child: ChildProcess;
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      shell,
      // Own process group (setsid) so the whole tree can be signalled. The
      // child is deliberately not unref'd: Polyth waits for it.
      detached: posix,
      // No stdin: a command that prompts gets EOF and fails instead of
      // hanging until the timeout turns it into an unknown outcome.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return startFailure(input, error as NodeJS.ErrnoException);
  }

  let stopReason: StopReason | undefined;
  let requestStop: (reason: StopReason) => void = () => undefined;
  const stopped = new Promise<StopReason>((resolve) => {
    requestStop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      resolve(reason);
    };
  });

  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const collect = (chunks: Buffer[]) => {
    let bytes = 0;
    return (chunk: Buffer) => {
      const room = MAX_OUTPUT_BYTES - bytes;
      if (room > 0) chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) requestStop("overflow");
    };
  };
  child.stdout?.on("data", collect(output.stdout));
  child.stderr?.on("data", collect(output.stderr));
  const text = () => ({ stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const started = new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", (error) => resolve(error));
  });
  // Later 'error' events (a failed signal on a gone child) must not crash the
  // server; the group checks below are the source of truth.
  child.on("error", () => undefined);

  const startError = await started;
  if (startError) return startFailure(input, startError);
  const pid = child.pid as number;

  const timer = setTimeout(() => requestStop("timeout"), input.timeoutMs ?? defaultTimeoutMs);
  const onAbort = () => requestStop("abort");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  let first: { exit: { code: number | null; signal: NodeJS.Signals | null } } | { stop: StopReason };
  try {
    first = await Promise.race([exited.then((exit) => ({ exit })), stopped.then((stop) => ({ stop }))]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }

  // The leader exiting on its own does not mean its descendants are done. A
  // native plugin command must not leave daemons behind, so whatever remains
  // in its group is terminated the same way as on a timeout. (Windows cannot
  // walk a tree whose root already exited; that case is not covered.)
  let released: boolean;
  if (posix) released = await terminatePosixGroup(pid);
  else released = "stop" in first ? await terminateWindowsTree(pid, exited) : true;

  // With every group member gone the pipes close promptly. One still open
  // means a process outside the group (e.g. it called setsid) holds it and
  // may still be working.
  const drained = await Promise.race([closed.then(() => true), delay(STDIO_DRAIN_MS).then(() => false)]);
  if (!drained) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const { stdout, stderr } = text();

  if ("stop" in first) {
    // Timeout, abort or output overflow: the command may have completed part
    // or all of its work, so this is never a known outcome.
    const message = STOP_MESSAGES[first.stop];
    return { ok: false, stdout, stderr, interrupted: true, message: released && drained ? message : `${message} ${STILL_RUNNING}` };
  }
  if (!released || !drained) {
    return { ok: false, stdout, stderr, interrupted: true, message: `The command exited, but a process it started could not be stopped. ${STILL_RUNNING}` };
  }
  const { code, signal } = first.exit;
  if (code === 0) return { ok: true, stdout, stderr };
  if (typeof code === "number") {
    return { ok: false, stdout, stderr, exitCode: code, message: diagnosticTail(stderr, stdout) || `Exited with status ${code}.` };
  }
  // Killed by a signal Polyth did not send: completion is unknown.
  return { ok: false, stdout, stderr, interrupted: true, message: `The command was terminated by ${signal ?? "a signal"}.` };
};

/** Read-only call (list, details). Throws on any failure. */
export async function readNativePluginCli(input: NativePluginCliInput): Promise<NativePluginCliOutput> {
  const result = await execute(input, DEFAULT_READ_TIMEOUT_MS);
  if (result.ok) return { stdout: result.stdout, stderr: result.stderr };
  const code = result.refused ?? (result.missing ? "not-installed" : result.interrupted ? "timeout" : "native-command-failed");
  throw Object.assign(new Error(result.message), { code });
}

/** One native mutation. Never retries. */
export async function runNativePluginCli(
  input: NativePluginCliInput & { operationId: string },
): Promise<MutationOutcome<NativePluginCliOutput>> {
  const result = await execute(input, DEFAULT_MUTATION_TIMEOUT_MS);
  if (result.ok) return { kind: "confirmed", value: { stdout: result.stdout, stderr: result.stderr } };
  if (result.refused) return { kind: "rejected", code: result.refused, message: result.message };
  if (result.missing) return { kind: "rejected", code: "not-installed", message: result.message };
  if (result.interrupted) return { kind: "unknown", operationId: input.operationId, message: result.message };
  return { kind: "rejected", code: "native-command-failed", message: result.message };
}

/** Serializes work per key (a harness id). Failures do not poison the queue. */
export function nativePluginMutex(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}
