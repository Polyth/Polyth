import { api } from "@polyth/session/web-api";
import {
  PROJECT_PRESENTATION_SETTING_KEYS,
  type JsonValue,
  type ProjectPresentationSettingKey,
  type ProjectPresentationSettingsDto,
} from "@polyth/contracts";

/** Presentation state is deliberately separate from client/account settings. */
export const PROJECT_PRESENTATION_HYDRATED_EVENT = "polyth:project-presentation-hydrated";

const PUSH_DEBOUNCE_MS = 500;
const STORAGE_KEY: Record<ProjectPresentationSettingKey, (projectId: string) => string> = {
  widgetLayout: (projectId) => `polyth.widgetLayout.${projectId}`,
  workspacePanel: (projectId) => `polyth.workspacePanel.v1.${projectId}`,
  workspacePane: (projectId) => `polyth.workspacePane.v2.${projectId}`,
  workbenchLayout: (projectId) => `polyth.workbenchLayout.v1.${projectId}`,
  capabilityLayout: (projectId) => `polyth.capabilityLayout.v1.${projectId}`,
  workspaceMode: (projectId) => `polyth.workspaceMode.v1.${projectId}`,
};

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

function readStoredValue(key: ProjectPresentationSettingKey, raw: string): unknown {
  if (key !== "workspaceMode") return JSON.parse(raw) as unknown;
  if (raw === "chat" || raw === "widgets" || raw === "edit") return raw;
  // Accept the JSON-encoded form briefly written by an earlier implementation.
  return JSON.parse(raw) as unknown;
}

function orderedSettings(value: Record<string, unknown>): Partial<Record<ProjectPresentationSettingKey, JsonValue>> {
  const result: Partial<Record<ProjectPresentationSettingKey, JsonValue>> = {};
  for (const key of PROJECT_PRESENTATION_SETTING_KEYS) {
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
  for (const key of PROJECT_PRESENTATION_SETTING_KEYS) {
    try {
      const raw = store.getItem(STORAGE_KEY[key](projectId));
      if (raw === null) continue;
      // workspaceMode predates the JSON records and stores its enum as a raw
      // string; all other project records are JSON documents.
      const value = readStoredValue(key, raw);
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
  for (const key of PROJECT_PRESENTATION_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    try {
      const serialized = key === "workspaceMode" && typeof settings[key] === "string"
        ? settings[key]
        : JSON.stringify(settings[key]);
      if (serialized !== undefined) store.setItem(STORAGE_KEY[key](projectId), serialized);
    } catch {
      // A bad remote value is ignored here; the owning parser still fails safe.
    }
  }
}

export function projectPresentationEventProjectId(event: Event): string | null {
  const detail = (event as CustomEvent<{ projectId?: unknown }>).detail;
  return typeof detail?.projectId === "string" && detail.projectId ? detail.projectId : null;
}

function publishHydrated(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECT_PRESENTATION_HYDRATED_EVENT, { detail: { projectId } }));
}

let started = false;
let activeProjectId: string | null = null;
let scopeGeneration = 0;
let hydrationToken = 0;
let hydrating = false;
let lastSavedJson = "";
let pushTimer: ReturnType<typeof setTimeout> | undefined;
const dirtyByProject = new Map<string, Set<ProjectPresentationSettingKey>>();

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
  const snapshot = readProjectPresentationSettings(projectId);
  const json = jsonOf(snapshot);
  if (projectId === activeProjectId && json === lastSavedJson) return;
  try {
    await api.projectPresentationSettingsSave(projectId, snapshot as Record<string, unknown>, { keepalive });
  } catch {
    return;
  }
  if (projectId !== activeProjectId || generation !== scopeGeneration) return;
  const current = readProjectPresentationSettings(projectId);
  if (jsonOf(current) === json) {
    lastSavedJson = json;
    dirtyByProject.delete(projectId);
  } else {
    schedulePush();
  }
}

async function pushCurrent(keepalive = false): Promise<void> {
  if (activeProjectId === null || hydrating) return;
  await pushProject(activeProjectId, scopeGeneration, keepalive);
}

async function hydrate(projectId: string, generation: number): Promise<void> {
  const token = ++hydrationToken;
  hydrating = true;
  const local = readProjectPresentationSettings(projectId);
  try {
    const rawDto: ProjectPresentationSettingsDto = await api.projectPresentationSettings(projectId);
    if (projectId !== activeProjectId || generation !== scopeGeneration || token !== hydrationToken) return;

    const dto = parseServerSettings(rawDto);
    const server = dto.settings;
    const merged: Record<string, unknown> = { ...local, ...server };
    const dirty = dirtyByProject.get(projectId);
    // A real edit made while the initial request was in flight wins for that
    // key; untouched local records are only fallbacks for new setting keys.
    for (const key of dirty ?? []) {
      if (Object.prototype.hasOwnProperty.call(local, key)) merged[key] = local[key];
    }
    const normalized = orderedSettings(merged);
    writeProjectPresentationSettings(projectId, normalized);
    const mergedJson = jsonOf(normalized);
    const serverJson = jsonOf(server);
    lastSavedJson = serverJson;
    hydrating = false;
    publishHydrated(projectId);

    const hasLocalOnlyState = Object.keys(normalized).some((key) => !Object.prototype.hasOwnProperty.call(server, key));
    if (dto.revision === 0 ? Object.keys(normalized).length > 0 : hasLocalOnlyState || mergedJson !== serverJson) {
      schedulePush();
    } else {
      dirtyByProject.delete(projectId);
      lastSavedJson = mergedJson;
    }
  } catch {
    if (projectId !== activeProjectId || generation !== scopeGeneration || token !== hydrationToken) return;
    hydrating = false;
    // Keep the local-first UX while the server is unavailable. The next
    // change or reconnect retries without inventing a server snapshot.
    lastSavedJson = "";
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
  if (typeof window !== "undefined") window.addEventListener("pagehide", flushProjectPresentationSync);
}

/** Called by the existing local stores after a successful project-scoped
 * local write. The server receives one complete, bounded project snapshot. */
export function markProjectPresentationChanged(
  projectId: string,
  key: ProjectPresentationSettingKey,
): void {
  if (!started || !PROJECT_PRESENTATION_SETTING_KEYS.includes(key)) return;
  const dirty = dirtyByProject.get(projectId) ?? new Set<ProjectPresentationSettingKey>();
  dirty.add(key);
  dirtyByProject.set(projectId, dirty);
  if (projectId === activeProjectId && !hydrating) schedulePush();
}

export function flushProjectPresentationSync(): void {
  clearPushTimer();
  if (activeProjectId !== null && !hydrating) void pushCurrent(true);
}
