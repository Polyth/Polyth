import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  BorrowedRuntimeEndpointLease,
  OwnedRuntimeEndpointLease,
  RuntimeAuthentication,
  RuntimeConfigAuthority,
  RuntimeEndpoint,
  RuntimeEndpointLease,
  RuntimeLocation,
} from "@polyth/contracts";
import {
  prepareBrowserToolEnvironment,
  type OpenCodeBrowserToolConfig,
} from "./browserTool.ts";
import {
  createDurableOwnedRuntimeState,
  ownedRuntimeIdentityKey,
  type OwnedRuntimeIncarnation,
} from "./ownedRuntimeState.ts";
import {
  inspectOpenCodeEngine,
  OPENCODE_UPDATE_DISABLE_ENV,
  prepareOpenCodeRuntime,
  resolveOpenCodeBinary,
  type OpenCodeBinarySource,
  type OpenCodeEngineIdentity,
  type PreparedOpenCodeRuntime,
  type ResolvedOpenCodeBinary,
} from "./runtimeStorage.ts";

export const LISTEN_RE = /opencode server listening on https?:\/\/[^\s:]+:(\d+)/i;
const BIND_COLLISION_RE = /EADDRINUSE|address already in use/i;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const normalizedHeaders = (headers: Readonly<Record<string, string>>): Array<[string, string]> =>
  Object.entries(headers)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort(([left], [right]) => left.localeCompare(right));

const environmentCredentialFingerprint = (
  authentication: RuntimeAuthentication,
): string => {
  if (authentication.kind !== "basic-env") return authentication.kind;
  return fingerprint([
    authentication.usernameEnv,
    process.env[authentication.usernameEnv] ?? "",
    authentication.passwordEnv,
    process.env[authentication.passwordEnv] ?? "",
  ]);
};

export interface ProcessIdentity {
  startIdentity: string;
  executable: string;
  command: string;
}

export type ProcessIdentityReader = (pid: number) => Promise<ProcessIdentity | undefined>;
export type ProcessSignaler = (pid: number, signal: NodeJS.Signals | 0) => void;

/** Linux exposes a stable process start tick alongside the executable and
 * command. If any field cannot be read, the PID is not safe to reap. */
