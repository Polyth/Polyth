import type { RemoteHost, RemoteProcessHandle } from "@polyth/contracts";
import {
  DEFAULT_REMOTE_RUNTIME_ROOT_EXPR,
  REMOTE_OWNER_FILE,
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

export interface FakeRemoteOwnerIdentity {
  token: string;
  pid: string;
  start: string;
  exe: string;
  cmd: string;
}

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
  ownerKind: RemotePathKind;
  ownerLive: boolean;
  ownerIdentity?: FakeRemoteOwnerIdentity;
  startingIdentity?: FakeRemoteOwnerIdentity;
  startingLive: boolean;
  serveIdentity?: FakeRemoteOwnerIdentity;
  serveLive: boolean;
  lockHeld: boolean;
  lockToken?: string;
  lockReclaimHeld: boolean;
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
  ownerKind: "missing",
  ownerLive: false,
  startingLive: false,
  serveLive: false,
  lockHeld: false,
  lockReclaimHeld: false,
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
      state.ownerKind = "file";
      state.ownerLive = true;
      state.ownerIdentity = {
        token: "live-token",
        pid: "4242",
        start: "100",
        exe: "/usr/bin/opencode",
        cmd: "1:2",
      };
      state.lockHeld = true;
      state.lockToken = "live-token";
      state.lockReclaimHeld = false;
      state.startingLive = false;
      state.serveLive = true;
      state.serveIdentity = state.ownerIdentity;
      return;
    case "symlink-owner":
      state.ownerKind = "symlink";
      state.ownerLive = false;
      state.ownerIdentity = undefined;
      state.lockHeld = false;
      state.lockToken = undefined;
      state.lockReclaimHeld = false;
      state.startingIdentity = undefined;
      state.startingLive = false;
      state.serveIdentity = undefined;
      state.serveLive = false;
      return;
    case "wipe-runtime":
      state.metadataKind = "missing";
      state.metadata = undefined;
      state.dbKind = "missing";
      state.dbContent = undefined;
      state.dbEntries = [];
      state.digestCache = undefined;
      state.ownerKind = "missing";
      state.ownerLive = false;
      state.ownerIdentity = undefined;
      state.lockHeld = false;
      state.lockToken = undefined;
      state.lockReclaimHeld = false;
      state.startingIdentity = undefined;
      state.startingLive = false;
      state.serveIdentity = undefined;
      state.serveLive = false;
      return;
  }
};

const identityComplete = (identity?: FakeRemoteOwnerIdentity): boolean =>
  Boolean(identity?.token && identity.pid && identity.start && identity.exe && identity.cmd);

const recordState = (
  present: boolean,
  identity: FakeRemoteOwnerIdentity | undefined,
  live: boolean,
): "missing" | "incomplete" | "live" | "dead" => {
  if (!present) return "missing";
  if (!identityComplete(identity)) return "incomplete";
  return live ? "live" : "dead";
};

export const applyRemoteLockAcquire = (
  state: FakeRemoteStorageState,
  token: string,
): { code: number; stdout: string; stderr: string } => {
  if (state.runtimeDirIsSymlink) {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=runtime-dir-is-symlink\n", stderr: "" };
  }
  if (state.mkdirFails) {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=mkdir-failed\n", stderr: "" };
  }
  const takeLock = (): { code: number; stdout: string; stderr: string } => {
    state.lockHeld = true;
    state.lockToken = token;
    state.startingIdentity = {
      token,
      pid: "9001",
      start: "100",
      exe: "/bin/sh",
      cmd: "1:2",
    };
    state.startingLive = true;
    return { code: 0, stdout: "POLYTH_LOCK_ACQUIRED=1\n", stderr: "" };
  };
  if (!state.lockHeld) return takeLock();

  const starting = recordState(
    state.startingIdentity !== undefined,
    state.startingIdentity,
    state.startingLive,
  );
  if (starting === "live") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=starting-alive\n", stderr: "" };
  }
  if (starting === "incomplete") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=verify-failed\n", stderr: "" };
  }

  const ownerPresent = state.ownerKind !== "missing";
  const owner = recordState(ownerPresent, state.ownerIdentity, state.ownerLive);
  if (owner === "live") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=already-owned\n", stderr: "" };
  }
  if (owner === "incomplete") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=verify-failed\n", stderr: "" };
  }

  const servePresent = state.serveIdentity !== undefined || state.serveLive;
  const serve = recordState(servePresent, state.serveIdentity, state.serveLive);
  if (serve === "live") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=already-owned\n", stderr: "" };
  }
  if (serve === "incomplete") {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=verify-failed\n", stderr: "" };
  }

  if (state.lockReclaimHeld) {
    return { code: 78, stdout: "POLYTH_LOCK_ERROR=already-owned\n", stderr: "" };
  }
  state.lockReclaimHeld = true;
  state.lockHeld = false;
  state.lockToken = undefined;
  state.startingIdentity = undefined;
  state.startingLive = false;
  const recovered = takeLock();
  state.lockReclaimHeld = false;
  if (recovered.code === 0) {
    return { code: 0, stdout: "POLYTH_LOCK_ACQUIRED=1\nPOLYTH_LOCK_RECOVERED=1\n", stderr: "" };
  }
  return { code: 78, stdout: "POLYTH_LOCK_ERROR=already-owned\n", stderr: "" };
};

