// SSH connection inventory + lifecycle for remote projects.
//
// Design (minimum load, delegated auth):
// - Authentication is delegated to the system OpenSSH client (`ssh` on PATH):
//   agent, default keys, ssh_config aliases, or an explicit identity FILE
//   PATH. Password auth is intentionally unsupported (BatchMode=yes) — no
//   secret material is ever stored, accepted, or returned by this package.
// - Every connection is an OpenSSH ControlMaster multiplexed over ONE TCP/SSH
//   connection (ControlPath socket under tmpdir). Execs, the long-lived agent
//   process, and port forwards all share that channel, so per-call latency is
//   a socket hop, not a new handshake.
// - Health checks use `ssh -O check` — a LOCAL control-socket probe, so
//   status polling never generates network chatter. `test` is the explicit
//   real round-trip probe.
// - Idle disconnect is ControlPersist: the master exits on its own after the
//   configured quiet period once no sessions/forwards remain.
//
// This package knows nothing about OpenCode. It exposes the generic
// `RemoteHost` transport (contracts) that backend-opencode consumes to run
// the agent runtime on the remote machine.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Disposable,
  RemoteHost,
  SshAuthMode,
  SshBrowseDto,
  SshConnectionDto,
  SshConnectionInput,
  SshConnectionState,
  SshConnectionStatusDto,
} from "@polyth/contracts";

export interface SshExecResult { code: number; stdout: string; stderr: string }

/** Bounded one-shot `ssh <args>` execution. Injectable for tests. */
export type SshRunner = (
  args: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number },
) => Promise<SshExecResult>;

/** Long-lived `ssh <args>` child (remote process channel). Injectable. */
export interface SshChild {
  onOutput(cb: (chunk: string) => void): Disposable;
  onExit(cb: (code: number | null) => void): Disposable;
  write?(data: string): void;
  kill(): void;
}
export type SshSpawner = (args: string[], opts?: { interactive?: boolean }) => SshChild;

export interface SshService {
  list(): SshConnectionDto[];
  get(id: string): SshConnectionDto | undefined;
  create(input: SshConnectionInput): SshConnectionDto;
  update(id: string, input: SshConnectionInput): SshConnectionDto;
  remove(id: string): Promise<void>;
  /** Establish (or reuse) the multiplexed master connection. */
  connect(id: string): Promise<SshConnectionStatusDto>;
  /** Tear down the master connection (forwards and channels close with it). */
  disconnect(id: string): Promise<SshConnectionStatusDto>;
  /** Local control-socket check — no network round-trip. */
  status(id: string): Promise<SshConnectionStatusDto>;
  /** Real round-trip probe measuring latency (auto-connects the master). */
  test(id: string): Promise<SshConnectionStatusDto>;
  /** Last known status without touching the socket (for list rendering). */
  cachedStatus(id: string): SshConnectionStatusDto | undefined;
  /** Run a command on the remote POSIX shell (auto-connects the master). */
  exec(id: string, command: string, opts?: { timeoutMs?: number }): Promise<SshExecResult>;
  /** Remote directory listing for pickers. Empty path = remote $HOME. */
  browse(id: string, path?: string): Promise<SshBrowseDto>;
  dirExists(id: string, path: string): Promise<boolean>;
  makeDir(id: string, path: string): Promise<void>;
  /** Generic transport facade for this connection (see contracts). */
  host(id: string): RemoteHost;
  disconnectAll(): Promise<void>;
}

export interface SshServiceOptions {
  /** Connection inventory JSON (e.g. `<dataDir>/ssh.json`). */
  file: string;
  /** Control sockets directory (default: `<tmpdir>/polyth-ssh`). */
  socketDir?: string;
  runner?: SshRunner;
  spawner?: SshSpawner;
  /** Local free-port allocator for forwards. Injectable for tests. */
  freeLocalPort?: () => Promise<number>;
  now?: () => number;
  /** Master idle lifetime in seconds once nothing uses it (default 600). */
  controlPersistSeconds?: number;
  execTimeoutMs?: number;
  connectTimeoutSeconds?: number;
}

