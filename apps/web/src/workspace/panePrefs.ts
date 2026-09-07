// UX-PANE-MODEL: versioned, project-scoped workspace-pane persistence —
// which workspace surface is open, its window mode, the preferred (not
// geometry-clamped) dimensions per surface, and the last
// provider resource per surface. Pure parse/serialize helpers are DOM-free so
// node --test covers clamping, migration, and project isolation directly.
//
// Storage key: polyth.workspacePane.v2.<projectId>. One record per project —
// project A's surface, width, and resource state never leaks into project B.
// Deliberately NOT migrated from the global polyth.railPrefs: that record is
// browser-global, and copying its widths into every project record on first
// load would replicate one project's layout everywhere (forbidden by spec).

export const WORKSPACE_PANE_PREFS_VERSION = 2;
export type PaneMode = "dynamic" | "pinned" | "fullscreen";
export type PanePreviousMode = Exclude<PaneMode, "fullscreen">;

export interface PaneWindowState {
  mode: PaneMode;
  previousMode: PanePreviousMode;
}

export type PaneWindowTransition =
  | { type: "toggle-fullscreen" }
  | { type: "toggle-pin" }
  | { type: "escape" }
  | { type: "outside-close" };

/** Pure package-window transition. `null` means the dynamic window closes. */
export function transitionPaneWindow(
  state: PaneWindowState,
  transition: PaneWindowTransition,
): PaneWindowState | null {
  if (transition.type === "escape") {
    if (state.mode === "dynamic") return null;
    if (state.mode === "pinned") return state;
    return { mode: state.previousMode, previousMode: state.previousMode };
  }
  if (transition.type === "outside-close") return state.mode === "dynamic" ? null : state;
  if (transition.type === "toggle-fullscreen") {
    return state.mode === "fullscreen"
      ? { mode: state.previousMode, previousMode: state.previousMode }
      : { mode: "fullscreen", previousMode: state.mode };
  }
  if (transition.type === "toggle-pin") {
    if (state.mode === "fullscreen") {
      return { ...state, previousMode: state.previousMode === "pinned" ? "dynamic" : "pinned" };
    }
    const mode = state.mode === "pinned" ? "dynamic" : "pinned";
    return { mode, previousMode: mode };
  }
  return state;
}

export interface WorkspacePanePrefs {
  version: typeof WORKSPACE_PANE_PREFS_VERSION;
  /** Pinned workspace surface restored when the project is activated; null = closed. */
  openSurface: string | null;
  /** User-selected mode; only pinned windows are restored across sessions. */
  mode: PaneMode;
  /** Exact non-fullscreen mode restored by fullscreen toggle/Escape. */
  previousMode: PanePreviousMode;
  /** Preferred pane width per surface id (px). Clamped on use, not on save. */
  widths: Record<string, number>;
  /** Preferred dynamic-window height per surface id (px). */
  heights: Record<string, number>;
  /** Last provider resource per surface id (e.g. "file:src/app.ts"). */
  lastResource: Record<string, string>;
}

export const emptyWorkspacePanePrefs: WorkspacePanePrefs = {
  version: WORKSPACE_PANE_PREFS_VERSION,
  openSurface: null,
  mode: "dynamic",
  previousMode: "dynamic",
  widths: {},
  heights: {},
  lastResource: {},
};

export function workspacePaneKey(projectId: string): string {
  return `polyth.workspacePane.v2.${projectId}`;
}

function legacyWorkspacePaneKey(projectId: string): string {
  return `polyth.workspacePane.v1.${projectId}`;
}

/** Every storage key an older build may have left for this project, newest first. */
export function legacyWorkspacePaneKeys(projectId: string): string[] {
  return [workspacePaneKey(projectId), legacyWorkspacePaneKey(projectId)];
}

/** Hard bounds applied when a persisted width is USED (never silently written
 *  back): sizes below this are rejected as garbage, the upper bound is the
 *  live geometry cap applied by the host at render time. */
const WIDTH_SANITY_MIN = 120;
const WIDTH_SANITY_MAX = 4096;
const HEIGHT_SANITY_MIN = 120;
const HEIGHT_SANITY_MAX = 4096;
const MAX_ENTRIES = 64;

export function clampPaneDimension(value: number, minimum: number, available: number, gutter = 32): number {
  const maximum = Math.max(1, Math.round(available - gutter));
  return Math.min(maximum, Math.max(Math.min(minimum, maximum), Math.round(value)));
}

/** Parse a persisted record. Unknown fields are ignored, non-finite or absurd
 *  sizes are rejected, at most 64 width/resource entries are read, and any
 *  malformed document falls back to the empty record. */
