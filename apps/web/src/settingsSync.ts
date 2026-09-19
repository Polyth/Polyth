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
import { api } from "@polyth/session/web-api";
import type { ClientSettingsDto } from "@polyth/contracts";
import { parseModelPrefs } from "@polyth/models";
import {
  getModelPrefs,
  replaceModelPrefs,
  subscribeModelPrefs,
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
  listClientSettingsContributions,
  subscribeClientSettingsContributions,
  type ClientSettingsContribution,
} from "./clientSettingsRegistry.ts";

const PUSH_DEBOUNCE_MS = 500;

let localRevision = -1;
let lastSyncedJson = "";
let applying = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let remoteLoaded = false;
let retainedPackagePrefs: Record<string, unknown> = {};
const contributionSubscriptions = new Map<string, {
  contribution: ClientSettingsContribution;
  unsubscribe: () => void;
}>();

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
  /** Package-owned preference slices. Unknown/disabled package entries are
   * retained so a core settings write can never erase optional package state. */
  packagePrefs: Record<string, unknown>;
}

function packagePrefsSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...retainedPackagePrefs };
  for (const contribution of listClientSettingsContributions()) {
    snapshot[contribution.id] = contribution.get();
  }
  return snapshot;
}

function currentBlob(): SettingsBlob {
  return {
    product: getState().settings,
    ui: getUiSettings(),
    sessionDefaults: getSessionDefaults(),
    modelPrefs: getModelPrefs(),
    packagePrefs: packagePrefsSnapshot(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Apply a newer server snapshot locally without bouncing it straight back. */
function applyRemote(dto: ClientSettingsDto): void {
  if (dto.revision <= localRevision) return;
  const incoming = dto.settings as {
    product?: unknown;
    ui?: unknown;
    sessionDefaults?: unknown;
    modelPrefs?: unknown;
    packagePrefs?: unknown;
    /** Short-lived pre-registry Usage branch compatibility. */
    usagePrefs?: unknown;
  };
  const nextPackagePrefs = isObject(incoming.packagePrefs)
    ? { ...incoming.packagePrefs }
    : {};
  if (!Object.prototype.hasOwnProperty.call(nextPackagePrefs, "usage") && isObject(incoming.usagePrefs)) {
    nextPackagePrefs.usage = incoming.usagePrefs;
  }
  retainedPackagePrefs = nextPackagePrefs;
  applying = true;
  try {
    if (isObject(incoming.product)) updateSettings(normalizeSettings(incoming.product));
    if (isObject(incoming.ui)) setUiSettings(parseUiSettings(JSON.stringify(incoming.ui)));
    if (isObject(incoming.sessionDefaults)) {
      setSessionDefaults(parseSessionDefaults(JSON.stringify(incoming.sessionDefaults)));
    }
    if (isObject(incoming.modelPrefs)) {
      replaceModelPrefs(parseModelPrefs(JSON.stringify(incoming.modelPrefs)));
    }
    for (const contribution of listClientSettingsContributions()) {
      if (!Object.prototype.hasOwnProperty.call(retainedPackagePrefs, contribution.id)) continue;
      contribution.apply(retainedPackagePrefs[contribution.id]);
    }
  } finally {
    applying = false;
  }
  localRevision = dto.revision;
  remoteLoaded = true;
  lastSyncedJson = JSON.stringify(currentBlob());
}

/** Reconcile a server snapshot and preserve two important migration/retry cases:
 *  - older server records without modelPrefs are backfilled from the existing
 *    account-local cache exactly like a first server seed;
 *  - an unchanged server revision after a failed/offline push retries any local
 *    blob that still differs from the last confirmed server state. */
function reconcileRemote(dto: ClientSettingsDto): void {
  const incoming = dto.settings as {
    modelPrefs?: unknown;
    packagePrefs?: unknown;
    usagePrefs?: unknown;
  };
  const serverHasModelPrefs = isObject(incoming.modelPrefs);
  const rawPackagePrefs = isObject(incoming.packagePrefs) ? incoming.packagePrefs : {};
  const missingActivePackagePrefs = listClientSettingsContributions().some((contribution) =>
    !Object.prototype.hasOwnProperty.call(rawPackagePrefs, contribution.id)
      && !(contribution.id === "usage" && isObject(incoming.usagePrefs)));
  applyRemote(dto);
  if (!serverHasModelPrefs || missingActivePackagePrefs) lastSyncedJson = "";
  if (JSON.stringify(currentBlob()) !== lastSyncedJson) schedulePush();
}

function push(opts?: { keepalive?: boolean }): void {
  timer = undefined;
  if (applying) return;
  const blob = currentBlob();
  const json = JSON.stringify(blob);
  if (json === lastSyncedJson) return;
  void api.clientSettingsSave(blob as unknown as Record<string, unknown>, opts)
    .then((dto) => {
      lastSyncedJson = json;
      if (dto.revision > localRevision) localRevision = dto.revision;
    })
    .catch(() => {
      // Offline or server rejected the write — the local record still stands.
      // initSettingsSync() compares it again on reconnect and retries.
    });
}

function schedulePush(): void {
  if (applying || timer !== undefined) return;
  timer = setTimeout(push, PUSH_DEBOUNCE_MS);
}

function syncContributionSubscriptions(): void {
  const active = new Map(listClientSettingsContributions().map((contribution) => [contribution.id, contribution]));

  for (const [id, record] of [...contributionSubscriptions]) {
    if (active.has(id)) continue;
    // Preserve the last local value even when the optional package unloads.
    retainedPackagePrefs[id] = record.contribution.get();
    record.unsubscribe();
    contributionSubscriptions.delete(id);
    if (remoteLoaded) schedulePush();
  }

  for (const contribution of active.values()) {
    if (contributionSubscriptions.has(contribution.id)) continue;
    const unsubscribe = contribution.subscribe(schedulePush);
    contributionSubscriptions.set(contribution.id, { contribution, unsubscribe });

    if (!remoteLoaded) continue;
    if (Object.prototype.hasOwnProperty.call(retainedPackagePrefs, contribution.id)) {
      applying = true;
      try {
        contribution.apply(retainedPackagePrefs[contribution.id]);
      } finally {
        applying = false;
      }
    } else {
      // Server record predates this package slice: local cache seeds it once.
      schedulePush();
    }
  }
}

export function flushSettingsSync(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  push({ keepalive: true });
}

/** WS gateway frame: another client changed the shared settings. */
export function applyRemoteClientSettings(dto: ClientSettingsDto): void {
  reconcileRemote(dto);
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
    subscribeModelPrefs(schedulePush);
    subscribeClientSettingsContributions(syncContributionSubscriptions);
    syncContributionSubscriptions();
    if (typeof window !== "undefined") window.addEventListener("pagehide", flushSettingsSync);
  }
  void api.clientSettings()
    .then((dto) => {
      if (dto.revision > 0) reconcileRemote(dto);
      // Server never written yet: seed it from this client's local records,
      // including any pre-server model preference state.
      else {
        localRevision = 0;
        remoteLoaded = true;
        schedulePush();
      }
    })
    .catch(() => {
      // No server reachable — local caches keep driving the UI. A reconnect
      // calls initSettingsSync() again and retries any unsynced blob.
    });
}
