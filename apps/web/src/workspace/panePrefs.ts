// UX-PANE-MODEL: versioned, project-scoped workspace-pane persistence —
// which workspace surface is open, whether the user explicitly expanded it,
// the preferred (not geometry-clamped) width per surface, and the last
// provider resource per surface. Pure parse/serialize helpers are DOM-free so
// node --test covers clamping, migration, and project isolation directly.
//
// Storage key: polyth.workspacePane.v1.<projectId>. One record per project —
// project A's surface, width, and resource state never leaks into project B.
// Deliberately NOT migrated from the global polyth.railPrefs: that record is
// browser-global, and copying its widths into every project record on first
// load would replicate one project's layout everywhere (forbidden by spec).

export const WORKSPACE_PANE_PREFS_VERSION = 1;

export interface WorkspacePanePrefs {
  version: typeof WORKSPACE_PANE_PREFS_VERSION;
  /** Workspace surface open when the project was last used; null = closed. */
  openSurface: string | null;
  /** Explicit user expansion only — an automatic full-screen fallback is a
   *  geometry outcome and must never be persisted as intent. */
  expanded: boolean;
  /** Preferred pane width per surface id (px). Clamped on use, not on save. */
  widths: Record<string, number>;
  /** Last provider resource per surface id (e.g. "file:src/app.ts"). */
  lastResource: Record<string, string>;
}

export const emptyWorkspacePanePrefs: WorkspacePanePrefs = {
  version: WORKSPACE_PANE_PREFS_VERSION,
  openSurface: null,
  expanded: false,
  widths: {},
  lastResource: {},
};

export function workspacePaneKey(projectId: string): string {
  return `polyth.workspacePane.v1.${projectId}`;
}

/** Hard bounds applied when a persisted width is USED (never silently written
 *  back): sizes below this are rejected as garbage, the upper bound is the
 *  live geometry cap applied by the host at render time. */
const WIDTH_SANITY_MIN = 120;
const WIDTH_SANITY_MAX = 4096;
const MAX_ENTRIES = 64;

/** Parse a persisted record. Unknown fields are ignored, non-finite or absurd
 *  sizes are rejected, at most 64 width/resource entries are read, and any
 *  malformed document falls back to the empty record. */
export function parseWorkspacePanePrefs(raw: string | null): WorkspacePanePrefs {
  if (!raw) return emptyWorkspacePanePrefs;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) return emptyWorkspacePanePrefs;
    if (data.version !== WORKSPACE_PANE_PREFS_VERSION) return emptyWorkspacePanePrefs;
    const widths: Record<string, number> = {};
    if (typeof data.widths === "object" && data.widths !== null) {
      for (const [id, w] of Object.entries(data.widths).slice(0, MAX_ENTRIES)) {
        if (!id || typeof w !== "number" || !Number.isFinite(w)) continue;
        if (w < WIDTH_SANITY_MIN || w > WIDTH_SANITY_MAX) continue;
        widths[id] = Math.round(w);
      }
    }
    const lastResource: Record<string, string> = {};
    if (typeof data.lastResource === "object" && data.lastResource !== null) {
      for (const [id, r] of Object.entries(data.lastResource).slice(0, MAX_ENTRIES)) {
        if (id && typeof r === "string" && r) lastResource[id] = r;
      }
    }
    return {
      version: WORKSPACE_PANE_PREFS_VERSION,
      openSurface: typeof data.openSurface === "string" && data.openSurface !== "" ? data.openSurface : null,
      expanded: data.expanded === true,
      widths,
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
  try { raw = localStorage.getItem(workspacePaneKey(projectId)); } catch { /* no storage */ }
  const prefs = parseWorkspacePanePrefs(raw);
  cache.set(projectId, prefs);
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
  // Closing also clears expansion: a later open starts docked when it fits.
  write(projectId, { ...prefs, openSurface: surfaceId, ...(surfaceId === null ? { expanded: false } : {}) });
}

export function setPaneExpanded(projectId: string, expanded: boolean): void {
  const prefs = read(projectId);
  if (prefs.expanded === expanded) return;
  write(projectId, { ...prefs, expanded });
}

/** Persist a PREFERRED width — callers must pass the user's chosen width, not
 *  a temporary geometry clamp. */
export function setPanePreferredWidth(projectId: string, surfaceId: string, width: number): void {
  if (!Number.isFinite(width)) return;
  const prefs = read(projectId);
  const rounded = Math.round(width);
  if (prefs.widths[surfaceId] === rounded) return;
  write(projectId, { ...prefs, widths: { ...prefs.widths, [surfaceId]: rounded } });
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
