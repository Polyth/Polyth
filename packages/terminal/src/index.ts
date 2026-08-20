// Project-scoped terminal sessions. Pure host logic (no HTTP/WS — the server
// maps routes onto this, like git/files). Each session is a spawned user
// shell; stdin/stdout/stderr are piped, so bidirectional I/O works for line
// commands.
//
// ponytail: no real PTY (node-pty is not installed). Full-screen apps (vim,
// htop) will misrender and resize only forwards SIGWINCH. Upgrade path: `npm i
// node-pty`, spawn via pty.spawn(shell, ["-i"], {cwd, cols, rows, env}) and
// wire onData/onExit — the service surface below stays identical.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Disposable, TerminalCreateInput, TerminalInfo } from "@polyth/contracts";

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
  proc: ChildProcess;
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

const toInfo = (s: TermSession): TerminalInfo => ({
  id: s.id, title: s.title, cwd: s.cwd, projectId: s.projectId,
  createdAt: s.createdAt, running: s.running,
  ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
});

export function createTerminalService(opts: { replayBytes?: number } = {}): TerminalService {
  const sessions = new Map<string, TermSession>();
  const dataCbs = new Set<(id: string, data: string) => void>();
  const exitCbs = new Set<(id: string, exitCode: number | null) => void>();
  const replayBytes = opts.replayBytes ?? DEFAULT_REPLAY_BYTES;

  const killGroup = (proc: ChildProcess, signal: NodeJS.Signals) => {
    if (proc.pid === undefined) return;
    try { process.kill(-proc.pid, signal); } catch { /* already gone */ }
    try { proc.kill(signal); } catch { /* already gone */ }
  };

  const emitExit = (s: TermSession, exitCode: number | null) => {
    if (!s.running) return;
    s.running = false;
    s.exitCode = exitCode;
    for (const cb of exitCbs) cb(s.id, exitCode);
  };

  const service: TerminalService = {
    async create(input) {
      const id = randomUUID();
      const cwd = input.cwd ?? input.projectId; // route resolves projectId -> path
      const title = basename(cwd) || cwd;
      const env = { ...process.env, TERM: "xterm-256color" };
      const proc = input.cmd
        ? spawn(input.cmd, { cwd, shell: true, env })
        : spawn(defaultShell(), ["-i"], { cwd, env });
      proc.on("error", () => emitExit(s, null));
      proc.on("exit", (code) => emitExit(s, typeof code === "number" ? code : null));
      // no real tty -> bash -i prints a "cannot set terminal process group"
      // warning to stderr; harmless, forwarded to the client like any output
      const push = (chunk: Buffer) => {
        if (!s.running) return;
        s.replay.push(chunk); // raw bytes, byte-exact within the cap
        // StringDecoder holds split multi-byte sequences until they complete,
        // so a chunk boundary can never corrupt live UTF-8 output (OC#1181)
        const text = s.decoder.write(chunk);
        if (!text) return;
        for (const cb of dataCbs) cb(id, text);
      };
      proc.stdout?.on("data", push);
      proc.stderr?.on("data", push);
      const s: TermSession = {
        id, projectId: input.projectId, cwd, title, cmd: input.cmd,
        proc, createdAt: Date.now(), running: true,
        replay: createReplayBuffer(replayBytes), decoder: new StringDecoder("utf8"),
      };
      sessions.set(id, s);
      return { id };
    },

    async run(input, opts = {}) {
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
        output += data;
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
      try { s.proc.stdin?.write(data); } catch { /* process gone */ }
    },

    resize(id, cols, rows) {
      const s = sessions.get(id);
      if (!s || !s.running) return;
      // ponytail: no PTY means no real terminal size; SIGWINCH at least wakes
      // the shell (bash re-reads LINES/COLUMNS). node-pty gives true resize.
      try { killGroup(s.proc, "SIGWINCH"); } catch { /* ignore */ }
    },

    async close(id) {
      const s = sessions.get(id);
      if (!s) return;
      killGroup(s.proc, "SIGTERM");
      const grace = setTimeout(() => killGroup(s.proc, "SIGKILL"), 1000);
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