interface StoredConnection {
  id: string;
  name: string;
  host: string;
  port?: number;
  user?: string;
  authMode: SshAuthMode;
  identityFile?: string;
  createdAt: number;
}

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const notFound = (message: string): Error =>
  Object.assign(new Error(message), { code: "not-found" });

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

/** POSIX single-quote escaping for remote command interpolation. */
export const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const short = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Destinations/values must never be parseable as ssh options. Everything is
 * passed as its own argv entry AND `--` precedes the destination, but a
 * leading `-` or embedded whitespace/control character is still rejected. */
const checkToken = (value: string, label: string): string => {
  if (!value) throw invalid(`${label} is required`);
  if (value.startsWith("-")) throw invalid(`${label} must not start with "-"`);
  if (/[\s\p{Cc}]/u.test(value)) throw invalid(`${label} must not contain whitespace or control characters`);
  return value;
};

const normalizeHost = (value: unknown): string => checkToken(short(value, 255), "host");

const normalizeUser = (value: unknown): string | undefined => {
  const user = short(value, 64);
  if (!user) return undefined;
  checkToken(user, "user");
  if (user.includes("@")) throw invalid("user must not contain @");
  return user;
};

const normalizePort = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid("port must be 1-65535");
  return port;
};

const normalizeAuthMode = (value: unknown): SshAuthMode => {
  if (value === undefined || value === "" || value === "agent") return "agent";
  if (value === "identity-file") return "identity-file";
  throw invalid('authMode must be "agent" or "identity-file"');
};

const normalizeIdentityFile = (value: unknown): string | undefined => {
  const file = short(value, 1024);
  if (!file) return undefined;
  if (file.startsWith("-")) throw invalid('identityFile must not start with "-"');
  if (/\p{Cc}/u.test(file)) throw invalid("identityFile must not contain control characters");
  return file;
};

/** Secrets never enter this inventory — reject payloads that try. */
const SECRET_FIELDS = ["password", "passphrase", "privateKey", "key", "token", "secret"] as const;
const rejectSecretFields = (raw: Record<string, unknown>): void => {
  for (const field of SECRET_FIELDS) {
    if (raw[field] !== undefined) {
      throw invalid(`"${field}" is not accepted: Polyth never stores SSH secrets — use an agent, ssh_config, or an identity file path`);
    }
  }
};

const tail = (text: string, max = 300): string => {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
};

const classifyFailure = (result: SshExecResult): { state: SshConnectionState; message: string } => {
  const err = tail(result.stderr) || tail(result.stdout);
  if (/permission denied|authentication fail|no supported authentication|too many authentication|host key verification failed/i.test(err)) {
    return { state: "auth-failed", message: err };
  }
  return { state: "unreachable", message: err || `ssh exited with code ${result.code}` };
};

const defaultRunner: SshRunner = (args, opts) =>
  new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const maxBytes = opts.maxOutputBytes ?? 262_144;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(0, maxBytes), stderr: stderr.slice(0, maxBytes) });
    };
    const timer = setTimeout(() => {
      stderr += "\nssh command timed out";
      child.kill("SIGKILL");
      settle(124);
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { stderr += String(err.message ?? err); settle(-1); });
    child.on("exit", (code) => settle(code ?? -1));
  });

const defaultSpawner: SshSpawner = (args, opts) => {
  const child = spawn("ssh", args, {
    stdio: [opts?.interactive ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const outputs = new Set<(chunk: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString();
    for (const cb of outputs) cb(text);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("error", () => { for (const cb of exits) cb(-1); });
  child.on("exit", (code) => { for (const cb of exits) cb(code); });
  return {
    onOutput(cb) {
      outputs.add(cb);
      return { dispose: () => { outputs.delete(cb); } };
    },
    onExit(cb) {
      exits.add(cb);
      return { dispose: () => { exits.delete(cb); } };
    },
    write(data) {
      try { child.stdin?.write(data); } catch { /* process exited */ }
    },
    kill() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
};

const defaultFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free local port"))));
    });
  });

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already renamed or removed */ }
    throw error;
  }
}

