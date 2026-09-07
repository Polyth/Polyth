/**
 * Test-only local owned-runtime failure injection. Mutates a real runtime
 * directory the same way `injectRemoteIdentityBreak` mutates fake remote
 * storage. Do not import from production packages.
 */
import assert from "node:assert/strict";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { RuntimeEndpoint } from "@polyth/contracts";
import {
  createOwnedLocalEndpointLease,
  parseOpenCodeRuntimeMetadata,
  type OwnedLocalEndpointOptions,
  type OpenCodeEngineIdentity,
  type OpenCodeRuntimeMetadata,
} from "../src/index.ts";

export const TEST_LOCAL_DIGEST = "a".repeat(64);
export const TEST_LOCAL_DIGEST_B = "b".repeat(64);

export const TEST_LOCAL_ENGINE: OpenCodeEngineIdentity = {
  engine: "opencode",
  version: "1.18.18",
  binaryDigest: TEST_LOCAL_DIGEST,
  protocolGeneration: 1,
};

export type LocalIdentityBreak =
  | { kind: "delete-database" }
  | { kind: "replace-database"; content?: string }
  | { kind: "delete-metadata" }
  | { kind: "replace-metadata"; metadata: string }
  | { kind: "change-storage-id"; storageId: string }
  | { kind: "change-binary-identity"; digest: string }
  | { kind: "wipe-runtime" }
  | { kind: "invalid-metadata" }
  | { kind: "symlink-database"; target: string }
  | { kind: "uncreatable-dir" }
  | { kind: "kill-runtime" };

interface FakeChild extends ChildProcess {
  observedSignals: NodeJS.Signals[];
}

const createFakeChild = (pid: number, output: string): FakeChild => {
  const emitter = new EventEmitter() as FakeChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.assign(emitter, {
    pid,
    stdout,
    stderr,
    stdin: null,
    stdio: [null, stdout, stderr, null, null],
    connected: false,
    spawnargs: [],
    spawnfile: "opencode",
    observedSignals: [] as NodeJS.Signals[],
    kill(signal: NodeJS.Signals = "SIGTERM") {
      emitter.observedSignals.push(signal);
      killed = true;
      signalCode = signal;
      queueMicrotask(() => emitter.emit("exit", null, signal));
      return true;
    },
    ref() {},
    unref() {},
    disconnect() {},
    send() { return false; },
  });
  Object.defineProperties(emitter, {
    killed: { get: () => killed },
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
  });
  setImmediate(() => {
    stderr.write(output);
  });
  return emitter;
};

const metadataPath = (runtimeDir: string): string => join(runtimeDir, "runtime.json");
const databasePath = (runtimeDir: string): string => join(runtimeDir, "opencode.db");

