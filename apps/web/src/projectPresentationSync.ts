import { api, errorCodeOf } from "@polyth/session/web-api";
import {
  type JsonValue,
  type ProjectPresentationSettingKey,
  type ProjectPresentationSettingsDto,
} from "@polyth/contracts";
import { mergeRecords3 } from "./presentationMerge.ts";
import {
  isSharedProjectInterface,
  presentationScopeId,
  setProjectInterfaceMode,
  SHARED_PRESENTATION_SCOPE,
  subscribeProjectInterfaceMode,
  type ProjectInterfaceMode,
} from "./projectInterfaceScope.ts";

/** Presentation state is deliberately separate from client/account settings. */
export const PROJECT_PRESENTATION_HYDRATED_EVENT = "polyth:project-presentation-hydrated";

const PUSH_DEBOUNCE_MS = 500;
// Share deliberate workspace customizations. Open windows, selected sessions,
// tabs, Chat/Canvas mode and per-session Files/Git/Terminal navigation remain
// on this device; old server records may still contain them for compatibility.
// `canvasEnabled` is not navigation: it records whether the project offers the
// Canvas surface at all, so it travels with the project like its widget layout.
// `workbenchProfiles` is the same choice for optional workbench profiles.
const SHARED_KEYS = ["widgetLayout", "workspacePanel", "capabilityLayout", "canvasEnabled", "workbenchProfiles"] as const satisfies readonly ProjectPresentationSettingKey[];
const STORAGE_KEY: Record<(typeof SHARED_KEYS)[number], (projectId: string) => string> = {
  widgetLayout: (projectId) => `polyth.widgetLayout.${projectId}`,
  workspacePanel: (projectId) => `polyth.workspacePanel.v1.${projectId}`,
  capabilityLayout: (projectId) => `polyth.capabilityLayout.v1.${projectId}`,
  canvasEnabled: (projectId) => `polyth.canvasEnabled.v1.${projectId}`,
  workbenchProfiles: (projectId) => `polyth.workbenchProfiles.v1.${projectId}`,
};

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function orderedSettings(value: Record<string, unknown>): Partial<Record<ProjectPresentationSettingKey, JsonValue>> {
  const result: Partial<Record<ProjectPresentationSettingKey, JsonValue>> = {};
  for (const key of SHARED_KEYS) {
    const item = value[key];
    if (Object.prototype.hasOwnProperty.call(value, key) && isJsonValue(item)) result[key] = item;
  }
  return result;
}

function parseServerSettings(value: unknown): {
  revision: number;
  settings: Partial<Record<ProjectPresentationSettingKey, JsonValue>>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid project presentation response");
  const dto = value as { revision?: unknown; updatedAt?: unknown; settings?: unknown };
  if (typeof dto.revision !== "number" || !Number.isFinite(dto.revision)
    || typeof dto.updatedAt !== "number" || !Number.isFinite(dto.updatedAt)
    || !dto.settings || typeof dto.settings !== "object" || Array.isArray(dto.settings)) {
    throw new Error("invalid project presentation response");
  }
  return {
    revision: Math.max(0, Math.trunc(dto.revision)),
    settings: orderedSettings(dto.settings as Record<string, unknown>),
  };
}

/** Read the local records in the same stable order used for server writes. */
export function readProjectPresentationSettings(
  projectId: string,
): Partial<Record<ProjectPresentationSettingKey, JsonValue>> {
  const store = storage();
  if (!store) return {};
  const result: Record<string, unknown> = {};
  for (const key of SHARED_KEYS) {
    try {
      const storageKey = STORAGE_KEY[key](projectId);
      const raw = store.getItem(storageKey);
      if (raw === null) continue;
      const value = JSON.parse(raw) as unknown;
      if (isJsonValue(value)) result[key] = value;
    } catch {
      // Individual browser records are untrusted; the feature parser owns its
      // fallback and one malformed key must not hide the other records.
    }
  }
  return orderedSettings(result);
}

