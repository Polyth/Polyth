import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverOpenCodeBinary,
  type OpenCodeSearchReport,
} from "./binaryDiscovery.ts";
import type { OwnedRuntimeIncarnation } from "./ownedRuntimeState.ts";

export const OPENCODE_PROTOCOL_GENERATION = 1;
export const OPENCODE_UPDATE_DISABLE_ENV = "OPENCODE_DISABLE_AUTOUPDATE";
export const POLYTH_OPENCODE_BIN_ENV = "POLYTH_OPENCODE_BIN";

// Runtime directories are recovery caches, not durable Polyth state. Keep
// abandoned worktree caches for 30 days and incompatible DB quarantines for
// 7 days. These intentionally conservative values are internal, not user
// configuration; active worktrees are never removed by this sweep.
export const OPEN_CODE_RUNTIME_STALE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const OPEN_CODE_QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface OpenCodeEngineIdentity {
  engine: "opencode";
  version: string;
  binaryDigest: string;
  protocolGeneration: number;
}

export type OpenCodeBinarySource =
  | "bundled"
  | "override"
  | "configured"
  /** Found on the PATH this process inherited. */
  | "path"
  /** Found in a documented install location the inherited PATH did not list. */
  | "well-known"
  /** Found on the PATH a login shell would have produced. */
  | "login-shell";

export const OPEN_CODE_BINARY_SOURCES: readonly OpenCodeBinarySource[] = [
  "bundled",
  "override",
  "configured",
  "path",
  "well-known",
  "login-shell",
];

export interface ResolvedOpenCodeBinary {
  executablePath: string;
  binarySource: OpenCodeBinarySource;
  binaryOverrideEnv?: typeof POLYTH_OPENCODE_BIN_ENV;
  /** Set when resolution succeeded but not the way it was configured to — a
   * missing bundle that fell back to an installed CLI. Surfaced, not thrown:
   * the runtime works, the packaging does not. */
  diagnostic?: string;
}

export interface OpenCodeRuntimeMetadata extends OpenCodeEngineIdentity {
  storageId: string;
  binarySource?: OpenCodeBinarySource;
  binaryPath?: string;
  binaryOverrideEnv?: typeof POLYTH_OPENCODE_BIN_ENV;
  runtimeAuthority: string;
  runtimeLocation: {
    projectId: string;
    cwd: string;
  };
  createdAt: string;
  lastOpenedAt: string;
}

export interface PreparedOpenCodeRuntime {
  runtimeDir: string;
  dbPath: string;
  storageId: string;
  engineIdentity: OpenCodeEngineIdentity;
  binary: ResolvedOpenCodeBinary;
  diagnostic?: string;
  recordOpen(incarnation: OwnedRuntimeIncarnation): Promise<void>;
  secureDatabaseFiles(): Promise<void>;
}

const unavailable = (message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "unavailable",
  });

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const execute = (
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectExecution(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolveExecution({ stdout, stderr });
      },
    );
  });

const executableCandidates = (bin: string, env: NodeJS.ProcessEnv): string[] => {
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return [resolve(bin)];
  }
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) =>
        join(directory, process.platform === "win32" && !extname(bin) ? `${bin}${extension}` : bin)));
};

const resolveExecutable = async (
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  for (const candidate of executableCandidates(bin, env)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  throw unavailable(`OpenCode binary is not executable or was not found on PATH: ${bin}`);
};

/** How many searched locations a failure names before it summarizes. Enough to
 * recognize the machine's real install layout, short enough to read. */
const REPORTED_SEARCH_LOCATIONS = 12;

const notFoundError = (
  binary: string,
  report: OpenCodeSearchReport,
): Error => {
  const shown = report.searched.slice(0, REPORTED_SEARCH_LOCATIONS);
  const rest = report.searched.length - shown.length;
  const where = shown.length === 0
    ? "nowhere — PATH was empty and no install location is readable"
    : `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
  return Object.assign(
    unavailable(
      `OpenCode CLI "${binary}" was not found. Searched ${where}.`
      + (report.loginShell ? ` A ${report.loginShell} login shell was consulted too.` : "")
      + ` Install OpenCode (https://opencode.ai) or set ${POLYTH_OPENCODE_BIN_ENV}`
      + " to the CLI path.",
    ),
    {
      binary,
      searched: report.searched,
      ...(report.loginShell ? { loginShell: report.loginShell } : {}),
    },
  );
};

