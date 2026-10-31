// Small persistence seam for client-only recovery metadata. Browser builds use
// their origin-backed localStorage synchronously; a paired mobile loopback can
// replace it with the same-origin, app-owned async store without exposing a
// native bridge to page JavaScript.
import { deadlineSignal } from "./deadline.ts";

export interface AsyncKeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type PersistenceScope = {
  connectionScope: string;
  accountId: string;
  spaceId?: string;
  projectId?: string;
  sessionId?: string;
};

const PREFIX = "polyth.client.v1.";
let backend: AsyncKeyValueStore | null = null;
const remoteCache = new Map<string, string | null>();
const cacheVersions = new Map<string, number>();
const MAX_REMOTE_CACHE_ENTRIES = 128;
const pendingWrites = new Set<Promise<void>>();
const writeChains = new Map<string, Promise<void>>();
const writeErrors = new Map<string, Error>();
let backendGeneration = 0;

const rawKey = (kind: string, scope: PersistenceScope): string => JSON.stringify([
  kind,
  scope.connectionScope,
  scope.accountId,
  scope.spaceId ?? "",
  scope.projectId ?? "",
  scope.sessionId ?? "",
]);

const browserKey = (kind: string, scope: PersistenceScope): string =>
  `${PREFIX}${encodeURIComponent(rawKey(kind, scope))}`;

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const base64url = (data: Uint8Array): string => {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

/** Native proxy keys are bounded and do not reveal account/project/session IDs. */
async function proxyKey(kind: string, scope: PersistenceScope): Promise<string> {
  const encoded = bytes(rawKey(kind, scope));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
  );
  return `p3.${kind}.${base64url(new Uint8Array(digest))}`;
}

function localGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}
function localRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* private mode / quota */ }
}

/** Install only after authenticated client-context discovery succeeds. */
export function setClientPersistenceBackend(next: AsyncKeyValueStore | null): void {
  backendGeneration += 1;
  backend = next;
  remoteCache.clear();
  cacheVersions.clear();
  writeChains.clear();
  writeErrors.clear();
}

/** True while a paired mobile loopback's app-owned store backs the records. */
export const hasClientPersistenceBackend = (): boolean => backend !== null;

/** Changes every time the backend is installed, replaced or removed. */
export const clientPersistenceBackendGeneration = (): number => backendGeneration;

/** Keep a small renderer-local working set. The proxy remains authoritative;
 * account/Space switches must not turn this into an unbounded second store. */
function cacheSet(key: string, value: string | null): void {
  remoteCache.delete(key);
  remoteCache.set(key, value);
  while (remoteCache.size > MAX_REMOTE_CACHE_ENTRIES) {
    const oldest = remoteCache.keys().next().value as string | undefined;
    if (!oldest) break;
    remoteCache.delete(oldest);
    cacheVersions.delete(oldest);
  }
}

function cacheGet(key: string): string | null {
  if (!remoteCache.has(key)) return null;
  const value = remoteCache.get(key) ?? null;
  cacheSet(key, value);
  return value;
}

/** Test-only boundedness observation; it exposes no keys or stored values. */
export const clientPersistenceCacheSizeForTest = (): number => remoteCache.size;

/** `barrier: false` keeps the write in order with later writes of its record
 * but out of `flushClientPersistence`: it is never awaited and its failure is
 * not reported. */
function queueWrite(raw: string, operation: () => Promise<void>, barrier = true): void {
  const generation = backendGeneration;
  const chainKey = `${generation}\0${raw}`;
  const prior = writeChains.get(chainKey) ?? Promise.resolve();
  // Serialize each logical record. A slow older PUT must never land after a
  // newer draft revision and become the value restored after process death.
  const write = prior.catch(() => undefined).then(operation);
  writeChains.set(chainKey, write);
  if (barrier) pendingWrites.add(write);
  void write.then(
    () => { if (barrier && generation === backendGeneration) writeErrors.delete(chainKey); },
    (error) => {
      if (barrier && generation === backendGeneration) {
        writeErrors.set(chainKey, error instanceof Error ? error : new Error(String(error)));
      }
    },
  ).finally(() => {
    if (barrier) pendingWrites.delete(write);
    if (writeChains.get(chainKey) === write) writeChains.delete(chainKey);
  });
}

/** Await native metadata writes before background/process handoff. Callers can
 * surface the returned error; failed writes never pretend to be durable. */
export async function flushClientPersistence(): Promise<void> {
  while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites]);
  const error = writeErrors.values().next().value as Error | undefined;
  if (error) throw error;
}

export const clientPersistenceWriteError = (): Error | null =>
  (writeErrors.values().next().value as Error | undefined) ?? null;

/** Fast path used by synchronous composer code. Native values appear after
 * `hydrateClientRecord`; browser values are available immediately. */