function writeProjectPresentationSettings(
  projectId: string,
  settings: Record<string, unknown>,
): void {
  const store = storage();
  if (!store) return;
  for (const key of SHARED_KEYS) {
    const present = Object.prototype.hasOwnProperty.call(settings, key);
    try {
      const storageKey = STORAGE_KEY[key](projectId);
      if (!present) {
        store.removeItem?.(storageKey);
        continue;
      }
      const serialized = JSON.stringify(settings[key]);
      if (serialized !== undefined && store.getItem(storageKey) !== serialized) store.setItem(storageKey, serialized);
    } catch {
      // A bad remote value is ignored here; the owning parser still fails safe.
    }
  }
}

export function projectPresentationEventProjectId(event: Event): string | null {
  const detail = (event as CustomEvent<{ projectId?: unknown }>).detail;
  return typeof detail?.projectId === "string" && detail.projectId ? detail.projectId : null;
}

export function projectPresentationEventHasKey(event: Event, key: ProjectPresentationSettingKey): boolean {
  const keys = (event as CustomEvent<{ keys?: unknown }>).detail?.keys;
  return Array.isArray(keys) && keys.includes(key);
}

function publishHydrated(projectId: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const keys = SHARED_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (keys.length === 0) return;
  window.dispatchEvent(new CustomEvent(PROJECT_PRESENTATION_HYDRATED_EVENT, { detail: { projectId, keys } }));
}

// The last server snapshot this device's local records derive from. Persisted
// (and shared by every tab of this origin) so a reload can still tell a local
// edit apart from a stale cache: only the difference against this base is
// merged into a newer server snapshot.
const baseStorageKey = (projectId: string): string => `polyth.projectPresentationBase.v1.${projectId}`;

function rememberServerSnapshot(projectId: string, json: string): void {
  savedJsonByProject.set(projectId, json);
  try { storage()?.setItem(baseStorageKey(projectId), json); } catch { /* quota/private mode */ }
}

function knownServerSnapshot(projectId: string): Record<string, unknown> | null {
  let raw: string | null | undefined;
  try { raw = storage()?.getItem(baseStorageKey(projectId)); } catch { raw = null; }
  for (const candidate of [raw, savedJsonByProject.get(projectId)]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return orderedSettings(value as Record<string, unknown>);
      }
    } catch {
      // A malformed base is only an optimization; fall through.
    }
  }
  return null;
}

/** Apply a live server broadcast to the active project. Local changes made
 * since the last synced snapshot are replayed on top of it and pushed; every
 * other value takes the server snapshot immediately. */
export function applyRemoteProjectPresentation(
  projectId: string,
  dto: ProjectPresentationSettingsDto,
): void {
  if (projectId !== activeProjectId) return;
  const knownRevision = revisionByProject.get(projectId) ?? -1;
  if (dto.revision <= knownRevision) return;

  let parsed: ReturnType<typeof parseServerSettings>;
  try {
    parsed = parseServerSettings(dto);
  } catch {
    return;
  }
  revisionByProject.set(projectId, parsed.revision);
  // A live frame is newer than an in-flight GET. Invalidate that GET so its
  // older response cannot restore stale local records.
  hydrationToken += 1;
  hydrating = false;

  const currentLocal = readProjectPresentationSettings(projectId);
  // A live frame is a complete authoritative snapshot; an omitted key means it
  // was removed on the source client.
  const base = knownServerSnapshot(projectId);
  let merged: Record<string, unknown>;
  if (base !== null) {
    merged = mergeRecords3(base, currentLocal, parsed.settings);
  } else {
    // No synced baseline: keep only keys with a pending local edit.
    merged = { ...parsed.settings };
    for (const key of dirtyByProject.get(projectId) ?? []) {
      if (Object.prototype.hasOwnProperty.call(currentLocal, key)) merged[key] = currentLocal[key];
      else delete merged[key];
    }
  }
  const normalized = orderedSettings(merged);
  writeProjectPresentationSettings(projectId, normalized);
  lastSavedJson = jsonOf(parsed.settings);
  rememberServerSnapshot(projectId, lastSavedJson);
  publishHydrated(projectId, currentLocal, normalized);
  if (jsonOf(normalized) !== lastSavedJson) schedulePush();
  else dirtyByProject.delete(projectId);
}

