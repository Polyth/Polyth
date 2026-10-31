// Project-scoped terminal sessions. Pure host logic (no HTTP/WS — the server
// maps routes onto this, like git/files). Each session is a spawned user
// shell.
//
// Shell: an explicit `SHELL` when the launcher provided one, otherwise the
// login shell recorded in the operating-system account database. A packaged
// desktop app launched from Finder/Dock starts without `SHELL`; reading that
// absence as "/bin/sh" produced a POSIX-only "cut-down" terminal instead of the
// user's zsh/bash (see resolveLoginShell). Terminal settings may pin another
// installed shell per Space (see shellSettings.ts); the route validates it and
// passes it to `create` as `shell`.
//
// PTY: when the optional `node-pty` dependency is installed the shell runs on
// a real pseudo-terminal (full-screen apps, prompts, true resize). Without it
// we fall back to pipes: bidirectional I/O works for line commands, COLUMNS/
// LINES are exported at spawn, and resize forwards SIGWINCH. The service
// surface is identical either way.
import { spawn, type ChildProcess } from "node:child_process";
import { AGENT_BETA_READ_ONLY_MESSAGE, agentBetaEnabled } from "@polyth/harness-runtime";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TerminalReplayFrame } from "./replay.ts";
import type { ProcessContainmentBoundary } from "@polyth/harness-runtime/process-authority";
import type {
  Disposable,
  RemoteHost,
  RemoteProcessHandle,
  TerminalCreateInput,
  TerminalInfo,
  TerminalWorkspace,
} from "@polyth/contracts";

// ------------------------------------------------------------- optional PTY

/** Minimal slice of the node-pty surface we use (no @types dependency). */
interface NodePty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): void;
}

interface NodePtyModule {
  spawn(file: string, args: string[] | string, options: {
    name: string; cols: number; rows: number; cwd: string;
    env: Record<string, string>;
  }): NodePty;
}

let nodePty: NodePtyModule | null = null;
try {
  nodePty = createRequire(import.meta.url)("node-pty") as NodePtyModule;
} catch {
  nodePty = null; // optional dependency absent or failed to build — pipe mode
}

/** True when the optional node-pty module loaded (real PTY available). */
export const hasRealPty = (): boolean => nodePty !== null;

// ---------------------------------------------------------------- replay ring

/** Default scrollback replay cap per PTY. Configurable per service. */
export const DEFAULT_REPLAY_BYTES = 200 * 1024;

/** Bounded byte ring per terminal: late subscribers replay startup output.
 *  Byte-exact within the cap; snapshot() never tears a UTF-8 code point even
 *  when eviction or chunk boundaries land mid-character. */
export interface ReplayBuffer {
  push(chunk: Buffer): void;
  /** Decoded scrollback; torn leading continuation bytes are skipped. */
  snapshot(): string;
  byteLength(): number;
  clear(): void;
}

interface SizedReplayBuffer extends ReplayBuffer {
  resize(cols: number, rows: number): void;
  frames(): TerminalReplayFrame[];
}

