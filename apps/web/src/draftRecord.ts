// One scoped offline draft record. Text, marker provenance, and pending
// attachment metadata are updated through this module so they cannot drift
// into competing local stores.
import type { AttachmentRef } from "@polyth/contracts";
import { hydrateClientRecord, readClientRecord, removeClientRecord, writeClientRecord, type PersistenceScope } from "./clientPersistence.ts";
import { clientPersistenceScope } from "./reliabilityContext.ts";
import { activeDraftLanePurpose, newSessionLaneDraftId } from "./workbench/lanes.ts";

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
  /** Recent unsent new-chat drafts shelved by an explicit New Chat action. */
  previousNewSessionDrafts?: RecoverableNewSessionDraft[];
}

export interface RecoverableNewSessionDraft {
  text: string;
  attachments: AttachmentRef[];
  nativeStaged?: NativeStagedAttachment[];
  title?: string;
  worktreePath?: string;
  repositoryIds?: string[];
  isolate?: boolean;
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
export const MAX_PREVIOUS_NEW_SESSION_DRAFTS = 3;
const MAX_SERVER_STAMPS = 64;

const KIND = "draft-record";
const empty = (): ScopedDraftRecord => ({ v: 1, revision: 0, updatedAt: 0, text: "", attachments: [] });
const serverStampCache = new Map<string, number>();
// A projection may arrive before the PATCH response. Keep the bytes of our
// outstanding writes so their echo is not mistaken for another client's edit
// when the user has already continued typing.
const outboundDraftTexts = new Map<string, Set<string>>();
const MAX_OUTBOUND_SCOPES = 64;
const MAX_OUTBOUND_TEXTS = 4;

function scope(sessionId: string | null | undefined, capturedScope?: PersistenceScope): PersistenceScope {
  if (capturedScope) return capturedScope;
  if (sessionId) return clientPersistenceScope({ sessionId });
  const laneId = newSessionLaneDraftId(activeDraftLanePurpose());
  return clientPersistenceScope(laneId ? { sessionId: laneId } : {});
}

export const scopedDraftCacheKey = (sessionId: string | null | undefined, capturedScope?: PersistenceScope): string => JSON.stringify(scope(sessionId, capturedScope));

/** Retain an uncertain write until its projection is observed. A successful
 * response or a definitive CAS rejection can release it immediately. */
export function trackOutboundDraftWrite(
  sessionId: string,
  text: string,
  capturedScope: PersistenceScope,
): (definitive: boolean) => void {
  const key = scopedDraftCacheKey(sessionId, capturedScope);
  const texts = outboundDraftTexts.get(key) ?? new Set<string>();
  texts.delete(text);
  texts.add(text);
  while (texts.size > MAX_OUTBOUND_TEXTS) texts.delete(texts.values().next().value!);
  outboundDraftTexts.delete(key);
  outboundDraftTexts.set(key, texts);
  while (outboundDraftTexts.size > MAX_OUTBOUND_SCOPES) {
    outboundDraftTexts.delete(outboundDraftTexts.keys().next().value!);
  }
  return (definitive) => {
    if (!definitive) return;
    const current = outboundDraftTexts.get(key);
    current?.delete(text);
    if (current?.size === 0) outboundDraftTexts.delete(key);
  };
}

function consumeOutboundDraftEcho(sessionId: string, text: string): boolean {
  const key = scopedDraftCacheKey(sessionId);
  const texts = outboundDraftTexts.get(key);
  if (!texts?.delete(text)) return false;
  if (texts.size === 0) outboundDraftTexts.delete(key);
  return true;
}

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
      ...(Array.isArray(value.previousNewSessionDrafts)
        ? { previousNewSessionDrafts: value.previousNewSessionDrafts.filter((item): item is RecoverableNewSessionDraft =>
          !!item && typeof item.text === "string" && Array.isArray(item.attachments),
        ).slice(-MAX_PREVIOUS_NEW_SESSION_DRAFTS).map((item) => ({
          text: item.text,
          attachments: item.attachments,
          ...(Array.isArray(item.nativeStaged) ? { nativeStaged: item.nativeStaged.filter(validNativeStaged).slice(-MAX_NATIVE_STAGED) } : {}),
          ...(typeof item.title === "string" ? { title: item.title } : {}),
          ...(typeof item.worktreePath === "string" ? { worktreePath: item.worktreePath } : {}),
          ...(typeof item.isolate === "boolean" ? { isolate: item.isolate } : {}),
          ...(Array.isArray(item.repositoryIds) && item.repositoryIds.every((id) => typeof id === "string")
            ? { repositoryIds: item.repositoryIds.slice(0, 32) } : {}),
        })) }
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

const persistScopedDraftRecord = (
  sessionId: string | null | undefined,
  next: ScopedDraftRecord,
  capturedScope: PersistenceScope,
): ScopedDraftRecord => {
  const key = scopedDraftCacheKey(sessionId, capturedScope);
  if (next.serverUpdatedAt !== undefined) rememberServerStamp(key, next.serverUpdatedAt);
  // A clean empty server draft needs only a small in-memory CAS stamp while
  // mounted. Persisting one tombstone per visited session would eventually
  // exhaust the bounded mobile metadata store.
  if (!next.text && !next.seed && next.attachments.length === 0 && !(next.nativeStaged?.length)
    && !(next.previousNewSessionDrafts?.length) && !next.dirty && !next.conflict) {
    removeClientRecord(KIND, capturedScope);
    return next;
  }
  writeClientRecord(KIND, capturedScope, JSON.stringify(next));
  return next;
};

export function updateScopedDraftRecord(
  sessionId: string | null | undefined,
  patch: Partial<Pick<ScopedDraftRecord, "text" | "seed" | "attachments" | "nativeStaged" | "previousNewSessionDrafts" | "dirty" | "serverUpdatedAt" | "conflict">>,
  capturedScope?: PersistenceScope,
): ScopedDraftRecord {
  const targetScope = scope(sessionId, capturedScope);
  const current = loadScopedDraftRecord(sessionId, targetScope);
  return persistScopedDraftRecord(sessionId, {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updatedAt: Date.now(),
  }, targetScope);
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
    // Session projections are broadcast for many unrelated mutations. When
    // the draft CAS witness has not advanced, a differing server value is the
    // unchanged base under this local edit, not evidence of another writer.
    // An older projection must likewise never acknowledge or conflict with a
    // newer local base.
    if (serverUpdatedAt !== undefined && current.serverUpdatedAt !== undefined) {
      if (serverUpdatedAt < current.serverUpdatedAt) return current;
      if (serverUpdatedAt === current.serverUpdatedAt && text !== current.text) return current;
    }
    if (serverUpdatedAt !== undefined && consumeOutboundDraftEcho(sessionId, text)) {
      return updateScopedDraftRecord(sessionId, {
        dirty: text !== current.text,
        serverUpdatedAt,
        conflict: undefined,
      });
    }
    if (text !== current.text) {
      return updateScopedDraftRecord(sessionId, {
        // Keep the newer server value as the CAS base for an explicit local
        // continuation without overwriting the preserved local text.
        ...(serverUpdatedAt !== undefined ? { serverUpdatedAt } : {}),
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
 * still advances the authoritative CAS base, but cannot falsely mark newer
 * local text durable. */
export function acknowledgeDraftRevision(
  sessionId: string,
  revision: number,
  serverUpdatedAt: number,
  capturedScope?: PersistenceScope,
): ScopedDraftRecord {
  const current = loadScopedDraftRecord(sessionId, capturedScope);
  if (!current.dirty) return current;
  if (current.revision !== revision) {
    if (current.serverUpdatedAt !== undefined && serverUpdatedAt < current.serverUpdatedAt) return current;
    return persistScopedDraftRecord(sessionId, { ...current, serverUpdatedAt }, scope(sessionId, capturedScope));
  }
  return updateScopedDraftRecord(sessionId, { dirty: false, serverUpdatedAt, conflict: undefined }, capturedScope);
}

export async function hydrateScopedDraftRecord(sessionId: string | null | undefined, capturedScope?: PersistenceScope): Promise<ScopedDraftRecord> {
  const target = scope(sessionId, capturedScope);
  return parseRecord(await hydrateClientRecord(KIND, target));
}
