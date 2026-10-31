// SSH connection inventory + lifecycle for remote projects.
//
// Design (minimum load, delegated auth):
// - Authentication is delegated to the system OpenSSH client (the `ssh`
//   binary Polyth resolves for this host):
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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteSync } from "@polyth/plugins";
import { resolveExecutable } from "@polyth/kernel/executable";
import type {
  Disposable,
  RemoteHost,
  SshAuthMode,
  SshBrowseDto,
  SshConnectionDto,
  SshConnectionInput,
  SshConnectionState,
  SshConnectionStatusDto,
  SshHarnessConfigSource,
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
  write?(data: string): Promise<void>;
  kill(): void;
}
export type SshSpawner = (args: string[], opts?: { interactive?: boolean; stdin?: "pipe" }) => SshChild;

/** Who a connection belongs to (Spaces §14.6). */
export type SshConnectionOwner =
  | { kind: "installation" }
  | { kind: "person"; userId: string };

/** Who else may use an installation connection besides the instance owner:
 * these people in any Space, and every member of these Spaces. Empty = only
 * the instance owner. */
export interface SshAccessList {
  allowedUserIds: string[];
  allowedSpaceIds: string[];
}

/**
 * Who is asking to use a connection:
 *
 * - `person`: a signed-in member (or the session's acting person) in `spaceId`.
 *   The caller has already proven membership; `instanceOwner` is the
 *   server-minted marker, never request input.
 * - `binding`: work with no person (a harness probe, a turn nobody started)
 *   on a project already bound to the connection in `spaceId`.
 */
export type SshPrincipal =
  | { kind: "person"; userId: string; spaceId: string; instanceOwner: boolean }
  | { kind: "binding"; spaceId: string };

export interface SshConnectionRecordDto extends SshConnectionDto {
  owner: "installation" | "person";
  /** Person-owned: the owner's id. */
  ownerUserId?: string;
  /** Installation-owned: the allowlists (shown to the instance owner only). */
  allowedUserIds?: string[];
  allowedSpaceIds?: string[];
  /** Person-owned: a private key has been uploaded. */
  keyUploaded?: boolean;
}

export interface SshService {
  /** Installation connections. */
  list(): SshConnectionRecordDto[];
  /** One person's own connections. */
  listOwned(userId: string): SshConnectionRecordDto[];
  get(id: string): SshConnectionRecordDto | undefined;
  create(input: SshConnectionInput, owner?: SshConnectionOwner): SshConnectionRecordDto;
  update(id: string, input: SshConnectionInput): SshConnectionRecordDto;
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
  ownerOf(id: string): SshConnectionOwner | undefined;
  /** May this principal use the connection? Unknown ids are not usable. */
  usable(id: string, principal: SshPrincipal): boolean;
  /** Replace an installation connection's allowlists. */
  setAccess(id: string, access: SshAccessList): SshConnectionRecordDto;
  /** Store a person-owned connection's private key (0600, person storage). */
  putKey(id: string, privateKey: string): SshConnectionRecordDto;
}

/** Storage of one person's SSH data (`host.people.storage(userId, "ssh")`). */
export interface SshPersonStorage {
  root: string;
  /** Escape-proof path under `root`. */
  path(relative: string): string;
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
  /** Remote loopback port candidate picker for reverse forwards. */
  pickRemotePort?: () => number;
  now?: () => number;
  /** Master idle lifetime in seconds once nothing uses it (default 600). */
  controlPersistSeconds?: number;
  execTimeoutMs?: number;
  connectTimeoutSeconds?: number;
  /** Person-owned connections live here; absent = installation only. */
  personStorage?: (userId: string) => SshPersonStorage;
  /** Active membership, for work with no person (`binding`). */
  isMember?: (userId: string, spaceId: string) => boolean;
}

interface StoredConnection {
  id: string;
  name: string;
  host: string;
  port?: number;
  user?: string;
  authMode: SshAuthMode;
  identityFile?: string;
  /** Only `remote` exceptions are stored; absent means `local`. */
  harnessConfig?: Record<string, "remote">;
  /** Installation connections only; absent = the instance owner alone. */
  access?: SshAccessList;
  createdAt: number;
}

