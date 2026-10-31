import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface OwnedRuntimeStateV1 {
  version: 1;
  authorityId: string;
  generation: number;
}

interface OwnedRuntimeState {
  version: 2;
  identityKey: string;
  authorityId: string;
  generation: number;
}

export interface OwnedRuntimeIncarnation {
  authorityId: string;
  generation: number;
}

export interface DurableOwnedRuntimeState {
  nextIncarnation(): Promise<OwnedRuntimeIncarnation>;
}

const unavailable = (message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "unavailable",
  });

export const ownedRuntimeIdentityKey = (identity: unknown): string =>
  createHash("sha256").update(JSON.stringify(identity)).digest("hex");

const parseOwnedRuntimeState = (
  raw: string,
): OwnedRuntimeState | OwnedRuntimeStateV1 | undefined => {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value !== "object"
      || value === null
      || typeof value.authorityId !== "string"
      || !value.authorityId
      || !Number.isSafeInteger(value.generation)
      || (value.generation as number) < 0
    ) {
      return undefined;
    }
    if (value.version === 1) {
      return {
        version: 1,
        authorityId: value.authorityId,
        generation: value.generation as number,
      };
    }
    if (value.version !== 2 || typeof value.identityKey !== "string" || !value.identityKey) {
      return undefined;
    }
    return {
      version: 2,
      identityKey: value.identityKey,
      authorityId: value.authorityId,
      generation: value.generation as number,
    };
  } catch {
    return undefined;
  }
};

interface OwnedRuntimeStateRow {
  identity_key: string;
  authority_id: string;
  generation: number;
}

const readLegacyState = async (
  stateFile: string,
): Promise<OwnedRuntimeState | OwnedRuntimeStateV1 | undefined> => {
  try {
    const persisted = parseOwnedRuntimeState(await readFile(stateFile, "utf8"));
    if (!persisted) throw unavailable(`owned runtime state is invalid: ${stateFile}`);
    return persisted;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const firstLegacyState = async (
  stateFiles: readonly string[],
): Promise<{
  state: OwnedRuntimeState | OwnedRuntimeStateV1;
  sourceFile: string;
} | undefined> => {
  for (const sourceFile of stateFiles) {
    const state = await readLegacyState(sourceFile);
    if (state) return { state, sourceFile };
  }
  return undefined;
};

const nextDurableIncarnation = async (
  stateFile: string,
  identityKey: string,
  configuredAuthorityId?: string,
  legacyStateFiles: readonly string[] = [],
): Promise<OwnedRuntimeIncarnation> => {
  if (!identityKey) throw unavailable("owned runtime identity is required");
  if (configuredAuthorityId !== undefined && !configuredAuthorityId) {
    throw unavailable("configured owned runtime authority is invalid");
  }
  await mkdir(dirname(stateFile), { recursive: true });
  const databaseFile = `${stateFile}.state.db`;
  let database: DatabaseSync | undefined;
  let transactionOpen = false;
  let migratedFile: string | undefined;
  try {
    database = new DatabaseSync(databaseFile);
    database.exec(`
      PRAGMA busy_timeout = 10000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS owned_runtime_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        identity_key TEXT NOT NULL,
        authority_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0)
      );
      BEGIN IMMEDIATE;
    `);
    transactionOpen = true;
    const row = database.prepare(
      `SELECT identity_key, authority_id, generation
       FROM owned_runtime_state WHERE singleton = 1`,
    ).get() as unknown as OwnedRuntimeStateRow | undefined;
    const migration = row
      ? undefined
      : await firstLegacyState([stateFile, ...legacyStateFiles]);
    const persisted = row
      ? {
          version: 2 as const,
          identityKey: row.identity_key,
          authorityId: row.authority_id,
          generation: row.generation,
        }
      : migration?.state;
    migratedFile = migration?.sourceFile;
    let current: OwnedRuntimeState;
    if (persisted?.version === 2 && persisted.identityKey === identityKey) {
      if (
        configuredAuthorityId
        && persisted.authorityId !== configuredAuthorityId
      ) {
        throw unavailable("configured owned runtime authority conflicts with durable state");
      }
      current = persisted;
    } else if (persisted?.version === 1) {
      // V1 never recorded the runtime identity. Reusing its authority would
      // let a newly isolated DB satisfy verified-continuity rebinds for the
      // old, potentially shared DB. The absence of identity proof requires a
      // cold authority, not a format-only migration.
      if (configuredAuthorityId) {
        throw unavailable(
          "configured owned runtime authority cannot be verified against legacy state",
        );
      }
      current = {
        version: 2,
        identityKey,
        authorityId: `owned:${randomUUID()}`,
        generation: 0,
      };
    } else {
      const authorityId = configuredAuthorityId ?? `owned:${randomUUID()}`;
      current = {
        version: 2,
        identityKey,
        authorityId,
        generation: persisted?.authorityId === authorityId
          ? persisted.generation
          : 0,
      };
    }
    if (current.generation >= Number.MAX_SAFE_INTEGER) {
      throw unavailable("owned runtime generation is exhausted");
    }
    const next = { ...current, generation: current.generation + 1 };
    database.prepare(`
      INSERT INTO owned_runtime_state (
        singleton, identity_key, authority_id, generation
      ) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        identity_key = excluded.identity_key,
        authority_id = excluded.authority_id,
        generation = excluded.generation
    `).run(next.identityKey, next.authorityId, next.generation);
    database.exec("COMMIT");
    transactionOpen = false;
    const incarnation = {
      authorityId: next.authorityId,
      generation: next.generation,
    };
    database.close();
    database = undefined;
    if (migratedFile) await rm(migratedFile, { force: true }).catch(() => {});
    return incarnation;
  } catch (error) {
    if (transactionOpen) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // The database already rolled the transaction back.
      }
    }
    try {
      database?.close();
    } catch {
      // Preserve the allocation failure.
    }
    if ((error as { code?: string }).code === "unavailable") throw error;
    throw unavailable(`failed to allocate owned runtime generation in ${databaseFile}`, error);
  }
};

export const createDurableOwnedRuntimeState = (
  stateFile: string,
  identityKey: string,
  configuredAuthorityId?: string,
  legacyStateFiles: readonly string[] = [],
): DurableOwnedRuntimeState => ({
  nextIncarnation: () =>
    nextDurableIncarnation(
      stateFile,
      identityKey,
      configuredAuthorityId,
      legacyStateFiles,
    ),
});