export const readProcessIdentity: ProcessIdentityReader = async (pid) => {
  try {
    const [stat, executable, commandBuffer] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readlink(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fieldsFromState = stat.slice(close + 2).trim().split(/\s+/);
    const startIdentity = fieldsFromState[19];
    if (!startIdentity) return undefined;
    const command = commandBuffer.toString("utf8").replaceAll("\0", " ").trim();
    if (!command) return undefined;
    return { startIdentity, executable, command };
  } catch {
    return undefined;
  }
};

interface PidRecord {
  version: 1;
  ownerPid: number;
  ownerInstanceToken: string;
  child: {
    pid: number;
    startIdentity: string;
    executable: string;
    command: string;
  };
}

const parsePidRecord = (raw: string): PidRecord | undefined => {
  try {
    const value = JSON.parse(raw) as Partial<PidRecord>;
    const child = value.child;
    if (
      value.version !== 1
      || !Number.isSafeInteger(value.ownerPid)
      || typeof value.ownerInstanceToken !== "string"
      || !value.ownerInstanceToken
      || !child
      || !Number.isSafeInteger(child.pid)
      || child.pid <= 0
      || typeof child.startIdentity !== "string"
      || !child.startIdentity
      || typeof child.executable !== "string"
      || !child.executable
      || typeof child.command !== "string"
      || !child.command
    ) {
      return undefined;
    }
    return value as PidRecord;
  } catch {
    // Legacy numeric PID files are deliberately not trusted.
    return undefined;
  }
};

const processIdentityMatches = (
  expected: PidRecord["child"],
  actual: ProcessIdentity | undefined,
): boolean =>
  actual !== undefined
  && actual.startIdentity === expected.startIdentity
  && actual.executable === expected.executable
  && actual.command === expected.command;

export const pidFileForDirectory = (
  cwd: string,
  projectId?: string,
  runtimeDir?: string,
): string => {
  const digest = createHash("sha256");
  if (projectId) digest.update(projectId).update("\0");
  digest.update(resolve(cwd));
  if (runtimeDir) digest.update("\0").update(resolve(runtimeDir));
  const key = digest.digest("hex").slice(0, 24);
  return join(tmpdir(), "polyth-opencode", `${key}.pid.json`);
};

interface ReapPidFileOptions {
  readIdentity: ProcessIdentityReader;
  signal: ProcessSignaler;
  graceMs: number;
}

const activeLocalInstanceTokens = new Set<string>();

/** Reap only the exact process described by a versioned, identity-complete
 * record. A stale/reused PID is never signalled. */
const reapPidFile = async (
  pidFile: string,
  options: ReapPidFileOptions,
): Promise<void> => {
  let record: PidRecord | undefined;
  try {
    record = parsePidRecord(await readFile(pidFile, "utf8"));
  } catch {
    return;
  }
  if (!record) {
    await rm(pidFile, { force: true });
    return;
  }

  const firstIdentity = await options.readIdentity(record.child.pid);
  if (!processIdentityMatches(record.child, firstIdentity)) {
    await rm(pidFile, { force: true });
    return;
  }
  if (activeLocalInstanceTokens.has(record.ownerInstanceToken)) {
    throw Object.assign(
      new Error(`an owned OpenCode child is already active for ${pidFile}`),
      { code: "already-active" },
    );
  }

  // Reading the private record transfers the orphan's exact instance token to
  // this lease. Re-check identity before every signal so PID reuse during the
  // grace period cannot target a replacement process.
  const adoptedToken = record.ownerInstanceToken;
  if (!adoptedToken) return;
  try {
    options.signal(record.child.pid, "SIGTERM");
  } catch {
    await rm(pidFile, { force: true });
    return;
  }
  await sleep(options.graceMs);
  const identityAfterGrace = await options.readIdentity(record.child.pid);
  if (processIdentityMatches(record.child, identityAfterGrace)) {
    try {
      options.signal(record.child.pid, "SIGKILL");
    } catch {
      // It exited after the final identity check.
    }
  }
  await rm(pidFile, { force: true });
};

const writePidRecord = async (
  pidFile: string,
  ownerInstanceToken: string,
  child: ChildProcess,
  readIdentity: ProcessIdentityReader,
): Promise<void> => {
  if (!child.pid) return;
  const identity = await readIdentity(child.pid);
  if (!identity) return;
  const record: PidRecord = {
    version: 1,
    ownerPid: process.pid,
    ownerInstanceToken,
    child: { pid: child.pid, ...identity },
  };
  await mkdir(dirname(pidFile), { recursive: true });
  const temporary = `${pidFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, pidFile);
};

const childExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const terminateChild = async (
  child: ChildProcess,
  gracefulMs: number,
): Promise<void> => {
  if (childExited(child)) return;
  const exited = new Promise<boolean>((resolveExit) => {
    child.once("exit", () => resolveExit(true));
  });
  child.kill("SIGTERM");
  if (await Promise.race([exited, sleep(gracefulMs).then(() => false)])) return;
  if (!childExited(child)) child.kill("SIGKILL");
  await Promise.race([exited, sleep(Math.min(gracefulMs, 1_000))]);
};

export const pickFreePort = (hostname: string): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port) resolvePort(port);
        else rejectPort(new Error("no free local port"));
      });
    });
  });

interface StartedOwnedInstance {
  url: string;
  instanceIdentity: string;
  authentication: RuntimeAuthentication;
  alive(): boolean;
  stop(): Promise<void>;
}

interface OwnedLeaseOptions {
  authorityId?: string;
  nextIncarnation?: () => Promise<OwnedRuntimeIncarnation>;
  prepareStart?: () => Promise<void>;
  continuity?: "verified" | "generation-only";
  location: RuntimeLocation;
  config: RuntimeConfigAuthority;
  authentication: RuntimeAuthentication;
  start(
    instanceToken: string,
    incarnation: OwnedRuntimeIncarnation,
  ): Promise<StartedOwnedInstance>;
}

const createOwnedLease = async (
  options: OwnedLeaseOptions,
): Promise<OwnedRuntimeEndpointLease> => {
  const defaultAuthorityId = options.authorityId ?? `owned:${randomUUID()}`;
  let current:
    | {
        endpoint: RuntimeEndpoint;
        instance: StartedOwnedInstance;
        credentialFingerprint: string;
      }
    | undefined;
  let generation = 0;
  let replacement: Promise<RuntimeEndpoint> | undefined;
  let disposal: Promise<void> | undefined;
  let disposed = false;

  const replace = async (): Promise<RuntimeEndpoint> => {
    if (disposed) throw unavailable("runtime endpoint lease is disposed");
    const previous = current;
    current = undefined;
    if (previous) await previous.instance.stop();
    const instanceToken = randomUUID();
    await options.prepareStart?.();
    const incarnation = options.nextIncarnation
      ? await options.nextIncarnation()
      : { authorityId: defaultAuthorityId, generation: generation + 1 };
    if (
      !incarnation.authorityId
      || !Number.isSafeInteger(incarnation.generation)
      || incarnation.generation <= 0
      || (
        previous?.endpoint.authorityId === incarnation.authorityId
        && incarnation.generation <= generation
      )
    ) {
      throw unavailable("owned runtime incarnation did not advance");
    }
    const instance = await options.start(instanceToken, incarnation);
    if (disposed) {
      await instance.stop();
      throw unavailable("runtime endpoint lease was disposed during startup");
    }
    generation = incarnation.generation;
    const endpoint: RuntimeEndpoint = {
      authorityId: incarnation.authorityId,
      continuity: options.continuity ?? "generation-only",
      generation,
      url: instance.url,
      location: { ...options.location },
      control: { kind: "owned", instanceToken },
      config: options.config,
      authentication: instance.authentication,
    };
    current = {
      endpoint,
      instance,
      credentialFingerprint: environmentCredentialFingerprint(instance.authentication),
    };
    return endpoint;
  };

  const replaceSingleFlight = (): Promise<RuntimeEndpoint> => {
    if (replacement) return replacement;
    replacement = replace().finally(() => {
      replacement = undefined;
    });
    return replacement;
  };

  await replaceSingleFlight();

  const lease: OwnedRuntimeEndpointLease = {
    get control() {
      if (!current) {
        throw unavailable("owned runtime endpoint has no active instance");
      }
      return current.endpoint.control as { kind: "owned"; instanceToken: string };
    },
    async endpoint() {
      if (disposed) throw unavailable("runtime endpoint lease is disposed");
      // A known-dead instance must never be handed out: after a failed
      // post-disconnect refresh (exit-notification race), endpoint() is the
      // only acquisition path left, and returning the dead generation would
      // wedge the runtime on a closed port forever.
      if (!current || !current.instance.alive()) return replaceSingleFlight();
      return current.endpoint;
    },
    async refresh() {
      if (disposed) throw unavailable("runtime endpoint lease is disposed");
      if (!current) return replaceSingleFlight();
      const credentialsChanged =
        environmentCredentialFingerprint(current.endpoint.authentication)
        !== current.credentialFingerprint;
      if (!current.instance.alive() || credentialsChanged) return replaceSingleFlight();
      return current.endpoint;
    },
    restart() {
      return replaceSingleFlight();
    },
    async dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        try {
          await replacement;
        } catch {
          // A failed replacement has no live instance to terminate.
        }
        const owned = current;
        current = undefined;
        if (owned) await owned.instance.stop();
      })();
      return disposal;
    },
  };
  return lease;
};

export interface OwnedLocalEndpointOptions {
  projectId?: string;
  cwd: string;
  port?: number;
  hostname?: string;
  bin?: string;
  binarySource?: Extract<OpenCodeBinarySource, "bundled" | "configured">;
  configDir?: string;
  /** @deprecated Use configDir. */
  dataDir?: string;
  runtimeDir?: string;
  browserTool?: OpenCodeBrowserToolConfig;
  configTargetId?: string;
  authorityId?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  listenTimeoutMs?: number;
  gracefulStopMs?: number;
  maxBindAttempts?: number;
  pickPort?: (hostname: string) => Promise<number>;
  spawn?: typeof spawn;
  pidFile?: string;
  stateFile?: string;
  readProcessIdentity?: ProcessIdentityReader;
  signalProcess?: ProcessSignaler;
  orphanGraceMs?: number;
  onRuntimeDiagnostic?: (message: string) => void;
  /** Test seam for an already-resolved executable. Production callers omit it. */
  resolveBinary?: (options: {
    bin?: string;
    binarySource?: Extract<OpenCodeBinarySource, "bundled" | "configured">;
  }) => Promise<ResolvedOpenCodeBinary>;
  /** Test seam for a pre-verified binary identity. Production callers omit it. */
  inspectEngine?: (bin: string) => Promise<OpenCodeEngineIdentity>;
}

interface StartedLocalChild {
  child: ChildProcess;
  port: number;
  hostname: string;
}

const startLocalChildOnce = async (
  options: OwnedLocalEndpointOptions,
  instanceToken: string,
  hostname: string,
  port: number,
  pidFile: string,
  readIdentity: ProcessIdentityReader,
  runtime: PreparedOpenCodeRuntime,
): Promise<StartedLocalChild> => {
  let env = { ...process.env };
  const configDir = options.configDir ?? options.dataDir;
  if (configDir) env.OPENCODE_CONFIG_DIR = configDir;
  env.OPENCODE_DB = runtime.dbPath;
  env[OPENCODE_UPDATE_DISABLE_ENV] = "true";
  if (options.browserTool) {
    env = await prepareBrowserToolEnvironment(options.browserTool, env);
  }
  // The token is not an OpenCode credential. It lets child wrappers and
  // diagnostics identify the exact Polyth-owned instance.
  env.POLYTH_OPENCODE_INSTANCE_TOKEN = instanceToken;
  const spawnProcess = options.spawn ?? spawn;
  const child = spawnProcess(
    runtime.binary.executablePath,
    ["serve", "--hostname", hostname, "--port", String(port)],
    {
      cwd: resolve(options.cwd),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let buffer = "";
  let timer: NodeJS.Timeout | undefined;
  const listenTimeoutMs = options.listenTimeoutMs ?? 20_000;
  try {
    const actualPort = await new Promise<number>((resolveListen, rejectListen) => {
      let settled = false;
      const finish = (error?: Error, listeningPort?: number) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.stdout?.off("data", onChunk);
        child.stderr?.off("data", onChunk);
        if (error) rejectListen(error);
        else resolveListen(listeningPort!);
      };
      const onChunk = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        if (BIND_COLLISION_RE.test(buffer)) {
          finish(Object.assign(new Error(`local port ${port} is in use`), { code: "port-in-use" }));
          return;
        }
        const match = buffer.match(LISTEN_RE);
        if (match) finish(undefined, Number(match[1]));
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        const error = BIND_COLLISION_RE.test(buffer)
          ? Object.assign(new Error(`local port ${port} is in use`), { code: "port-in-use" })
          : unavailable(`opencode serve exited ${code}: ${buffer.slice(-400)}`);
        finish(error);
      });
      timer = setTimeout(
        () => finish(unavailable(`opencode serve listen timeout after ${listenTimeoutMs}ms`)),
        listenTimeoutMs,
      );
    });
    child.stdout?.resume();
    child.stderr?.resume();
    await runtime.secureDatabaseFiles();
    await writePidRecord(pidFile, instanceToken, child, readIdentity);
    return { child, port: actualPort, hostname };
  } catch (error) {
    await terminateChild(child, options.gracefulStopMs ?? 3_000);
    throw error;
  }
};

/** Owned local mode. Bind collisions discard the failed exact child before a
 * fresh port is selected, so no failed attempt leaks. */
export const createOwnedLocalEndpointLease = async (
  options: OwnedLocalEndpointOptions,
): Promise<OwnedRuntimeEndpointLease> => {
  const cwd = resolve(options.cwd);
  if (!options.runtimeDir) {
    throw unavailable(
      "owned OpenCode runtimeDir is required; refusing to fall back to the global OpenCode DB",
    );
  }
  if (!options.projectId) {
    throw unavailable("owned OpenCode projectId is required for isolated runtime identity");
  }
  if (options.authorityId) {
    throw unavailable(
      "configured authorityId is incompatible with isolated OpenCode engine rotation",
    );
  }
  const hostname = options.hostname ?? "127.0.0.1";
  // The isolated DB, not just the checkout, defines process ownership. Two
  // Polyth servers may serve the same project from different data directories;
  // sharing the old cwd-keyed record made each server reap the other's child.
  const pidFile = options.pidFile
    ?? pidFileForDirectory(cwd, options.projectId, options.runtimeDir);
  const legacyStateFile = `${pidFile}.lease.json`;
  const stateFile = options.stateFile ?? legacyStateFile;
  const readIdentity = options.readProcessIdentity ?? readProcessIdentity;
  const signal = options.signalProcess ?? ((pid, processSignal) => process.kill(pid, processSignal));
  const authentication: RuntimeAuthentication = {
    kind: "basic-env",
    usernameEnv: options.usernameEnv ?? "OPENCODE_SERVER_USERNAME",
    passwordEnv: options.passwordEnv ?? "OPENCODE_SERVER_PASSWORD",
  };
  let firstStart = true;
  let preparedRuntime: PreparedOpenCodeRuntime | undefined;

  return createOwnedLease({
    async nextIncarnation() {
      const runtime = preparedRuntime;
      if (!runtime) throw unavailable("isolated OpenCode runtime was not prepared");
      return createDurableOwnedRuntimeState(
        stateFile,
        ownedRuntimeIdentityKey({
          kind: "owned-local",
          directory: cwd,
          projectId: options.projectId,
          engine: runtime.engineIdentity.engine,
          version: runtime.engineIdentity.version,
          binaryDigest: runtime.engineIdentity.binaryDigest,
          protocolGeneration: runtime.engineIdentity.protocolGeneration,
          storageId: runtime.storageId,
        }),
      ).nextIncarnation();
    },
    async prepareStart() {
      const binary = await (options.resolveBinary ?? resolveOpenCodeBinary)({
        bin: options.bin,
        binarySource: options.binarySource,
      });
      preparedRuntime = await prepareOpenCodeRuntime({
        runtimeDir: options.runtimeDir!,
        projectId: options.projectId!,
        cwd,
        engineIdentity: await (options.inspectEngine ?? inspectOpenCodeEngine)(
          binary.executablePath,
        ),
        binary,
      });
      if (preparedRuntime.diagnostic) {
        (options.onRuntimeDiagnostic
          ?? ((message: string) => console.warn(`[polyth] ${message}`)))(
          preparedRuntime.diagnostic,
        );
      }
      if (!firstStart) return;
      await reapPidFile(pidFile, {
        readIdentity,
        signal,
        graceMs: options.orphanGraceMs ?? 250,
      });
      firstStart = false;
    },
    continuity: "verified",
    location: { directory: cwd },
    config: options.configTargetId
      ? { kind: "writable", targetId: options.configTargetId }
      : { kind: "read-only" },
    authentication,
    async start(instanceToken, incarnation) {
      const runtime = preparedRuntime;
      if (!runtime) throw unavailable("isolated OpenCode runtime was not prepared");
      await runtime.recordOpen(incarnation);
      const attempts = Math.max(1, options.maxBindAttempts ?? 4);
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const port = attempt === 0 && options.port !== undefined
          ? options.port
          : await (options.pickPort ?? pickFreePort)(hostname);
        try {
          const started = await startLocalChildOnce(
            { ...options, cwd },
            instanceToken,
            hostname,
            port,
            pidFile,
            readIdentity,
            runtime,
          );
          let stopped = false;
          activeLocalInstanceTokens.add(instanceToken);
          return {
            url: `http://${started.hostname}:${started.port}`,
            instanceIdentity: `${instanceToken}:${started.child.pid ?? "unknown"}`,
            authentication,
            alive: () => !stopped && !childExited(started.child),
            async stop() {
              if (stopped) return;
              stopped = true;
              activeLocalInstanceTokens.delete(instanceToken);
              let shouldRemove = true;
              try {
                const record = parsePidRecord(await readFile(pidFile, "utf8"));
                shouldRemove = record?.ownerInstanceToken === instanceToken;
              } catch {
                // Missing record is already clean.
              }
              if (shouldRemove) await rm(pidFile, { force: true });
              await terminateChild(started.child, options.gracefulStopMs ?? 3_000);
            },
          };
        } catch (error) {
          lastError = error;
          if ((error as { code?: string }).code !== "port-in-use") throw error;
        }
      }
      throw lastError ?? unavailable("could not bind an OpenCode local endpoint");
    },
  });
};

