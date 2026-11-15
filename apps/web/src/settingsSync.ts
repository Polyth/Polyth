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
import { normalizeSettings, type PolythSettings } from "./settings.ts";
import { hasClientPersistenceBackend } from "./clientPersistence.ts";
import {
  encodeSettingsLook,
  LOOK_PREFERENCE_IDS,
  pickLookProduct,
  pickLookUi,
  readSettingsLook,
  writeSettingsLook,
  type SettingsLook,
} from "./settingsSnapshot.ts";
import { getState, subscribeStore, updateSettings } from "./store.ts";
import { getUiSettings, parseUiSettings, setUiSettings, subscribeUiSettings, type UiSettings } from "./uiPrefs.ts";
import {
  getSessionDefaults,
  parseSessionDefaults,
  setSessionDefaults,
  subscribeSessionDefaults,
} from "./sessionDefaults.ts";
import {
  DEFAULT_BACKGROUND_ID,
  getBackground,
  type BackgroundId,
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

// ---- per-device appearance sync ------------------------------------------------
// "Sync appearance with server" is a device-local choice: it never reaches the
// account blob. When it is OFF this device keeps its own look — it neither
// applies remote appearance changes nor pushes its own — while every other
// setting keeps syncing. The fields that count as "appearance" are exactly the
// Appearance settings page's own controls, enumerated here so the sync boundary
// and the page cannot drift apart.

/** Product settings that shape the look, from the Appearance page. */
export const APPEARANCE_PRODUCT_KEYS = [
  "theme", "appearanceMode", "themeStyle", "accentColor", "density",
  "fontSize", "chatFontSize", "fontFamily",
] as const satisfies readonly (keyof PolythSettings)[];

/** UI settings that shape the look, from the Appearance page. */
export const APPEARANCE_UI_KEYS = [
  "density", "fontSize", "headerFontSize", "subheaderFontSize", "terminalFontSize",
  "editorFontSize", "rounding", "glassEffect", "hideBorders", "shellLook",
  "mirrorLayout", "chatWidth", "topRailSurface", "shellLayout", "shellBarStyle",
  "floatingColumns", "shellToolsDock", "shellActionsDock", "shellTitle",
  "topRailSize", "rightRailSize", "leftRailSize", "railSpacing",
] as const satisfies readonly (keyof UiSettings)[];

/** Account preferences that shape the look (wallpaper preset, custom themes). */
export const APPEARANCE_PREFERENCE_IDS = ["core.background", "core.custom-themes"] as const;

/** Device-local storage key for the toggle. It is deliberately outside the
 *  synced blob and outside the product/UI settings stores, so it can never be
 *  captured into a PUT or read back from a server snapshot. */
const APPEARANCE_SYNC_KEY = "polyth.appearanceSync.v1";
const appearanceSyncListeners = new Set<() => void>();
let appearanceSyncEnabled = readAppearanceSyncFlag();

function readAppearanceSyncFlag(): boolean {
  try { return localStorage.getItem(APPEARANCE_SYNC_KEY) !== "0"; } catch { return true; }
}

/** Whether this device pushes/pulls the appearance fields. Defaults ON. */
export function isAppearanceSyncEnabled(): boolean {
  return appearanceSyncEnabled;
}

/** Change the toggle. OFF freezes the current local look; ON adopts the
 *  server look (the least surprising: the account's look wins over this
 *  device's frozen one, with no flicker and no push of the frozen look). */
export function setAppearanceSyncEnabled(enabled: boolean): void {
  if (appearanceSyncEnabled === enabled) return;
  appearanceSyncEnabled = enabled;
  try {
    if (enabled) localStorage.removeItem(APPEARANCE_SYNC_KEY);
    else localStorage.setItem(APPEARANCE_SYNC_KEY, "0");
  } catch { /* private mode */ }
  if (enabled) adoptServerAppearance();
  for (const listener of appearanceSyncListeners) listener();
  // Re-baseline so the transition itself does not trigger a push: turning ON
  // has just overwritten the local look with the server's, and turning OFF
  // must not re-send the (now frozen) local look as though it were new.
  if (started && localRevision >= 0) {
    initialBaseline = currentBlob();
    lastSyncedJson = JSON.stringify(initialBaseline);
  }
}

export function subscribeAppearanceSync(listener: () => void): () => void {
  appearanceSyncListeners.add(listener);
  return () => { appearanceSyncListeners.delete(listener); };
}

/** Copy the appearance fields from the last confirmed server record into the
 *  local stores, so a freshly re-enabled sync starts from the account's look
 *  rather than pushing this device's frozen one. A null record (server not yet
 *  answered) leaves the local look as it is. */
function adoptServerAppearance(): void {
  const remote = lastServerSettings;
  if (remote === null) return;
  const wasApplying = applying;
  applying = true;
  try {
    if (isObject(remote.product)) {
      const next = { ...getState().settings } as Record<string, unknown>;
      for (const key of APPEARANCE_PRODUCT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(remote.product, key)) next[key] = remote.product[key];
      }
      updateSettings(normalizeSettings(next));
    }
    if (isObject(remote.ui)) {
      const next = { ...getUiSettings() } as Record<string, unknown>;
      for (const key of APPEARANCE_UI_KEYS) {
        if (Object.prototype.hasOwnProperty.call(remote.ui, key)) next[key] = remote.ui[key];
      }
      setUiSettings(parseUiSettings(JSON.stringify(next)));
    }
    if (isObject(remote.preferences)) {
      for (const id of APPEARANCE_PREFERENCE_IDS) {
        if (!Object.prototype.hasOwnProperty.call(remote.preferences, id)) continue;
        const adapter = preferenceAdapters.get(id);
        const value = remote.preferences[id];
        if (adapter && isJsonValue(value)) {
          try { adapter.write(value); capturePreference(id, adapter.read()); } catch { /* unavailable */ }
        }
      }
    }
  } finally {
    applying = wasApplying;
  }
}

