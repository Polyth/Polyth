// Versioned, project-scoped workbench persistence: the active profile plus one
// layout per profile, region sizes, surface placements, collapsed regions,
// per-surface geometry, and the legacy per-surface "last resource" memory.
// Pure parse/serialize/migrate helpers are DOM-free so node --test covers
// versioning, idempotence, and project isolation directly.
//
// Storage key: polyth.workbenchLayout.v1.<projectId>. One record per project —
// a layout is never copied between projects. Layout preferences are browser
// presentation state and are never written to the session event log.
//
// Migration: the previous record, polyth.workspacePane.v2.<projectId> (one
// package window: openSurface + dynamic/pinned/fullscreen mode + widths/heights
// + lastResource), becomes the conversation profile's layout. The legacy key is
// removed only after the new record has been written.
import type { WorkbenchLayoutTemplate } from "@polyth/web-sdk";
import {
  emptyLayout,
  layoutFromTemplate,
  parseLayout,
  placementOf,
  resizeSurface,
  withoutTransient,
  type WorkbenchLayout,
} from "./layout.ts";
import { CONVERSATION_PROFILE_ID, CONVERSATION_TEMPLATE } from "./profiles.ts";
import {
  legacyWorkspacePaneKeys,
  parseWorkspacePanePrefs,
  type WorkspacePanePrefs,
} from "../workspace/panePrefs.ts";
import { markProjectPresentationChanged } from "../projectPresentationSync.ts";

export const WORKBENCH_PREFS_VERSION = 1;

export interface WorkbenchProfileRecord {
  layout: WorkbenchLayout;
  /** The user moved/resized/swapped something: the layout is no longer the
   *  package-defined default (Reset returns to it). */
  customized: boolean;
}

export interface WorkbenchPrefs {
  version: typeof WORKBENCH_PREFS_VERSION;
  activeProfile: string;
  profiles: Record<string, WorkbenchProfileRecord>;
  /** Compatibility: last provider resource per surface (e.g. "changes:a.ts"). */
  lastResource: Record<string, string>;
}

export function workbenchPrefsKey(projectId: string): string {
  return `polyth.workbenchLayout.v${WORKBENCH_PREFS_VERSION}.${projectId}`;
}

export function emptyWorkbenchPrefs(): WorkbenchPrefs {
  return { version: WORKBENCH_PREFS_VERSION, activeProfile: CONVERSATION_PROFILE_ID, profiles: {}, lastResource: {} };
}

const MAX_PROFILES = 32;
const MAX_RESOURCES = 64;
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function parseWorkbenchPrefs(raw: string | null): WorkbenchPrefs | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null || data.version !== WORKBENCH_PREFS_VERSION) return null;
    const prefs = emptyWorkbenchPrefs();
    if (typeof data.activeProfile === "string" && PROFILE_ID.test(data.activeProfile)) {
      prefs.activeProfile = data.activeProfile;
    }
    const profiles = typeof data.profiles === "object" && data.profiles !== null
      ? data.profiles as Record<string, unknown>
      : {};
    for (const [id, record] of Object.entries(profiles).slice(0, MAX_PROFILES)) {
      if (!PROFILE_ID.test(id) || typeof record !== "object" || record === null) continue;
      const value = record as { layout?: unknown; customized?: unknown };
      prefs.profiles[id] = {
        layout: parseLayout(value.layout),
        customized: value.customized === true,
      };
    }
    if (typeof data.lastResource === "object" && data.lastResource !== null) {
      for (const [id, resource] of Object.entries(data.lastResource as Record<string, unknown>).slice(0, MAX_RESOURCES)) {
        if (id && typeof resource === "string" && resource) prefs.lastResource[id] = resource;
      }
    }
    return prefs;
  } catch {
    return null;
  }
}

export function serializeWorkbenchPrefs(prefs: WorkbenchPrefs): string {
  return JSON.stringify(prefs);
}