export interface OwnedSshStorageIdentity {
  connection: string;
  host: string;
  remotePath: string;
  runtimeDir: string;
  engine: "opencode";
  version: string;
  binaryDigest: string;
  protocolGeneration: number;
  storageId: string;
}

export type OwnedSshRuntimeIdentity =
  | string
  | OwnedSshStorageIdentity
  | (() => string | OwnedSshStorageIdentity);

/** Connection identity stays in the outer SSH envelope. Storage/engine fields
 * are the shared owned-runtime semantic block; they never include credentials
 * or conversation content. */
export const ownedSshRuntimeIdentityKey = (identity: OwnedSshStorageIdentity): string =>
  ownedRuntimeIdentityKey({
    kind: "owned-ssh",
    connection: identity.connection,
    host: identity.host,
    remotePath: identity.remotePath,
    runtimeDir: identity.runtimeDir,
    engine: identity.engine,
    version: identity.version,
    binaryDigest: identity.binaryDigest,
    protocolGeneration: identity.protocolGeneration,
    storageId: identity.storageId,
  });

const resolveSshRuntimeIdentity = (
  identity: string | OwnedSshStorageIdentity,
  location: RuntimeLocation,
): string =>
  typeof identity === "string"
    ? ownedRuntimeIdentityKey({
        kind: "owned-ssh",
        runtime: identity,
        location,
      })
    : ownedSshRuntimeIdentityKey(identity);