/** When sync is OFF, the pushed blob must carry the server's appearance (so it
 *  is neither overwritten by nor erased from the account) rather than this
 *  device's own. Appearance keys the server has no word on are dropped. */
function gateAppearanceForPush(
  product: Record<string, unknown>,
  ui: Record<string, unknown>,
  preferences: Record<string, unknown>,
): void {
  if (appearanceSyncEnabled) return;
  const serverProduct = lastServerSettings && isObject(lastServerSettings.product) ? lastServerSettings.product : null;
  const serverUi = lastServerSettings && isObject(lastServerSettings.ui) ? lastServerSettings.ui : null;
  const serverPreferences = lastServerSettings && isObject(lastServerSettings.preferences) ? lastServerSettings.preferences : null;
  for (const key of APPEARANCE_PRODUCT_KEYS) {
    if (serverProduct && Object.prototype.hasOwnProperty.call(serverProduct, key)) product[key] = serverProduct[key];
    else delete product[key];
  }
  for (const key of APPEARANCE_UI_KEYS) {
    if (serverUi && Object.prototype.hasOwnProperty.call(serverUi, key)) ui[key] = serverUi[key];
    else delete ui[key];
  }
  for (const id of APPEARANCE_PREFERENCE_IDS) {
    if (serverPreferences && Object.prototype.hasOwnProperty.call(serverPreferences, id)) preferences[id] = serverPreferences[id];
    else delete preferences[id];
  }
}

/** Copy the appearance fields from `local` into a copy of the merged `target`,
 *  so a remote snapshot never overwrites this device's look while the toggle
 *  is OFF. The input is never mutated: `mergeLocal` can return the remote
 *  object verbatim, and mutating it would corrupt the stored server record. */
