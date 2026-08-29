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

export type OpenCodeBinarySource = "bundled" | "override" | "configured" | "path";

export interface ResolvedOpenCodeBinary {
  executablePath: string;
  binarySource: OpenCodeBinarySource;
  binaryOverrideEnv?: typeof POLYTH_OPENCODE_BIN_ENV;
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

export const resolveOpenCodeBinary = async (options: {
  bin?: string;
  binarySource?: Extract<OpenCodeBinarySource, "bundled" | "configured">;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ResolvedOpenCodeBinary> => {
  const env = options.env ?? process.env;
  const configured = options.bin?.trim();
  if (options.binarySource === "bundled" && (!configured || !isAbsolute(configured))) {
    throw unavailable("bundled OpenCode binary must be provided as an absolute path");
  }

  // Desktop supplies a trusted absolute resources path. It must not be
  // shadowed by a developer's ambient override.
  if (configured && isAbsolute(configured)) {
    return {
      executablePath: await resolveExecutable(configured, env),
      binarySource: options.binarySource ?? "configured",
    };
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

  if (configured) {
    return {
      executablePath: await resolveExecutable(configured, env),
      binarySource: options.binarySource ?? "configured",
    };
  }
  return {
    executablePath: await resolveExecutable("opencode", env),
    binarySource: "path",
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

/** Resolve the exact executable, hash its bytes, and prove this OpenCode build
 * honors OPENCODE_DB before any owned worker is allowed to start. */
export const inspectOpenCodeEngine = async (
  bin = "opencode",
): Promise<OpenCodeEngineIdentity> => {
  const executable = await resolveExecutable(bin);
  const probeDirectory = await mkdtemp(join(tmpdir(), "polyth-opencode-db-probe-"));
  const expectedDb = join(probeDirectory, "probe.db");
  let version: string;
  try {
    try {
      const result = await execute(executable, ["--version"], {
        env: {
          ...process.env,
          OPENCODE_DB: expectedDb,
          [OPENCODE_UPDATE_DISABLE_ENV]: "true",
        },
        timeout: 10_000,
      });
      version = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
    } catch (error) {
      throw unavailable(`could not read the OpenCode version from ${executable}`, error);
    }
    if (!version) throw unavailable(`OpenCode at ${executable} returned an empty version`);

    try {
      const result = await execute(executable, ["db", "path"], {
        env: {
          ...process.env,
          OPENCODE_DB: expectedDb,
          [OPENCODE_UPDATE_DISABLE_ENV]: "true",
        },
        timeout: 10_000,
      });
      const actualDb = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
      if (!actualDb || resolve(actualDb) !== resolve(expectedDb)) {
        throw unavailable(
          `OpenCode ${version} does not honor OPENCODE_DB; expected ${expectedDb}, got ${actualDb || "no path"}. `
          + "Polyth refuses to start an owned runtime because its global OpenCode DB would not be isolated.",
        );
      }
    } catch (error) {
      if ((error as { code?: string }).code === "unavailable") throw error;
      throw unavailable(
        `could not verify OPENCODE_DB support in OpenCode ${version}; Polyth refuses to use the global OpenCode DB`,
        error,
      );
    }
  } finally {
    await rm(probeDirectory, { recursive: true, force: true }).catch(() => {});
  }

  return {
    engine: "opencode",
    version,
    binaryDigest: await digestFile(executable),
    protocolGeneration: OPENCODE_PROTOCOL_GENERATION,
  };
};

const runtimeMetadata = (raw: string): OpenCodeRuntimeMetadata | undefined => {
  try {
    const value = JSON.parse(raw) as Partial<OpenCodeRuntimeMetadata>;
    const location = value.runtimeLocation;
    if (
      value.engine !== "opencode"
      || typeof value.version !== "string"
      || !value.version
      || typeof value.binaryDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(value.binaryDigest)
      || !Number.isSafeInteger(value.protocolGeneration)
      || (value.protocolGeneration ?? 0) <= 0
      || typeof value.storageId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.storageId)
      || (
        value.binarySource !== undefined
        && !["bundled", "override", "configured", "path"].includes(value.binarySource)
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

const sameEngine = (
  metadata: OpenCodeRuntimeMetadata,
  identity: OpenCodeEngineIdentity,
): boolean =>
  metadata.engine === identity.engine
  && metadata.version === identity.version
  && metadata.binaryDigest === identity.binaryDigest
  && metadata.protocolGeneration === identity.protocolGeneration;

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
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(runtimeDir, 0o700);
  } catch (error) {
    throw unavailable(`could not create isolated OpenCode runtime directory ${runtimeDir}`, error);
  }

  let previous: OpenCodeRuntimeMetadata | undefined;
  let metadataExists = false;
  try {
    previous = runtimeMetadata(await readFile(metadataFile, "utf8"));
    metadataExists = true;
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
    && sameEngine(previous, options.engineIdentity);
  const compatible = engineCompatible && databaseIsRegular;
  const diagnostic = previous && sameLocation
    ? !sameEngine(previous, options.engineIdentity)
      ? `OpenCode engine identity changed for ${runtimeDir}; the previous writable runtime DB was quarantined without being opened. `
        + `Previous engine: version ${previous.version}, digest ${previous.binaryDigest}. `
        + `Selected engine: version ${options.engineIdentity.version}, digest ${options.engineIdentity.binaryDigest}. `
        + `Existing sessions will require a new runtime epoch. For development, set ${POLYTH_OPENCODE_BIN_ENV} to pin the intended binary.`
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
      metadata = runtimeMetadata(await readFile(join(runtimeDir, "runtime.json"), "utf8"));
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