export function createReplayBuffer(maxBytes = DEFAULT_REPLAY_BYTES): SizedReplayBuffer {
  let chunks: Buffer[] = [];
  let total = 0;
  let received = 0;
  let sizes: Array<{ offset: number; cols: number; rows: number }> = [];
  const evict = (cap: number) => {
    while (total > cap) {
      const first = chunks[0]!;
      const excess = total - cap;
      if (first.length <= excess) { chunks.shift(); total -= first.length; }
      else { chunks[0] = first.subarray(excess); total -= excess; }
    }
  };
  const pruneSizes = () => {
    const start = received - total;
    // Keep the grid in force at the retained beginning, plus later changes.
    while (sizes.length > 1 && sizes[1]!.offset <= start) sizes.shift();
  };
  const retained = () => {
    const buf = Buffer.concat(chunks);
    let skip = 0;
    while (skip < buf.length && (buf[skip]! & 0xc0) === 0x80) skip++;
    return { bytes: buf.subarray(skip), start: received - total + skip };
  };
  return {
    push(chunk) {
      if (chunk.length === 0) return;
      received += chunk.length;
      if (chunk.length >= maxBytes) {
        chunks = [chunk.subarray(chunk.length - maxBytes)];
        total = maxBytes;
      } else {
        chunks.push(chunk);
        total += chunk.length;
        evict(maxBytes);
      }
      pruneSizes();
    },
    snapshot() {
      return retained().bytes.toString("utf8");
    },
    resize(cols, rows) {
      const last = sizes.at(-1);
      if (last?.cols === cols && last.rows === rows) return;
      const size = { offset: received, cols, rows };
      if (last?.offset === received) sizes[sizes.length - 1] = size;
      else sizes.push(size);
      // Resize metadata is bounded too. If necessary, evict output preceding
      // the oldest retained grid instead of dropping its interpretation.
      if (sizes.length > 2048) {
        sizes = sizes.slice(-2048);
        evict(received - sizes[0]!.offset);
      }
      pruneSizes();
    },
    frames() {
      const { bytes, start } = retained();
      const frames: TerminalReplayFrame[] = [];
      const initial = sizes.findLast((size) => size.offset <= start);
      if (initial) frames.push({ type: "resize", cols: initial.cols, rows: initial.rows });
      const decoder = new StringDecoder("utf8");
      let offset = 0;
      const append = (end: number) => {
        const data = decoder.write(bytes.subarray(offset, end));
        if (data) frames.push({ type: "data", data });
        offset = end;
      };
      for (const size of sizes) {
        if (size.offset <= start) continue;
        append(size.offset - start);
        frames.push({ type: "resize", cols: size.cols, rows: size.rows });
      }
      append(bytes.length);
      return frames;
    },
    byteLength: () => total,
    clear() {
      chunks = [];
      total = 0;
      received = 0;
      sizes = [];
    },
  };
}

interface TermSession {
  id: string;
  projectId: string;
  cwd: string;
  title: string;
  cmd?: string;
  /** Exactly one of these is set: real PTY or pipe-backed child. */
  pty: NodePty | null;
  proc: ChildProcess | null;
  remote: RemoteProcessHandle | null;
  pid: number | undefined;
  cols: number;
  rows: number;
  createdAt: number;
  running: boolean;
  exitCode?: number | null;
  replay: SizedReplayBuffer;
  decoder: StringDecoder;
  workspaceRoots?: readonly string[];
  workspace?: TerminalWorkspace;
  sessionId?: string;
  repositoryId?: string;
  workspaceCleanup?: () => Promise<void>;
  boundary?: ProcessContainmentBoundary;
  release?: Promise<void>;
  released?: boolean;
  closing?: Promise<void>;
  workspaceReleased?: boolean;
  workspaceDetached?: boolean;
  /** Server-owned process (a background custom action) that interactive
   *  Terminal tab lists must not adopt. */
  hidden?: boolean;
  purpose?: TerminalInfo["purpose"];
}

/** Server-only create options. The HTTP route builds its input field by field
 *  and never forwards these. */
export interface TerminalServerCreateOptions {
  workspaceRoots?: readonly string[];
  workspaceCleanup?: () => Promise<void>;
  /** A background process interactive Terminal tab lists must not adopt. */
  hidden?: boolean;
  /** Caller-validated shell path for a local terminal (the terminal settings
   *  choice); remote hosts and `systemShell` ignore it. */
  shell?: string;
  /** Run `cmd` through the platform's system shell (`/bin/sh` or `cmd.exe`)
   *  instead of the person's chosen or login shell. */
  systemShell?: boolean;
  /** Run on this machine even when the project lives on an SSH host. */
  local?: boolean;
  /** Extra non-secret environment for a local terminal (never `POLYTH_SAFE_*`). */
  env?: Readonly<Record<string, string>>;
  title?: string;
  purpose?: TerminalInfo["purpose"];
}