let started = false;
let activeProjectId: string | null = null;
let scopeGeneration = 0;
let hydrationToken = 0;
let hydrating = false;
let lastSavedJson = "";
let pushTimer: ReturnType<typeof setTimeout> | undefined;
const dirtyByProject = new Map<string, Set<ProjectPresentationSettingKey>>();
const revisionByProject = new Map<string, number>();
const savedJsonByProject = new Map<string, string>();
const pushInFlight = new Map<string, Promise<void>>();
const syncedListeners = new Set<() => void>();
// Shared-interface mirror (see the end of this file).
const sharedListeners = new Set<() => void>();
let sharedSettled = false;

function notifySynced(): void {
  for (const listener of [...syncedListeners]) listener();
}

/** True once the active project's shared records reflect the server. Code that
 * makes automatic, persisted decisions from those records waits for this. */
export function isProjectPresentationSynced(projectId: string): boolean {
  if (!started || projectId !== activeProjectId) return false;
  // A shared interface lives in the account settings, not the project record.
  if (isSharedProjectInterface()) return sharedSettled;
  return !hydrating && revisionByProject.has(projectId);
}

export function subscribeProjectPresentationSynced(listener: () => void): () => void {
  syncedListeners.add(listener);
  return () => { syncedListeners.delete(listener); };
}

function jsonOf(settings: Record<string, unknown>): string {
  return JSON.stringify(orderedSettings(settings));
}

function clearPushTimer(): void {
  if (pushTimer === undefined) return;
  clearTimeout(pushTimer);
  pushTimer = undefined;
}

function schedulePush(): void {
  if (pushTimer !== undefined || activeProjectId === null || hydrating) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    void pushCurrent();
  }, PUSH_DEBOUNCE_MS);
  (pushTimer as unknown as { unref?: () => void }).unref?.();
}

async function pushProject(
  projectId: string,
  generation: number,
  keepalive = false,
): Promise<void> {
  const previous = pushInFlight.get(projectId);
  if (previous) await previous;
  // A failed initial GET gives us no compare-and-swap baseline. Fetch it
  // before writing so an offline local cache cannot overwrite a newer record.
  if (!revisionByProject.has(projectId)) {
    if (projectId !== activeProjectId || generation !== scopeGeneration
      || !await hydrate(projectId, generation)) return;
  }
  const snapshot = readProjectPresentationSettings(projectId);
  const json = jsonOf(snapshot);
  if (json === savedJsonByProject.get(projectId)) {
    dirtyByProject.delete(projectId);
    return;
  }
  let mayContinue = false;
  const operation = (async () => {
    try {
      const saved = await api.projectPresentationSettingsSave(projectId, snapshot as Record<string, unknown>, {
        keepalive,
        expectedRevision: revisionByProject.get(projectId),
      });
      const knownRevision = revisionByProject.get(projectId) ?? -1;
      if (!Number.isFinite(saved.revision) || saved.revision < knownRevision) return;
      mayContinue = true;
      revisionByProject.set(projectId, saved.revision);
      rememberServerSnapshot(projectId, json);
      const current = readProjectPresentationSettings(projectId);
      if (jsonOf(current) === json) {
        dirtyByProject.delete(projectId);
        if (projectId === activeProjectId && generation === scopeGeneration) lastSavedJson = json;
      }
    } catch (error) {
      if (errorCodeOf(error) !== "conflict" || projectId !== activeProjectId || generation !== scopeGeneration) return;
      mayContinue = await hydrate(projectId, generation);
    }
  })();
  pushInFlight.set(projectId, operation);
  try { await operation; }
  finally {
    if (pushInFlight.get(projectId) === operation) pushInFlight.delete(projectId);
    if (mayContinue && projectId === activeProjectId && generation === scopeGeneration
      && jsonOf(readProjectPresentationSettings(projectId)) !== lastSavedJson) schedulePush();
  }
}

async function pushCurrent(keepalive = false): Promise<void> {
  if (activeProjectId === null || hydrating) return;
  await pushProject(activeProjectId, scopeGeneration, keepalive);
}

