// One scoped offline draft record. Text, marker provenance, and pending
// attachment metadata are updated through this module so they cannot drift
// into competing local stores.
import type { AttachmentRef } from "@polyth/contracts";
import { hydrateClientRecord, readClientRecord, removeClientRecord, writeClientRecord, type PersistenceScope } from "./clientPersistence.ts";
import { clientPersistenceScope } from "./reliabilityContext.ts";

export interface ScopedDraftRecord {
  v: 1;
  revision: number;
  updatedAt: number;
  text: string;
  /** Local edits remain authoritative until their exact server acknowledgement. */
  dirty?: boolean;
  /** Authoritative projection timestamp last incorporated locally. */
  serverUpdatedAt?: number;
  /** A newer or unordered server value is retained alongside a dirty draft. */
  conflict?: { text: string; serverUpdatedAt?: number };
  seed?: { key: string; seedText: string };
  attachments: AttachmentRef[];
  /** Native-owned staged files are metadata only. Their paths never become
   * AttachmentRefs or server payloads; upload admission owns that boundary. */
  nativeStaged?: NativeStagedAttachment[];
}

export interface NativeStagedAttachment {
  id: string;
  stagingPath: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  destination: string;
}

const MAX_NATIVE_STAGED = 16;
const MAX_SERVER_STAMPS = 64;

const KIND = "draft-record";
const empty = (): ScopedDraftRecord => ({ v: 1, revision: 0, updatedAt: 0, text: "", attachments: [] });
const serverStampCache = new Map<string, number>();

function scope(sessionId: string | null | undefined, capturedScope?: PersistenceScope): PersistenceScope {
  return capturedScope ?? clientPersistenceScope(sessionId ? { sessionId } : {});
}

export const scopedDraftCacheKey = (sessionId: string | null | undefined, capturedScope?: PersistenceScope): string => JSON.stringify(scope(sessionId, capturedScope));

function rememberServerStamp(key: string, stamp: number): void {
  serverStampCache.delete(key);
  serverStampCache.set(key, stamp);
  while (serverStampCache.size > MAX_SERVER_STAMPS) {
    serverStampCache.delete(serverStampCache.keys().next().value!);
  }
}

function parseRecord(raw: string | null): ScopedDraftRecord {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<ScopedDraftRecord> | null;
    if (value?.v !== 1 || typeof value.text !== "string" || !Array.isArray(value.attachments)
      || !Number.isSafeInteger(value.revision) || typeof value.updatedAt !== "number") return empty();
    return {
      v: 1, text: value.text, attachments: value.attachments as AttachmentRef[],
      revision: value.revision as number, updatedAt: value.updatedAt,
      ...(value.seed && typeof value.seed.key === "string" && typeof value.seed.seedText === "string" ? { seed: value.seed } : {}),
      ...(Array.isArray(value.nativeStaged)
        ? { nativeStaged: value.nativeStaged.filter(validNativeStaged).slice(-MAX_NATIVE_STAGED) }
        : {}),
      ...(value.dirty === true ? { dirty: true } : {}),
      ...(typeof value.serverUpdatedAt === "number" && value.serverUpdatedAt >= 0 ? { serverUpdatedAt: value.serverUpdatedAt } : {}),
      ...(value.conflict && typeof value.conflict === "object"
        && typeof (value.conflict as { text?: unknown }).text === "string"
        ? { conflict: {
          text: (value.conflict as { text: string }).text,
          ...((value.conflict as { serverUpdatedAt?: unknown }).serverUpdatedAt !== undefined
            && typeof (value.conflict as { serverUpdatedAt?: unknown }).serverUpdatedAt === "number"
            ? { serverUpdatedAt: (value.conflict as { serverUpdatedAt: number }).serverUpdatedAt }
            : {}),
        } }
        : {}),
    };
  } catch {
    return empty();
  }
}

export function loadScopedDraftRecord(sessionId: string | null | undefined, capturedScope?: PersistenceScope): ScopedDraftRecord {
  const targetScope = scope(sessionId, capturedScope);
  const record = parseRecord(readClientRecord(KIND, targetScope));
  const cachedStamp = serverStampCache.get(scopedDraftCacheKey(sessionId, targetScope));
  return record.serverUpdatedAt === undefined && cachedStamp !== undefined
    ? { ...record, serverUpdatedAt: cachedStamp }
    : record;
}

export function updateScopedDraftRecord(
  sessionId: string | null | undefined,
  patch: Partial<Pick<ScopedDraftRecord, "text" | "seed" | "attachments" | "nativeStaged" | "dirty" | "serverUpdatedAt" | "conflict">>,
  capturedScope?: PersistenceScope,
): ScopedDraftRecord {
  const targetScope = scope(sessionId, capturedScope);
  const current = loadScopedDraftRecord(sessionId, targetScope);
  const next: ScopedDraftRecord = {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updatedAt: Date.now(),
  };
  const key = scopedDraftCacheKey(sessionId, targetScope);
  if (next.serverUpdatedAt !== undefined) rememberServerStamp(key, next.serverUpdatedAt);
  // A clean empty server draft needs only a small in-memory CAS stamp while
  // mounted. Persisting one tombstone per visited session would eventually
  // exhaust the bounded mobile metadata store.
  if (!next.text && !next.seed && next.attachments.length === 0 && !(next.nativeStaged?.length) && !next.dirty && !next.conflict) {
    removeClientRecord(KIND, targetScope);
    return next;
  }
  writeClientRecord(KIND, targetScope, JSON.stringify(next));
  return next;
}