function withLocalAppearance(target: unknown, local: unknown, keys: readonly string[]): unknown {
  if (!isObject(target) || !isObject(local)) return target;
  const copy: Record<string, unknown> = { ...target };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(local, key)) copy[key] = local[key];
  }
  return copy;
}


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
  const product = { ...getState().settings } as Record<string, unknown>;
  const ui = { ...getUiSettings() } as Record<string, unknown>;
  const preferences = currentPreferences() as Record<string, unknown>;
  gateAppearanceForPush(product, ui, preferences);
  return {
    product: product as unknown as SettingsBlob["product"],
    ui: ui as unknown as SettingsBlob["ui"],
    sessionDefaults: getSessionDefaults(),
    modelPrefs: getModelPrefs(),
    modelVisibility: getModelVisibilityPrefs(),
    preferences: preferences as Record<string, JsonValue>,
  };
}

/** The stores as they stand right now, appearance included and ungated. Used
 *  as the merge base in `applyRemote`, so a remote snapshot cannot overwrite an
 *  appearance change the toggle keeps local, nor erase a local field a
 *  mergeLocal walk would otherwise take from the server. */
function localSnapshot(): SettingsBlob {
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

// ---- remembered look ------------------------------------------------------------
// The native shell's origin storage is empty on every launch, so the account's
// theme and wallpaper would otherwise arrive only with the server's answer. The
// last launch's look (settingsSnapshot.ts) is applied to the local stores
// before the first render, strictly *before* initSettingsSync() snapshots its
// baseline: from then on it is just the local state the client started with,
// so the server's answer replaces it through the ordinary merge, an edit made
// meanwhile still wins for its own field, and nothing is pushed because of it
// (pushes need a server revision, and the baseline already equals the blob).

const LOOK_WRITE_DELAY_MS = 2_000;

interface RememberedLook {
  /** What the stores held before the remembered look went in. */
  previous: SettingsLook;
  /** What the stores held right after it did. */
  applied: SettingsLook;
}

let remembered: RememberedLook | null = null;
let lookTimer: ReturnType<typeof setTimeout> | undefined;
let lastLookJson = "";

function currentLook(): SettingsLook {
  const background = getBackground().id;
  const product = pickLookProduct(getState().settings);
  return {
    product,
    ui: pickLookUi(getUiSettings()),
    background: background === "custom" ? sharedBackgroundIdFallback() : background,
    customTheme: loadCustomThemes().find((theme) => theme.id === product.theme) ?? null,
    preferences: currentLookPreferences(),
  };
}

function currentLookPreferences(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of LOOK_PREFERENCE_IDS) {
    const adapter = preferenceAdapters.get(id);
    if (!adapter) continue;
    try {
      const value = adapter.read();
      if (isJsonValue(value)) out[id] = value;
    } catch { /* an unreadable store is simply not remembered */ }
  }
  return out;
}

/** Write remembered preference values through their registered adapters, which
 *  validate them, and keep the captured values (the sync baseline) in step. */
function applyLookPreferences(values: Record<string, unknown>): void {
  for (const [id, value] of Object.entries(values)) {
    const adapter = preferenceAdapters.get(id);
    if (!adapter || !isJsonValue(value)) continue;
    try {
      if (!sameJson(adapter.read(), value)) adapter.write(value);
      capturePreference(id, adapter.read());
    } catch { /* a broken store keeps what it had */ }
  }
}

/** The wallpaper preset the account shares while a device image is in use. */
function sharedBackgroundIdFallback(): string {
  const shared = preferenceValues.get("core.background");
  const id = isObject(shared) ? shared.id : undefined;
  return typeof id === "string" && id !== "custom" ? id : DEFAULT_BACKGROUND_ID;
}

/** `dropThemeId`: a custom theme this client added on the remembered look's
 *  behalf and that is to leave again. Other custom themes are never touched. */