// Leading alphanumeric, no dots: the same rule as `host.people` user ids.
const PERSON_USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PERSON_CONNECTION_ID = /^u\.([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ALLOWED_SPACE_ID = /^spc_[A-Za-z0-9_-]{1,200}$/;
const MAX_ALLOWED = 64;
const MAX_KEY_BYTES = 16_384;
const PRIVATE_KEY_RE = /^-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----\s*$/;

/** A person-owned connection id names its owner, so a lookup from server
 * work (a project binding) never needs an index: `u.<userId>.<uuid>`. */
export const personOfConnection = (id: string): string | undefined =>
  PERSON_CONNECTION_ID.exec(id)?.[1];

const normalizeAccess = (value: unknown): SshAccessList => {
  const raw = (value ?? {}) as { allowedUserIds?: unknown; allowedSpaceIds?: unknown };
  const list = (input: unknown, pattern: RegExp, field: string): string[] => {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw invalid(`${field} must be an array`);
    if (input.length > MAX_ALLOWED) throw invalid(`${field} has too many entries`);
    const out = new Set<string>();
    for (const item of input) {
      if (typeof item !== "string" || !pattern.test(item)) throw invalid(`${field} has an invalid id`);
      out.add(item);
    }
    return [...out];
  };
  return {
    allowedUserIds: list(raw.allowedUserIds, PERSON_USER_ID, "allowedUserIds"),
    allowedSpaceIds: list(raw.allowedSpaceIds, ALLOWED_SPACE_ID, "allowedSpaceIds"),
  };
};

/**
 * The one usability rule (Spaces §14.6):
 *
 * - installation: the instance owner; a person on `allowedUserIds` (any
 *   Space); any member of a Space on `allowedSpaceIds`. Work with no person
 *   on a project already bound to it keeps running (server work, §14.3).
 * - person: only its owner. Work with no person only in a Space where the
 *   owner is still an active member (the owner bound the project there).
 *
 * A stored list that is not well-formed admits nobody but the owner.
 */
export function sshConnectionUsable(
  owner: SshConnectionOwner,
  access: SshAccessList | undefined,
  principal: SshPrincipal,
  isMember: (userId: string, spaceId: string) => boolean = () => false,
): boolean {
  if (owner.kind === "person") {
    if (principal.kind === "binding") return isMember(owner.userId, principal.spaceId);
    return principal.userId === owner.userId;
  }
  if (principal.kind === "binding") return true;
  if (principal.instanceOwner) return true;
  const users = Array.isArray(access?.allowedUserIds) ? access.allowedUserIds : [];
  const spaces = Array.isArray(access?.allowedSpaceIds) ? access.allowedSpaceIds : [];
  return users.includes(principal.userId) || spaces.includes(principal.spaceId);
}

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const notFound = (message: string): Error =>
  Object.assign(new Error(message), { code: "not-found" });

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

/** POSIX single-quote escaping for remote command interpolation. */
export const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Non-interactive SSH shells skip the rc files where installers add their
 * PATH entries; probe the standard per-user install locations explicitly. */
export const REMOTE_HARNESS_PATH =
  'PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:$PATH"; export PATH';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** POSIX command line that runs `argv` in `cwd` with the harness PATH. Every
 * value is single-quoted; env names must be plain identifiers. */
export const remoteProcessScript = (
  argv: readonly string[],
  opts: { cwd?: string; env?: Readonly<Record<string, string>> } = {},
): string => {
  if (argv.length === 0 || !argv[0]) throw invalid("remote command is required");
  const env = Object.entries(opts.env ?? {}).map(([name, value]) => {
    if (!ENV_NAME_RE.test(name)) throw invalid(`invalid environment variable name: ${name.slice(0, 64)}`);
    return `${name}=${shq(value)}`;
  });
  return [
    REMOTE_HARNESS_PATH,
    ...(opts.cwd ? [`cd -- ${shq(opts.cwd)} || exit 78`] : []),
    `exec ${env.length ? `env ${env.join(" ")} ` : ""}${argv.map(shq).join(" ")}`,
  ].join("; ");
};

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

const HARNESS_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Keeps only the `remote` exceptions: `local` is the default and is never
 * stored, so a harness added later starts on this machine's configuration. */
const normalizeHarnessConfig = (value: unknown): Record<string, "remote"> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("harnessConfig must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw invalid("harnessConfig has too many entries");
  const next: Record<string, "remote"> = {};
  for (const [harnessId, source] of entries) {
    if (!HARNESS_ID_RE.test(harnessId)) throw invalid(`invalid harness id: ${harnessId.slice(0, 64)}`);
    if (source !== "local" && source !== "remote") throw invalid('harness configuration must be "local" or "remote"');
    if (source === "remote") next[harnessId] = "remote";
  }
  return Object.keys(next).length ? next : undefined;
};

/** Configuration source of one harness on a stored connection. */
export const harnessConfigSource = (
  connection: Pick<SshConnectionDto, "harnessConfig"> | undefined,
  harnessId: string,
): SshHarnessConfigSource => connection?.harnessConfig?.[harnessId] === "remote" ? "remote" : "local";

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
    const child = spawn(resolveExecutable("ssh"), args, { stdio: ["ignore", "pipe", "pipe"] });
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
    child.stdout?.on("error", (err) => { stderr += String(err.message ?? err); settle(-1); });
    child.stderr?.on("error", (err) => { stderr += String(err.message ?? err); settle(-1); });
    child.on("error", (err) => { stderr += String(err.message ?? err); settle(-1); });
    child.on("exit", (code) => settle(code ?? -1));
    child.on("close", (code) => settle(code ?? -1));
  });

