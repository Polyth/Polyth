// Server-backed client preferences. Product settings (theme, density, interface
// scale, …) and UI preferences travel together as one blob so every device that
// talks to this server paints the same way. Local storage stays the fast path;
// this module mirrors it to `/api/settings/client` and applies any change that
// lands from another device over the WS gateway.
//
// Echo handling is value-based: a push only fires when the serialized blob
// actually differs from what the server last confirmed, so re-applying an
// inbound snapshot (which re-enters updateSettings/setUiSettings) can never
// loop back into another push.
import { api } from "@polyth/session/web-api";
import type { ClientSettingsDto } from "@polyth/contracts";
import { normalizeSettings } from "./settings.ts";
import { getState, subscribeStore, updateSettings } from "./store.ts";
import { getUiSettings, parseUiSettings, setUiSettings, subscribeUiSettings } from "./uiPrefs.ts";
import {
  getSessionDefaults,
  parseSessionDefaults,
  setSessionDefaults,
  subscribeSessionDefaults,
} from "./sessionDefaults.ts";

const PUSH_DEBOUNCE_MS = 500;

let localRevision = -1;
let lastSyncedJson = "";
let applying = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

interface SettingsBlob {
  product: ReturnType<typeof normalizeSettings>;
  ui: ReturnType<typeof getUiSettings>;
  // Session defaults travel with the shared blob so server-side small-model
  // generation (commit messages, next-action, task brief) uses the model the
  // user picked in Settings, and so the picks follow them across devices.
  sessionDefaults: ReturnType<typeof getSessionDefaults>;
}

function currentBlob(): SettingsBlob {
  return { product: getState().settings, ui: getUiSettings(), sessionDefaults: getSessionDefaults() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Apply a server snapshot locally without bouncing it straight back. */
function applyRemote(dto: ClientSettingsDto): void {
  if (dto.revision <= localRevision) return;
  const incoming = dto.settings as { product?: unknown; ui?: unknown; sessionDefaults?: unknown };
  applying = true;
  try {
    if (isObject(incoming.product)) updateSettings(normalizeSettings(incoming.product));
    if (isObject(incoming.ui)) setUiSettings(parseUiSettings(JSON.stringify(incoming.ui)));
    if (isObject(incoming.sessionDefaults)) {
      setSessionDefaults(parseSessionDefaults(JSON.stringify(incoming.sessionDefaults)));
    }
  } finally {
    applying = false;
  }
  localRevision = dto.revision;
  lastSyncedJson = JSON.stringify(currentBlob());
}

function push(): void {
  timer = undefined;
  if (applying) return;
  const json = JSON.stringify(currentBlob());
  if (json === lastSyncedJson) return;
  void api.clientSettingsSave(currentBlob() as unknown as Record<string, unknown>)
    .then((dto) => {
      lastSyncedJson = json;
      if (dto.revision > localRevision) localRevision = dto.revision;
    })
    .catch(() => {
      // Offline or server rejected the write — the local record still stands
      // and the next change (or reconnect) retries.
    });
}

function schedulePush(): void {
  if (applying || timer !== undefined) return;
  timer = setTimeout(push, PUSH_DEBOUNCE_MS);
}

/** Cancel any pending debounce and push immediately. Used on pagehide /
 *  beforeunload so a mid-debounce settings change is not dropped on exit. */
export function flushSettingsSync(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  push();
}

function installUnloadFlush(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", flushSettingsSync);
  window.addEventListener("beforeunload", flushSettingsSync);
}

/** WS gateway frame: another device changed the shared settings. */
export function applyRemoteClientSettings(dto: ClientSettingsDto): void {
  applyRemote(dto);
}

/** Pull the server copy once, then keep it in step with local edits. Safe to
 *  call again on reconnect — it only wires the subscriptions the first time. */
export function initSettingsSync(): void {
  if (!started) {
    started = true;
    lastSyncedJson = JSON.stringify(currentBlob());
    subscribeStore(schedulePush);
    subscribeUiSettings(schedulePush);
    subscribeSessionDefaults(schedulePush);
    installUnloadFlush();
  }
  void api.clientSettings()
    .then((dto) => {
      if (dto.revision > 0) applyRemote(dto);
      // Server never written yet: seed it from this device's local record.
      else { localRevision = 0; schedulePush(); }
    })
    .catch(() => {
      // No server reachable — local storage keeps driving the UI.
    });
}