function applyLook(look: SettingsLook, dropThemeId: string | null = null): void {
  const wasApplying = applying;
  applying = true;
  try {
    // Palette first: a custom theme must exist before the setting names it.
    const themes = loadCustomThemes();
    const wanted = look.customTheme;
    if (wanted && !sameJson(themes.find((theme) => theme.id === wanted.id), wanted)) {
      replaceCustomThemes([...themes.filter((theme) => theme.id !== wanted.id), wanted]);
    } else if (!wanted && dropThemeId && themes.some((theme) => theme.id === dropThemeId)) {
      replaceCustomThemes(themes.filter((theme) => theme.id !== dropThemeId));
    }
    updateSettings(look.product);
    setUiSettings(look.ui);
    applyLookPreferences(look.preferences);
    // Last, so the system bar colour follows the palette and the wallpaper. An
    // empty id is a preset this build does not know: keep the current one.
    if (look.background && getBackground().id !== "custom" && getBackground().id !== look.background) {
      setBackground(look.background as BackgroundId);
    }
  } finally {
    applying = wasApplying;
  }
}

/** Put the last launch's look on screen before the first render. Returns true
 *  when one was applied. Does nothing in a browser (localStorage already works
 *  there) or once sync started: the caller runs it before anything renders, so
 *  nothing the person did can be older than it. */
export async function restoreRememberedLook(): Promise<boolean> {
  if (started || remembered !== null || !hasClientPersistenceBackend()) return false;
  const record = await readSettingsLook();
  if (record === null || started || remembered !== null) return false;
  // The adapters exist before the first render (registration is idempotent),
  // so the remembered preferences land in their stores now and in the sync
  // baseline taken at start.
  registerCorePreferences();
  const previous = currentLook();
  try {
    applyLook(record);
  } catch {
    applyLook(previous);
    return false;
  }
  remembered = { previous, applied: currentLook() };
  return true;
}

/** The first server answer is in (`remote`; null = the server holds no record).
 *  A part of the remembered look the person did not touch and the server has
 *  no word on goes back to what the client had, so it is never pushed up as
 *  though it were the account's choice. */
function settleRememberedLook(remote: { product?: unknown; ui?: unknown; preferences?: unknown } | null): void {
  const mine = remembered;
  remembered = null;
  if (mine === null) return;
  const now = currentLook();
  const preferences = remote && isObject(remote.preferences) ? remote.preferences : {};
  const next: SettingsLook = { ...now, preferences: { ...now.preferences } };
  let changed = false;
  if (!(remote && isObject(remote.product)) && sameJson(now.product, mine.applied.product) && !sameJson(now.product, mine.previous.product)) {
    next.product = mine.previous.product; changed = true;
  }
  if (!(remote && isObject(remote.ui)) && sameJson(now.ui, mine.applied.ui) && !sameJson(now.ui, mine.previous.ui)) {
    next.ui = mine.previous.ui; changed = true;
  }
  if (!("core.background" in preferences) && now.background === mine.applied.background && now.background !== mine.previous.background) {
    next.background = mine.previous.background; changed = true;
  }
  if (!("core.custom-themes" in preferences) && sameJson(now.customTheme, mine.applied.customTheme) && !sameJson(now.customTheme, mine.previous.customTheme)) {
    next.customTheme = mine.previous.customTheme; changed = true;
  }
  for (const id of LOOK_PREFERENCE_IDS) {
    if (id in preferences) continue;
    if (!sameJson(now.preferences[id], mine.applied.preferences[id]) || sameJson(now.preferences[id], mine.previous.preferences[id])) continue;
    if (id in mine.previous.preferences) next.preferences[id] = mine.previous.preferences[id];
    changed = true;
  }
  if (!changed) return;
  applyLook(next, mine.applied.customTheme?.id ?? null);
  for (const id of ["core.background", "core.custom-themes"]) {
    const adapter = preferenceAdapters.get(id);
    if (adapter) { try { capturePreference(id, adapter.read()); } catch { /* unavailable */ } }
  }
  initialBaseline = currentBlob();
  lastSyncedJson = JSON.stringify(initialBaseline);
}

