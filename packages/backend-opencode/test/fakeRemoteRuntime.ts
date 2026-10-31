import type { RemoteHost, RemoteProcessHandle } from "@polyth/contracts";
import {
  DEFAULT_REMOTE_RUNTIME_ROOT_EXPR,
  REMOTE_STORAGE_MARKERS,
} from "../src/remoteStorage.ts";

export type RemotePathKind = "missing" | "file" | "symlink" | "other";

export type RemoteIdentityBreak =
  | { kind: "delete-metadata" }
  | { kind: "delete-database" }
  | { kind: "replace-database" }
  | { kind: "replace-both" }
  | { kind: "restore-stale-metadata"; metadata: string }
  | { kind: "copy-database"; content?: string }
  | { kind: "symlink-database"; target: string }
  | { kind: "symlink-metadata"; target: string }
  | { kind: "digest-change"; digest: string }
  | { kind: "uncreatable-dir" }
  | { kind: "live-owner" }
  | { kind: "symlink-owner" }
  | { kind: "wipe-runtime" }
  | { kind: "wrong-db-path"; path: string }
  | { kind: "missing-db-path" }
  | { kind: "missing-binary" };

export interface FakeRemoteServeIdentity {
  token: string;
  pid: string;
  start: string;
  exe: string;
  cmd: string;
  port?: number;
  /** Authoritative /proc/<pid>/cmdline arguments used by legacy migration tests. */
  argv?: string[];
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export const createDeferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const waitUntil = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export interface FakeRemoteStorageState {
  runtimeDir: string;
  mkdirFails: boolean;
  resolveFails: boolean;
  resolveNotAbsolute: boolean;
  runtimeDirIsSymlink: boolean;
  metadataKind: RemotePathKind;
  metadata?: string;
  dbKind: RemotePathKind;
  dbContent?: string;
  dbEntries: string[];
  serveIdentity?: FakeRemoteServeIdentity;
  serveLive: boolean;
  lockHeld: boolean;
  serveMismatch: boolean;
  lockAcquireCalls: number;
  processIdentityCapable: boolean;
  binaryPath: string;
  binarySize: string;
  binaryMtime: string;
  binaryDigest: string;
  binaryMissing: boolean;
  digestCache?: { path: string; size: string; mtime: string; digest: string };
  inspectCalls: number;
  hashCalls: number;
  quarantineCalls: number;
  metadataWrites: number;
  killedPids: string[];
  serveSignals: Array<"TERM" | "KILL">;
  exitOnTerm: boolean;
  exitOnKill: boolean;
  holdAfterTerm?: Deferred<void>;
  pidReuseAfterTerm: boolean;
  failControllerRelease: boolean;
  failPfWrite: boolean;
  reusedProcessLive: boolean;
  nextServePid: number;
  lastRuntimeDir?: string;
}

export const TEST_REMOTE_DIGEST = "a".repeat(64);
export const TEST_REMOTE_DIGEST_B = "b".repeat(64);

export const createFakeRemoteStorage = (
  runtimeDir: string,
  options: { binaryDigest?: string } = {},
): FakeRemoteStorageState => ({
  runtimeDir,
  mkdirFails: false,
  resolveFails: false,
  resolveNotAbsolute: false,
  runtimeDirIsSymlink: false,
  metadataKind: "missing",
  dbKind: "missing",
  dbEntries: [],
  serveLive: false,
  lockHeld: false,
  serveMismatch: false,
  lockAcquireCalls: 0,
  processIdentityCapable: true,
  binaryPath: "/home/dev/.opencode/bin/opencode",
  binarySize: "4096",
  binaryMtime: "1700000000",
  binaryDigest: options.binaryDigest ?? TEST_REMOTE_DIGEST,
  binaryMissing: false,
  inspectCalls: 0,
  hashCalls: 0,
  quarantineCalls: 0,
  metadataWrites: 0,
  killedPids: [],
  serveSignals: [],
  exitOnTerm: true,
  exitOnKill: true,
  pidReuseAfterTerm: false,
  failControllerRelease: false,
  failPfWrite: false,
  reusedProcessLive: false,
  nextServePid: 4242,
});

export const injectRemoteIdentityBreak = (
  state: FakeRemoteStorageState,
  breakKind: RemoteIdentityBreak,
): void => {
  switch (breakKind.kind) {
    case "delete-metadata":
      state.metadataKind = "missing";
      state.metadata = undefined;
      return;
    case "delete-database":
    case "replace-database":
      state.dbKind = "missing";
      state.dbContent = undefined;
      state.dbEntries = [];
      return;
    case "replace-both":
      state.metadataKind = "missing";
      state.metadata = undefined;
      state.dbKind = "missing";
      state.dbContent = undefined;
      state.dbEntries = [];
      state.digestCache = undefined;
      return;
    case "restore-stale-metadata":
      state.metadataKind = "file";
      state.metadata = breakKind.metadata;
      return;
    case "copy-database":
      state.dbKind = "file";
      state.dbContent = breakKind.content ?? "foreign-opencode-db";
      state.dbEntries = ["opencode.db"];
      state.metadataKind = "missing";
      state.metadata = undefined;
      return;
    case "symlink-database":
      state.dbKind = "symlink";
      state.dbEntries = ["opencode.db"];
      return;
    case "symlink-metadata":
      state.metadataKind = "symlink";
      state.metadata = undefined;
      return;
    case "digest-change":
      state.binaryDigest = breakKind.digest;
      state.binaryMtime = String(Number(state.binaryMtime) + 1);
      state.digestCache = undefined;
      return;
    case "uncreatable-dir":
      state.mkdirFails = true;
      return;
    case "live-owner":
      state.lockHeld = true;
      state.serveLive = true;
      state.serveIdentity = {
        token: "live-token",
        pid: "4242",
        start: "100",
        exe: "/usr/bin/opencode",
        cmd: "1:2",
        port: 4100,
      };
      return;
    case "symlink-owner":
      state.lockHeld = false;
      state.serveIdentity = { token: "x", pid: "", start: "", exe: "", cmd: "" };
      state.serveLive = false;
      return;
    case "wipe-runtime":
      state.metadataKind = "missing";
      state.metadata = undefined;
      state.dbKind = "missing";
      state.dbContent = undefined;
      state.dbEntries = [];
      state.digestCache = undefined;
      state.lockHeld = false;
      state.serveIdentity = undefined;
      state.serveLive = false;
      return;
  }
};

const identityComplete = (identity?: FakeRemoteServeIdentity): boolean =>
  Boolean(identity?.token && identity.pid && identity.start && identity.exe && identity.cmd);

const recordState = (
  identity: FakeRemoteServeIdentity | undefined,
  live: boolean,
  mismatch = false,
): "missing" | "incomplete" | "live" | "dead" | "mismatch" => {
  if (!identity) return "missing";
  if (!identityComplete(identity)) return "incomplete";
  if (live && mismatch) return "mismatch";
  return live ? "live" : "dead";
};

export const applyRemoteLockAcquire = (
  state: FakeRemoteStorageState,
): { code: number; stdout: string; stderr: string } => {
  if (!state.processIdentityCapable) {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=unsupported\n", stderr: "" };
  }
  if (state.runtimeDirIsSymlink) {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=runtime-dir-is-symlink\n", stderr: "" };
  }
  if (state.mkdirFails) {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=mkdir-failed\n", stderr: "" };
  }
  if (state.lockHeld) {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=already-owned\n", stderr: "" };
  }
  const takeLock = (): { code: number; stdout: string; stderr: string } => {
    state.lockHeld = true;
    return { code: 0, stdout: "POLYTH_LOCK_ACQUIRED=1\n", stderr: "" };
  };

  const serve = recordState(state.serveIdentity, state.serveLive, state.serveMismatch);
  if (serve === "incomplete") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=verify-failed\n", stderr: "" };
  }
  if (serve === "mismatch") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=identity-mismatch\n", stderr: "" };
  }
  if (serve === "live") {
    let identity = state.serveIdentity!;
    let port = identity.port;
    const legacyOutput: string[] = [];
    if (!Number.isInteger(port) || (port ?? 0) < 1 || (port ?? 0) > 65535) {
      legacyOutput.push("POLYTH_LEGACY_RECORD=1");
      const argv = identity.argv ?? [];
      const candidates: string[] = [];
      let serveCount = 0;
      for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === "serve") serveCount += 1;
        if (argument === "--port") {
          if (index + 1 < argv.length) candidates.push(argv[++index]!);
        } else if (argument.startsWith("--port=")) {
          candidates.push(argument.slice("--port=".length));
        }
      }
      const recovered = candidates.length === 1 && /^\d{1,5}$/.test(candidates[0]!)
        ? Number(candidates[0])
        : 0;
      if (serveCount !== 1 || recovered < 1 || recovered > 65535) {
        return {
          code: 78,
          stdout: `${legacyOutput.join("\n")}\nPOLYTH_LOCK_ERROR=listen-unknown\n`,
          stderr: "",
        };
      }
      port = recovered;
      identity = { ...identity, port };
      state.serveIdentity = identity;
      legacyOutput.push("POLYTH_LEGACY_MIGRATED=1");
    }
    const acquired = takeLock();
    if (acquired.code !== 0) return acquired;
    return {
      code: 0,
      stdout: [
        ...legacyOutput,
        "POLYTH_LOCK_ADOPTABLE=1",
        `POLYTH_ADOPT_PID=${identity.pid}`,
        `POLYTH_ADOPT_START=${identity.start}`,
        `POLYTH_ADOPT_EXE=${identity.exe}`,
        `POLYTH_ADOPT_CMD=${identity.cmd}`,
        `POLYTH_ADOPT_TOKEN=${identity.token}`,
        `POLYTH_ADOPT_PORT=${port}`,
        "POLYTH_LOCK_ACQUIRED=1",
        "",
      ].join("\n"),
      stderr: "",
    };
  }
  return takeLock();
};