const processInputError = (
  code: "process-exited" | "stdin-closed" | "write-failed",
  message: string,
  cause?: unknown,
): Error => Object.assign(
  new Error(message, cause === undefined ? undefined : { cause }),
  { code },
);

/** Own every terminal/error path of a spawned SSH channel. In particular,
 * Writable.write() may return normally and emit EPIPE later; the callback and
 * permanent stdin error listener jointly turn that into an observable promise
 * rejection instead of an uncaught EventEmitter error. */
export const createOwnedSshChild = (
  child: ReturnType<typeof spawn>,
): SshChild => {
  const outputs = new Set<(chunk: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  const pendingWrites = new Set<{
    resolve(): void;
    reject(error: Error): void;
    settled: boolean;
  }>();
  let terminalCode: number | null | undefined;
  let stdinOpen = child.stdin !== null;
  let stdinFailure: Error | undefined;

  const settleWrite = (
    pending: { resolve(): void; reject(error: Error): void; settled: boolean },
    error?: Error,
  ): void => {
    if (pending.settled) return;
    pending.settled = true;
    pendingWrites.delete(pending);
    if (error) pending.reject(error);
    else pending.resolve();
  };
  const closeInput = (error: Error): void => {
    stdinOpen = false;
    stdinFailure ??= error;
    for (const pending of [...pendingWrites]) settleWrite(pending, error);
  };
  const settleExit = (code: number | null): void => {
    if (terminalCode !== undefined) return;
    terminalCode = code;
    closeInput(processInputError(
      "process-exited",
      `SSH process exited${code === null ? "" : ` with code ${code}`}`,
    ));
    for (const cb of [...exits]) cb(code);
    exits.clear();
    outputs.clear();
  };
  const failTransport = (): void => {
    if (terminalCode !== undefined) return;
    try {
      if (!child.killed) child.kill("SIGTERM");
    } catch {
      // settleExit below still owns the terminal callback when kill itself is
      // unavailable (for example, a child that failed before spawn).
    }
    settleExit(-1);
  };
  const onChunk = (chunk: Buffer) => {
    if (terminalCode !== undefined) return;
    const text = chunk.toString();
    for (const cb of [...outputs]) cb(text);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.stdout?.on("error", failTransport);
  child.stderr?.on("error", failTransport);
  child.on("error", failTransport);
  child.on("exit", (code) => settleExit(code));
  child.on("close", (code) => settleExit(code));
  child.stdin?.on("error", (error) => {
    closeInput(processInputError("write-failed", "SSH process input failed", error));
  });
  child.stdin?.on("close", () => {
    closeInput(processInputError("stdin-closed", "SSH process input is closed"));
  });
  return {
    onOutput(cb) {
      if (terminalCode !== undefined) return { dispose: () => {} };
      outputs.add(cb);
      return { dispose: () => { outputs.delete(cb); } };
    },
    onExit(cb) {
      if (terminalCode !== undefined) {
        let active = true;
        queueMicrotask(() => { if (active) cb(terminalCode!); });
        return { dispose: () => { active = false; } };
      }
      exits.add(cb);
      return { dispose: () => { exits.delete(cb); } };
    },
    ...(child.stdin ? {
      write(data: string): Promise<void> {
        if (terminalCode !== undefined) {
          return Promise.reject(processInputError(
            "process-exited",
            `SSH process already exited${terminalCode === null ? "" : ` with code ${terminalCode}`}`,
          ));
        }
        const input = child.stdin;
        if (!input || !stdinOpen || input.destroyed || input.writableEnded || !input.writable) {
          return Promise.reject(stdinFailure ?? processInputError(
            "stdin-closed",
            "SSH process input is closed",
          ));
        }
        return new Promise<void>((resolve, reject) => {
          const pending = { resolve, reject, settled: false };
          pendingWrites.add(pending);
          try {
            input.write(data, (error?: Error | null) => {
              settleWrite(
                pending,
                error
                  ? processInputError("write-failed", "SSH process input write failed", error)
                  : undefined,
              );
            });
          } catch (error) {
            settleWrite(
              pending,
              processInputError("write-failed", "SSH process input write failed", error),
            );
          }
        });
      },
    } : {}),
    kill() {
      if (terminalCode === undefined && !child.killed) child.kill("SIGTERM");
    },
  };
};

const defaultSpawner: SshSpawner = (args, opts) =>
  createOwnedSshChild(spawn(resolveExecutable("ssh"), args, {
    stdio: [opts?.interactive || opts?.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
  }));

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
  const pickRemotePort = options.pickRemotePort ?? (() => 20_000 + Math.floor(Math.random() * 45_000));
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
    atomicWriteSync(options.file, JSON.stringify(items, null, 2), 0o600);
  };

  // Person-owned connections: `<people>/<userId>/packages/ssh/connections.json`,
  // read per lookup so a deleted account takes its connections with it.
  // Dialed ids are remembered only to close their masters on disable.
  const dialedPersonIds = new Set<string>();
  const personStore = (userId: string): SshPersonStorage => {
    if (!options.personStorage) throw notFound("personal SSH connections are unavailable");
    return options.personStorage(userId);
  };
  const readPerson = (userId: string): StoredConnection[] => {
    if (!options.personStorage) return [];
    try {
      const raw = JSON.parse(readFileSync(personStore(userId).path("connections.json"), "utf8")) as unknown;
      return Array.isArray(raw)
        ? raw.filter((entry): entry is StoredConnection =>
          !!entry && typeof entry === "object"
            && typeof (entry as StoredConnection).id === "string"
            && personOfConnection((entry as StoredConnection).id) === userId
            && typeof (entry as StoredConnection).host === "string")
        : [];
    } catch {
      return [];
    }
  };
  const writePerson = (userId: string, next: StoredConnection[]): void => {
    atomicWriteSync(personStore(userId).path("connections.json"), JSON.stringify(next, null, 2), 0o600);
  };
  const keyPath = (userId: string, id: string): string => personStore(userId).path(join("keys", id));
  const knownHostsPath = (userId: string): string => personStore(userId).path("known_hosts");
  const hasKey = (userId: string, id: string): boolean => {
    try { return existsSync(keyPath(userId, id)); } catch { return false; }
  };

  const find = (id: string): StoredConnection | undefined => {
    const person = personOfConnection(id);
    if (person) return readPerson(person).find((c) => c.id === id);
    return items.find((c) => c.id === id);
  };

  const must = (id: string): StoredConnection => {
    const conn = find(id);
    if (!conn) throw notFound(`unknown SSH connection: ${id}`);
    return conn;
  };

  const ownerOf = (id: string): SshConnectionOwner => {
    const person = personOfConnection(id);
    return person ? { kind: "person", userId: person } : { kind: "installation" };
  };

  const dto = (conn: StoredConnection): SshConnectionRecordDto => {
    const person = personOfConnection(conn.id);
    return {
      id: conn.id,
      name: conn.name,
      host: conn.host,
      ...(conn.port !== undefined ? { port: conn.port } : {}),
      ...(conn.user ? { user: conn.user } : {}),
      authMode: conn.authMode,
      // A personal key lives in the owner's storage; its path is not shown.
      ...(conn.identityFile && !person ? { identityFile: conn.identityFile } : {}),
      ...(conn.harnessConfig && Object.keys(conn.harnessConfig).length
        ? { harnessConfig: { ...conn.harnessConfig } }
        : {}),
      createdAt: conn.createdAt,
      ...(person
        ? { owner: "person" as const, ownerUserId: person, keyUploaded: hasKey(person, conn.id) }
        : {
          owner: "installation" as const,
          allowedUserIds: [...(conn.access?.allowedUserIds ?? [])],
          allowedSpaceIds: [...(conn.access?.allowedSpaceIds ?? [])],
        }),
    };
  };

  const destination = (conn: StoredConnection): string =>
    conn.user ? `${conn.user}@${conn.host}` : conn.host;

  const socketFor = (id: string): string => join(socketDir, `${shortHash(id)}.sock`);

  /** A person's connection never touches the server user's OpenSSH setup:
   * no ssh_config (aliases, IdentityFile, ProxyCommand), no agent, no default
   * keys, and its own known_hosts. Only the key the person uploaded. */
  const personArgs = (conn: StoredConnection): string[] => {
    const person = personOfConnection(conn.id);
    if (!person) return [];
    const key = keyPath(person, conn.id);
    if (!existsSync(key)) throw invalid(`upload a private key for "${conn.name}" first`);
    dialedPersonIds.add(conn.id);
    return [
      "-F", "/dev/null",
      "-o", "IdentityAgent=none",
      "-o", `UserKnownHostsFile=${knownHostsPath(person)}`,
      "-i", key,
      "-o", "IdentitiesOnly=yes",
    ];
  };

  /** Options shared by every dialing invocation (exec / start / connect). */
  const dialArgs = (conn: StoredConnection): string[] => [
    ...personArgs(conn),
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
    ...(!personOfConnection(conn.id) && conn.authMode === "identity-file" && conn.identityFile
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
    personal = false,
  ): Omit<StoredConnection, "id" | "createdAt"> => {
    rejectSecretFields(raw);
    const input = raw as SshConnectionInput;
    if (personal) {
      // The server's agent, keys and ssh_config belong to the instance owner.
      if ((input.authMode !== undefined && input.authMode !== "identity-file") || input.identityFile !== undefined) {
        throw invalid("personal SSH connections authenticate only with a private key you upload");
      }
      const { authMode: _mode, identityFile: _file, ...rest } = input;
      return {
        ...applyInput({ ...rest, authMode: "agent" }, previous ? { ...previous, authMode: "agent" } : undefined),
        authMode: "identity-file",
      };
    }
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
    const harnessConfig = input.harnessConfig === undefined && previous
      ? previous.harnessConfig
      : normalizeHarnessConfig(input.harnessConfig);
    const fallbackName = user ? `${user}@${host}` : host;
    const name = input.name === undefined && previous ? previous.name : (short(input.name, 120) || fallbackName);
    return {
      name, host, authMode,
      ...(port !== undefined ? { port } : {}),
      ...(user ? { user } : {}),
      ...(authMode === "identity-file" && identityFile ? { identityFile } : {}),
      ...(harnessConfig ? { harnessConfig } : {}),
      ...(previous?.access ? { access: previous.access } : {}),
    };
  };

  const replace = (next: StoredConnection): void => {
    const person = personOfConnection(next.id);
    if (person) {
      writePerson(person, readPerson(person).map((c) => (c.id === next.id ? next : c)));
      return;
    }
    items = items.map((c) => (c.id === next.id ? next : c));
    persist();
  };

  const closeMaster = async (conn: StoredConnection): Promise<void> => {
    await run(controlArgs(conn, "exit"), { timeoutMs: 5_000 }).catch(() => undefined);
  };

  return {
    list: () => items.map(dto),
    listOwned: (userId) => (PERSON_USER_ID.test(userId) ? readPerson(userId).map(dto) : []),
    get: (id) => {
      const conn = find(id);
      return conn ? dto(conn) : undefined;
    },

    create(input, owner = { kind: "installation" }) {
      if (owner.kind === "person") {
        if (!PERSON_USER_ID.test(owner.userId)) throw invalid("invalid owner");
        const fields = applyInput((input ?? {}) as Record<string, unknown>, undefined, true);
        const conn: StoredConnection = { id: `u.${owner.userId}.${randomUUID()}`, createdAt: now(), ...fields };
        const mine = readPerson(owner.userId);
        if (mine.length >= MAX_ALLOWED) throw invalid("too many SSH connections");
        writePerson(owner.userId, [...mine, conn]);
        return dto(conn);
      }
      const fields = applyInput((input ?? {}) as Record<string, unknown>);
      const conn: StoredConnection = { id: randomUUID(), createdAt: now(), ...fields };
      items.push(conn);
      persist();
      return dto(conn);
    },

    update(id, input) {
      const conn = must(id);
      const fields = applyInput((input ?? {}) as Record<string, unknown>, conn, Boolean(personOfConnection(id)));
      const next: StoredConnection = { id: conn.id, createdAt: conn.createdAt, ...fields };
      replace(next);
      return dto(next);
    },

    async remove(id) {
      const conn = must(id);
      await closeMaster(conn);
      statuses.delete(id);
      homes.delete(id);
      dialedPersonIds.delete(id);
      const person = personOfConnection(id);
      if (person) {
        writePerson(person, readPerson(person).filter((c) => c.id !== id));
        rmSync(keyPath(person, id), { force: true });
        return;
      }
      items = items.filter((c) => c.id !== id);
      persist();
    },

    ownerOf: (id) => (find(id) ? ownerOf(id) : undefined),

    usable(id, principal) {
      const conn = find(id);
      return conn ? sshConnectionUsable(ownerOf(id), conn.access, principal, options.isMember) : false;
    },

    setAccess(id, access) {
      const conn = must(id);
      if (personOfConnection(id)) throw invalid("a personal connection is used only by its owner");
      const next: StoredConnection = { ...conn, access: normalizeAccess(access) };
      if (next.access!.allowedUserIds.length === 0 && next.access!.allowedSpaceIds.length === 0) delete next.access;
      replace(next);
      return dto(next);
    },

    putKey(id, privateKey) {
      const conn = must(id);
      const person = personOfConnection(id);
      if (!person) throw invalid("shared connections use the server's own SSH setup; keys are uploaded to personal connections only");
      if (typeof privateKey !== "string" || !privateKey.trim()) throw invalid("privateKey is required");
      if (Buffer.byteLength(privateKey) > MAX_KEY_BYTES) throw invalid("privateKey is too large");
      const text = `${privateKey.replace(/\r\n/g, "\n").trim()}\n`;
      if (!PRIVATE_KEY_RE.test(text) || /ENCRYPTED/.test(text.split("\n", 3).join("\n"))) {
        throw invalid("privateKey must be an unencrypted OpenSSH or PEM private key (Polyth cannot answer a passphrase prompt)");
      }
      const file = keyPath(person, id);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // Resolve again after mkdir: a planted symlink must not move the key out.
      atomicWriteSync(keyPath(person, id), text, 0o600);
      // The new key applies to the next dial.
      void closeMaster(conn);
      statuses.delete(id);
      return dto(conn);
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
        processCommand(argv, opts) {
          const fresh = must(id);
          // `-T`: raw pipes, never a TTY, so protocol bytes pass unchanged.
          // ControlMaster=auto reuses the master or dials one itself.
          return {
            command: "ssh",
            args: [...dialArgs(fresh), "-T", "--", destination(fresh), remoteProcessScript(argv, opts)],
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
        async reverseForward(localPort, requestedRemotePort) {
          if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
            throw invalid("local reverse-forward port must be 1-65535");
          }
          if (requestedRemotePort !== undefined
            && (!Number.isInteger(requestedRemotePort) || requestedRemotePort < 1 || requestedRemotePort > 65_535)) {
            throw invalid("remote reverse-forward port must be 1-65535");
          }
          await ensureConnected(id);
          const fresh = must(id);
          let lastError = "";
          const attempts = requestedRemotePort === undefined ? 8 : 1;
          for (let attempt = 0; attempt < attempts; attempt++) {
            const remotePort = requestedRemotePort ?? pickRemotePort();
            if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
              throw invalid("remote reverse-forward port picker returned an invalid port");
            }
            const spec = `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`;
            const result = await run(controlArgs(fresh, "forward", ["-R", spec]), { timeoutMs: 10_000 });
            if (result.code !== 0) {
              lastError = tail(result.stderr) || `ssh exited ${result.code}`;
              continue;
            }
            return {
              remotePort,
              dispose: async () => {
                await run(controlArgs(fresh, "cancel", ["-R", spec]), { timeoutMs: 10_000 }).catch(() => undefined);
              },
            };
          }
          throw unavailable(`reverse port forward failed: ${lastError || "no remote loopback port was available"}`);
        },
      };
    },

    async disconnectAll() {
      const dialed = [...dialedPersonIds].flatMap((id) => {
        const conn = find(id);
        return conn ? [conn] : [];
      });
      dialedPersonIds.clear();
      await Promise.all([...items, ...dialed].map(async (conn) => {
        await closeMaster(conn);
        setStatus(conn.id, "disconnected");
      }));
    },
  };
}