function writeLookNow(): void {
  if (lookTimer !== undefined) { clearTimeout(lookTimer); lookTimer = undefined; }
  // Only a look the server has answered for: a launch must never re-save its
  // own remembered copy (or a fetch that failed) as if it were current.
  if (localRevision < 0 || remembered !== null || !hasClientPersistenceBackend()) return;
  const encoded = encodeSettingsLook(currentLook(), Date.now());
  if (encoded === null) return;
  const content = JSON.stringify(currentLook());
  if (content === lastLookJson) return;
  lastLookJson = content;
  writeSettingsLook(encoded);
}

function rememberLook(): void {
  if (lookTimer !== undefined || !hasClientPersistenceBackend()) return;
  lookTimer = setTimeout(writeLookNow, LOOK_WRITE_DELAY_MS);
  (lookTimer as unknown as { unref?: () => void }).unref?.();
}

/** Test seam: forget this document's remembered-look state. */
export function resetRememberedLookForTest(): void {
  remembered = null;
  lastLookJson = "";
  if (lookTimer !== undefined) clearTimeout(lookTimer);
  lookTimer = undefined;
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
  settleRememberedLook(incoming);
  const before = localSnapshot();
  const base = lastServerSettings ?? initialBaseline ?? before;
  const mergeSection = (key: keyof SettingsBlob): unknown => {
    const remote = incoming[key];
    if (!isObject(remote)) return before[key];
    return mergeLocal(base[key], before[key], remote);
  };
  // The toggle OFF keeps this device's look: remote appearance changes are
  // never applied, while every other section still merges normally. Re-assert
  // the local values for exactly the appearance fields after the merge. This
  // must not mutate the incoming/remote object (mergeLocal can hand it back
  // verbatim), or the server record we just stored would lose the account's
  // real appearance and the next adopt/push would see the local look instead.
  const mergedProduct = !appearanceSyncEnabled
    ? withLocalAppearance(mergeSection("product"), before.product, APPEARANCE_PRODUCT_KEYS)
    : mergeSection("product");
  const mergedUi = !appearanceSyncEnabled
    ? withLocalAppearance(mergeSection("ui"), before.ui, APPEARANCE_UI_KEYS)
    : mergeSection("ui");
  const mergedDefaults = mergeSection("sessionDefaults");
  const mergedModels = mergeSection("modelPrefs");
  // The visibility section is server-owned: when the record has one, take it as
  // given (it is the account's list, already merged server-side); a record that
  // predates it leaves the local copy untouched.
  const mergedVisibility = isObject(incoming.modelVisibility)
    ? parseModelVisibilityPrefs(incoming.modelVisibility)
    : before.modelVisibility;
  const mergedPreferences = isObject(incoming.preferences)
    ? (appearanceSyncEnabled
      ? mergeLocal(base.preferences ?? {}, before.preferences, incoming.preferences)
      : withLocalAppearance(mergeLocal(base.preferences ?? {}, before.preferences, incoming.preferences), before.preferences, APPEARANCE_PREFERENCE_IDS))
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
    // Server-owned: a PUT never changes it, and a record that has none (an
    // account that never toggled a model) says nothing about it. Counting that
    // as a difference re-pushed the same blob on every echo of our own write.
    modelVisibility: mergedVisibility,
    preferences: incoming.preferences,
  });
  rememberLook();
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
        rememberLook();
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
  writeLookNow();
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

/** Test seam: forget this document's sync state so one test file can run
 *  several launches. Subscriptions stay (they only schedule a push). */
export function resetSettingsSyncForTest(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  localRevision = -1;
  lastSyncedJson = "";
  lastServerSettings = null;
  initialBaseline = null;
  pushInFlight = null;
  applying = false;
  started = false;
  settled = false;
  preferenceValues.clear();
  for (const [id, adapter] of preferenceAdapters) capturePreference(id, adapter.read());
  appearanceSyncEnabled = readAppearanceSyncFlag();
  resetRememberedLookForTest();
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
          settleRememberedLook(null);
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
