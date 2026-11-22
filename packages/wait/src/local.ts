// Local conditions: process liveness (with a start fingerprint against PID
// reuse), file appearance (confined to the workspace roots) and the clock.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export interface ProcessIdentity {
  pid: number;
  /** Start fingerprint; absent where the platform offers none. */
  fingerprint?: string;
  label?: string;
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** Field 22 (starttime) of /proc/<pid>/stat, parsed after the last ")" because
 *  the command name may hold spaces and parentheses. Also reports the state. */
export function parseProcStat(stat: string): { state: string; starttime: string } | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field 22 is fields[19].
  const state = fields[0];
  const starttime = fields[19];
  return state && starttime ? { state, starttime } : undefined;
}

function psStart(pid: number): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3000 }, (error, stdout) => {
      done(error ? undefined : stdout.trim() || undefined);
    });
  });
}

/** What identifies the process now, or undefined when none can be read. */
export async function readFingerprint(pid: number, platform: NodeJS.Platform = process.platform): Promise<{ fingerprint?: string; zombie?: boolean }> {
  if (platform === "linux") {
    try {
      const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      return parsed ? { fingerprint: parsed.starttime, zombie: parsed.state === "Z" || parsed.state === "X" } : {};
    } catch { return {}; }
  }
  if (platform === "darwin") {
    const start = await psStart(pid);
    return start ? { fingerprint: start } : {};
  }
  return {};
}

function readLabel(pid: number, platform: NodeJS.Platform): string | undefined {
  if (platform !== "linux") return undefined;
  try {
    const text = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    return text ? text.slice(0, 200) : undefined;
  } catch { return undefined; }
}

/** Whether a signal-0 probe finds the process: true (or EPERM) means it exists. */
export function probeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return errnoOf(error) === "EPERM"; }
}

/** The chat's own roots for a process's working directory: its cwd and the
 *  project, not the shared temp directory. */
export function workspaceRoots(cwd: string, projectPath: string): string[] {
  return [...new Set([cwd, projectPath].map((root) => realOrNull(root)).filter((root): root is string => !!root))];
}

/** `roots` confine which processes a chat may watch where the platform can
 *  tell: on Linux the process's working directory must lie inside them, so a
 *  chat cannot probe other people's processes or read their command lines
 *  (which may carry tokens). Elsewhere only existence is observed, and no
 *  command line is read. */
export async function identifyProcess(pid: unknown, platform: NodeJS.Platform = process.platform, roots?: readonly string[]): Promise<ProcessIdentity> {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) throw fail("invalid-input", "pid must be an integer greater than 1.");
  if (pid === process.pid) throw fail("invalid-input", "That is the Polyth server itself; wait on a process you started.");
  if (!probeAlive(pid)) throw fail("not-found", `No process with pid ${pid} is running on this machine.`);
  const { fingerprint, zombie } = await readFingerprint(pid, platform);
  if (zombie) throw fail("not-found", `The process ${pid} has already exited.`);
  let confined = false;
  if (platform === "linux" && roots) {
    const cwd = realOrNull(`/proc/${pid}/cwd`);
    if (!cwd || !roots.some((root) => inside(root, cwd))) {
      throw fail("forbidden", `The process ${pid} was not started from this chat's workspace, so it cannot be waited on. Start it from the workspace, or write an exit file and wait on that.`);
    }
    confined = true;
  }
  const label = confined ? readLabel(pid, platform) : undefined;
  return { pid, ...(fingerprint ? { fingerprint } : {}), ...(label ? { label } : {}) };
}

/** True when the identified process is gone: no such pid, a zombie, or another
 *  process now owns the pid (a different start fingerprint). */
export async function processGone(identity: ProcessIdentity, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!probeAlive(identity.pid)) return true;
  const now = await readFingerprint(identity.pid, platform);
  if (now.zombie) return true;
  return !!identity.fingerprint && !!now.fingerprint && now.fingerprint !== identity.fingerprint;
}

// ---- files ------------------------------------------------------------------

const realOrNull = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };

/** `path` with its nearest existing ancestor resolved through symlinks. */
function realWithMissingTail(path: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    const real = realOrNull(current);
    if (real !== null) return join(real, ...tail.toReversed());
    const parent = dirname(current);
    if (parent === current) return path;
    tail.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The allowed roots, as real paths: the chat's cwd, the project and the temp dir. */
export function allowedRoots(cwd: string, projectPath: string): string[] {
  return [...new Set([cwd, projectPath, tmpdir()].map((root) => realOrNull(root)).filter((root): root is string => !!root))];
}

/** The real absolute path a `file` wait watches; escapes are refused. */
export function confineFile(file: unknown, cwd: string, roots: readonly string[]): string {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) throw fail("invalid-input", "file must be a path.");
  const real = realWithMissingTail(resolve(cwd, file));
  if (!roots.some((root) => inside(root, real))) {
    throw fail("forbidden", "That path is outside this chat's workspace and the temp directory, so it cannot be waited on.");
  }
  return real;
}

/** Size and mtime once the file exists inside the roots; never its content. */
export function fileAppeared(path: string, roots: readonly string[]): { size: number; mtime: string } | null {
  try {
    const real = realpathSync(path);
    if (!roots.some((root) => inside(root, real))) return null;
    const info = statSync(real);
    return { size: info.size, mtime: info.mtime.toISOString() };
  } catch { return null; }
}