export function readClientRecord(kind: string, scope: PersistenceScope): string | null {
  if (!backend) return localGet(browserKey(kind, scope));
  return cacheGet(rawKey(kind, scope));
}

function writeRecord(kind: string, scope: PersistenceScope, value: string, barrier: boolean): void {
  const raw = rawKey(kind, scope);
  if (!backend) {
    localSet(browserKey(kind, scope), value);
    return;
  }
  cacheVersions.set(raw, (cacheVersions.get(raw) ?? 0) + 1);
  cacheSet(raw, value);
  const target = backend;
  queueWrite(raw, async () => {
    const key = await proxyKey(kind, scope);
    await target?.set(key, value);
  }, barrier);
}

export function writeClientRecord(kind: string, scope: PersistenceScope, value: string): void {
  writeRecord(kind, scope, value, true);
}

/** `writeClientRecord` for presentation state that may be lost without harm
 * (what the navigator had open). Recovery records hold a send behind
 * `flushClientPersistence`, so a failure there refuses the message; a full
 * quota or a stalled loopback must not do that over a remembered disclosure.
 * This write is never awaited by the flush and its failure is dropped. */
export function writeClientPreference(kind: string, scope: PersistenceScope, value: string): void {
  writeRecord(kind, scope, value, false);
}

export function removeClientRecord(kind: string, scope: PersistenceScope): void {
  const raw = rawKey(kind, scope);
  if (!backend) {
    localRemove(browserKey(kind, scope));
    return;
  }
  cacheVersions.set(raw, (cacheVersions.get(raw) ?? 0) + 1);
  cacheSet(raw, null);
  const target = backend;
  queueWrite(raw, async () => {
    const key = await proxyKey(kind, scope);
    await target?.remove(key);
  });
}

/** Explicit async hydration for native process-restart recovery. */
export async function hydrateClientRecord(kind: string, scope: PersistenceScope): Promise<string | null> {
  if (!backend) return readClientRecord(kind, scope);
  const raw = rawKey(kind, scope);
  if (remoteCache.has(raw)) return cacheGet(raw);
  const version = cacheVersions.get(raw) ?? 0;
  const value = await backend.get(await proxyKey(kind, scope));
  // Typing/removal may have updated the synchronous working copy while the
  // native read was in flight. Never let that older read clobber new intent.
  if ((cacheVersions.get(raw) ?? 0) !== version) return cacheGet(raw);
  cacheSet(raw, value);
  return value;
}

/** Conservative one-way legacy migration. The caller must establish that the
 * sole current scope owned the old key; ambiguity leaves the old record in
 * place for recovery and never clones it into multiple scopes. */
export function migrateLegacyClientRecord(
  legacyKey: string,
  kind: string,
  scope: PersistenceScope,
  ownershipProven: boolean,
): boolean {
  if (!ownershipProven || backend) return false;
  const migrationScope: PersistenceScope = {
    connectionScope: scope.connectionScope,
    accountId: scope.accountId,
    spaceId: scope.spaceId,
  };
  const markerKind = "migration-v1";
  const marker = `${kind}:${legacyKey}`;
  if (localGet(browserKey(markerKind, migrationScope)) === marker) return false;
  const legacy = localGet(legacyKey);
  if (legacy === null || localGet(browserKey(kind, scope)) !== null) return false;
  localSet(browserKey(kind, scope), legacy);
  localRemove(legacyKey);
  localSet(browserKey(markerKind, migrationScope), marker);
  return true;
}

/** Opening a session awaits this read, so a stalled loopback must fail the open
 * (the user can retry) instead of hanging it. Writes stay unbounded: an
 * abandoned PUT could still land after a newer one and restore a stale draft. */
const CLIENT_CONTEXT_READ_TIMEOUT_MS = 5_000;

/** Same-origin loopback adapter. The endpoint authorizes the proxy cookie and
 * accepts only bounded opaque keys; callers never send connection secrets. */
export function clientContextStore(): AsyncKeyValueStore {
  return {
    async get(key) {
      const response = await fetch(`/__polyth/client-context/storage/${encodeURIComponent(key)}`, {
        signal: deadlineSignal(CLIENT_CONTEXT_READ_TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`client persistence: HTTP ${response.status}`);
      const body = await response.json() as { value?: unknown };
      return typeof body.value === "string" ? body.value : null;
    },
    async set(key, value) {
      const response = await fetch(`/__polyth/client-context/storage/${encodeURIComponent(key)}`, {
        method: "PUT", body: value,
      });
      if (!response.ok) throw new Error(`client persistence: HTTP ${response.status}`);
    },
    async remove(key) {
      const response = await fetch(`/__polyth/client-context/storage/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`client persistence: HTTP ${response.status}`);
    },
  };
}