const quotedAssignment = (command: string, name: string): string | undefined => {
  const match = command.match(new RegExp(`${name}='((?:\\\\'|[^'])*)'`));
  return match?.[1]?.replace(/'\\''/g, "'");
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
    `POLYTH_OWNER_KIND=${state.ownerKind}`,
    `POLYTH_OWNER_LIVE=${state.ownerLive ? "1" : "0"}`,
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

export const applyRemoteStorageCommand = (
  command: string,
  storeFor: (runtimeDir: string) => FakeRemoteStorageState,
  fallback: FakeRemoteStorageState,
): { code: number; stdout: string; stderr: string } | undefined => {
  if (command.includes(REMOTE_STORAGE_MARKERS.processIdentity)) {
    const state = storeFor(fallback.lastRuntimeDir ?? fallback.runtimeDir);
    if (!state.processIdentityCapable || !fallback.processIdentityCapable) {
      return { code: 78, stdout: "POLYTH_PROCESS_IDENTITY_ERROR=unsupported\n", stderr: "" };
    }
    return {
      code: 0,
      stdout: [
        "POLYTH_PROCESS_IDENTITY_OK=1",
        "POLYTH_PROCESS_START=100",
        "POLYTH_PROCESS_EXE=/bin/sh",
        "POLYTH_PROCESS_CMD=1:2",
        "",
      ].join("\n"),
      stderr: "",
    };
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.acquireLock)) {
    const runtimeDir = quotedAssignment(command, "RUNTIME_DIR") ?? fallback.runtimeDir;
    const token = quotedAssignment(command, "LOCK_TOKEN") ?? "";
    const state = storeFor(runtimeDir);
    state.lockAcquireCalls += 1;
    fallback.lastRuntimeDir = runtimeDir;
    state.lastRuntimeDir = runtimeDir;
    return applyRemoteLockAcquire(state, token);
  }

  if (command.includes(REMOTE_STORAGE_MARKERS.releaseLock)) {
    const runtimeDir = quotedAssignment(command, "RUNTIME_DIR") ?? fallback.runtimeDir;
    const token = quotedAssignment(command, "LOCK_TOKEN") ?? "";
    const state = storeFor(runtimeDir);
    if (state.lockHeld && state.lockToken === token) {
      state.lockHeld = false;
      state.lockToken = undefined;
      state.startingIdentity = undefined;
      state.startingLive = false;
      return { code: 0, stdout: "POLYTH_LOCK_RELEASED=1\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
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

  if (command.includes(`rm -f`) && command.includes(REMOTE_OWNER_FILE)) {
    const owner = quotedAssignment(command, "OWNER");
    if (owner) {
      const runtimeDir = owner.replace(/\/\.polyth-runtime-owner$/, "");
      const state = storeFor(runtimeDir);
      state.ownerLive = false;
      state.ownerKind = "missing";
      state.ownerIdentity = undefined;
      state.serveLive = false;
      state.serveIdentity = undefined;
    }
    return undefined;
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
  killedHandles: number[];
  forwards: Array<{ remotePort: number; cancelled: boolean }>;
  reportedDbPath?: string;
  missingDbPath: boolean;
  missingBinary: boolean;
  inject(breakKind: RemoteIdentityBreak): void;
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
    stores.set(runtimeDir, created);
    return created;
  };

  const execCalls: string[] = [];
  const startCommands: string[] = [];
  const killedHandles: number[] = [];
  const forwards: Array<{ remotePort: number; cancelled: boolean }> = [];
  let reportedDbPath = script.reportedDbPath;
  let missingDbPath = false;
  let missingBinary = script.missingBinary ?? false;

  const host: RemoteHost = {
    label: "dev@fake.example",
    async exec(command) {
      execCalls.push(command);
      if (command.includes(REMOTE_STORAGE_MARKERS.processIdentity) && probeYieldMs > 0) {
        await yieldMs(probeYieldMs);
      }
      if (command.includes(REMOTE_STORAGE_MARKERS.inspect) && script.holdAfterLock) {
        await holdAfterLockGate;
      }
      const handled = applyRemoteStorageCommand(command, storageAt, fallback);
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
      const handle: RemoteProcessHandle = {
        onOutput(cb) {
          outputs.add(cb);
          return { dispose: () => { outputs.delete(cb); } };
        },
        onExit(cb) {
          exits.add(cb);
          return { dispose: () => { exits.delete(cb); } };
        },
        async kill() {
          killedHandles.push(index);
          if (isRemoteLockGuardianCommand(command)) {
            if (state.lockToken === quotedAssignment(command, "LOCK_TOKEN")) {
              state.startingLive = false;
            }
            return;
          }
          state.ownerLive = false;
          state.serveLive = false;
        },
      };

      if (isRemoteLockGuardianCommand(command)) {
        if (awaitLockRivals > 0) {
          lockArrivals += 1;
          if (lockArrivals >= awaitLockRivals) releaseLockGate();
          await lockGate;
        }
        const result = applyRemoteStorageCommand(command, storageAt, fallback)
          ?? { code: 78, stdout: "POLYTH_LOCK_ERROR=already-owned\n", stderr: "" };
        setTimeout(() => {
          for (const cb of outputs) cb(result.stdout);
          if (result.code === 0) {
            notifyLockHeld();
            const bucket = guardianExits.get(runtimeDir) ?? new Set();
            bucket.add((code) => { for (const cb of exits) cb(code); });
            guardianExits.set(runtimeDir, bucket);
            return;
          }
          for (const cb of exits) cb(result.code);
        }, 5);
        return handle;
      }

      const port = Number(command.match(/--port (\d+)/)?.[1] ?? 0);
      setTimeout(() => {
        if (script.busyPorts?.includes(port)) {
          for (const cb of outputs) cb(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
          for (const cb of exits) cb(1);
          return;
        }
        state.dbKind = "file";
        if (!state.dbEntries.includes("opencode.db")) state.dbEntries.push("opencode.db");
        state.dbContent = state.dbContent ?? "opaque-remote-opencode-db";
        state.ownerKind = "file";
        state.ownerLive = true;
        state.ownerIdentity = {
          token: "started-token",
          pid: "4242",
          start: "100",
          exe: "/usr/bin/opencode",
          cmd: "1:2",
        };
        state.serveIdentity = state.ownerIdentity;
        state.serveLive = true;
        state.startingLive = false;
        for (const cb of guardianExits.get(runtimeDir) ?? []) cb(0);
        guardianExits.delete(runtimeDir);
        for (const cb of outputs) cb("POLYTH_REMOTE_PID=4242\n");
        for (const cb of outputs) cb(`opencode server listening on http://127.0.0.1:${port}\n`);
      }, 5);
      return handle;
    },
    async forward(remotePort) {
      const record = { remotePort, cancelled: false };
      forwards.push(record);
      return {
        localPort: script.stubPort,
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
    killedHandles,
    releaseHoldAfterLock() {
      releaseHold();
    },
    whenLockHeld() {
      return lockHeldGate;
    },
    forwards,
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
  };
};

export const defaultRemoteXdgRootCommand = (remoteStateKey: string): string =>
  `${DEFAULT_REMOTE_RUNTIME_ROOT_EXPR}/${remoteStateKey}`;