/**
 * Resolve the OpenCode executable Polyth will own.
 *
 * `POLYTH_OPENCODE_BIN` is an instruction from the user and stays exact: it
 * either resolves or fails loudly, because silently running a *different*
 * OpenCode than the one that was named is worse than not starting.
 *
 * A `bundled` path is different — it is Polyth's own packaging detail, not a
 * user decision. When our bundle is absent (a dev build that skipped the
 * download, a pruned resources dir, a quarantined file) refusing to start left
 * a user who has a perfectly good `opencode` on their machine with a dead app.
 * A missing bundle therefore degrades to discovery and reports that it did.
 *
 * Everything else goes through {@link discoverOpenCodeBinary}, which widens
 * past the inherited PATH into the documented install locations and, as a last
 * resort, a login shell's PATH — the difference between "works in a terminal,
 * empty catalog in the app" and just working.
 */
export const resolveOpenCodeBinary = async (options: {
  bin?: string;
  binarySource?: Extract<OpenCodeBinarySource, "bundled" | "configured">;
  env?: NodeJS.ProcessEnv;
  /** `false` skips the login-shell PATH probe (hermetic tests, CI). */
  loginShellProbe?: boolean;
} = {}): Promise<ResolvedOpenCodeBinary> => {
  const env = options.env ?? process.env;
  const discovery = {
    env,
    ...(options.loginShellProbe === undefined
      ? {}
      : { loginShellProbe: options.loginShellProbe }),
  };
  const configured = options.bin?.trim();
  if (options.binarySource === "bundled" && (!configured || !isAbsolute(configured))) {
    throw unavailable("bundled OpenCode binary must be provided as an absolute path");
  }

  // Desktop supplies a trusted absolute resources path. It must not be
  // shadowed by a developer's ambient override.
  let bundleMissing: string | undefined;
  if (configured && isAbsolute(configured)) {
    try {
      return {
        executablePath: await resolveExecutable(configured, env),
        binarySource: options.binarySource ?? "configured",
      };
    } catch (error) {
      // Only *our* bundle degrades. An operator-configured path is a decision
      // and keeps failing loudly, exactly like the env override below.
      if (options.binarySource !== "bundled") throw error;
      bundleMissing = configured;
    }
  }

  const override = env[POLYTH_OPENCODE_BIN_ENV]?.trim();
  if (override) {
    try {
      return {
        executablePath: await resolveExecutable(override, env),
        binarySource: "override",
        binaryOverrideEnv: POLYTH_OPENCODE_BIN_ENV,
      };
    } catch (error) {
      throw unavailable(
        `${POLYTH_OPENCODE_BIN_ENV} points to a missing or non-executable OpenCode binary: ${override}`,
        error,
      );
    }
  }

  // A configured *path* stays exact; a configured *name* is discovered like
  // the default one, so `bin: "opencode"` behaves the same as no setting.
  if (!bundleMissing && configured && (configured.includes("/") || configured.includes("\\"))) {
    return {
      executablePath: await resolveExecutable(configured, env),
      binarySource: options.binarySource ?? "configured",
    };
  }

  const binary = bundleMissing ? "opencode" : configured || "opencode";
  const report = await discoverOpenCodeBinary(binary, discovery);
  if (!report.hit) {
    const error = notFoundError(binary, report);
    if (!bundleMissing) throw error;
    throw Object.assign(
      unavailable(
        `bundled OpenCode is missing at ${bundleMissing} and no installed OpenCode could be`
        + ` used instead. ${error.message}`,
        error,
      ),
      { binary, searched: report.searched },
    );
  }
  return {
    executablePath: report.hit.executablePath,
    binarySource: bundleMissing
      ? report.hit.stage
      : configured
        ? options.binarySource ?? "configured"
        : report.hit.stage,
    ...(bundleMissing
      ? {
        diagnostic:
          `bundled OpenCode is missing at ${bundleMissing}; falling back to the`
          + ` OpenCode found at ${report.hit.executablePath}`,
      }
      : {}),
  };
};