export interface TerminalService {
  create(input: TerminalCreateInput & TerminalServerCreateOptions): Promise<{ id: string }>;
  /** Run a bounded, non-interactive command and capture merged output. */
  run(input: TerminalRunInput, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<TerminalRunResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  /** Close every running terminal whose cwd is `path` or nested under it. */
  closeByCwd(path: string): Promise<void>;
  list(projectId?: string): TerminalInfo[];
  get(id: string): TerminalInfo | undefined;
  /** Bounded scrollback replay for late subscribers; undefined = unknown id. */
  replay(id: string): string | undefined;
  /** Optional ordered replay metadata; string replay remains compatible. */
  replayFrames?(id: string): TerminalReplayFrame[] | undefined;
  /** Rename a tab; undefined = unknown id. */
  rename(id: string, title: string): TerminalInfo | undefined;
  /** child output (stdout+stderr merged) */
  onData(cb: (id: string, data: string) => void): Disposable;
  /** fired on process exit (also after close()); last callback wins for an id */
  onExit(cb: (id: string, exitCode: number | null) => void): Disposable;
}

/** Server-only injection seam. Values are accepted only by `run`, never by
 * the HTTP terminal-create route or interactive terminal sessions. */
export interface TerminalRunInput extends TerminalCreateInput {
  cmd: string;
  secureEnv?: Readonly<Record<string, string>>;
}

export interface TerminalRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/** The user's login shell recorded in the operating-system account database.
 *  A packaged desktop app launched from Finder/Dock/Spotlight does not inherit
 *  `SHELL`, and its absence must not be read as a request for POSIX `/bin/sh`. */
const systemAccountShell = (platform: NodeJS.Platform): string | undefined => {
  if (platform === "win32") return undefined;
  try {
    const shell = userInfo().shell?.trim();
    return shell || undefined;
  } catch {
    return undefined; // no passwd entry (minimal container or exotic account)
  }
};

/** The shell a user would get in their own terminal on `platform`. An explicit
 *  `SHELL` wins; otherwise the system account database is authoritative, then
 *  the platform's conventional login shell. `accountShell` is an injection seam
 *  (null = known absent) so tests stay independent of the host account. */
export const resolveLoginShell = (
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  accountShell: string | null | undefined = undefined,
): string => {
  if (platform === "win32") return env.COMSPEC?.trim() || "cmd.exe";
  const explicit = env.SHELL?.trim();
  if (explicit) return explicit;
  const account = accountShell !== undefined ? accountShell : systemAccountShell(platform);
  const login = account?.trim();
  if (login) return login;
  // macOS has shipped zsh as the system login shell since Catalina.
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
};

/** POSIX-family shells known to accept `-i` for an interactive session. Any
 *  other chosen shell starts without flags (a PTY makes it interactive). */
const INTERACTIVE_FLAG_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "mksh", "csh", "tcsh", "nu", "xonsh", "yash", "oksh"]);

/** A local launch. `commandLine` is set for `cmd.exe`: it must receive its
 *  command line verbatim, because the generic Windows argv quoting (node-pty,
 *  libuv) escapes an inner `"` as `\"`, which `cmd.exe` does not understand. */
export interface LocalShellLaunch { file: string; args: string[]; commandLine?: string }

const cmdExeLaunch = (file: string, cmd: string): LocalShellLaunch =>
  ({ file, args: ["/d", "/s", "/c", cmd], commandLine: `/d /s /c "${cmd}"` });

/** `shell` is an explicit, already-validated shell path (the terminal
 *  settings choice); omitted means the login shell (auto). */
export const localShellCommand = (
  cmd?: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  accountShell: string | null | undefined = undefined,
  shell?: string,
): LocalShellLaunch => {
  const file = shell?.trim() || resolveLoginShell(platform, env, accountShell);
  if (platform === "win32") {
    const name = file.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
    if (name === "pwsh" || name === "powershell") return { file, args: cmd ? ["-NoLogo", "-Command", cmd] : ["-NoLogo"] };
    if (name === "bash") return { file, args: cmd ? ["-c", cmd] : ["-i"] };
    return cmd ? cmdExeLaunch(file, cmd) : { file, args: [] };
  }
  if (cmd) return { file, args: ["-c", cmd] };
  return { file, args: !shell || INTERACTIVE_FLAG_SHELLS.has(basename(file)) ? ["-i"] : [] };
};

