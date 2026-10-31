// Pure tab-host state for workspace panes. DOM-free so it is testable
// with node --test. A tab is a keyed resource (file path, plugin id); the host
// component owns keep-alive rendering while this module owns ordering,
// activation, dirty guarding, and persistence round-trips.

export interface PaneTab {
  /** Stable resource key, e.g. "file:src/app.ts" or "plugin:git-graph". */
  id: string;
  /** Open provider namespace: any
   *  registered pane-provider kind, not a closed union. */
  kind: string;
  /** Resource locator inside the kind (relative path, plugin tab id). */
  resource: string;
  repositoryId?: string;
  title: string;
  dirty: boolean;
  /** One clean, replaceable tab per pane; editing makes it permanent. */
  preview?: boolean;
  /** A restored tab whose provider is gone renders an honest unavailable state. */
  unavailable?: boolean;
}

export interface PaneState {
  tabs: PaneTab[];
  activeId: string | null;
}

export const emptyPane: PaneState = { tabs: [], activeId: null };

export function tabId(kind: PaneTab["kind"], resource: string, repositoryId?: string): string {
  if (repositoryId !== undefined && repositoryId !== "primary") return JSON.stringify([kind, repositoryId, resource]);
  return `${kind}:${resource}`;
}

/** Open (or re-activate) a tab. Existing tab keeps its dirty flag.
 *  `background` adds the tab without taking the active one away (it still
 *  activates when nothing is active). */
export function openTab(state: PaneState, tab: Omit<PaneTab, "dirty">, options: { background?: boolean } = {}): PaneState {
  const existing = state.tabs.find((t) => t.id === tab.id);
  const activeId = (id: string) => options.background && state.activeId !== null ? state.activeId : id;
  if (existing) {
    const next = !tab.preview && existing.preview ? pinTab(state, tab.id) : state;
    if (next.activeId === activeId(tab.id)) return next;
    return { ...next, activeId: activeId(tab.id) };
  }
  const replaceAt = tab.preview ? state.tabs.findIndex((t) => t.preview && !t.dirty) : -1;
  const tabs = [...state.tabs];
  if (replaceAt >= 0) tabs.splice(replaceAt, 1, { ...tab, dirty: false });
  else tabs.push({ ...tab, dirty: false });
  const nextActive = activeId(tab.id);
  return { tabs, activeId: tabs.some((t) => t.id === nextActive) ? nextActive : tab.id };
}

export function pinTab(state: PaneState, id: string): PaneState {
  const index = state.tabs.findIndex((tab) => tab.id === id && tab.preview);
  if (index < 0) return state;
  const tabs = [...state.tabs];
  const { preview: _, ...tab } = tabs[index]!;
  tabs[index] = tab;
  return { ...state, tabs };
}

export function activateTab(state: PaneState, id: string): PaneState {
  if (!state.tabs.some((t) => t.id === id) || state.activeId === id) return state;
  return { ...state, activeId: id };
}

/** Mark a tab dirty/clean. Dirty state survives hide/move by living here. */
export function markDirty(state: PaneState, id: string, dirty: boolean): PaneState {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0 || (state.tabs[i]!.dirty === dirty && !(dirty && state.tabs[i]!.preview))) return state;
  const tabs = [...state.tabs];
  tabs[i] = { ...tabs[i]!, dirty };
  if (dirty) delete tabs[i]!.preview;
  return { ...state, tabs };
}

/** Close a tab. Dirty tabs block unless force — the host confirms with the user. */
export function closeTab(
  state: PaneState,
  id: string,
  opts: { force?: boolean } = {},
): { state: PaneState; blocked: boolean } {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return { state, blocked: false };
  if (state.tabs[i]!.dirty && !opts.force) return { state, blocked: true };
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeId = state.activeId;
  if (activeId === id) {
    // Prefer the right neighbor, then the left, mirroring editor conventions.
    const next = tabs[Math.min(i, tabs.length - 1)];
    activeId = next ? next.id : null;
  }
  return { state: { tabs, activeId }, blocked: false };
}

/** Reorder: move tab `id` to index `to` (clamped). Dirty flags ride along. */
export function moveTab(state: PaneState, id: string, to: number): PaneState {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from < 0) return state;
  const bounded = Math.max(0, Math.min(to, state.tabs.length - 1));
  if (bounded === from) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(bounded, 0, tab!);
  return { ...state, tabs };
}

/** Recompute availability after provider registration/replacement/disposal:
 *  a restored-unavailable tab whose provider arrived late becomes usable, and
 *  a tab whose provider unloaded turns honestly unavailable — never dropped. */
export function reconcileAvailability(
  state: PaneState,
  available: (kind: string, resource: string) => boolean,
): PaneState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    const ok = available(t.kind, t.resource);
    if (ok === !t.unavailable) return t;
    changed = true;
    const { unavailable: _, ...next } = t;
    return ok ? next : { ...next, unavailable: true };
  });
  return changed ? { ...state, tabs } : state;
}

/** Cycle activation with keyboard (Ctrl+PageDown / PageUp semantics). */
export function cycleTab(state: PaneState, dir: 1 | -1): PaneState {
  if (state.tabs.length < 2) return state;
  const i = state.tabs.findIndex((t) => t.id === state.activeId);
  const next = state.tabs[(i + dir + state.tabs.length) % state.tabs.length]!;
  return { ...state, activeId: next.id };
}

// ---- persistence -------------------------------------------------------------

interface PersistedTab { id: string; kind: string; resource: string; title: string; preview?: boolean; repositoryId?: string }
interface PersistedPane { tabs: PersistedTab[]; activeId: string | null }

export function serializePane(state: PaneState): string {
  const out: PersistedPane = {
    tabs: state.tabs.map((t) => ({ id: t.id, kind: t.kind, resource: t.resource, title: t.title, ...(t.repositoryId ? { repositoryId: t.repositoryId } : {}), ...(t.preview && !t.dirty ? { preview: true } : {}) })),
    activeId: state.activeId,
  };
  return JSON.stringify(out);
}

/** Restore a persisted pane. Tabs of unknown kinds (or kinds whose provider
 *  disappeared, per `available`) come back flagged unavailable instead of
 *  vanishing — the user can see and close them deliberately. */
export function deserializePane(
  raw: string | null,
  available: (kind: string, resource: string) => boolean,
): PaneState {
  if (!raw) return emptyPane;
  try {
    const data = JSON.parse(raw) as PersistedPane;
    if (!Array.isArray(data.tabs)) return emptyPane;
    const tabs: PaneTab[] = [];
    const seen = new Set<string>();
    let hasPreview = false;
    for (const t of data.tabs.slice(0, 64)) {
      if (!t || typeof t !== "object") continue;
      if (typeof t.id !== "string" || typeof t.resource !== "string" || seen.has(t.id)) continue;
      seen.add(t.id);
      const kind = typeof t.kind === "string" && t.kind !== "" ? t.kind : "plugin";
      const ok = available(kind, t.resource);
      tabs.push({
        id: t.id,
        kind,
        resource: t.resource,
        ...(typeof t.repositoryId === "string" && t.repositoryId ? { repositoryId: t.repositoryId } : {}),
        title: typeof t.title === "string" && t.title ? t.title : t.resource,
        dirty: false,
        ...(t.preview === true && !hasPreview ? { preview: true } : {}),
        ...(ok ? {} : { unavailable: true }),
      });
      if (t.preview === true) hasPreview = true;
    }
    const activeId = tabs.some((t) => t.id === data.activeId) ? data.activeId : tabs[0]?.id ?? null;
    return { tabs, activeId };
  } catch {
    return emptyPane;
  }
}