const digestFile = async (file: string): Promise<string> => {
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest("hex");
  } catch (error) {
    throw unavailable(`could not hash the OpenCode binary at ${file}`, error);
  }
};

interface EngineInspectCacheEntry {
  ino: number;
  mtimeMs: number;
  size: number;
  pending: Promise<OpenCodeEngineIdentity>;
}

const engineInspectCache = new Map<string, EngineInspectCacheEntry>();

const isolatedProbeEnv = (dbPath: string): NodeJS.ProcessEnv => ({
  ...process.env,
  OPENCODE_DB: dbPath,
  [OPENCODE_UPDATE_DISABLE_ENV]: "true",
});

const lastNonEmptyLine = (text: string): string =>
  text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";

const inspectOpenCodeEngineUncached = async (
  executable: string,
): Promise<OpenCodeEngineIdentity> => {
  const versionDirectory = await mkdtemp(join(tmpdir(), "polyth-opencode-db-probe-"));
  const dbDirectory = await mkdtemp(join(tmpdir(), "polyth-opencode-db-probe-"));
  const versionDb = join(versionDirectory, "probe.db");
  const expectedDb = join(dbDirectory, "probe.db");
  try {
    const versionProbe = async (): Promise<string> => {
      try {
        const result = await execute(executable, ["--version"], {
          env: isolatedProbeEnv(versionDb),
          timeout: 10_000,
        });
        const version = lastNonEmptyLine(result.stdout);
        if (!version) throw unavailable(`OpenCode at ${executable} returned an empty version`);
        return version;
      } catch (error) {
        if ((error as { code?: string }).code === "unavailable") throw error;
        throw unavailable(`could not read the OpenCode version from ${executable}`, error);
      }
    };
    const versionPromise = versionProbe();
    const dbProbe = async (): Promise<void> => {
      try {
        const result = await execute(executable, ["db", "path"], {
          env: isolatedProbeEnv(expectedDb),
          timeout: 10_000,
        });
        const actualDb = lastNonEmptyLine(result.stdout);
        if (!actualDb || resolve(actualDb) !== resolve(expectedDb)) {
          const version = await versionPromise.catch(() => "unknown");
          throw unavailable(
            `OpenCode ${version} does not honor OPENCODE_DB; expected ${expectedDb}, got ${actualDb || "no path"}. `
            + "Polyth refuses to start an owned runtime because its global OpenCode DB would not be isolated.",
          );
        }
      } catch (error) {
        if ((error as { code?: string }).code === "unavailable") throw error;
        const version = await versionPromise.catch(() => "unknown");
        throw unavailable(
          `could not verify OPENCODE_DB support in OpenCode ${version}; Polyth refuses to use the global OpenCode DB`,
          error,
        );
      }
    };

    const [version, binaryDigest] = await Promise.all([
      versionPromise,
      dbProbe().then(() => undefined),
      digestFile(executable),
    ]).then(([probedVersion, , digest]) => [probedVersion, digest] as const);

    return {
      engine: "opencode",
      version,
      binaryDigest,
      protocolGeneration: OPENCODE_PROTOCOL_GENERATION,
    };
  } finally {
    await Promise.all([
      rm(versionDirectory, { recursive: true, force: true }).catch(() => {}),
      rm(dbDirectory, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
};

/** Resolve the exact executable, hash its bytes, and prove this OpenCode build
 * honors OPENCODE_DB before any owned worker is allowed to start. Unchanged
 * binaries (realpath + inode/mtime/size) reuse the in-flight or completed
 * probe so project fan-out and restarts do not relaunch the 100MB+ CLI. */
export const inspectOpenCodeEngine = async (
  bin = "opencode",
): Promise<OpenCodeEngineIdentity> => {
  const executable = await resolveExecutable(bin);
  const info = await stat(executable);
  const cached = engineInspectCache.get(executable);
  if (
    cached
    && cached.ino === info.ino
    && cached.mtimeMs === info.mtimeMs
    && cached.size === info.size
  ) {
    return { ...await cached.pending };
  }
  const pending = inspectOpenCodeEngineUncached(executable).catch((error) => {
    if (engineInspectCache.get(executable)?.pending === pending) {
      engineInspectCache.delete(executable);
    }
    throw error;
  });
  engineInspectCache.set(executable, {
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    size: info.size,
    pending,
  });
  return { ...await pending };
};

export const OPENCODE_BINARY_DIGEST_RE = /^[a-f0-9]{64}$/;
export const OPENCODE_STORAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shared `runtime.json` contract for owned local and owned SSH storage. */
export const parseOpenCodeRuntimeMetadata = (
  raw: string,
): OpenCodeRuntimeMetadata | undefined => {
  try {
    const value = JSON.parse(raw) as Partial<OpenCodeRuntimeMetadata>;
    const location = value.runtimeLocation;
    if (
      value.engine !== "opencode"
      || typeof value.version !== "string"
      || !value.version
      || typeof value.binaryDigest !== "string"
      || !OPENCODE_BINARY_DIGEST_RE.test(value.binaryDigest)
      || !Number.isSafeInteger(value.protocolGeneration)
      || (value.protocolGeneration ?? 0) <= 0
      || typeof value.storageId !== "string"
      || !OPENCODE_STORAGE_ID_RE.test(value.storageId)
      || (
        value.binarySource !== undefined
        && !(OPEN_CODE_BINARY_SOURCES as readonly string[]).includes(value.binarySource)
      )
      || (value.binaryPath !== undefined && (
        typeof value.binaryPath !== "string"
        || !isAbsolute(value.binaryPath)
      ))
      || (
        value.binaryOverrideEnv !== undefined
        && value.binaryOverrideEnv !== POLYTH_OPENCODE_BIN_ENV
      )
      || typeof value.runtimeAuthority !== "string"
      || !value.runtimeAuthority
      || !location
      || typeof location.projectId !== "string"
      || !location.projectId
      || typeof location.cwd !== "string"
      || !location.cwd
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.lastOpenedAt !== "string"
      || !Number.isFinite(Date.parse(value.lastOpenedAt))
    ) {
      return undefined;
    }
    return value as OpenCodeRuntimeMetadata;
  } catch {
    return undefined;
  }
};

export const openCodeEnginesMatch = (
  left: OpenCodeEngineIdentity,
  right: OpenCodeEngineIdentity,
): boolean =>
  left.engine === right.engine
  && left.binaryDigest === right.binaryDigest
  && left.protocolGeneration === right.protocolGeneration;

/** Digest is the safety identity. Version strings are diagnostic only and
 * may stay equal across incompatible binaries. */
export const formatEngineRolloverDiagnostic = (
  location: string,
  previous: OpenCodeEngineIdentity,
  selected: OpenCodeEngineIdentity,
): string => {
  const prefix = (digest: string) => digest.slice(0, 12);
  return (
    `runtime.engine.rollover ${location}: the previous writable runtime DB was quarantined without being opened. `
    + `previous version=${previous.version} digest=${prefix(previous.binaryDigest)} `
    + `selected version=${selected.version} digest=${prefix(selected.binaryDigest)}. `
    + `Existing sessions need a new runtime epoch. `
    + `Pin an immutable binary with ${POLYTH_OPENCODE_BIN_ENV} when reproducibility matters.`
  );
};

const databaseNames = new Set(["opencode.db", "opencode.db-wal", "opencode.db-shm"]);

const existingDatabaseNames = async (runtimeDir: string): Promise<string[]> =>
  (await readdir(runtimeDir, { withFileTypes: true }))
    // Include non-regular entries so quarantine removes a tampered symlink or
    // directory at a recognized DB path instead of letting OpenCode follow it.
    .filter((entry) => databaseNames.has(entry.name))
    .map((entry) => entry.name);

const primaryDatabaseIsRegular = async (runtimeDir: string): Promise<boolean> => {
  try {
    const info = await lstat(join(runtimeDir, "opencode.db"));
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

const rotateDatabase = async (
  runtimeDir: string,
  reason: string,
  now: number,
): Promise<void> => {
  const names = await existingDatabaseNames(runtimeDir);
  if (names.length === 0) return;
  const quarantineRoot = join(runtimeDir, "quarantine");
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  await chmod(quarantineRoot, 0o700);
  const destination = join(quarantineRoot, `${now}-${reason}`);
  await mkdir(destination, { mode: 0o700 });
  await chmod(destination, 0o700);
  for (const name of names) await rename(join(runtimeDir, name), join(destination, name));
};

const atomicMetadataWrite = async (
  metadataFile: string,
  metadata: OpenCodeRuntimeMetadata,
): Promise<void> => {
  const temporary = `${metadataFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, metadataFile);
    await chmod(metadataFile, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

export const prepareOpenCodeRuntime = async (options: {
  runtimeDir: string;
  projectId: string;
  cwd: string;
  engineIdentity: OpenCodeEngineIdentity;
  binary: ResolvedOpenCodeBinary;
  now?: number;
}): Promise<PreparedOpenCodeRuntime> => {
  if (!options.runtimeDir.trim()) throw unavailable("owned OpenCode runtimeDir is required");
  if (!options.projectId.trim()) throw unavailable("owned OpenCode projectId is required");
  const runtimeDir = resolve(options.runtimeDir);
  const cwd = resolve(options.cwd);
  const metadataFile = join(runtimeDir, "runtime.json");
  const now = options.now ?? Date.now();
  try {
    const existing = await lstat(runtimeDir);
    if (existing.isSymbolicLink()) {
      throw unavailable(
        `owned OpenCode runtime directory is a symlink: ${runtimeDir}; refusing to follow it`,
      );
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "unavailable") throw error;
    if (!isMissing(error)) {
      throw unavailable(`could not inspect isolated OpenCode runtime directory ${runtimeDir}`, error);
    }
  }
  try {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw unavailable(`could not create isolated OpenCode runtime directory ${runtimeDir}`, error);
  }
  try {
    const created = await lstat(runtimeDir);
    if (created.isSymbolicLink()) {
      throw unavailable(
        `owned OpenCode runtime directory is a symlink: ${runtimeDir}; refusing to follow it`,
      );
    }
    await chmod(runtimeDir, 0o700);
  } catch (error) {
    if ((error as { code?: unknown }).code === "unavailable") throw error;
    throw unavailable(`could not create isolated OpenCode runtime directory ${runtimeDir}`, error);
  }

  let previous: OpenCodeRuntimeMetadata | undefined;
  let metadataExists = false;
  try {
    const metadataInfo = await lstat(metadataFile);
    metadataExists = true;
    if (metadataInfo.isSymbolicLink() || !metadataInfo.isFile()) {
      previous = undefined;
    } else {
      previous = parseOpenCodeRuntimeMetadata(await readFile(metadataFile, "utf8"));
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw unavailable(`could not read OpenCode runtime metadata ${metadataFile}`, error);
    }
  }

  const sameLocation = previous
    && previous.runtimeLocation.projectId === options.projectId
    && resolve(previous.runtimeLocation.cwd) === cwd;
  let databaseIsRegular: boolean;
  try {
    databaseIsRegular = await primaryDatabaseIsRegular(runtimeDir);
  } catch (error) {
    throw unavailable(`could not inspect isolated OpenCode DB in ${runtimeDir}`, error);
  }
  const engineCompatible = previous && sameLocation
    && openCodeEnginesMatch(previous, options.engineIdentity);
  const compatible = engineCompatible && databaseIsRegular;
  const diagnostic = previous && sameLocation
    ? !openCodeEnginesMatch(previous, options.engineIdentity)
      ? formatEngineRolloverDiagnostic(runtimeDir, previous, options.engineIdentity)
      : !databaseIsRegular
        ? `OpenCode runtime storage was missing or unsafe for ${runtimeDir}; recognized DB paths were quarantined without being opened. `
          + "Existing sessions will require a new runtime epoch."
        : undefined
    : undefined;
  if (!compatible) {
    const reason = metadataExists
      ? previous
        ? engineCompatible
          ? "missing-or-unsafe-database"
          : "incompatible-engine"
        : "invalid-metadata"
      : "missing-metadata";
    try {
      await rotateDatabase(runtimeDir, reason, now);
    } catch (error) {
      throw unavailable(`could not quarantine incompatible OpenCode DB in ${runtimeDir}`, error);
    }
  }

  const createdAt = compatible && previous
    ? previous.createdAt
    : new Date(now).toISOString();
  const storageId = compatible && previous
    ? previous.storageId
    : randomUUID();
  return {
    runtimeDir,
    dbPath: join(runtimeDir, "opencode.db"),
    storageId,
    engineIdentity: { ...options.engineIdentity },
    binary: { ...options.binary },
    ...(diagnostic ? { diagnostic } : {}),
    async recordOpen(incarnation) {
      const openedAt = new Date().toISOString();
      const metadata: OpenCodeRuntimeMetadata = {
        ...options.engineIdentity,
        storageId,
        binarySource: options.binary.binarySource,
        binaryPath: options.binary.executablePath,
        ...(options.binary.binaryOverrideEnv
          ? { binaryOverrideEnv: options.binary.binaryOverrideEnv }
          : {}),
        runtimeAuthority: incarnation.authorityId,
        runtimeLocation: { projectId: options.projectId, cwd },
        createdAt,
        lastOpenedAt: openedAt,
      };
      try {
        await atomicMetadataWrite(metadataFile, metadata);
      } catch (error) {
        throw unavailable(`could not persist OpenCode runtime metadata ${metadataFile}`, error);
      }
    },
    async secureDatabaseFiles() {
      for (const name of await existingDatabaseNames(runtimeDir)) {
        const databaseFile = join(runtimeDir, name);
        try {
          const info = await lstat(databaseFile);
          if (!info.isFile() || info.isSymbolicLink()) {
            throw unavailable(`OpenCode database path is not a regular file: ${databaseFile}`);
          }
          await chmod(databaseFile, 0o600);
        } catch (error) {
          if ((error as { code?: unknown }).code === "unavailable") throw error;
          throw unavailable(`could not secure OpenCode database file ${databaseFile}`, error);
        }
      }
    },
  };
};

const pathMissing = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return isMissing(error);
  }
};

const quarantineTimestamp = async (path: string, name: string): Promise<number> => {
  const fromName = Number(name.split("-", 1)[0]);
  if (Number.isFinite(fromName) && fromName > 0) return fromName;
  return (await stat(path)).mtimeMs;
};

export const sweepOpenCodeRuntimes = async (
  runtimesRoot: string,
  options: {
    now?: number;
    staleRuntimeTtlMs?: number;
    quarantineTtlMs?: number;
  } = {},
): Promise<{ runtimesRemoved: number; quarantinesRemoved: number }> => {
  const root = resolve(runtimesRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const now = options.now ?? Date.now();
  const staleRuntimeTtlMs = options.staleRuntimeTtlMs ?? OPEN_CODE_RUNTIME_STALE_TTL_MS;
  const quarantineTtlMs = options.quarantineTtlMs ?? OPEN_CODE_QUARANTINE_TTL_MS;
  let runtimesRemoved = 0;
  let quarantinesRemoved = 0;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const runtimeDir = join(root, entry.name);
    const runtimeStat = await lstat(runtimeDir);
    if (runtimeStat.isSymbolicLink()) continue;
    let metadata: OpenCodeRuntimeMetadata | undefined;
    try {
      metadata = parseOpenCodeRuntimeMetadata(await readFile(join(runtimeDir, "runtime.json"), "utf8"));
    } catch (error) {
      if (!isMissing(error)) continue;
    }
    if (
      metadata
      && now - Date.parse(metadata.lastOpenedAt) > staleRuntimeTtlMs
      && await pathMissing(metadata.runtimeLocation.cwd)
    ) {
      await rm(runtimeDir, { recursive: true, force: true });
      runtimesRemoved += 1;
      continue;
    }

    const quarantineRoot = join(runtimeDir, "quarantine");
    let quarantines;
    try {
      quarantines = await readdir(quarantineRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const quarantine of quarantines) {
      if (!quarantine.isDirectory() || quarantine.isSymbolicLink()) continue;
      const quarantinePath = join(quarantineRoot, quarantine.name);
      if (now - await quarantineTimestamp(quarantinePath, quarantine.name) <= quarantineTtlMs) {
        continue;
      }
      await rm(quarantinePath, { recursive: true, force: true });
      quarantinesRemoved += 1;
    }
  }
  return { runtimesRemoved, quarantinesRemoved };
};