async function hydrate(projectId: string, generation: number): Promise<boolean> {
  const token = ++hydrationToken;
  hydrating = true;
  const local = readProjectPresentationSettings(projectId);
  try {
    const rawDto: ProjectPresentationSettingsDto = await api.projectPresentationSettings(projectId);
    if (projectId !== activeProjectId || generation !== scopeGeneration || token !== hydrationToken) return false;

    const dto = parseServerSettings(rawDto);
    if (dto.revision < (revisionByProject.get(projectId) ?? -1)) {
      // The server record is older than the revision this client last saw:
      // either a stale in-flight response or a server record that was reset or
      // restored. Keep the newer local records, but adopt the server revision —
      // retrying the previously known revision can only conflict again, which
      // would loop forever instead of converging.
      revisionByProject.set(projectId, dto.revision);
      hydrating = false;
      if ((dirtyByProject.get(projectId)?.size ?? 0) > 0) schedulePush();
      notifySynced();
      return false;
    }
    revisionByProject.set(projectId, Math.max(revisionByProject.get(projectId) ?? 0, dto.revision));
    const server = dto.settings;
    const currentLocal = readProjectPresentationSettings(projectId);
    // Once the server has a record, an omitted key is a real deletion. Local
    // cache only seeds a never-written project or an edit made during the GET.
    const seedLocal = dto.revision === 0
      || (Object.keys(server).length === 0 && Object.keys(rawDto.settings).length > 0);
    let merged: Record<string, unknown>;
    if (seedLocal) {
      merged = { ...local, ...server };
      // A real edit made while the initial request was in flight wins.
      for (const key of dirtyByProject.get(projectId) ?? []) {
        if (Object.prototype.hasOwnProperty.call(currentLocal, key)) merged[key] = currentLocal[key];
        else delete merged[key];
      }
    } else {
      // Replay only what changed locally since the snapshot this cache was
      // synced from. Without a recorded snapshot, the cache as it was when
      // this request started is that baseline: edits made while the request
      // was in flight still win, but a stale cache (and automatic repairs
      // layered on it) can no longer overwrite newer choices from another
      // client — the bug that kept bringing hidden rail icons back.
      merged = mergeRecords3(knownServerSnapshot(projectId) ?? local, currentLocal, server);
    }
    const normalized = orderedSettings(merged);
    writeProjectPresentationSettings(projectId, normalized);
    const mergedJson = jsonOf(normalized);
    const serverJson = jsonOf(server);
    lastSavedJson = serverJson;
    rememberServerSnapshot(projectId, serverJson);
    hydrating = false;
    publishHydrated(projectId, currentLocal, normalized);

    if (seedLocal ? Object.keys(normalized).length > 0 : mergedJson !== serverJson) {
      schedulePush();
    } else {
      dirtyByProject.delete(projectId);
      lastSavedJson = mergedJson;
    }
    notifySynced();
    return true;
  } catch {
    if (projectId !== activeProjectId || generation !== scopeGeneration || token !== hydrationToken) return false;
    hydrating = false;
    // Keep the local-first UX while the server is unavailable. The next
    // change or reconnect retries without inventing a server snapshot.
    lastSavedJson = "";
    return false;
  }
}

function syncScope(projectId: string | null): void {
  if (projectId === activeProjectId) return;
  const previous = activeProjectId;
  clearPushTimer();
  if (previous !== null && (dirtyByProject.get(previous)?.size ?? 0) > 0) {
    void pushProject(previous, scopeGeneration, true);
  }
  activeProjectId = projectId;
  scopeGeneration += 1;
  hydrating = false;
  lastSavedJson = "";
  if (projectId !== null) void hydrate(projectId, scopeGeneration);
}

/** Start the project-scoped mirror. Recalling it on reconnect rehydrates the
 * active project without wiring a second store subscription. */
export function initProjectPresentationSync(
  subscribe: (listener: () => void) => () => void,
  getProjectId: () => string | null,
): void {
  if (started) {
    syncScope(getProjectId());
    if (activeProjectId !== null) void hydrate(activeProjectId, scopeGeneration);
    return;
  }
  started = true;
  activeProjectId = null;
  subscribe(() => syncScope(getProjectId()));
  syncScope(getProjectId());
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushProjectPresentationSync);
    window.addEventListener("storage", mirrorOtherTabWrite);
  }
}

/** Another tab of this origin wrote a shared record. The local stores keep an
 * in-memory copy, so without this a background tab keeps showing (and on its
 * next edit re-saves) the layout from before the other tab's change. */