export const readLocalRuntimeMetadata = async (
  runtimeDir: string,
): Promise<OpenCodeRuntimeMetadata | undefined> => {
  try {
    return parseOpenCodeRuntimeMetadata(await readFile(metadataPath(runtimeDir), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const rewriteMetadata = async (
  runtimeDir: string,
  update: (current: OpenCodeRuntimeMetadata) => OpenCodeRuntimeMetadata | string,
): Promise<void> => {
  const current = await readLocalRuntimeMetadata(runtimeDir);
  if (!current) throw new Error(`runtime metadata missing in ${runtimeDir}`);
  const next = update(current);
  await writeFile(
    metadataPath(runtimeDir),
    typeof next === "string" ? next : `${JSON.stringify(next, null, 2)}\n`,
    { mode: 0o600 },
  );
};

export const injectLocalIdentityBreak = async (
  runtimeDir: string,
  breakKind: LocalIdentityBreak,
  options: { lastChild?: FakeChild } = {},
): Promise<void> => {
  const db = databasePath(runtimeDir);
  const meta = metadataPath(runtimeDir);
  switch (breakKind.kind) {
    case "delete-database":
      await rm(db, { force: true });
      await rm(`${db}-wal`, { force: true });
      await rm(`${db}-shm`, { force: true });
      return;
    case "replace-database":
      await writeFile(db, breakKind.content ?? "foreign-opencode-db", { mode: 0o600 });
      return;
    case "delete-metadata":
      await rm(meta, { force: true });
      return;
    case "replace-metadata":
      await writeFile(meta, breakKind.metadata, { mode: 0o600 });
      return;
    case "change-storage-id":
      await rewriteMetadata(runtimeDir, (current) => ({
        ...current,
        storageId: breakKind.storageId,
      }));
      return;
    case "change-binary-identity":
      await rewriteMetadata(runtimeDir, (current) => ({
        ...current,
        binaryDigest: breakKind.digest,
      }));
      return;
    case "wipe-runtime":
      await rm(runtimeDir, { recursive: true, force: true });
      return;
    case "invalid-metadata":
      await writeFile(meta, "{not-json", { mode: 0o600 });
      return;
    case "symlink-database":
      await rm(db, { force: true });
      await symlink(breakKind.target, db);
      return;
    case "uncreatable-dir":
      await rm(runtimeDir, { recursive: true, force: true });
      await mkdir(join(runtimeDir, ".."), { recursive: true });
      await writeFile(runtimeDir, "occupied");
      return;
    case "kill-runtime":
      options.lastChild?.kill("SIGKILL");
      return;
  }
};

export interface LocalOwnedBoot {
  lease: Awaited<ReturnType<typeof createOwnedLocalEndpointLease>>;
  endpoint: RuntimeEndpoint;
  metadata?: OpenCodeRuntimeMetadata;
}

export interface LocalOwnedFixture {
  directory: string;
  runtimeDir: string;
  stateFile: string;
  globalDb: string;
  diagnostics: string[];
  spawnedDbs: string[];
  engine: OpenCodeEngineIdentity;
  boot(): Promise<LocalOwnedBoot>;
  inject(breakKind: LocalIdentityBreak): Promise<void>;
  killRuntime(): void;
  dispose(): Promise<void>;
}

export const createLocalOwnedFixture = async (options: {
  projectId?: string;
  prefix?: string;
  engine?: OpenCodeEngineIdentity;
} = {}): Promise<LocalOwnedFixture> => {
  const directory = await mkdtemp(join(tmpdir(), options.prefix ?? "polyth-local-failure-"));
  const runtimeDir = join(directory, "runtimes", "opencode", "project");
  const stateFile = join(directory, "opencode-local", "project.lease.json");
  const globalDb = join(directory, "forbidden-global.db");
  await mkdir(join(directory, "opencode-local"), { recursive: true });
  await writeFile(globalDb, "user global OpenCode DB must stay untouched", { mode: 0o600 });
  const previousGlobalDb = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = globalDb;

  const diagnostics: string[] = [];
  const spawnedDbs: string[] = [];
  let engine = options.engine ?? { ...TEST_LOCAL_ENGINE };
  let nextPid = 18_000;
  let nextPort = 47_000;
  let lastChild: FakeChild | undefined;
  let activeLease: Awaited<ReturnType<typeof createOwnedLocalEndpointLease>> | undefined;
  const resolveTestBinary: NonNullable<OwnedLocalEndpointOptions["resolveBinary"]> = async (
    resolveOptions,
  ) => ({
    executablePath: resolve("/test-opencode-binaries", resolveOptions.bin ?? "opencode"),
    binarySource: resolveOptions.binarySource ?? (resolveOptions.bin ? "configured" : "path"),
  });

  const disposeLease = async (): Promise<void> => {
    if (!activeLease) return;
    await activeLease.dispose();
    activeLease = undefined;
  };

  const fixture: LocalOwnedFixture = {
    directory,
    runtimeDir,
    stateFile,
    globalDb,
    diagnostics,
    spawnedDbs,
    get engine() {
      return engine;
    },
    async boot() {
      await disposeLease();
      const port = nextPort++;
      const lease = await createOwnedLocalEndpointLease({
        projectId: options.projectId ?? "project-a",
        cwd: directory,
        runtimeDir,
        stateFile,
        pidFile: join(directory, "opencode-local", "project.pid.json"),
        resolveBinary: resolveTestBinary,
        inspectEngine: async () => engine,
        onRuntimeDiagnostic: (message) => diagnostics.push(message),
        pickPort: async () => port,
        spawn: ((_bin: string, args: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
          const isolatedDb = spawnOptions.env?.OPENCODE_DB;
          assert.ok(isolatedDb, "owned spawn must always receive OPENCODE_DB");
          spawnedDbs.push(isolatedDb);
          writeFileSync(isolatedDb, `opaque database ${nextPid}`, { mode: 0o600 });
          lastChild = createFakeChild(
            nextPid++,
            `opencode server listening on http://127.0.0.1:${Number(args.at(-1))}\n`,
          );
          return lastChild;
        }) as unknown as typeof nodeSpawn,
        readProcessIdentity: async (pid) => ({
          startIdentity: `start-${pid}`,
          executable: "/usr/bin/opencode",
          command: `opencode-${pid}`,
        }),
        gracefulStopMs: 20,
      });
      activeLease = lease;
      return {
        lease,
        endpoint: await lease.endpoint(),
        metadata: await readLocalRuntimeMetadata(runtimeDir),
      };
    },
    async inject(breakKind) {
      if (breakKind.kind === "change-binary-identity") {
        engine = { ...engine, binaryDigest: breakKind.digest };
        return;
      }
      if (breakKind.kind === "kill-runtime") {
        lastChild?.kill("SIGKILL");
        return;
      }
      await disposeLease();
      await injectLocalIdentityBreak(runtimeDir, breakKind, { lastChild });
    },
    killRuntime() {
      lastChild?.kill("SIGKILL");
    },
    async dispose() {
      await disposeLease();
      if (previousGlobalDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousGlobalDb;
      await rm(directory, { recursive: true, force: true });
    },
  };
  return fixture;
};