export interface OwnedSshEndpointOptions {
  location: RuntimeLocation;
  start(
    instanceToken: string,
    incarnation: OwnedRuntimeIncarnation,
  ): Promise<{
    url: string;
    instanceIdentity: string;
    alive?(): boolean;
    stop(): Promise<void>;
  }>;
  authorityId?: string;
  /** Durable authority/generation fence for this exact remote runtime. */
  stateFile?: string;
  /** Stable connection/host and runtime binding identity. Required with stateFile. */
  runtimeIdentity?: OwnedSshRuntimeIdentity;
  prepareStart?: () => Promise<void>;
  authentication?: RuntimeAuthentication;
}

/** Owned SSH mode controls an exact remote child/forward token but never
 * grants authority over the local OpenCode config. When stateFile is supplied,
 * process restarts retain authority while every replacement consumes a new
 * generation. Forward/remote-child lifecycle remains coupled here. */
export const createOwnedSshEndpointLease = async (
  options: OwnedSshEndpointOptions,
): Promise<OwnedRuntimeEndpointLease> => {
  const authentication = options.authentication ?? {
    kind: "basic-env",
    usernameEnv: "OPENCODE_SERVER_USERNAME",
    passwordEnv: "OPENCODE_SERVER_PASSWORD",
  };
  if (options.stateFile && !options.runtimeIdentity) {
    throw unavailable("durable SSH runtime state requires a runtime identity");
  }
  const durable = options.stateFile && options.runtimeIdentity
    ? {
        nextIncarnation: async () => {
          const resolved = typeof options.runtimeIdentity === "function"
            ? options.runtimeIdentity()
            : options.runtimeIdentity;
          if (!resolved) throw unavailable("durable SSH runtime state requires a runtime identity");
          return createDurableOwnedRuntimeState(
            options.stateFile!,
            resolveSshRuntimeIdentity(resolved, options.location),
            options.authorityId,
          ).nextIncarnation();
        },
      }
    : options.authorityId
      ? { authorityId: options.authorityId }
      : {};
  return createOwnedLease({
    ...durable,
    ...(options.prepareStart ? { prepareStart: options.prepareStart } : {}),
    continuity: options.stateFile && options.runtimeIdentity ? "verified" : "generation-only",
    location: options.location,
    config: { kind: "read-only" },
    authentication,
    async start(instanceToken, incarnation) {
      const started = await options.start(instanceToken, incarnation);
      return {
        ...started,
        authentication,
        alive: started.alive ?? (() => true),
      };
    },
  });
};