function mirrorOtherTabWrite(event: StorageEvent): void {
  const projectId = activeProjectId;
  if (projectId === null || event.key === null || typeof window === "undefined") return;
  const scope = presentationScopeId(projectId);
  const keys = SHARED_KEYS.filter((key) => STORAGE_KEY[key](scope) === event.key);
  if (keys.length === 0) return;
  window.dispatchEvent(new CustomEvent(PROJECT_PRESENTATION_HYDRATED_EVENT, { detail: { projectId, keys } }));
}

/** Called by the existing local stores after a successful project-scoped
 * local write. The server receives one complete, bounded project snapshot. */
export function markProjectPresentationChanged(
  projectId: string,
  key: ProjectPresentationSettingKey,
): void {
  if (!(SHARED_KEYS as readonly string[]).includes(key)) return;
  if (isSharedProjectInterface()) {
    // The stores wrote the shared record; the account settings mirror it.
    for (const listener of [...sharedListeners]) listener();
    return;
  }
  if (!started) return;
  const dirty = dirtyByProject.get(projectId) ?? new Set<ProjectPresentationSettingKey>();
  dirty.add(key);
  dirtyByProject.set(projectId, dirty);
  if (projectId === activeProjectId && !hydrating) schedulePush();
}

export function flushProjectPresentationSync(): void {
  clearPushTimer();
  if (activeProjectId !== null && !hydrating) void pushCurrent(true);
}

// ---------------------------------------------------------------- shared interface

/** Account preference holding the arrangement every project shows while the
 * interface is shared (`projectInterfaceScope`). Same keys and values as a
 * project record, kept under the shared storage scope. */
export const SHARED_PROJECT_INTERFACE_PREFERENCE_ID = "core.shared-project-interface";

function publishAll(projectId: string | null): void {
  if (projectId === null || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECT_PRESENTATION_HYDRATED_EVENT, { detail: { projectId, keys: [...SHARED_KEYS] } }));
}

export const sharedProjectPresentationPreference = {
  read: (): Partial<Record<ProjectPresentationSettingKey, JsonValue>> =>
    readProjectPresentationSettings(SHARED_PRESENTATION_SCOPE),
  write: (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const before = readProjectPresentationSettings(SHARED_PRESENTATION_SCOPE);
    const next = orderedSettings(value as Record<string, unknown>);
    writeProjectPresentationSettings(SHARED_PRESENTATION_SCOPE, next);
    if (isSharedProjectInterface() && activeProjectId !== null) publishHydrated(activeProjectId, before, next);
  },
  subscribe: (listener: () => void): (() => void) => {
    sharedListeners.add(listener);
    return () => { sharedListeners.delete(listener); };
  },
};

/** The account settings snapshot has arrived (or will not): automatic,
 * persisted decisions about the shared arrangement may now be made. */
export function markSharedProjectPresentationSettled(): void {
  if (sharedSettled) return;
  sharedSettled = true;
  notifySynced();
}

/** Copy one project's arrangement into the shared record (Settings action, and
 * the first switch to a shared interface). */
export function copyProjectPresentationToShared(projectId: string): void {
  writeProjectPresentationSettings(SHARED_PRESENTATION_SCOPE, readProjectPresentationSettings(projectId));
  for (const listener of [...sharedListeners]) listener();
  if (isSharedProjectInterface()) publishAll(activeProjectId);
}

/** Switch between one shared interface and per-project ones. The first switch
 * to shared starts from `sourceProjectId`'s arrangement instead of an empty
 * one; afterwards the shared record is kept, as is every project's own. */
export function chooseProjectInterface(next: ProjectInterfaceMode, sourceProjectId: string | null): void {
  if (next === "shared" && sourceProjectId !== null
    && Object.keys(readProjectPresentationSettings(SHARED_PRESENTATION_SCOPE)).length === 0) {
    copyProjectPresentationToShared(sourceProjectId);
  }
  setProjectInterfaceMode(next);
}

subscribeProjectInterfaceMode(() => {
  // Every store re-reads the active project's records from the new scope.
  publishAll(activeProjectId);
  notifySynced();
});