/** Pure legacy migration: one package window → the conversation layout. */
export function migrateWorkspacePanePrefs(legacy: WorkspacePanePrefs): WorkbenchPrefs {
  const prefs = emptyWorkbenchPrefs();
  let layout = layoutFromTemplate(CONVERSATION_TEMPLATE);
  const open = legacy.openSurface;
  if (open !== null && open !== "session") {
    if (legacy.mode === "pinned") {
      layout = dockEnd(layout, open);
    } else if (legacy.mode === "dynamic") {
      layout = { ...layout, floating: [open] };
    } else {
      const previous = legacy.previousMode === "pinned"
        ? { presentation: "docked" as const, region: "end" as const }
        : { presentation: "floating" as const };
      layout = previous.presentation === "docked" ? dockEnd(layout, open) : { ...layout, floating: [open] };
      layout = { ...layout, fullscreen: { surfaceId: open, previous } };
    }
  }
  for (const [id, width] of Object.entries(legacy.widths)) layout = resizeSurface(layout, id, { inline: width });
  for (const [key, height] of Object.entries(legacy.heights)) {
    const dock = key.endsWith("::dock");
    const id = dock ? key.slice(0, -"::dock".length) : key;
    if (!id) continue;
    layout = resizeSurface(layout, id, dock ? { dockBlock: height } : { block: height });
  }
  prefs.profiles[CONVERSATION_PROFILE_ID] = { layout, customized: false };
  prefs.lastResource = { ...legacy.lastResource };
  return prefs;
}

function dockEnd(layout: WorkbenchLayout, surfaceId: string): WorkbenchLayout {
  if (placementOf(layout, surfaceId) !== null) return layout;
  return {
    ...layout,
    regions: { ...layout.regions, end: { surfaces: [surfaceId], active: surfaceId } },
    homes: { ...layout.homes, [surfaceId]: "end" },
  };
}

/** Restore-time normalization applied to every profile layout: floating
 *  windows are transient, fullscreen returns home. */
export function restoreWorkbenchPrefs(prefs: WorkbenchPrefs): WorkbenchPrefs {
  const profiles: Record<string, WorkbenchProfileRecord> = {};
  for (const [id, record] of Object.entries(prefs.profiles)) {
    profiles[id] = { ...record, layout: withoutTransient(record.layout) };
  }
  return { ...prefs, profiles };
}

/** The record for a profile, creating it from the template when missing. */
export function profileRecord(
  prefs: WorkbenchPrefs,
  profileId: string,
  template: WorkbenchLayoutTemplate | null,
): WorkbenchProfileRecord {
  const existing = prefs.profiles[profileId];
  if (existing) return existing;
  return {
    layout: template ? layoutFromTemplate(template) : emptyLayout(),
    customized: false,
  };
}

// ---- browser-side store ------------------------------------------------------------

const cache = new Map<string, WorkbenchPrefs>();

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Read (migrating a legacy record on first access). The legacy key is only
 *  removed after the new record was written successfully. */
export function readWorkbenchPrefs(projectId: string): WorkbenchPrefs {
  const hit = cache.get(projectId);
  if (hit) return hit;
  const store = storage();
  let prefs: WorkbenchPrefs | null = null;
  let migratedFrom: string | null = null;
  if (store) {
    try {
      prefs = parseWorkbenchPrefs(store.getItem(workbenchPrefsKey(projectId)));
      if (prefs === null) {
        for (const key of legacyWorkspacePaneKeys(projectId)) {
          const raw = store.getItem(key);
          if (raw === null) continue;
          prefs = migrateWorkspacePanePrefs(parseWorkspacePanePrefs(raw));
          migratedFrom = key;
          break;
        }
      }
    } catch { /* unreadable storage */ }
  }
  const restored = restoreWorkbenchPrefs(prefs ?? emptyWorkbenchPrefs());
  cache.set(projectId, restored);
  if (store && (migratedFrom !== null || prefs === null)) {
    let written = false;
    try {
      store.setItem(workbenchPrefsKey(projectId), serializeWorkbenchPrefs(restored));
      written = true;
    } catch { /* full/private */ }
    if (written && migratedFrom !== null) {
      for (const key of legacyWorkspacePaneKeys(projectId)) {
        try { store.removeItem(key); } catch { /* best effort */ }
      }
    }
  }
  return restored;
}

export function writeWorkbenchPrefs(projectId: string, prefs: WorkbenchPrefs): void {
  cache.set(projectId, prefs);
  const store = storage();
  if (!store) return;
  try {
    store.setItem(workbenchPrefsKey(projectId), serializeWorkbenchPrefs(prefs));
    markProjectPresentationChanged(projectId, "workbenchLayout");
  } catch { /* full/private */ }
}

/** Drop one project's cached record before a server hydration event. */
export function reloadWorkbenchPrefs(projectId: string): WorkbenchPrefs {
  cache.delete(projectId);
  return readWorkbenchPrefs(projectId);
}

/** Test seam: forget the in-memory cache (e.g. between simulated projects). */
export function resetWorkbenchPrefsCache(): void {
  cache.clear();
}