export function parseWorkspacePanePrefs(raw: string | null): WorkspacePanePrefs {
  if (!raw) return emptyWorkspacePanePrefs;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) return emptyWorkspacePanePrefs;
    if (data.version !== 1 && data.version !== WORKSPACE_PANE_PREFS_VERSION) return emptyWorkspacePanePrefs;
    const widths: Record<string, number> = {};
    if (typeof data.widths === "object" && data.widths !== null) {
      for (const [id, w] of Object.entries(data.widths).slice(0, MAX_ENTRIES)) {
        if (!id || typeof w !== "number" || !Number.isFinite(w)) continue;
        if (w < WIDTH_SANITY_MIN || w > WIDTH_SANITY_MAX) continue;
        widths[id] = Math.round(w);
      }
    }
    const heights: Record<string, number> = {};
    if (typeof data.heights === "object" && data.heights !== null) {
      for (const [id, h] of Object.entries(data.heights).slice(0, MAX_ENTRIES)) {
        if (!id || typeof h !== "number" || !Number.isFinite(h)) continue;
        if (h < HEIGHT_SANITY_MIN || h > HEIGHT_SANITY_MAX) continue;
        heights[id] = Math.round(h);
      }
    }
    const lastResource: Record<string, string> = {};
    if (typeof data.lastResource === "object" && data.lastResource !== null) {
      for (const [id, r] of Object.entries(data.lastResource).slice(0, MAX_ENTRIES)) {
        if (id && typeof r === "string" && r) lastResource[id] = r;
      }
    }
    const mode: PaneMode = data.version === 1
      ? (data.expanded === true ? "fullscreen" : "dynamic")
      : data.mode === "pinned" || data.mode === "fullscreen" ? data.mode : "dynamic";
    const previousMode: PanePreviousMode = data.previousMode === "pinned" ? "pinned" : "dynamic";
    return {
      version: WORKSPACE_PANE_PREFS_VERSION,
      openSurface: typeof data.openSurface === "string" && data.openSurface !== "" ? data.openSurface : null,
      mode,
      previousMode: mode === "fullscreen" ? previousMode : mode,
      widths,
      heights,
      lastResource,
    };
  } catch {
    return emptyWorkspacePanePrefs;
  }
}

export function serializeWorkspacePanePrefs(prefs: WorkspacePanePrefs): string {
  return JSON.stringify(prefs);
}

// ---- browser-side store ------------------------------------------------------
// A tiny cache so repeated reads during one project's lifetime don't re-parse.

const cache = new Map<string, WorkspacePanePrefs>();

function read(projectId: string): WorkspacePanePrefs {
  const hit = cache.get(projectId);
  if (hit) return hit;
  let raw: string | null = null;
  let legacy = false;
  try {
    raw = localStorage.getItem(workspacePaneKey(projectId));
    if (raw === null) {
      raw = localStorage.getItem(legacyWorkspacePaneKey(projectId));
      legacy = raw !== null;
    }
  } catch { /* no storage */ }
  const prefs = parseWorkspacePanePrefs(raw);
  cache.set(projectId, prefs);
  if (legacy) {
    try {
      localStorage.setItem(workspacePaneKey(projectId), serializeWorkspacePanePrefs(prefs));
      localStorage.removeItem(legacyWorkspacePaneKey(projectId));
    } catch { /* full/private */ }
  }
  return prefs;
}

function write(projectId: string, prefs: WorkspacePanePrefs): void {
  cache.set(projectId, prefs);
  try { localStorage.setItem(workspacePaneKey(projectId), serializeWorkspacePanePrefs(prefs)); } catch { /* full/private */ }
}

export function getWorkspacePanePrefs(projectId: string): WorkspacePanePrefs {
  return read(projectId);
}

export function setPaneOpenSurface(projectId: string, surfaceId: string | null): void {
  const prefs = read(projectId);
  if (prefs.openSurface === surfaceId) return;
  // A later open starts dynamic; dimensions and resource memory survive.
  write(projectId, {
    ...prefs,
    openSurface: surfaceId,
    ...(surfaceId === null ? { mode: "dynamic" as const, previousMode: "dynamic" as const } : {}),
  });
}

export function setPersistedPaneMode(projectId: string, state: PaneWindowState): void {
  const prefs = read(projectId);
  if (prefs.mode === state.mode && prefs.previousMode === state.previousMode) return;
  write(projectId, { ...prefs, ...state });
}

/** Persist a PREFERRED width — callers must pass the user's chosen width, not
 *  a temporary geometry clamp. */
export function setPanePreferredWidth(projectId: string, surfaceId: string, width: number): void {
  if (!Number.isFinite(width) || width < WIDTH_SANITY_MIN || width > WIDTH_SANITY_MAX) return;
  const prefs = read(projectId);
  const rounded = Math.round(width);
  if (prefs.widths[surfaceId] === rounded) return;
  write(projectId, { ...prefs, widths: { ...prefs.widths, [surfaceId]: rounded } });
}

export function setPaneDynamicHeight(projectId: string, surfaceId: string, height: number): void {
  if (!Number.isFinite(height) || height < HEIGHT_SANITY_MIN || height > HEIGHT_SANITY_MAX) return;
  const prefs = read(projectId);
  const rounded = Math.round(height);
  if (prefs.heights[surfaceId] === rounded) return;
  write(projectId, { ...prefs, heights: { ...prefs.heights, [surfaceId]: rounded } });
}

export function setPaneLastResource(projectId: string, surfaceId: string, resource: string): void {
  const prefs = read(projectId);
  if (prefs.lastResource[surfaceId] === resource) return;
  write(projectId, { ...prefs, lastResource: { ...prefs.lastResource, [surfaceId]: resource } });
}

/** Test seam: forget the in-memory cache (e.g. between simulated projects). */
export function resetWorkspacePanePrefsCache(): void {
  cache.clear();
}
