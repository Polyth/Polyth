/**
 * Test-only harness for live OpenCode destructive checks. Spawns through
 * `createOwnedLocalEndpointLease` only. Never opens or migrates the user's
 * global `~/.local/share/opencode/opencode.db`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, RuntimeEndpoint } from "@polyth/contracts";
import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
  createOwnedLocalEndpointLease,
  inspectOpenCodeEngine,
  type OpenCodeEngineIdentity,
  type OpenCodeRuntimeMetadata,
  type RuntimeLifecycle,
} from "../src/index.ts";
import {
  injectLocalIdentityBreak,
  readLocalRuntimeMetadata,
  type LocalIdentityBreak,
} from "./localRuntimeFailure.ts";

export interface FileIdentity {
  exists: boolean;
  ino: number;
  mtimeMs: number;
  size: number;
}

export const globalOpenCodeDbPath = (): string =>
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode", "opencode.db");

export const snapshotPath = (path: string): FileIdentity => {
  try {
    const info = statSync(path);
    return { exists: true, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return { exists: false, ino: 0, mtimeMs: 0, size: 0 };
  }
};

export const fileIdentitiesEqual = (left: FileIdentity, right: FileIdentity): boolean =>
  left.exists === right.exists
  && left.ino === right.ino
  && left.mtimeMs === right.mtimeMs
  && left.size === right.size;

export interface LiveOpenCodeBinary {
  bin: string;
  version: string;
}

const resolveLiveOpenCodeBinary = (): LiveOpenCodeBinary | undefined => {
  try {
    const bin = execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
    if (!bin || !existsSync(bin)) return undefined;
    const version = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "true" },
    }).trim().split(/\r?\n/).at(-1)?.trim();
    if (!version) return undefined;
    return { bin, version };
  } catch {
    return undefined;
  }
};

export const LIVE_OPENCODE = resolveLiveOpenCodeBinary();

export const LIVE_OPENCODE_SKIP = LIVE_OPENCODE
  ? false
  : "opencode is not on PATH; live destructive tests require a real OpenCode process";

let cachedEngine: OpenCodeEngineIdentity | undefined;

export const inspectLiveOpenCodeEngine = async (): Promise<OpenCodeEngineIdentity> => {
  if (!cachedEngine) cachedEngine = await inspectOpenCodeEngine(LIVE_OPENCODE?.bin);
  return cachedEngine;
};

export const readOwnedChildPid = async (pidFile: string): Promise<number | undefined> => {
  try {
    const record = JSON.parse(await readFile(pidFile, "utf8")) as { child?: { pid?: unknown } };
    return typeof record.child?.pid === "number" && record.child.pid > 0
      ? record.child.pid
      : undefined;
  } catch {
    return undefined;
  }
};

export const listDeletedDatabaseFds = (pid: number): string[] => {
  try {
    const fdDir = `/proc/${pid}/fd`;
    return readdirSyncOrEmpty(fdDir)
      .map((fd) => {
        try {
          return execFileSync("readlink", [join(fdDir, fd)], { encoding: "utf8" }).trim();
        } catch {
          return "";
        }
      })
      .filter((target) => /opencode\.db/.test(target) && /\(deleted\)/.test(target));
  } catch {
    return [];
  }
};

const readdirSyncOrEmpty = (path: string): string[] => {
  try {
    return execFileSync("ls", ["-1", path], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

export interface RealOwnedLiveBoot {
  lease: Awaited<ReturnType<typeof createOwnedLocalEndpointLease>>;
  lifecycle: RuntimeLifecycle;
  runtime: AgentRuntime;
  endpoint: RuntimeEndpoint;
  metadata?: OpenCodeRuntimeMetadata;
}

export interface RealOwnedLiveFixture {
  directory: string;
  runtimeDir: string;
  stateFile: string;
  pidFile: string;
  configDir: string;
  globalDb: string;
  globalDbBefore: FileIdentity;
  diagnostics: string[];
  boot(options?: {
    inspectEngine?: () => Promise<OpenCodeEngineIdentity>;
  }): Promise<RealOwnedLiveBoot>;
  inject(breakKind: LocalIdentityBreak): Promise<void>;
  childPid(): Promise<number | undefined>;
  signalChild(signal: NodeJS.Signals): Promise<number | undefined>;
  disposeActive(): Promise<void>;
  dispose(): Promise<void>;
}

export const createRealOwnedLiveFixture = async (options: {
  projectId?: string;
  prefix?: string;
} = {}): Promise<RealOwnedLiveFixture> => {
  const directory = await mkdtemp(join(tmpdir(), options.prefix ?? "polyth-oc-live-"));
  const runtimeDir = join(directory, "runtimes", "opencode", "project");
  const stateFile = join(directory, "opencode-local", "project.lease.json");
  const pidFile = join(directory, "opencode-local", "project.pid.json");
  const configDir = join(directory, "opencode-config");
  await mkdir(join(directory, "opencode-local"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  const globalDb = globalOpenCodeDbPath();
  const globalDbBefore = snapshotPath(globalDb);
  const diagnostics: string[] = [];
  let inspectEngine: () => Promise<OpenCodeEngineIdentity> = inspectLiveOpenCodeEngine;
  let active: RealOwnedLiveBoot | undefined;

  const disposeActive = async (): Promise<void> => {
    if (!active) return;
    const current = active;
    active = undefined;
    await current.runtime.dispose().catch(() => undefined);
    await current.lifecycle.dispose().catch(() => undefined);
  };

  const fixture: RealOwnedLiveFixture = {
    directory,
    runtimeDir,
    stateFile,
    pidFile,
    configDir,
    globalDb,
    globalDbBefore,
    diagnostics,
    async boot(bootOptions) {
      await disposeActive();
      if (bootOptions?.inspectEngine) inspectEngine = bootOptions.inspectEngine;
      const lease = await createOwnedLocalEndpointLease({
        projectId: options.projectId ?? "live-destructive",
        cwd: directory,
        runtimeDir,
        stateFile,
        pidFile,
        configDir,
        inspectEngine,
        onRuntimeDiagnostic: (message) => diagnostics.push(message),
        listenTimeoutMs: 25_000,
        gracefulStopMs: 5_000,
      });
      let lifecycle: RuntimeLifecycle;
      try {
        lifecycle = await createOpenCodeRuntimeLifecycle({
          lease,
          startupDeadlineMs: 25_000,
          probeDeadlineMs: 2_000,
        });
      } catch (error) {
        await lease.dispose().catch(() => undefined);
        throw error;
      }
      const runtime = attachRuntimeLifecycle(
        createOpenCodeRuntimeFacade({ cwd: directory, lifecycle }),
        lifecycle,
      );
      const endpoint = await lease.endpoint();
      active = {
        lease,
        lifecycle,
        runtime,
        endpoint,
        metadata: await readLocalRuntimeMetadata(runtimeDir),
      };
      return active;
    },
    async inject(breakKind) {
      await disposeActive();
      await injectLocalIdentityBreak(runtimeDir, breakKind);
    },
    childPid() {
      return readOwnedChildPid(pidFile);
    },
    async signalChild(signal) {
      const pid = await readOwnedChildPid(pidFile);
      if (pid === undefined) return undefined;
      process.kill(pid, signal);
      return pid;
    },
    disposeActive,
    async dispose() {
      await disposeActive();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return fixture;
};

export const assertGlobalOpenCodeDbUntouched = (before: FileIdentity): void => {
  const after = snapshotPath(globalOpenCodeDbPath());
  if (!fileIdentitiesEqual(before, after)) {
    throw new Error(
      `live test must not touch the user global OpenCode DB; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
};

export const isolatedDatabasePath = (runtimeDir: string): string =>
  join(runtimeDir, "opencode.db");

export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} was not reached within ${timeoutMs}ms`);
};