const quotedAssignment = (command: string, name: string): string | undefined => {
  const match = command.match(new RegExp(`${name}='((?:\\\\'|[^'])*)'`));
  return match?.[1]?.replace(/'\\''/g, "'");
};

const terminateUnpublishedChild = async (
  state: FakeRemoteStorageState,
  pid: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  state.killedPids.push(pid);
  state.serveSignals.push("TERM");
  if (state.exitOnTerm) {
    state.serveLive = false;
    return {
      code: 1,
      stdout: "POLYTH_UNPUBLISHED_TERM=1\nPOLYTH_SERVE_IDENTITY_INCOMPLETE=1\n",
      stderr: "",
    };
  }
  if (state.holdAfterTerm) {
    await state.holdAfterTerm.promise;
    if (!state.serveLive) {
      return {
        code: 1,
        stdout: "POLYTH_UNPUBLISHED_TERM=1\nPOLYTH_SERVE_IDENTITY_INCOMPLETE=1\n",
        stderr: "",
      };
    }
  }
  state.serveSignals.push("KILL");
  if (state.exitOnKill) {
    state.serveLive = false;
    return {
      code: 1,
      stdout: "POLYTH_UNPUBLISHED_TERM=1\nPOLYTH_UNPUBLISHED_KILL=1\nPOLYTH_SERVE_IDENTITY_INCOMPLETE=1\n",
      stderr: "",
    };
  }
  return {
    code: 78,
    stdout: "POLYTH_UNPUBLISHED_TERM=1\nPOLYTH_UNPUBLISHED_KILL=1\nPOLYTH_UNPUBLISHED_ERROR=still-alive\n",
    stderr: "",
  };
};

export const applyRemoteStopServe = async (
  command: string,
  state: FakeRemoteStorageState,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const expected = quotedAssignment(command, "EXPECT_TOKEN")
    ?? command.match(/EXPECT_TOKEN='([^']*)'/)?.[1];
  const rec = state.serveIdentity;
  if (!rec || rec.token !== expected) {
    return { code: 0, stdout: "POLYTH_STOP_OK=1\n", stderr: "" };
  }
  if (!state.serveLive || state.serveMismatch) {
    if (rec.token === expected) state.serveIdentity = undefined;
    return { code: 0, stdout: "POLYTH_STOP_OK=1\n", stderr: "" };
  }

  const snapshot = { ...rec };
  const stillExact = (): boolean => Boolean(
    state.serveLive
    && state.serveIdentity
    && state.serveIdentity.token === snapshot.token
    && state.serveIdentity.pid === snapshot.pid
    && state.serveIdentity.start === snapshot.start
    && state.serveIdentity.exe === snapshot.exe
    && state.serveIdentity.cmd === snapshot.cmd
    && !state.serveMismatch,
  );

  state.killedPids.push(snapshot.pid);
  state.serveSignals.push("TERM");
  const lines = ["POLYTH_STOP_TERM=1"];

  if (state.pidReuseAfterTerm) {
    state.reusedProcessLive = true;
    state.serveIdentity = undefined;
    state.serveLive = false;
    return { code: 0, stdout: `${lines.join("\n")}\nPOLYTH_STOP_OK=1\n`, stderr: "" };
  }

  if (state.exitOnTerm) {
    state.serveLive = false;
    state.serveIdentity = undefined;
    return { code: 0, stdout: `${lines.join("\n")}\nPOLYTH_STOP_OK=1\n`, stderr: "" };
  }

  if (state.holdAfterTerm) {
    await state.holdAfterTerm.promise;
    if (!stillExact()) {
      if (state.serveIdentity?.token === snapshot.token) state.serveIdentity = undefined;
      return { code: 0, stdout: `${lines.join("\n")}\nPOLYTH_STOP_OK=1\n`, stderr: "" };
    }
  }

  if (stillExact()) {
    state.serveSignals.push("KILL");
    lines.push("POLYTH_STOP_KILL=1");
    if (state.exitOnKill) {
      state.serveLive = false;
      state.serveIdentity = undefined;
      return { code: 0, stdout: `${lines.join("\n")}\nPOLYTH_STOP_OK=1\n`, stderr: "" };
    }
    return {
      code: 78,
      stdout: `${lines.join("\n")}\nPOLYTH_STOP_ERROR=still-alive\n`,
      stderr: "",
    };
  }

  if (state.serveIdentity?.token === snapshot.token) state.serveIdentity = undefined;
  return { code: 0, stdout: `${lines.join("\n")}\nPOLYTH_STOP_OK=1\n`, stderr: "" };
};