export interface BorrowedServiceDescriptor {
  url: string;
  authorityId?: string;
  continuity?: "verified" | "generation-only";
  instanceId?: string;
  headers:
    | Readonly<Record<string, string>>
    | (() => Promise<Readonly<Record<string, string>>>);
}

export interface BorrowedServiceEndpointOptions {
  location: RuntimeLocation;
  discover(): Promise<BorrowedServiceDescriptor | undefined>;
  ensure(): Promise<BorrowedServiceDescriptor>;
  authorityId?: string;
}

const resolveDescriptorHeaders = async (
  descriptor: BorrowedServiceDescriptor,
): Promise<Record<string, string>> => ({
  ...(typeof descriptor.headers === "function"
    ? await descriptor.headers()
    : descriptor.headers),
});

/** Borrowed discovered/ensured mode. `ensure` may cause the official service
 * to exist, but does not grant Polyth a stop/restart/config capability. */
export const createBorrowedServiceEndpointLease = async (
  options: BorrowedServiceEndpointOptions,
): Promise<BorrowedRuntimeEndpointLease> => {
  const fallbackAuthorityId = options.authorityId ?? `borrowed-service:${randomUUID()}`;
  let current: RuntimeEndpoint | undefined;
  let currentFingerprint = "";
  let generation = 0;
  let refreshFlight: Promise<RuntimeEndpoint> | undefined;
  let disposed = false;

  const refreshOnce = async (): Promise<RuntimeEndpoint> => {
    if (disposed) throw unavailable("runtime endpoint lease is disposed");
    const descriptor = await options.discover() ?? await options.ensure();
    const headers = await resolveDescriptorHeaders(descriptor);
    const authorityId = descriptor.authorityId ?? fallbackAuthorityId;
    const nextFingerprint = fingerprint([
      descriptor.url,
      authorityId,
      descriptor.instanceId ?? "",
      normalizedHeaders(headers),
    ]);
    if (!current || nextFingerprint !== currentFingerprint) generation += 1;
    currentFingerprint = nextFingerprint;
    const generationHeaders = { ...headers };
    current = {
      authorityId,
      continuity: descriptor.continuity ?? "generation-only",
      generation,
      url: descriptor.url,
      location: { ...options.location },
      control: { kind: "borrowed", source: "shared" },
      config: { kind: "read-only" },
      authentication: {
        kind: "endpoint-headers",
        async resolve() {
          return { ...generationHeaders };
        },
      },
    };
    return current;
  };

  const refresh = (): Promise<RuntimeEndpoint> => {
    if (refreshFlight) return refreshFlight;
    refreshFlight = refreshOnce().finally(() => {
      refreshFlight = undefined;
    });
    return refreshFlight;
  };

  await refresh();
  return {
    control: { kind: "borrowed", source: "shared" },
    async endpoint() {
      if (disposed) throw unavailable("runtime endpoint lease is disposed");
      return current ?? refresh();
    },
    refresh,
    async dispose() {
      // Deliberately no Service.stop(), config mutation, or process signal.
      disposed = true;
      current = undefined;
    },
  };
};

