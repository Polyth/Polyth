// Project-scoped terminal sessions. Pure host logic (no HTTP/WS — the server
// maps routes onto this, like git/files). Each session is a spawned user
// shell.
//
// PTY: when the optional `node-pty` dependency is installed the shell runs on
// a real pseudo-terminal (full-screen apps, prompts, true resize). Without it
// we fall back to pipes: bidirectional I/O works for line commands, COLUMNS/
// LINES are exported at spawn, and resize forwards SIGWINCH. The service
// surface is identical either way.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  Disposable,
  RemoteHost,
  RemoteProcessHandle,
  TerminalCreateInput,
  TerminalInfo,
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

/** Default scrollback replay cap per PTY (F12). Configurable per service. */
export const DEFAULT_REPLAY_BYTES = 200 * 1024;

/** Bounded byte ring per terminal: late subscribers replay startup output.
 *  Byte-exact within the cap; snapshot() never tears a UTF-8 code point even
 *  when eviction or chunk boundaries land mid-character (OC#1181). */
export interface ReplayBuffer {
  push(chunk: Buffer): void;
  /** Decoded scrollback; torn leading continuation bytes are skipped. */
  snapshot(): string;
  byteLength(): number;
  clear(): void;
}

export function createReplayBuffer(maxBytes = DEFAULT_REPLAY_BYTES): ReplayBuffer {
  let chunks: Buffer[] = [];
  let total = 0;
  return {
    push(chunk) {
      if (chunk.length === 0) return;
      if (chunk.length >= maxBytes) {
        chunks = [chunk.subarray(chunk.length - maxBytes)];
        total = maxBytes;
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
      while (total > maxBytes) {
        const first = chunks[0]!;
        const excess = total - maxBytes;
        if (first.length <= excess) {
          chunks.shift();
          total -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          total -= excess;
        }
      }
    },
    snapshot() {
      const buf = Buffer.concat(chunks);
      // eviction may have cut into a multi-byte character: skip the orphaned
      // continuation bytes (0b10xxxxxx) so the decode never renders garbage
      let i = 0;
      while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
      return buf.subarray(i).toString("utf8");
    },
    byteLength: () => total,
    clear() {
      chunks = [];
      total = 0;
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
  replay: ReplayBuffer;
  decoder: StringDecoder;
}

export interface TerminalService {
  create(input: TerminalCreateInput): Promise<{ id: string }>;
  /** Run a bounded, non-interactive command and capture merged output. */
  run(input: TerminalCreateInput & { cmd: string }, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<TerminalRunResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  /** Close every running terminal whose cwd is `path` or nested under it. */
  closeByCwd(path: string): Promise<void>;
  list(projectId?: string): TerminalInfo[];
  get(id: string): TerminalInfo | undefined;
  /** Bounded scrollback replay for late subscribers (F12); undefined = unknown id. */
  replay(id: string): string | undefined;
  /** Rename a tab; undefined = unknown id. */
  rename(id: string, title: string): TerminalInfo | undefined;
  /** child output (stdout+stderr merged) */
  onData(cb: (id: string, data: string) => void): Disposable;
  /** fired on process exit (also after close()); last callback wins for an id */
  onExit(cb: (id: string, exitCode: number | null) => void): Disposable;
}

export interface TerminalRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

const defaultShell = (): string => process.env.SHELL || "/bin/sh";

const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** The SSH transport allocates the actual pseudo-terminal; this command only
 * places the remote shell in the selected project/session workspace. `stty`
 * is best-effort (a host without it still gets a shell), and the user's own
 * login shell is preferred over plain sh. */
const remoteTerminalCommand = (cwd: string, cmd: string | undefined, cols: number, rows: number): string =>
  `cd -- ${shq(cwd)} && { stty cols ${cols} rows ${rows} 2>/dev/null || true; } `
    + `&& TERM=xterm-256color COLORTERM=truecolor exec "\${SHELL:-/bin/sh}" ${cmd ? `-lc ${shq(cmd)}` : "-i"}`;

export type RemoteHostForProject = (projectId: string) => Promise<RemoteHost | undefined>;

const toInfo = (s: TermSession): TerminalInfo => ({
  id: s.id, title: s.title, cwd: s.cwd, projectId: s.projectId,
  createdAt: s.createdAt, running: s.running,
  ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
});

export function createTerminalService(opts: {
  replayBytes?: number;
  forcePipe?: boolean;
  maxSessions?: number;
  /** Resolve a project's execution host; absent means a local shell. */
  remoteHostForProject?: RemoteHostForProject;
} = {}): TerminalService {
  const sessions = new Map<string, TermSession>();
  const dataCbs = new Set<(id: string, data: string) => void>();
  const exitCbs = new Set<(id: string, exitCode: number | null) => void>();
  const replayBytes = opts.replayBytes ?? DEFAULT_REPLAY_BYTES;
  const usePty = !opts.forcePipe && nodePty !== null && process.env.POLYTH_NO_PTY !== "1";
  const maxSessions = Number.isFinite(opts.maxSessions)
    ? Math.max(1, Math.min(100, Math.floor(opts.maxSessions!)))
    : Number.POSITIVE_INFINITY;

  const killGroup = (s: TermSession, signal: NodeJS.Signals) => {
    // node-pty children are session leaders, pipe children get detached=false —
    // try the process group first, then the process itself
    if (s.pid !== undefined) {
      try { process.kill(-s.pid, signal); } catch { /* already gone */ }
    }
    try { s.pty?.kill(signal); } catch { /* already gone */ }
    try { s.proc?.kill(signal); } catch { /* already gone */ }
    if (s.remote) void s.remote.kill().catch(() => {});
  };

  const emitExit = (s: TermSession, exitCode: number | null) => {
    if (!s.running) return;
    s.running = false;
    s.exitCode = exitCode;
    for (const cb of exitCbs) cb(s.id, exitCode);
  };

  const clampCols = (v: number | undefined, def: number, max: number) =>
    Math.max(2, Math.min(Math.floor(v ?? def) || def, max));

  const service: TerminalService = {
    async create(input) {
      const activeSessions = [...sessions.values()].filter((session) => session.running).length;
      if (activeSessions >= maxSessions) {
        throw Object.assign(new Error(`terminal limit reached (${maxSessions})`), { code: "resource-limit" });
      }
      const id = randomUUID();
      const cwd = input.cwd ?? input.projectId; // route resolves projectId -> path
      const title = basename(cwd) || cwd;
      const cols = clampCols(input.cols, 120, 500);
      const rows = clampCols(input.rows, 32, 200);
      // node-pty expects concrete string values; process.env's type permits
      // undefined, so discard those entries before passing the environment on.
      const env = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      env.TERM = "xterm-256color";
      env.COLORTERM = "truecolor";

      const s: TermSession = {
        id, projectId: input.projectId, cwd, title, cmd: input.cmd,
        pty: null, proc: null, remote: null, pid: undefined, cols, rows,
        createdAt: Date.now(), running: true,
        replay: createReplayBuffer(replayBytes), decoder: new StringDecoder("utf8"),
      };

      const emitText = (text: string) => {
        if (!text) return;
        for (const cb of dataCbs) cb(id, text);
      };

      const remoteHost = await opts.remoteHostForProject?.(input.projectId);
      if (remoteHost) {
        const remote = await remoteHost.start(
          remoteTerminalCommand(cwd, input.cmd, cols, rows),
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
        let spawned = false;
        if (usePty && nodePty) {
          try {
            const shell = defaultShell();
            const args = input.cmd ? ["-c", input.cmd] : ["-i"];
            const pty = nodePty.spawn(shell, args, {
              name: "xterm-256color", cols, rows, cwd, env,
            });
            pty.onData((data) => {
              if (!s.running) return;
              s.replay.push(Buffer.from(data, "utf8")); // byte-exact within the cap
              emitText(data);
            });
            pty.onExit(({ exitCode }) => emitExit(s, typeof exitCode === "number" ? exitCode : null));
            s.pty = pty;
            s.pid = pty.pid;
            spawned = true;
          } catch {
            spawned = false; // PTY allocation failed — fall back to pipes below
          }
        }

        if (!spawned) {
          // pipe fallback: export the grid so line tools wrap correctly; bash -i
          // prints a harmless "cannot set terminal process group" warning that is
          // forwarded to the client like any output
          env.COLUMNS = String(cols);
          env.LINES = String(rows);
          const proc = input.cmd
            ? spawn(input.cmd, { cwd, shell: true, env })
            : spawn(defaultShell(), ["-i"], { cwd, env });
          proc.on("error", () => emitExit(s, null));
          proc.on("exit", (code) => emitExit(s, typeof code === "number" ? code : null));
          const push = (chunk: Buffer) => {
            if (!s.running) return;
            s.replay.push(chunk); // raw bytes, byte-exact within the cap
            // StringDecoder holds split multi-byte sequences until they complete,
            // so a chunk boundary can never corrupt live UTF-8 output (OC#1181)
            emitText(s.decoder.write(chunk));
          };
          proc.stdout?.on("data", push);
          proc.stderr?.on("data", push);
          proc.stdout?.on("error", () => emitExit(s, proc.exitCode));
          proc.stderr?.on("error", () => emitExit(s, proc.exitCode));
          // A command can exit between the running check in write() and the
          // kernel accepting stdin. Own the pipe error so EPIPE is a terminal
          // event for this session, never an uncaught process-wide error.
          proc.stdin?.on("error", () => emitExit(s, proc.exitCode));
          s.proc = proc;
          s.pid = proc.pid;
        }
      }

      sessions.set(id, s);
      return { id };
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
        terminalId = (await service.create(input)).id;
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
      const s = sessions.get(id);
      if (!s || !s.running) return;
      try {
        if (s.pty) s.pty.write(data);
        else if (s.remote?.write) {
          void s.remote.write(data).catch(() => emitExit(s, null));
        }
        else s.proc?.stdin?.write(data);
      } catch { /* process gone */ }
    },

    resize(id, cols, rows) {
      const s = sessions.get(id);
      if (!s || !s.running) return;
      s.cols = clampCols(cols, s.cols, 500);
      s.rows = clampCols(rows, s.rows, 200);
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
      const s = sessions.get(id);
      if (!s) return;
      killGroup(s, "SIGTERM");
      const grace = setTimeout(() => killGroup(s, "SIGKILL"), 1000);
      const onExit = () => { clearTimeout(grace); sessions.delete(id); };
      if (!s.running) { onExit(); return; }
      // wait for the exit event, with a hard fallback
      const wait = new Promise<void>((res) => {
        const timer = setTimeout(() => { sessions.delete(id); res(); }, 2000);
        const sub = service.onExit((exitedId) => {
          if (exitedId !== id) return;
          clearTimeout(timer);
          sub.dispose();
          sessions.delete(id);
          res();
        });
      });
      await wait;
      if (!sessions.has(id)) return;
      onExit();
    },

    async closeAll() {
      await Promise.all([...sessions.keys()].map((id) => service.close(id)));
    },

    async closeByCwd(path) {
      const target = resolve(path);
      const ids = [...sessions.values()]
        .filter((session) => {
          const cwd = resolve(session.cwd);
          return cwd === target || cwd.startsWith(`${target}/`) || cwd.startsWith(`${target}\\`);
        })
        .map((session) => session.id);
      await Promise.all(ids.map((id) => service.close(id)));
    },

    list(projectId) {
      const out: TerminalInfo[] = [];
      for (const s of sessions.values()) {
        if (projectId && s.projectId !== projectId) continue;
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