const inspectOutput = (state: FakeRemoteStorageState): string => {
  const lines = [
    `POLYTH_RUNTIME_DIR=${state.runtimeDir}`,
    `POLYTH_METADATA_KIND=${state.metadataKind}`,
  ];
  if (state.metadataKind === "file" && state.metadata) {
    lines.push("POLYTH_METADATA_BEGIN", state.metadata.replace(/\n$/, ""), "POLYTH_METADATA_END");
  }
  lines.push(
    `POLYTH_DB_KIND=${state.dbKind}`,
    `POLYTH_DB_ENTRIES=${state.dbEntries.join(" ")}`,
    `POLYTH_BINARY_PATH=${state.binaryPath}`,
    `POLYTH_BINARY_SIZE=${state.binarySize}`,
    `POLYTH_BINARY_MTIME=${state.binaryMtime}`,
    `POLYTH_DIGEST_CACHE_KIND=${state.digestCache ? "file" : "missing"}`,
  );
  if (state.digestCache) {
    lines.push(
      `POLYTH_DIGEST_CACHE_PATH=${state.digestCache.path}`,
      `POLYTH_DIGEST_CACHE_SIZE=${state.digestCache.size}`,
      `POLYTH_DIGEST_CACHE_MTIME=${state.digestCache.mtime}`,
      `POLYTH_DIGEST_CACHE_DIGEST=${state.digestCache.digest}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

export const applyRemoteStorageCommand = async (
  command: string,
  storeFor: (runtimeDir: string) => FakeRemoteStorageState,
  fallback: FakeRemoteStorageState,
): Promise<{ code: number; stdout: string; stderr: string } | undefined> => {
  if (command.includes(REMOTE_STORAGE_MARKERS.acquireLock)) {
    const runtimeDir = quotedAssignment(command, "RUNTIME_DIR") ?? fallback.runtimeDir;
    const state = storeFor(runtimeDir);
    state.lockAcquireCalls += 1;
    fallback.lastRuntimeDir = runtimeDir;
    state.lastRuntimeDir = runtimeDir;
    return applyRemoteLockAcquire(state);
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.resolveDir)) {
    if (fallback.resolveFails) {
      return { code: 78, stdout: "POLYTH_PREPARE_ERROR=mkdir-failed\n", stderr: "" };
    }
    const key = command.match(/polyth\/runtimes\/opencode\/([A-Za-z0-9._-]+)/)?.[1];
    const resolved = fallback.resolveNotAbsolute
      ? "relative/polyth/runtimes/opencode/invalid"
      : fallback.runtimeDir.includes("/polyth/runtimes/opencode/")
        ? fallback.runtimeDir
        : `/home/dev/.local/share/polyth/runtimes/opencode/${key ?? "default"}`;
    if (!fallback.runtimeDir.includes("/polyth/runtimes/opencode/") && key) {
      fallback.runtimeDir = resolved;
    }
    return { code: 0, stdout: `POLYTH_RUNTIME_DIR=${resolved}\n`, stderr: "" };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.inspect)) {
    const runtimeDir = quotedAssignment(command, "RUNTIME_DIR") ?? fallback.runtimeDir;
    const state = storeFor(runtimeDir);
    state.inspectCalls += 1;
    fallback.lastRuntimeDir = runtimeDir;
    state.lastRuntimeDir = runtimeDir;
    if (state.runtimeDirIsSymlink) {
      return { code: 78, stdout: "POLYTH_PREPARE_ERROR=runtime-dir-is-symlink\n", stderr: "" };
    }
    if (state.mkdirFails) {
      return { code: 78, stdout: "POLYTH_PREPARE_ERROR=mkdir-failed\n", stderr: "" };
    }
    if (state.binaryMissing) {
      return { code: 78, stdout: "POLYTH_PREPARE_ERROR=binary-not-found\n", stderr: "" };
    }
    return { code: 0, stdout: inspectOutput(state), stderr: "" };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.hashBinary)) {
    const state = storeFor(fallback.lastRuntimeDir ?? fallback.runtimeDir);
    state.hashCalls += 1;
    return {
      code: 0,
      stdout: `POLYTH_BINARY_DIGEST=${state.binaryDigest}\n`,
      stderr: "",
    };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.writeDigestCache)) {
    const cachePath = quotedAssignment(command, "CACHE") ?? "";
    const body = quotedAssignment(command, "BODY") ?? "";
    const runtimeDir = cachePath.replace(/\/\.polyth-binary-digest$/, "") || fallback.runtimeDir;
    const state = storeFor(runtimeDir);
    const [path, size, mtime, digest] = body.trim().split("\t");
    if (path && size && mtime && digest) {
      state.digestCache = { path, size, mtime, digest };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.quarantine)) {
    const runtimeDir = quotedAssignment(command, "RUNTIME_DIR") ?? fallback.runtimeDir;
    const state = storeFor(runtimeDir);
    state.quarantineCalls += 1;
    state.dbKind = "missing";
    state.dbContent = undefined;
    state.dbEntries = [];
    return { code: 0, stdout: "POLYTH_QUARANTINE_MOVED=1\n", stderr: "" };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.attach)) {
    const runtimeDir = quotedAssignment(command, "RUNTIME_DIR") ?? fallback.runtimeDir;
    const expectPid = quotedAssignment(command, "EXPECT_PID") ?? "";
    const expectStart = quotedAssignment(command, "EXPECT_START") ?? "";
    const expectExe = quotedAssignment(command, "EXPECT_EXE") ?? "";
    const expectCmd = quotedAssignment(command, "EXPECT_CMD") ?? "";
    const state = storeFor(runtimeDir);
    fallback.lastRuntimeDir = runtimeDir;
    const identity = state.serveIdentity;
    if (
      !state.serveLive
      || !identity
      || identity.pid !== expectPid
      || identity.start !== expectStart
      || identity.exe !== expectExe
      || identity.cmd !== expectCmd
    ) {
      return { code: 78, stdout: "POLYTH_ATTACH_ERROR=dead\n", stderr: "" };
    }
    return { code: 0, stdout: "POLYTH_ATTACH_OK=1\n", stderr: "" };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.stopServe)) {
    const runtimeDir = fallback.lastRuntimeDir ?? fallback.runtimeDir;
    return applyRemoteStopServe(command, storeFor(runtimeDir));
  }

  if (command.includes("echo POLYTH_SERVE_LIVE=1")) {
    const runtimeDir = fallback.lastRuntimeDir ?? fallback.runtimeDir;
    const state = storeFor(runtimeDir);
    const expected = command.match(/TOKEN='([^']*)'/)?.[1]
      ?? quotedAssignment(command, "TOKEN");
    const identity = state.serveIdentity;
    const live = Boolean(
      state.serveLive
      && identity
      && !state.serveMismatch
      && (!expected || identity.token === expected),
    );
    return {
      code: 0,
      stdout: live ? "POLYTH_SERVE_LIVE=1\n" : "",
      stderr: "",
    };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.writeMetadata)) {
    const file = quotedAssignment(command, "FILE") ?? "";
    const json = quotedAssignment(command, "METADATA_JSON") ?? "";
    const runtimeDir = file.replace(/\/runtime\.json$/, "") || fallback.runtimeDir;
    const state = storeFor(runtimeDir);
    state.metadataKind = "file";
    state.metadata = json;
    state.metadataWrites += 1;
    return { code: 0, stdout: "", stderr: "" };
  }

  return undefined;
};

export interface FakeRemoteHostScript {
  version?: string;
  missingBinary?: boolean;
  missingDir?: boolean;
  reportedDbPath?: string;
  busyPorts?: number[];
  stubPort: number;
  runtimeDir?: string;
  binaryDigest?: string;
  processIdentityCapable?: boolean;
  probeYieldMs?: number;
  startYieldMs?: number;
  awaitLockRivals?: number;
  holdAfterLock?: boolean;
  exitAfterAcquired?: boolean;
  failForwardRemaining?: number;
  failServeWrite?: boolean;
  remoteReversePort?: number;
  lockOutputDelayMs?: number;
}

export const isRemoteLockGuardianCommand = (command: string): boolean =>
  command.includes(REMOTE_STORAGE_MARKERS.lockGuardian)
  || command.includes("POLYTH_REMOTE_LOCK_GUARDIAN=1");

export const isRemoteServeCommand = (command: string): boolean =>
  command.includes("opencode serve");

export interface FakeRemoteHost {
  host: RemoteHost;
  storage: FakeRemoteStorageState;
  storageAt(runtimeDir: string): FakeRemoteStorageState;
  execCalls: string[];
  startCommands: string[];
  serveStartCommands: string[];
  guardianStartCommands: string[];
  guardianWrites: string[];
  serveWrites: string[];
  killedHandles: number[];
  forwards: Array<{ remotePort: number; cancelled: boolean }>;
  reverseForwards: Array<{ localPort: number; remotePort: number; cancelled: boolean }>;
  reportedDbPath?: string;
  missingDbPath: boolean;
  missingBinary: boolean;
  inject(breakKind: RemoteIdentityBreak): void;
  failNextForwards(count: number): void;
  failNextAttach(count: number): void;
  killGuardians(): void;
  setServeProbeUnreachable(value: boolean): void;
  releaseHoldAfterLock(): void;
  whenLockHeld(): Promise<void>;
}

export const createFakeRemoteHost = (script: FakeRemoteHostScript): FakeRemoteHost => {
  const stores = new Map<string, FakeRemoteStorageState>();
  const fallback = createFakeRemoteStorage(
    script.runtimeDir ?? "/var/lib/polyth/runtimes/app",
    { binaryDigest: script.binaryDigest },
  );
  fallback.processIdentityCapable = script.processIdentityCapable ?? true;
  stores.set(fallback.runtimeDir, fallback);
  const probeYieldMs = script.probeYieldMs ?? 0;
  const startYieldMs = script.startYieldMs ?? 0;
  const awaitLockRivals = script.awaitLockRivals ?? 0;
  let lockArrivals = 0;
  let releaseLockGate = (): void => undefined;
  const lockGate = awaitLockRivals > 0
    ? new Promise<void>((resolve) => { releaseLockGate = resolve; })
    : Promise.resolve();
  let releaseHold = (): void => undefined;
  const holdAfterLockGate = script.holdAfterLock
    ? new Promise<void>((resolve) => { releaseHold = resolve; })
    : Promise.resolve();
  let notifyLockHeld = (): void => undefined;
  const lockHeldGate = new Promise<void>((resolve) => { notifyLockHeld = resolve; });
  const guardianExits = new Map<string, Set<(code: number | null) => void>>();
  const yieldMs = (ms: number): Promise<void> =>
    ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve();
  const storageAt = (runtimeDir: string): FakeRemoteStorageState => {
    const existing = stores.get(runtimeDir);
    if (existing) return existing;
    const created = createFakeRemoteStorage(runtimeDir, { binaryDigest: script.binaryDigest });
    created.processIdentityCapable = fallback.processIdentityCapable;
    stores.set(runtimeDir, created);
    return created;
  };

  const execCalls: string[] = [];
  const startCommands: string[] = [];
  const guardianWrites: string[] = [];
  const serveWrites: string[] = [];
  const killedHandles: number[] = [];
  const forwards: Array<{ remotePort: number; cancelled: boolean }> = [];
  const reverseForwards: Array<{ localPort: number; remotePort: number; cancelled: boolean }> = [];
  let serveProbeUnreachable = false;
  let failForwardRemaining = script.failForwardRemaining ?? 0;
  let failAttachRemaining = 0;
  let reportedDbPath = script.reportedDbPath;
  let missingDbPath = false;
  let missingBinary = script.missingBinary ?? false;

  const host: RemoteHost = {
    label: "dev@fake.example",
    async exec(command) {
      execCalls.push(command);
      if (command.includes("echo POLYTH_SERVE_LIVE=1") && serveProbeUnreachable) {
        return { code: 1, stdout: "", stderr: "ssh: connection refused\n" };
      }
      if (command.includes(REMOTE_STORAGE_MARKERS.attach) && failAttachRemaining > 0) {
        failAttachRemaining -= 1;
        throw new Error("ssh: connection refused");
      }
      if (command.includes(REMOTE_STORAGE_MARKERS.inspect) && probeYieldMs > 0) {
        await yieldMs(probeYieldMs);
      }
      if (command.includes(REMOTE_STORAGE_MARKERS.inspect) && script.holdAfterLock) {
        await holdAfterLockGate;
      }
      const handled = await applyRemoteStorageCommand(command, storageAt, fallback);
      if (handled) return handled;
      if (command.includes("command -v") && !command.includes(REMOTE_STORAGE_MARKERS.inspect)) {
        return missingBinary
          ? { code: 0, stdout: "POLYTH_OC_MISSING\n", stderr: "" }
          : { code: 0, stdout: `${script.version ?? "1.18.18"}\n`, stderr: "" };
      }
      if (command.includes(" db path")) {
        if (missingDbPath) return { code: 1, stdout: "", stderr: "" };
        const expected = command.match(/OPENCODE_DB='([^']+)'/)?.[1] ?? "";
        return {
          code: 0,
          stdout: `${reportedDbPath ?? expected}\n`,
          stderr: "",
        };
      }
      if (command.startsWith("test -d")) {
        return { code: script.missingDir ? 1 : 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async start(command) {
      if (startYieldMs > 0 && isRemoteServeCommand(command)) await yieldMs(startYieldMs);
      startCommands.push(command);
      const index = startCommands.length - 1;
      const runtimeDir = quotedAssignment(command, "RUNTIME_DIR") ?? fallback.runtimeDir;
      const state = storageAt(runtimeDir);
      const outputs = new Set<(chunk: string) => void>();
      const exits = new Set<(code: number | null) => void>();
      let guardianAlive = true;
      let holdsFlock = false;
      const releaseThisGuardian = (): void => {
        if (!guardianAlive) return;
        guardianAlive = false;
        if (holdsFlock) {
          holdsFlock = false;
          state.lockHeld = false;
        }
        for (const cb of exits) cb(0);
      };
      const handle: RemoteProcessHandle = {
        onOutput(cb) {
          outputs.add(cb);
          return { dispose: () => { outputs.delete(cb); } };
        },
        onExit(cb) {
          exits.add(cb);
          return { dispose: () => { exits.delete(cb); } };
        },
        async write(data) {
          if (isRemoteServeCommand(command)) {
            serveWrites.push(data);
            if (script.failServeWrite) throw new Error("remote stdin is closed");
            return;
          }
          if (!isRemoteLockGuardianCommand(command)) return;
          guardianWrites.push(data);
          if (!data.includes("POLYTH_RELEASE")) return;
          if (state.failControllerRelease) return;
          releaseThisGuardian();
        },
        async kill() {
          killedHandles.push(index);
          if (isRemoteLockGuardianCommand(command)) {
            if (state.failControllerRelease) return;
            releaseThisGuardian();
            return;
          }
          // Guardian handle death is not OpenCode death.
        },
      };

      if (isRemoteLockGuardianCommand(command)) {
        if (awaitLockRivals > 0) {
          lockArrivals += 1;
          if (lockArrivals >= awaitLockRivals) releaseLockGate();
          await lockGate;
        }
        const result = await applyRemoteStorageCommand(command, storageAt, fallback)
          ?? { code: 78, stdout: "POLYTH_LOCK_ERROR=already-owned\n", stderr: "" };
        holdsFlock = result.code === 0;
        setTimeout(() => {
          if (!guardianAlive) return;
          for (const cb of outputs) cb(result.stdout);
          if (result.code === 0) {
            notifyLockHeld();
            if (script.exitAfterAcquired) {
              releaseThisGuardian();
              return;
            }
            const bucket = guardianExits.get(runtimeDir) ?? new Set();
            bucket.add((code) => { for (const cb of exits) cb(code); });
            guardianExits.set(runtimeDir, bucket);
            return;
          }
          for (const cb of exits) cb(result.code);
        }, script.lockOutputDelayMs ?? 5);
        return handle;
      }

      const port = Number(command.match(/--port (\d+)/)?.[1] ?? 0);
      setTimeout(() => {
        void (async () => {
          if (script.busyPorts?.includes(port)) {
            for (const cb of outputs) cb(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
            for (const cb of exits) cb(1);
            return;
          }
          const serveToken = quotedAssignment(command, "SERVE_TOKEN")
            ?? quotedAssignment(command, "INSTANCE_TOKEN")
            ?? "started-token";
          const pidNum = state.nextServePid;
          state.nextServePid += 1;
          const pid = String(pidNum);
          state.dbKind = "file";
          if (!state.dbEntries.includes("opencode.db")) state.dbEntries.push("opencode.db");
          state.dbContent = state.dbContent ?? "opaque-remote-opencode-db";
          fallback.lastRuntimeDir = runtimeDir;
          state.lastRuntimeDir = runtimeDir;
          if (state.failPfWrite) {
            state.serveLive = true;
            state.serveIdentity = undefined;
            const result = await terminateUnpublishedChild(state, pid);
            for (const cb of outputs) cb(result.stdout);
            for (const cb of exits) cb(result.code);
            return;
          }
          state.serveIdentity = {
            token: serveToken,
            pid,
            start: String(100 + (pidNum - 4242)),
            exe: "/usr/bin/opencode",
            cmd: "1:2",
            port,
          };
          state.serveLive = true;
          for (const cb of outputs) cb(`POLYTH_REMOTE_PID=${pid}\n`);
          for (const cb of outputs) cb("POLYTH_SERVE_SPAWNED=1\n");
          for (const cb of exits) cb(0);
        })();
      }, 5);
      return handle;
    },
    async forward(remotePort) {
      if (failForwardRemaining > 0) {
        failForwardRemaining -= 1;
        throw Object.assign(new Error("injected forward failure"), { code: "unavailable" });
      }
      const record = { remotePort, cancelled: false };
      forwards.push(record);
      return {
        localPort: script.stubPort,
        dispose: async () => { record.cancelled = true; },
      };
    },
    async reverseForward(localPort, requestedRemotePort) {
      const record = {
        localPort,
        remotePort: requestedRemotePort ?? script.remoteReversePort ?? 39_123,
        cancelled: false,
      };
      reverseForwards.push(record);
      return {
        remotePort: record.remotePort,
        dispose: async () => { record.cancelled = true; },
      };
    },
  };

  const applyHostBreak = (breakKind: RemoteIdentityBreak): boolean => {
    switch (breakKind.kind) {
      case "wrong-db-path":
        reportedDbPath = breakKind.path;
        missingDbPath = false;
        return true;
      case "missing-db-path":
        missingDbPath = true;
        return true;
      case "missing-binary":
        missingBinary = true;
        return true;
      default:
        return false;
    }
  };

  return {
    host,
    get storage() {
      return fallback;
    },
    storageAt,
    execCalls,
    startCommands,
    get serveStartCommands() {
      return startCommands.filter(isRemoteServeCommand);
    },
    get guardianStartCommands() {
      return startCommands.filter(isRemoteLockGuardianCommand);
    },
    guardianWrites,
    serveWrites,
    killedHandles,
    releaseHoldAfterLock() {
      releaseHold();
    },
    whenLockHeld() {
      return lockHeldGate;
    },
    forwards,
    reverseForwards,
    get reportedDbPath() {
      return reportedDbPath;
    },
    get missingDbPath() {
      return missingDbPath;
    },
    get missingBinary() {
      return missingBinary;
    },
    inject(breakKind) {
      if (!applyHostBreak(breakKind)) injectRemoteIdentityBreak(fallback, breakKind);
    },
    failNextForwards(count) {
      failForwardRemaining = count;
    },
    failNextAttach(count) {
      failAttachRemaining = count;
    },
    killGuardians() {
      for (const [runtimeDir, bucket] of guardianExits) {
        const state = storageAt(runtimeDir);
        state.lockHeld = false;
        for (const cb of [...bucket]) cb(0);
      }
    },
    setServeProbeUnreachable(value) {
      serveProbeUnreachable = value;
    },
  };
};

export const defaultRemoteXdgRootCommand = (remoteStateKey: string): string =>
  `${DEFAULT_REMOTE_RUNTIME_ROOT_EXPR}/${remoteStateKey}`;