export interface BorrowedExternalEndpointOptions {
  url: string;
  location: RuntimeLocation;
  authorityId?: string;
  usernameEnv?: string;
  passwordEnv?: string;
}

/** Borrowed external mode connects only. Credential values remain in the
 * referenced environment and are used solely to detect refresh generations. */
export const createBorrowedExternalEndpointLease = async (
  options: BorrowedExternalEndpointOptions,
): Promise<BorrowedRuntimeEndpointLease> => {
  const authentication: RuntimeAuthentication = {
    kind: "basic-env",
    usernameEnv: options.usernameEnv ?? "OPENCODE_SERVER_USERNAME",
    passwordEnv: options.passwordEnv ?? "OPENCODE_SERVER_PASSWORD",
  };
  const authorityId = options.authorityId ?? `external:${randomUUID()}`;
  let generation = 0;
  let credentialFingerprint = "";
  let current: RuntimeEndpoint | undefined;
  let disposed = false;
  let refreshFlight: Promise<RuntimeEndpoint> | undefined;

  const refreshOnce = async (): Promise<RuntimeEndpoint> => {
    if (disposed) throw unavailable("runtime endpoint lease is disposed");
    const nextCredentials = environmentCredentialFingerprint(authentication);
    if (!current || nextCredentials !== credentialFingerprint) generation += 1;
    credentialFingerprint = nextCredentials;
    current = {
      authorityId,
      continuity: "generation-only",
      generation,
      url: options.url,
      location: { ...options.location },
      control: { kind: "borrowed", source: "external" },
      config: { kind: "read-only" },
      authentication,
    };
    return current;
  };
  const refresh = (): Promise<RuntimeEndpoint> => {
    if (refreshFlight) return refreshFlight;
    refreshFlight = refreshOnce().finally(() => {
      refreshFlight = undefined;
    });
    return refreshFlight;
  };
  await refresh();
  return {
    control: { kind: "borrowed", source: "external" },
    async endpoint() {
      if (disposed) throw unavailable("runtime endpoint lease is disposed");
      return current ?? refresh();
    },
    refresh,
    async dispose() {
      // Connect-only ownership: detach local references and nothing else.
      disposed = true;
      current = undefined;
    },
  };
};

export const isOwnedEndpointLease = (
  lease: RuntimeEndpointLease,
): lease is OwnedRuntimeEndpointLease => lease.control.kind === "owned";
