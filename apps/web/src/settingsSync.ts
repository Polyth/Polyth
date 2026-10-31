// Server-backed client preferences. Product settings (theme, density, interface
// scale, …), UI preferences, session defaults, and model-picker preferences
// travel together as one account-owned blob so every client that talks to this
// server inherits the same choices. Local storage stays the synchronous cache;
// this module mirrors it to `/api/settings/client` and applies any newer server
// snapshot received on boot, reconnect, or the WS gateway.
//
// Echo handling is value-based: a push only fires when the serialized blob
// actually differs from what the server last confirmed, so re-applying an
// inbound snapshot (which re-enters local preference stores) cannot loop back
// into another push.
import { api, errorCodeOf } from "@polyth/session/web-api";
import type { ClientSettingsDto, JsonValue } from "@polyth/contracts";
import { parseModelPrefs } from "@polyth/models";
import {
  getModelVisibilityPrefs,
  parseModelVisibilityPrefs,
  replaceModelVisibilityPrefs,
} from "@polyth/models/model-visibility-prefs";
import {
  getLastHarnessModelsRecord,
  getModelPrefs,
  getThinkingPrefs,
  replaceLastHarnessModels,
  replaceModelPrefs,
  replaceThinkingPrefs,
  subscribeLastHarnessModels,
  subscribeModelPrefs,
  subscribeThinkingPrefs,
} from "@polyth/models/web-prefs";
import { normalizeSettings } from "./settings.ts";
import { getState, subscribeStore, updateSettings } from "./store.ts";
import { getUiSettings, parseUiSettings, setUiSettings, subscribeUiSettings } from "./uiPrefs.ts";
import {
  getSessionDefaults,
  parseSessionDefaults,
  setSessionDefaults,
  subscribeSessionDefaults,
} from "./sessionDefaults.ts";
import {
  DEFAULT_BACKGROUND_ID,
  getBackground,
  parseBackgroundState,
  setBackground,
  subscribeBackground,
} from "./backgrounds.ts";
import { getSidebarLayout, parseSidebarLayout, setSidebarLayout, subscribeSidebarLayout } from "./sidebarLayout.ts";
import {
  getSidebarPrefsSnapshot,
  replaceSidebarPrefs,
  subscribeSidebarPrefs,
} from "./sidebarPrefs.ts";
import { getRailPrefs, replaceRailPrefs, subscribeRailPrefs } from "./railPrefs.ts";
import {
  getEditorPrefs,
  parseEditorPrefs,
  setEditorPrefs,
  subscribeEditorPrefs,
} from "./uiPrefs.ts";
import {
  getPackageTourPrefs,
  parsePackageTourPrefs,
  replacePackageTourPrefs,
  subscribePackageTourPrefs,
} from "./packages/onboarding/prefs.ts";
import {
  loadCustomThemes,
  parseCustomThemes,
  replaceCustomThemes,
  subscribeCustomThemes,
} from "./theme.ts";
import {
  getHeroWidgetPrefs,
  replaceHeroWidgetPrefs,
  subscribeHeroWidgetPrefs,
} from "./heroWidgetPrefs.ts";
import { getHeroBoard, replaceHeroBoard, subscribeHeroBoard } from "./heroBoard.ts";
import {
  getProjectIconPrefs,
  replaceProjectIconPrefs,
  subscribeProjectIconPrefs,
} from "./projectIconPrefs.ts";
import { PROJECT_INTERFACE_PREFERENCE_ID, projectInterfacePreference } from "./projectInterfaceScope.ts";
import {
  markSharedProjectPresentationSettled,
  SHARED_PROJECT_INTERFACE_PREFERENCE_ID,
  sharedProjectPresentationPreference,
} from "./projectPresentationSync.ts";
import {
  MOBILE_RAIL_PREFERENCE_ID,
  mobileRailPreference,
} from "./composer/mobileRail.ts";
import {
  SHELL_INTRO_PREFERENCE_ID,
  getShellIntroPrefs,
  replaceShellIntroPrefs,
  subscribeShellIntroPrefs,
} from "./shellIntro.ts";

const PUSH_DEBOUNCE_MS = 500;
// First-run decisions (the interface tour) wait for the account snapshot so a
// second device does not replay what the account already saw. A server that
// never answers must not hold the shell hostage.
const SETTLE_FALLBACK_MS = 5000;
// Older server blobs contain navigation and recently-used history. Drop those
// keys on read; they are local to the device that produced them.
const DEVICE_LOCAL_PREFERENCES = new Set(["core.mobile-workspace", "core.recent-widgets"]);