const safeName = (name: string): string =>
  (name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "attachment");

const validNativeStaged = (value: unknown): value is NativeStagedAttachment => {
  const item = value as Partial<NativeStagedAttachment> | null;
  return !!item && typeof item.id === "string" && UUID.test(item.id) && typeof item.stagingPath === "string"
    && typeof item.name === "string" && typeof item.mimeType === "string"
    && Number.isSafeInteger(item.size) && (item.size as number) >= 0
    && Number.isSafeInteger(item.lastModified) && (item.lastModified as number) >= 0
    && typeof item.destination === "string";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Register a native-staged file in the same authoritative scoped draft.
 * Its deterministic destination is stable across a renderer restart. */
export function registerNativeStagedAttachment(
  sessionId: string | null | undefined,
  input: Omit<NativeStagedAttachment, "destination">,
): NativeStagedAttachment {
  if (!UUID.test(input.id)) throw new Error("native staged attachment id must be a UUID");
  const staged: NativeStagedAttachment = {
    ...input,
    destination: `_inbox/${input.id}-${safeName(input.name)}`,
  };
  const current = loadScopedDraftRecord(sessionId).nativeStaged ?? [];
  const withoutSame = current.filter((item) => item.id !== staged.id);
  if (withoutSame.length >= MAX_NATIVE_STAGED) {
    throw new Error(`Keep at most ${MAX_NATIVE_STAGED} staged mobile attachments in one draft.`);
  }
  updateScopedDraftRecord(sessionId, { nativeStaged: [...withoutSame, staged] });
  return staged;
}

export function nativeStagedAttachments(sessionId: string | null | undefined): NativeStagedAttachment[] {
  return [...(loadScopedDraftRecord(sessionId).nativeStaged ?? [])];
}

export function removeNativeStagedAttachment(sessionId: string | null | undefined, id: string): void {
  const current = loadScopedDraftRecord(sessionId).nativeStaged ?? [];
  updateScopedDraftRecord(sessionId, { nativeStaged: current.filter((item) => item.id !== id) });
}

/** Record a user edit and return the revision a server acknowledgement must
 * match. Local edits never overwrite attachment/seed provenance. */
export function recordLocalDraftEdit(sessionId: string, text: string, capturedScope?: PersistenceScope): ScopedDraftRecord {
  return updateScopedDraftRecord(sessionId, { text, dirty: true, conflict: undefined }, capturedScope);
}

/** Incorporate a projection draft only when it cannot clobber local typing.
 * Any differing server value while dirty is preserved as a bounded sibling
 * payload for the composer to resolve; there is no implicit last-writer win. */
export function adoptServerDraft(
  sessionId: string,
  text: string,
  serverUpdatedAt?: number,
): ScopedDraftRecord {
  const current = loadScopedDraftRecord(sessionId);
  if (current.dirty) {
    if (text !== current.text) {
      return updateScopedDraftRecord(sessionId, {
        conflict: { text, ...(serverUpdatedAt !== undefined ? { serverUpdatedAt } : {}) },
      });
    }
    // An exact canonical projection is an acknowledgement of these bytes,
    // even if an earlier PATCH response was lost.
    if (serverUpdatedAt !== undefined) {
      return updateScopedDraftRecord(sessionId, {
        dirty: false,
        serverUpdatedAt,
        conflict: undefined,
      });
    }
    return current;
  }
  if (serverUpdatedAt !== undefined && current.serverUpdatedAt !== undefined && serverUpdatedAt < current.serverUpdatedAt) {
    return current;
  }
  if (text !== current.text && current.updatedAt > 0 && serverUpdatedAt === undefined) {
    return updateScopedDraftRecord(sessionId, { conflict: { text } });
  }
  if (text !== current.text && serverUpdatedAt !== undefined && current.serverUpdatedAt === serverUpdatedAt) {
    return updateScopedDraftRecord(sessionId, { conflict: { text, serverUpdatedAt } });
  }
  if (text !== current.text && current.updatedAt > 0 && (
    serverUpdatedAt === undefined
    || (current.serverUpdatedAt !== undefined && serverUpdatedAt === current.serverUpdatedAt)
  )) {
    return updateScopedDraftRecord(sessionId, {
      conflict: { text, ...(serverUpdatedAt !== undefined ? { serverUpdatedAt } : {}) },
    });
  }
  return updateScopedDraftRecord(sessionId, {
    text,
    dirty: false,
    ...(serverUpdatedAt !== undefined ? { serverUpdatedAt } : {}),
    conflict: undefined,
  });
}

/** Clear dirty only for the exact revision sent to the server. A stale ACK
 * after another keystroke cannot falsely mark newer local text durable. */
export function acknowledgeDraftRevision(
  sessionId: string,
  revision: number,
  serverUpdatedAt: number,
  capturedScope?: PersistenceScope,
): ScopedDraftRecord {
  const current = loadScopedDraftRecord(sessionId, capturedScope);
  if (current.revision !== revision || !current.dirty) return current;
  return updateScopedDraftRecord(sessionId, { dirty: false, serverUpdatedAt, conflict: undefined }, capturedScope);
}

export async function hydrateScopedDraftRecord(sessionId: string | null | undefined, capturedScope?: PersistenceScope): Promise<ScopedDraftRecord> {
  const target = scope(sessionId, capturedScope);
  return parseRecord(await hydrateClientRecord(KIND, target));
}