/** Short stable hash — unix socket paths have a ~104 byte limit. */
const shortHash = (value: string): string => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export function createSshService(options: SshServiceOptions): SshService {
  mkdirSync(dirname(options.file), { recursive: true });
  const socketDir = options.socketDir ?? join(tmpdir(), "polyth-ssh");
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const run = options.runner ?? defaultRunner;
  const spawnChild = options.spawner ?? defaultSpawner;
  const freeLocalPort = options.freeLocalPort ?? defaultFreePort;
  const now = options.now ?? Date.now;
  const persistSeconds = options.controlPersistSeconds ?? 600;
  const execTimeoutMs = options.execTimeoutMs ?? 20_000;
  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? 10;

  let items: StoredConnection[] = [];
  try {
    const raw = JSON.parse(readFileSync(options.file, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      items = raw.filter((entry): entry is StoredConnection =>
        !!entry && typeof entry === "object" && typeof (entry as StoredConnection).id === "string"
          && typeof (entry as StoredConnection).host === "string");
    }
  } catch { /* first run */ }

  const statuses = new Map<string, SshConnectionStatusDto>();
  const homes = new Map<string, string>();
  const connecting = new Map<string, Promise<SshConnectionStatusDto>>();

  const persist = (): void => {
    atomicWrite(options.file, JSON.stringify(items, null, 2));
  };

  const must = (id: string): StoredConnection => {
    const conn = items.find((c) => c.id === id);
    if (!conn) throw notFound(`unknown SSH connection: ${id}`);
    return conn;
  };

  const dto = (conn: StoredConnection): SshConnectionDto => ({
    id: conn.id,
    name: conn.name,
    host: conn.host,
    ...(conn.port !== undefined ? { port: conn.port } : {}),
    ...(conn.user ? { user: conn.user } : {}),
    authMode: conn.authMode,
    ...(conn.identityFile ? { identityFile: conn.identityFile } : {}),
    createdAt: conn.createdAt,
  });

  const destination = (conn: StoredConnection): string =>
    conn.user ? `${conn.user}@${conn.host}` : conn.host;

  const socketFor = (id: string): string => join(socketDir, `${shortHash(id)}.sock`);

  /** Options shared by every dialing invocation (exec / start / connect). */
  const dialArgs = (conn: StoredConnection): string[] => [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    // TOFU: BatchMode cannot answer the interactive host-key prompt. New keys
    // are recorded; a CHANGED key still fails closed (OpenSSH >= 7.6).
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${socketFor(conn.id)}`,
    "-o", `ControlPersist=${persistSeconds}s`,
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    // Without this, every slave prints "Shared connection to X closed." on
    // clean exit — it lands in composer-shell tool output.
    "-o", "LogLevel=ERROR",
    ...(conn.port !== undefined ? ["-p", String(conn.port)] : []),
    ...(conn.authMode === "identity-file" && conn.identityFile
      ? ["-i", conn.identityFile, "-o", "IdentitiesOnly=yes"]
      : []),
  ];

  /** Control operations talk to the local mux socket only — never dial. */
  const controlArgs = (conn: StoredConnection, op: string, extra: string[] = []): string[] => [
    "-o", `ControlPath=${socketFor(conn.id)}`,
    "-O", op,
    ...extra,
    "--", destination(conn),
  ];

  const setStatus = (id: string, state: SshConnectionState, patch: Partial<SshConnectionStatusDto> = {}): SshConnectionStatusDto => {
    const status: SshConnectionStatusDto = { id, state, checkedAt: now(), ...patch };
    statuses.set(id, status);
    return status;
  };

  const execOn = async (
    conn: StoredConnection,
    command: string,
    timeoutMs = execTimeoutMs,
    maxOutputBytes?: number,
  ): Promise<SshExecResult> =>
    run([...dialArgs(conn), "--", destination(conn), command], {
      timeoutMs,
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    });

  const connect = async (id: string): Promise<SshConnectionStatusDto> => {
    const running = connecting.get(id);
    if (running) return running;
    const task = (async () => {
      const conn = must(id);
      const result = await execOn(conn, "true");
      if (result.code === 0) return setStatus(id, "connected");
      const failure = classifyFailure(result);
      return setStatus(id, failure.state, { message: failure.message });
    })().finally(() => connecting.delete(id));
    connecting.set(id, task);
    return task;
  };

  const checkMux = async (conn: StoredConnection): Promise<boolean> =>
    (await run(controlArgs(conn, "check"), { timeoutMs: 5_000 })).code === 0;

  const ensureConnected = async (id: string): Promise<void> => {
    const conn = must(id);
    if (await checkMux(conn)) return;
    const status = await connect(id);
    if (status.state !== "connected") {
      throw unavailable(`SSH connection "${conn.name}" is ${status.state}${status.message ? `: ${status.message}` : ""}`);
    }
  };

  const exec = async (id: string, command: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<SshExecResult> => {
    const conn = must(id);
    return execOn(conn, command, opts?.timeoutMs ?? execTimeoutMs, opts?.maxOutputBytes);
  };

  const homeOf = async (id: string): Promise<string> => {
    const cached = homes.get(id);
    if (cached) return cached;
    const result = await exec(id, 'printf %s "$HOME"');
    if (result.code !== 0) throw unavailable(`could not resolve remote home: ${tail(result.stderr)}`);
    const home = result.stdout.trim() || "/";
    homes.set(id, home);
    return home;
  };

  const applyInput = (
    raw: Record<string, unknown>,
    previous?: StoredConnection,
  ): Omit<StoredConnection, "id" | "createdAt"> => {
    rejectSecretFields(raw);
    const input = raw as SshConnectionInput;
    const host = input.host === undefined && previous ? previous.host : normalizeHost(input.host);
    const user = input.user === undefined && previous ? previous.user : normalizeUser(input.user);
    const port = input.port === undefined && previous ? previous.port : normalizePort(input.port);
    const authMode = input.authMode === undefined && previous ? previous.authMode : normalizeAuthMode(input.authMode);
    const identityFile = input.identityFile === undefined && previous
      ? previous.identityFile
      : normalizeIdentityFile(input.identityFile);
    if (authMode === "identity-file" && !identityFile) {
      throw invalid("identityFile is required when authMode is identity-file");
    }
    const fallbackName = user ? `${user}@${host}` : host;
    const name = input.name === undefined && previous ? previous.name : (short(input.name, 120) || fallbackName);
    return {
      name, host, authMode,
      ...(port !== undefined ? { port } : {}),
      ...(user ? { user } : {}),
      ...(authMode === "identity-file" && identityFile ? { identityFile } : {}),
    };
  };

  return {
    list: () => items.map(dto),
    get: (id) => {
      const conn = items.find((c) => c.id === id);
      return conn ? dto(conn) : undefined;
    },

    create(input) {
      const fields = applyInput((input ?? {}) as Record<string, unknown>);
      const conn: StoredConnection = { id: randomUUID(), createdAt: now(), ...fields };
      items.push(conn);
      persist();
      return dto(conn);
    },

    update(id, input) {
      const conn = must(id);
      const fields = applyInput((input ?? {}) as Record<string, unknown>, conn);
      const next: StoredConnection = { id: conn.id, createdAt: conn.createdAt, ...fields };
      items = items.map((c) => (c.id === id ? next : c));
      persist();
      return dto(next);
    },

    async remove(id) {
      const conn = must(id);
      await run(controlArgs(conn, "exit"), { timeoutMs: 5_000 }).catch(() => undefined);
      items = items.filter((c) => c.id !== id);
      statuses.delete(id);
      homes.delete(id);
      persist();
    },

    connect,

    async disconnect(id) {
      const conn = must(id);
      await run(controlArgs(conn, "exit"), { timeoutMs: 5_000 });
      homes.delete(id);
      return setStatus(id, "disconnected");
    },

    async status(id) {
      const conn = must(id);
      if (await checkMux(conn)) return setStatus(id, "connected");
      const previous = statuses.get(id);
      // A dead mux is "disconnected" unless the last dial failed harder.
      const state = previous && (previous.state === "auth-failed" || previous.state === "unreachable")
        ? previous.state
        : "disconnected";
      return setStatus(id, state, previous?.message ? { message: previous.message } : {});
    },

    async test(id) {
      const conn = must(id);
      const nonce = `polyth-${Math.random().toString(36).slice(2, 10)}`;
      const startedAt = now();
      const result = await execOn(conn, `echo ${nonce}`);
      if (result.code === 0 && result.stdout.includes(nonce)) {
        return setStatus(id, "connected", { latencyMs: Math.max(0, now() - startedAt) });
      }
      const failure = result.code === 0
        ? { state: "unreachable" as const, message: "unexpected probe output" }
        : classifyFailure(result);
      return setStatus(id, failure.state, { message: failure.message });
    },

    cachedStatus: (id) => statuses.get(id),

    exec,

    async browse(id, path) {
      const base = short(path, 4096) || await homeOf(id);
      const result = await exec(id, `cd -- ${shq(base)} && pwd && LC_ALL=C ls -1Ap`);
      if (result.code !== 0) {
        throw Object.assign(
          new Error(`cannot browse ${base}: ${tail(result.stderr) || "directory not accessible"}`),
          { code: "not-found" },
        );
      }
      const lines = result.stdout.split("\n");
      const canonical = (lines[0] ?? base).trim() || "/";
      const entries = lines.slice(1)
        .map((line) => line.trim())
        .filter((line) => line.endsWith("/"))
        .map((line) => line.slice(0, -1))
        .filter((name) => name && !name.startsWith("."))
        .map((name) => ({ name, path: posix.join(canonical, name) }));
      return {
        path: canonical,
        parent: canonical === "/" ? null : posix.dirname(canonical),
        home: await homeOf(id),
        entries,
      };
    },

    async dirExists(id, path) {
      const target = short(path, 4096);
      if (!target) throw invalid("path is required");
      return (await exec(id, `test -d ${shq(target)}`)).code === 0;
    },

    async makeDir(id, path) {
      const target = short(path, 4096);
      if (!target) throw invalid("path is required");
      const result = await exec(id, `mkdir -p -- ${shq(target)}`);
      if (result.code !== 0) {
        throw invalid(`could not create ${target}: ${tail(result.stderr) || "mkdir failed"}`);
      }
    },

    host(id) {
      const conn = must(id);
      return {
        label: destination(conn),
        exec: (command, opts) => exec(id, command, opts),
        async start(command, opts) {
          await ensureConnected(id);
          const fresh = must(id);
          const child = spawnChild([
            ...dialArgs(fresh),
            ...(opts?.interactive ? ["-tt"] : []),
            "--", destination(fresh), command,
          ], opts);
          return {
            onOutput: (cb) => child.onOutput(cb),
            onExit: (cb) => child.onExit(cb),
            ...(child.write ? { write: (data: string) => child.write!(data) } : {}),
            kill: async () => child.kill(),
          };
        },
        async forward(remotePort) {
          await ensureConnected(id);
          const fresh = must(id);
          const localPort = await freeLocalPort();
          const spec = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
          const result = await run(controlArgs(fresh, "forward", ["-L", spec]), { timeoutMs: 10_000 });
          if (result.code !== 0) {
            throw unavailable(`port forward failed: ${tail(result.stderr) || `ssh exited ${result.code}`}`);
          }
          return {
            localPort,
            dispose: async () => {
              await run(controlArgs(fresh, "cancel", ["-L", spec]), { timeoutMs: 10_000 }).catch(() => undefined);
            },
          };
        },
      };
    },

    async disconnectAll() {
      await Promise.all(items.map(async (conn) => {
        await run(controlArgs(conn, "exit"), { timeoutMs: 5_000 }).catch(() => undefined);
        setStatus(conn.id, "disconnected");
      }));
    },
  };
}