/** The platform's system shell running `cmd`: POSIX `/bin/sh` or `cmd.exe`.
 *  Commands Polyth itself supplies (harness install/sign-in) are written for
 *  it, so they never depend on the person's own terminal shell (fish, nu,
 *  tcsh, PowerShell all parse `VAR=value cmd` or `'quoted'` differently). */
export const systemShellCommand = (
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalShellLaunch => platform === "win32"
  ? cmdExeLaunch(env.COMSPEC?.trim() || "cmd.exe", cmd)
  : { file: "/bin/sh", args: ["-c", cmd] };

const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const secureEnvKey = /^POLYTH_SAFE_[A-Z][A-Z0-9_]*$/;

/** The SSH transport allocates the actual pseudo-terminal; this command only
 * places the remote shell in the selected project/session workspace. `stty`
 * is best-effort (a host without it still gets a shell), and the user's own
 * login shell is preferred over plain sh. */
const remoteTerminalCommand = (cwd: string, cmd: string | undefined, cols: number, rows: number, systemShell = false): string =>
  `cd -- ${shq(cwd)} && { stty cols ${cols} rows ${rows} 2>/dev/null || true; } `
    + `&& TERM=xterm-256color COLORTERM=truecolor exec `
    + (cmd && systemShell ? `/bin/sh -c ${shq(cmd)}` : `"\${SHELL:-/bin/sh}" ${cmd ? `-lc ${shq(cmd)}` : "-i"}`);

export type RemoteHostForProject = (projectId: string) => Promise<RemoteHost | undefined>;

const toInfo = (s: TermSession): TerminalInfo => ({
  id: s.id, title: s.title, cwd: s.cwd, projectId: s.projectId,
  createdAt: s.createdAt, running: s.running,
  ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
  ...(s.workspace ? { workspace: s.workspace } : {}),
  ...(s.sessionId ? { sessionId: s.sessionId } : {}),
  ...(s.repositoryId ? { repositoryId: s.repositoryId } : {}),
  ...(s.purpose ? { purpose: s.purpose } : {}),
});

export function createTerminalService(opts: {
  replayBytes?: number;
  forcePipe?: boolean;
  maxSessions?: number;
  /** Resolve a project's execution host; absent means a local shell. */
  remoteHostForProject?: RemoteHostForProject;
  /** Kernel containment supplied by the server owner. Without it, checkout
   * destruction remains blocked after terminal use even if the shell exits. */
  processBoundary?: (input: { id: string; projectId: string; cwd: string; workspaceRoots?: readonly string[] }) => ProcessContainmentBoundary | undefined | Promise<ProcessContainmentBoundary | undefined>;
  recoverProcesses?: { byCwd(cwd: string): Promise<void>; all(): Promise<void> };
} = {}): TerminalService {
  const sessions = new Map<string, TermSession>();
  let pendingCreations = 0;
  const unreleased = new Map<string, TermSession>();
  const workspaceRefs = new Map<string, { count: number; cleanup: () => Promise<void> }>();
  const dataCbs = new Set<(id: string, data: string) => void>();
  const exitCbs = new Set<(id: string, exitCode: number | null) => void>();
  const replayBytes = opts.replayBytes ?? DEFAULT_REPLAY_BYTES;
  const usePty = !opts.forcePipe && nodePty !== null && process.env.POLYTH_NO_PTY !== "1";
  const maxSessions = Number.isFinite(opts.maxSessions)
    ? Math.max(1, Math.min(100, Math.floor(opts.maxSessions!)))
    : Number.POSITIVE_INFINITY;

  const killGroup = (s: TermSession, signal: NodeJS.Signals) => {
    // Only signal a group created by this owner; never guess a pipe child's PGID.
    if (s.pid !== undefined && process.platform !== "win32") {
      try { process.kill(-s.pid, signal); } catch { /* already gone */ }
    }
    try { s.pty?.kill(signal); } catch { /* already gone */ }
    try { s.proc?.kill(signal); } catch { /* already gone */ }
    if (s.remote) void s.remote.kill().catch(() => {});
  };

  const releaseWorkspace = async (s: TermSession) => {
    if (s.workspaceReleased) return;
    if (!s.workspaceRoots?.length || !s.workspaceCleanup) { s.workspaceReleased = true; return; }
    const root = resolve(s.cwd);
    const ref = workspaceRefs.get(root);
    if (!ref) { await s.workspaceCleanup(); s.workspaceReleased = true; return; }
    if (!s.workspaceDetached) { ref.count -= 1; s.workspaceDetached = true; }
    if (ref.count > 0) { s.workspaceReleased = true; return; }
    await ref.cleanup();
    workspaceRefs.delete(root);
    s.workspaceReleased = true;
  };

  const releaseExecution = (s: TermSession): Promise<void> => {
    if (s.released) return releaseWorkspace(s).then(() => { unreleased.delete(s.id); });
    if (!s.boundary) return Promise.reject(Object.assign(
      new Error("Terminal descendants have no verified execution release"), { code: "outcome-unknown" },
    ));
    if (!s.release) s.release = s.boundary.close().then(async () => {
      s.released = true;
      await releaseWorkspace(s);
      unreleased.delete(s.id);
    }).finally(() => { s.release = undefined; });
    return s.release;
  };

  const emitExit = (s: TermSession, exitCode: number | null) => {
    if (!s.running) return;
    s.running = false;
    s.exitCode = exitCode;
    s.boundary?.launcherExited();
    if (s.boundary) void releaseExecution(s).catch(() => { unreleased.set(s.id, s); });
    else unreleased.set(s.id, s);
    for (const cb of exitCbs) cb(s.id, exitCode);
  };

  const clampCols = (v: number | undefined, def: number, max: number) =>
    Math.max(2, Math.min(Math.floor(v ?? def) || def, max));

  const spawnTerminal = async (input: TerminalCreateInput & TerminalServerCreateOptions & {
    secureEnv?: Readonly<Record<string, string>>;
    workspace?: TerminalWorkspace;
  }): Promise<{ id: string }> => {
      if (agentBetaEnabled()) {
        throw Object.assign(new Error(AGENT_BETA_READ_ONLY_MESSAGE), { code: "forbidden" });
      }
      const activeSessions = [...sessions.values()].filter((session) => session.running).length;
      if (activeSessions + pendingCreations >= maxSessions) {
        throw Object.assign(new Error(`terminal limit reached (${maxSessions})`), { code: "resource-limit" });
      }
      pendingCreations += 1;
      try {
      const id = randomUUID();
      const cwd = input.cwd ?? input.projectId; // route resolves projectId -> path
      const title = input.title?.trim().slice(0, 80) || basename(cwd) || cwd;
      const cols = clampCols(input.cols, 120, 500);
      const rows = clampCols(input.rows, 32, 200);
      // node-pty expects concrete string values; process.env's type permits
      // undefined, so discard those entries before passing the environment on.
      const env = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const secureEnv = input.secureEnv ?? {};
      for (const [key, value] of Object.entries(secureEnv)) {
        if (!secureEnvKey.test(key) || typeof value !== "string") {
          throw Object.assign(new Error("Credential Vault environment key is invalid"), { code: "invalid-input" });
        }
      }
      // Never inherit a host value for a reserved handle reference. Only the
      // resolver may place one into a bounded local child environment.
      for (const key of Object.keys(env)) {
        if (secureEnvKey.test(key)) delete env[key];
      }
      for (const [key, value] of Object.entries(input.env ?? {})) {
        if (secureEnvKey.test(key) || typeof value !== "string") {
          throw Object.assign(new Error("Terminal environment key is reserved"), { code: "invalid-input" });
        }
        // Windows names are case-insensitive: one `Path`/`PATH` entry only.
        if (process.platform === "win32") {
          for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
        }
        env[key] = value;
      }
      Object.assign(env, secureEnv);
      env.TERM = "xterm-256color";
      env.COLORTERM = "truecolor";

      const s: TermSession = {
        id, projectId: input.projectId, cwd, title, cmd: input.cmd,
        pty: null, proc: null, remote: null, pid: undefined, cols, rows,
        createdAt: Date.now(), running: true,
        replay: createReplayBuffer(replayBytes), decoder: new StringDecoder("utf8"),
        ...(input.workspaceRoots ? { workspaceRoots: [...input.workspaceRoots] } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
        ...(input.workspaceCleanup ? { workspaceCleanup: input.workspaceCleanup } : {}),
        ...(input.hidden === true ? { hidden: true } : {}),
        ...(input.purpose ? { purpose: input.purpose } : {}),
      };
      s.replay.resize(cols, rows);

      const emitText = (text: string) => {
        if (!text) return;
        for (const cb of dataCbs) cb(id, text);
      };

      const remoteHost = input.local ? undefined : await opts.remoteHostForProject?.(input.projectId);
      if (remoteHost) {
        if (Object.keys(secureEnv).length > 0) {
          throw Object.assign(
            new Error("Credential Vault env refs are supported only by local bounded shell runs"),
            { code: "unsupported" },
          );
        }
        const remote = await remoteHost.start(
          remoteTerminalCommand(cwd, input.cmd, cols, rows, input.systemShell === true),
          { interactive: true },
        );
        if (!remote.write) {
          await remote.kill().catch(() => {});
          throw Object.assign(
            new Error(`interactive terminal unavailable on ${remoteHost.label}`),
            { code: "unsupported" },
          );
        }
        s.remote = remote;
        remote.onOutput((data) => {
          if (!s.running) return;
          s.replay.push(Buffer.from(data, "utf8"));
          emitText(data);
        });
        remote.onExit((exitCode) => emitExit(s, exitCode));
      } else {
        s.boundary = await opts.processBoundary?.(s);
        const shell = input.systemShell && input.cmd
          ? systemShellCommand(input.cmd)
          : localShellCommand(input.cmd, process.platform, process.env, undefined, input.shell);
        // Tools that consult $SHELL (editors, `script`, tmux) follow the choice.
        if (input.shell && !input.systemShell && process.platform !== "win32") env.SHELL = shell.file;
        const launch = s.boundary?.launch(shell.file, shell.args) ?? { command: shell.file, args: shell.args };
        // Containment wraps the launch only on Linux; elsewhere `cmd.exe`
        // gets its verbatim command line (see LocalShellLaunch).
        const verbatim = !s.boundary && process.platform === "win32" ? shell.commandLine : undefined;
        let spawned = false;
        if (usePty && nodePty) {
          let pty: NodePty | undefined;
          try {
            pty = nodePty.spawn(launch.command, verbatim ?? launch.args, {
              name: "xterm-256color", cols, rows, cwd, env,
            });
          } catch {
            // Allocation threw without returning a process handle. Never retry
            // an uncertain contained launch; the exact unit must be released.
            if (s.boundary) {
              try { await s.boundary.close(); }
              catch (error) { unreleased.set(s.id, s); throw error; }
              throw Object.assign(new Error("Terminal PTY allocation failed"), { code: "unavailable" });
            }
          }
          if (pty) {
            s.pty = pty;
            s.pid = pty.pid;
            spawned = true;
            pty.onData((data) => {
              if (!s.running) return;
              s.replay.push(Buffer.from(data, "utf8")); // byte-exact within the cap
              emitText(data);
            });
            pty.onExit(({ exitCode }) => emitExit(s, typeof exitCode === "number" ? exitCode : null));
            try { s.boundary?.launcherStarted?.(pty.pid); }
            catch (error) {
              unreleased.set(id, s);
              await releaseExecution(s);
              throw error;
            }
          }
        }

        if (!spawned) {
          // Pipe fallback exports the grid so line tools wrap correctly.
          // The platform-native shell comes from localShellCommand().
          env.COLUMNS = String(cols);
          env.LINES = String(rows);
          const proc = verbatim
            ? spawn(launch.command, [verbatim], { cwd, env, windowsVerbatimArguments: true })
            : spawn(launch.command, launch.args, { cwd, env, detached: process.platform !== "win32" });
          proc.on("error", () => emitExit(s, null));
          proc.on("exit", (code) => emitExit(s, typeof code === "number" ? code : null));
          const push = (chunk: Buffer) => {
            if (!s.running) return;
            s.replay.push(chunk); // raw bytes, byte-exact within the cap
            // StringDecoder holds split multi-byte sequences until they complete,
            // so a chunk boundary can never corrupt live UTF-8 output
            emitText(s.decoder.write(chunk));
          };
          proc.stdout?.on("data", push);
          proc.stderr?.on("data", push);
          // Stream failures (including stdin EPIPE) are transport errors, not
          // proof that the child exited. Keep the composite workspace alive
          // until the process emits its authoritative exit event.
          proc.stdout?.on("error", () => {});
          proc.stderr?.on("error", () => {});
          proc.stdin?.on("error", () => {});
          s.proc = proc;
          s.pid = proc.pid;
          if (proc.pid !== undefined) {
            try { s.boundary?.launcherStarted?.(proc.pid); }
            catch (error) {
              unreleased.set(id, s);
              await releaseExecution(s);
              throw error;
            }
          }
        }
      }

      sessions.set(id, s);
      if (input.workspaceRoots?.length && input.workspaceCleanup) {
        const root = resolve(cwd);
        const current = workspaceRefs.get(root);
        if (current) current.count += 1;
        else workspaceRefs.set(root, { count: 1, cleanup: input.workspaceCleanup });
      }
      return { id };
      } finally { pendingCreations -= 1; }
  };

  const service: TerminalService = {
    create(input) {
      if ("secureEnv" in input && (input as { secureEnv?: unknown }).secureEnv) {
        return Promise.reject(Object.assign(
          new Error("Credential Vault env refs are supported only by local bounded shell runs"),
          { code: "unsupported" },
        ));
      }
      return spawnTerminal(input);
    },

    async run(input, opts = {}) {
      // Default stays short for bounded helpers; callers may raise up to 2 minutes.
      const timeoutMs = Math.max(100, Math.min(opts.timeoutMs ?? 30_000, 120_000));
      const maxOutputBytes = Math.max(1_024, Math.min(opts.maxOutputBytes ?? 64 * 1_024, 1024 * 1024));
      let terminalId = "";
      let output = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolveResult: (result: TerminalRunResult) => void = () => {};
      const result = new Promise<TerminalRunResult>((resolve) => { resolveResult = resolve; });
      const dataSub = service.onData((id, data) => {
        if (id !== terminalId || settled) return;
        // PTY-backed channels (node-pty locally, ssh -tt remotely) translate
        // \n to \r\n; plain results keep \n. Normalize CRLF so composer-shell
        // output renders like any other tool result.
        output += data.replace(/\r\n/g, "\n");
        if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
          truncated = true;
          // Retain a little extra by character first, then tighten by bytes.
          output = output.slice(-maxOutputBytes);
          while (Buffer.byteLength(output, "utf8") > maxOutputBytes) output = output.slice(1);
        }
      });
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        dataSub.dispose();
        exitSub.dispose();
        resolveResult({ output, exitCode, timedOut, truncated });
        if (terminalId) void service.close(terminalId).catch(() => {});
      };
      const exitSub = service.onExit((id, exitCode) => {
        if (id === terminalId) finish(exitCode);
      });
      try {
        terminalId = (await spawnTerminal(input)).id;
        timer = setTimeout(() => {
          timedOut = true;
          void service.close(terminalId).then(() => finish(null)).catch(() => finish(null));
        }, timeoutMs);
        timer.unref?.();
      } catch (err) {
        dataSub.dispose();
        exitSub.dispose();
        throw err;
      }
      return result;
    },

    write(id, data) {
      if (agentBetaEnabled()) return;
      const s = sessions.get(id);
      if (!s || !s.running) return;
      try {
        if (s.pty) s.pty.write(data);
        else if (s.remote?.write) {
          // A transport rejection does not prove the remote process exited;
          // retain workspace ownership until the remote exit callback.
          void s.remote.write(data).catch(() => {});
        }
        else s.proc?.stdin?.write(data);
      } catch { /* process gone */ }
    },

    resize(id, cols, rows) {
      const s = sessions.get(id);
      if (!s || !s.running) return;
      const nextCols = clampCols(cols, s.cols, 500);
      const nextRows = clampCols(rows, s.rows, 200);
      if (nextCols === s.cols && nextRows === s.rows) return;
      s.cols = nextCols;
      s.rows = nextRows;
      s.replay.resize(s.cols, s.rows);
      if (s.pty) {
        // real PTY: the kernel delivers SIGWINCH with the new size
        try { s.pty.resize(s.cols, s.rows); } catch { /* ignore */ }
        return;
      }
      if (s.remote) return; // its initial remote PTY dimensions are set at spawn
      // pipe fallback: no real terminal size; SIGWINCH at least wakes the
      // shell (bash re-reads LINES/COLUMNS)
      try { killGroup(s, "SIGWINCH"); } catch { /* ignore */ }
    },

    async close(id) {
      const s = sessions.get(id) ?? unreleased.get(id);
      if (!s) return;
      if (s.closing) return s.closing;
      s.closing = (async () => {
        if (s.boundary) {
          await releaseExecution(s);
          emitExit(s, s.exitCode ?? null);
        } else if (s.running) {
          // Subscribe before signaling: a remote adapter may exit synchronously.
          await new Promise<void>((res, rej) => {
            const finish = (error?: Error) => {
              clearTimeout(grace); clearTimeout(timer); sub.dispose();
              if (error) rej(error); else res();
            };
            const grace = setTimeout(() => killGroup(s, "SIGKILL"), 1000);
            const timer = setTimeout(() => finish(Object.assign(
              new Error("Terminal exit was not confirmed"), { code: "outcome-unknown" },
            )), 2000);
            const sub = service.onExit((exitedId) => { if (exitedId === id) finish(); });
            killGroup(s, "SIGTERM");
          });
        }
        sessions.delete(id);
        if (!s.released) {
          s.replay.clear();
          s.pty = null; s.proc = null; s.remote = null;
        }
      })().finally(() => { s.closing = undefined; });
      return s.closing;
    },

    async closeAll() {
      const failures: unknown[] = [];
      for (const id of new Set([...sessions.keys(), ...unreleased.keys()])) {
        try { await service.close(id); } catch (error) { failures.push(error); }
      }
      try { await opts.recoverProcesses?.all(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Some terminal executions could not be released");
    },

    async closeByCwd(path) {
      const target = resolve(path);
      const matching = [...new Map([...unreleased, ...sessions]).values()]
        .filter((session) => {
          const cwd = resolve(session.cwd);
          return cwd === target || cwd.startsWith(`${target}/`) || cwd.startsWith(`${target}\\`)
            || session.workspaceRoots?.some((root) => {
              const referenced = resolve(root);
              return referenced === target || referenced.startsWith(`${target}/`) || referenced.startsWith(`${target}\\`);
            });
        })
        ;
      for (const session of matching) {
        await service.close(session.id);
        if (!session.released) await releaseExecution(session);
      }
      await opts.recoverProcesses?.byCwd(target);
    },

    list(projectId) {
      const out: TerminalInfo[] = [];
      for (const s of sessions.values()) {
        if (projectId && s.projectId !== projectId) continue;
        if (s.hidden) continue;
        out.push(toInfo(s));
      }
      return out;
    },

    get(id) {
      const s = sessions.get(id);
      return s ? toInfo(s) : undefined;
    },

    replay(id) {
      return sessions.get(id)?.replay.snapshot();
    },

    replayFrames(id) {
      return sessions.get(id)?.replay.frames();
    },

    rename(id, title) {
      const s = sessions.get(id);
      if (!s) return undefined;
      const next = title.trim();
      if (next) s.title = next.slice(0, 80);
      return toInfo(s);
    },

    onData(cb) {
      dataCbs.add(cb);
      return { dispose: () => { dataCbs.delete(cb); } };
    },

    onExit(cb) {
      exitCbs.add(cb);
      return { dispose: () => { exitCbs.delete(cb); } };
    },
  };

  return service;
}

export { attachTerminalWs } from "./serverEntry.ts";