let localRevision = -1;
let lastSyncedJson = "";
let lastServerSettings: Record<string, unknown> | null = null;
let initialBaseline: SettingsBlob | null = null;
let pushInFlight: Promise<void> | null = null;
let applying = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let settled = false;
const settledListeners = new Set<() => void>();
const preferenceAdapters = new Map<string, UiPreferenceAdapter>();
const preferenceValues = new Map<string, JsonValue>();

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function capturePreference(id: string, value: unknown): boolean {
  if (!isJsonValue(value) || DEVICE_LOCAL_PREFERENCES.has(id)) return false;
  const next = JSON.stringify(value);
  if (JSON.stringify(preferenceValues.get(id)) === next) return false;
  preferenceValues.set(id, value);
  return true;
}

function currentPreferences(): Record<string, JsonValue> {
  return Object.fromEntries([...preferenceValues.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** Register one durable UI preference. The adapter owns validation and its
 * synchronous local cache; this boundary only mirrors the JSON value. */
export function registerUiPreference(id: string, adapter: UiPreferenceAdapter): () => void {
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(id)) throw new Error("invalid UI preference id");
  if (DEVICE_LOCAL_PREFERENCES.has(id)) throw new Error(`device-local preference cannot be registered: ${id}`);
  if (preferenceAdapters.has(id)) throw new Error(`UI preference already registered: ${id}`);
  preferenceAdapters.set(id, adapter);
  try {
    if (preferenceValues.has(id)) {
      const wasApplying = applying;
      applying = true;
      let normalized = false;
      try {
        adapter.write(preferenceValues.get(id));
        normalized = capturePreference(id, adapter.read());
      }
      finally { applying = wasApplying; }
      if (normalized && started && localRevision >= 0) schedulePush();
    } else {
      if (capturePreference(id, adapter.read()) && started && localRevision >= 0) schedulePush();
    }
    const off = adapter.subscribe(() => {
      if (applying) return;
      try {
        if (capturePreference(id, adapter.read())) schedulePush();
      } catch { /* one package cannot interrupt another preference store */ }
    });
    return () => {
      off();
      if (preferenceAdapters.get(id) === adapter) preferenceAdapters.delete(id);
    };
  } catch (error) {
    if (preferenceAdapters.get(id) === adapter) preferenceAdapters.delete(id);
    throw error;
  }
}

export interface UiPreferenceAdapter {
  read(): unknown;
  write(value: unknown): void;
  subscribe(listener: () => void): () => void;
}

interface SettingsBlob {
  product: ReturnType<typeof normalizeSettings>;
  ui: ReturnType<typeof getUiSettings>;
  // Session defaults travel with the shared blob so server-side small-model
  // generation (commit messages, next-action, task brief) uses the model the
  // user picked in Settings, and so the picks follow them across devices.
  sessionDefaults: ReturnType<typeof getSessionDefaults>;
  // Model-picker preferences are account-owned server state. Favorites already
  // carry harness-qualified model keys; provider order/accordion state for every
  // harness travels in the same canonical preference object.
  modelPrefs: ReturnType<typeof getModelPrefs>;
  // OpenCode provider/model toggles ("Providers & Models"). Carried in the same
  // account blob so the per-user list follows the account onto every client;
  // the server owns the value and preserves it when an older client omits it.
  modelVisibility: ReturnType<typeof getModelVisibilityPrefs>;
  /** Feature/shell preferences use stable ids; the server keeps this opaque. */
  preferences: Record<string, JsonValue>;
}

function currentBlob(): SettingsBlob {
  return {
    product: getState().settings,
    ui: getUiSettings(),
    sessionDefaults: getSessionDefaults(),
    modelPrefs: getModelPrefs(),
    modelVisibility: getModelVisibilityPrefs(),
    preferences: currentPreferences(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge concurrent edits by field. A local change since the last confirmed
 * server record wins only for that field; unrelated remote edits still land. */
function mergeLocal(base: unknown, local: unknown, remote: unknown): unknown {
  if (sameJson(local, base)) return remote;
  if (!isObject(base) || !isObject(local) || !isObject(remote)) return local;
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const hasLocal = Object.prototype.hasOwnProperty.call(local, key);
    const hasBase = Object.prototype.hasOwnProperty.call(base, key);
    const hasRemote = Object.prototype.hasOwnProperty.call(remote, key);
    if (!hasLocal && hasBase) continue; // Local deletion.
    if (!hasRemote) {
      if (hasLocal && (!hasBase || !sameJson(local[key], base[key]))) result[key] = local[key];
      continue;
    }
    if (!hasLocal) { result[key] = remote[key]; continue; }
    result[key] = hasBase ? mergeLocal(base[key], local[key], remote[key]) : local[key];
  }
  return result;
}

function normalizeRemotePreferences(value: unknown): { preferences: unknown; changed: boolean } {
  if (!isObject(value)) return { preferences: value, changed: false };
  const preferences: Record<string, unknown> = {};
  let changed = false;
  for (const [id, item] of Object.entries(value)) {
    if (DEVICE_LOCAL_PREFERENCES.has(id)) {
      changed = true;
      continue;
    }
    if (id === "core.background" && isObject(item)) {
      if (item.id === "custom") {
        changed = true;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(item, "customImage")) {
        const shared = { ...item };
        delete shared.customImage;
        preferences[id] = shared;
        changed = true;
        continue;
      }
    }
    preferences[id] = item;
  }
  return { preferences, changed };
}

/** Apply a newer server snapshot locally without bouncing it straight back. */
function applyRemote(dto: ClientSettingsDto): void {
  if (dto.revision <= localRevision) return;
  const rawIncoming = dto.settings as {
    product?: unknown;
    ui?: unknown;
    sessionDefaults?: unknown;
    modelPrefs?: unknown;
    modelVisibility?: unknown;
    preferences?: unknown;
  };
  const normalizedPreferences = normalizeRemotePreferences(rawIncoming.preferences);
  const incoming = { ...rawIncoming, preferences: normalizedPreferences.preferences };
  const before = currentBlob();
  const base = lastServerSettings ?? initialBaseline ?? before;
  const mergeSection = (key: keyof SettingsBlob): unknown => {
    const remote = incoming[key];
    if (!isObject(remote)) return before[key];
    return mergeLocal(base[key], before[key], remote);
  };
  const mergedProduct = mergeSection("product");
  const mergedUi = mergeSection("ui");
  const mergedDefaults = mergeSection("sessionDefaults");
  const mergedModels = mergeSection("modelPrefs");
  // The visibility section is server-owned: when the record has one, take it as
  // given (it is the account's list, already merged server-side); a record that
  // predates it leaves the local copy untouched.
  const mergedVisibility = isObject(incoming.modelVisibility)
    ? parseModelVisibilityPrefs(incoming.modelVisibility)
    : before.modelVisibility;
  const mergedPreferences = isObject(incoming.preferences)
    ? mergeLocal(base.preferences ?? {}, before.preferences, incoming.preferences)
    : before.preferences;
  applying = true;
  try {
    if (isObject(mergedProduct) && !sameJson(mergedProduct, before.product)) updateSettings(normalizeSettings(mergedProduct));
    if (isObject(mergedUi) && !sameJson(mergedUi, before.ui)) setUiSettings(parseUiSettings(JSON.stringify(mergedUi)));
    if (isObject(mergedDefaults) && !sameJson(mergedDefaults, before.sessionDefaults)) {
      setSessionDefaults(parseSessionDefaults(JSON.stringify(mergedDefaults)));
    }
    if (isObject(mergedModels) && !sameJson(mergedModels, before.modelPrefs)) {
      replaceModelPrefs(parseModelPrefs(JSON.stringify(mergedModels)));
    }
    if (!sameJson(mergedVisibility, before.modelVisibility)) {
      replaceModelVisibilityPrefs(mergedVisibility);
    }
    if (isObject(mergedPreferences)) {
      preferenceValues.clear();
      for (const [id, value] of Object.entries(mergedPreferences)) {
        if (!isJsonValue(value) || DEVICE_LOCAL_PREFERENCES.has(id)) continue;
        preferenceValues.set(id, value);
        const adapter = preferenceAdapters.get(id);
        if (adapter) {
          try {
            if (!sameJson(adapter.read(), value)) adapter.write(value);
            capturePreference(id, adapter.read());
          } catch {
            // A disabled/broken package adapter cannot stop unrelated
            // appearance and model settings from reaching this client.
          }
        }
      }
      for (const [id, adapter] of preferenceAdapters) {
        if (!preferenceValues.has(id)) {
          try { capturePreference(id, adapter.read()); } catch { /* package preference is unavailable */ }
        }
      }
    }
  } finally {
    applying = false;
  }
  localRevision = dto.revision;
  lastServerSettings = incoming as Record<string, unknown>;
  lastSyncedJson = normalizedPreferences.changed ? "" : JSON.stringify({
    product: incoming.product,
    ui: incoming.ui,
    sessionDefaults: incoming.sessionDefaults,
    modelPrefs: incoming.modelPrefs,
    modelVisibility: incoming.modelVisibility,
    preferences: incoming.preferences,
  });
}

/** Reconcile a server snapshot and preserve two important migration/retry cases:
 *  - older server records without modelPrefs are backfilled from the existing
 *    account-local cache exactly like a first server seed;
 *  - an unchanged server revision after a failed/offline push retries any local
 *    blob that still differs from the last confirmed server state. */
function reconcileRemote(dto: ClientSettingsDto): void {
  applyRemote(dto);
  if (JSON.stringify(currentBlob()) !== lastSyncedJson) schedulePush();
}

function push(opts?: { keepalive?: boolean }): void {
  timer = undefined;
  if (applying || pushInFlight !== null || localRevision < 0) return;
  const blob = currentBlob();
  const json = JSON.stringify(blob);
  if (json === lastSyncedJson) return;
  let mayContinue = false;
  pushInFlight = api.clientSettingsSave(blob as unknown as Record<string, unknown>, {
    ...opts,
    expectedRevision: localRevision,
  })
    .then((dto) => {
      if (dto.revision > localRevision) {
        mayContinue = true;
        lastSyncedJson = json;
        lastServerSettings = blob as unknown as Record<string, unknown>;
        localRevision = dto.revision;
      } else if (dto.revision === localRevision && lastSyncedJson === json) {
        // Our WS echo can arrive before the PUT response.
        mayContinue = true;
      }
    })
    .catch(async (error) => {
      if (errorCodeOf(error) === "conflict") {
        try {
          reconcileRemote(await api.clientSettings());
          mayContinue = true;
        } catch { /* retry on reconnect */ }
      }
      // Offline or server rejected the write — the local record still stands.
      // initSettingsSync() compares it again on reconnect and retries.
    }).finally(() => {
      pushInFlight = null;
      if (mayContinue && JSON.stringify(currentBlob()) !== lastSyncedJson) schedulePush();
    });
}

function schedulePush(): void {
  if (applying || timer !== undefined) return;
  timer = setTimeout(push, PUSH_DEBOUNCE_MS);
}

export function flushSettingsSync(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  push({ keepalive: true });
}

function markSettled(): void {
  if (settled) return;
  settled = true;
  markSharedProjectPresentationSettled();
  for (const listener of [...settledListeners]) listener();
}

/** True once the first server snapshot was applied, the fetch failed, or the
 *  fallback elapsed — local caches are then as good as this client gets. */
export function isClientSettingsSettled(): boolean {
  return settled;
}

export function subscribeClientSettingsSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

/** WS gateway frame: another client changed the shared settings. */
export function applyRemoteClientSettings(dto: ClientSettingsDto): void {
  reconcileRemote(dto);
}

let corePreferencesRegistered = false;
function registerCorePreferences(): void {
  if (corePreferencesRegistered) return;
  corePreferencesRegistered = true;
  const register = (id: string, adapter: UiPreferenceAdapter): void => { registerUiPreference(id, adapter); };
  let sharedBackgroundId = getBackground().id === "custom" ? DEFAULT_BACKGROUND_ID : getBackground().id;
  register("core.background", {
    // A custom image is a device asset; embedding a multi-megabyte data URL
    // in every unrelated settings PUT/WS frame made the UI stutter.
    read: () => {
      const currentId = getBackground().id;
      if (currentId !== "custom") sharedBackgroundId = currentId;
      return { id: sharedBackgroundId };
    },
    write: (value) => {
      const id = value && typeof value === "object" && "id" in value
        ? (value as { id?: unknown }).id
        : undefined;
      if (id === "custom") return; // Legacy server image remains local to its source device.
      const next = parseBackgroundState(JSON.stringify({ id }));
      sharedBackgroundId = next.id === "custom" ? DEFAULT_BACKGROUND_ID : next.id;
      if (getBackground().id !== "custom" && getBackground().id !== sharedBackgroundId) setBackground(sharedBackgroundId);
    },
    subscribe: subscribeBackground,
  });
  register("core.sidebar-layout", {
    read: () => ({ width: getSidebarLayout().width }),
    write: (value) => {
      const next = parseSidebarLayout(JSON.stringify(value));
      setSidebarLayout({ width: next.width });
    },
    subscribe: subscribeSidebarLayout,
  });
  register("core.sidebar", {
    read: getSidebarPrefsSnapshot,
    write: replaceSidebarPrefs,
    subscribe: subscribeSidebarPrefs,
  });
  register("core.rail", {
    read: () => ({ widths: getRailPrefs().widths }),
    write: (value) => {
      const incoming = value && typeof value === "object" ? value as { widths?: unknown } : {};
      replaceRailPrefs({ ...getRailPrefs(), widths: incoming.widths });
    },
    subscribe: subscribeRailPrefs,
  });
  register("core.editor", {
    read: getEditorPrefs,
    write: (value) => setEditorPrefs(parseEditorPrefs(JSON.stringify(value))),
    subscribe: subscribeEditorPrefs,
  });
  register("core.package-tours", {
    read: getPackageTourPrefs,
    write: (value) => replacePackageTourPrefs(parsePackageTourPrefs(JSON.stringify(value))),
    subscribe: subscribePackageTourPrefs,
  });
  register(SHELL_INTRO_PREFERENCE_ID, {
    read: getShellIntroPrefs,
    write: replaceShellIntroPrefs,
    subscribe: subscribeShellIntroPrefs,
  });
  register("core.custom-themes", {
    read: loadCustomThemes,
    write: (value) => replaceCustomThemes(parseCustomThemes(JSON.stringify(value))),
    subscribe: subscribeCustomThemes,
  });
  register("core.hero-widgets", {
    read: getHeroWidgetPrefs,
    write: replaceHeroWidgetPrefs,
    subscribe: subscribeHeroWidgetPrefs,
  });
  // Its own id, not a `core.hero-widgets` field: a client that predates the
  // board keeps the unknown id instead of erasing it.
  register("core.hero-board", {
    read: getHeroBoard,
    write: replaceHeroBoard,
    subscribe: subscribeHeroBoard,
  });
  register("core.project-icons", {
    read: () => ({ favorites: getProjectIconPrefs().favorites }),
    write: (value) => {
      const incoming = value && typeof value === "object" ? value as { favorites?: unknown } : {};
      replaceProjectIconPrefs({ ...getProjectIconPrefs(), favorites: incoming.favorites });
    },
    subscribe: subscribeProjectIconPrefs,
  });
  register("core.thinking", {
    read: getThinkingPrefs,
    write: replaceThinkingPrefs,
    subscribe: subscribeThinkingPrefs,
  });
  // A preference id, not a modelPrefs field: a client that predates it keeps
  // the unknown id instead of erasing it from the account record.
  register("core.last-harness-models", {
    read: getLastHarnessModelsRecord,
    write: replaceLastHarnessModels,
    subscribe: subscribeLastHarnessModels,
  });
  // Phone composer buttons are per Space + project; mirroring them by id (not
  // by device) is what lets a second client inherit the arrangement.
  register(MOBILE_RAIL_PREFERENCE_ID, mobileRailPreference);
  // One interface for every project, or one per project; the shared
  // arrangement itself travels with the account in the second record.
  register(PROJECT_INTERFACE_PREFERENCE_ID, projectInterfacePreference);
  register(SHARED_PROJECT_INTERFACE_PREFERENCE_ID, sharedProjectPresentationPreference);
}

/** Pull the server copy once, then keep it in step with local edits. Safe to
 *  call again on reconnect — it only wires the subscriptions the first time. */
export function initSettingsSync(): void {
  if (!started) {
    started = true;
    registerCorePreferences();
    lastSyncedJson = JSON.stringify(currentBlob());
    initialBaseline = currentBlob();
    let previousSettings = getState().settings;
    subscribeStore(() => {
      const next = getState().settings;
      if (next === previousSettings) return;
      previousSettings = next;
      schedulePush();
    });
    subscribeUiSettings(schedulePush);
    subscribeSessionDefaults(schedulePush);
    subscribeModelPrefs(schedulePush);
    if (typeof window !== "undefined") window.addEventListener("pagehide", flushSettingsSync);
    const fallback = setTimeout(markSettled, SETTLE_FALLBACK_MS) as unknown as { unref?: () => void };
    fallback.unref?.();
  }
  void api.clientSettings()
    .then((dto) => {
      if (dto.revision > 0) reconcileRemote(dto);
      // Server never written yet: seed it from this client's local records,
      // including any pre-server model preference state.
      else {
        if (localRevision < 0) {
          localRevision = 0;
          lastSyncedJson = "";
          schedulePush();
        }
      }
      markSettled();
    })
    .catch(() => {
      markSettled();
      // No server reachable — local caches keep driving the UI. A reconnect
      // calls initSettingsSync() again and retries any unsynced blob.
    });
}
