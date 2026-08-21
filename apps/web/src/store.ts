// Minimal useSyncExternalStore-backed store. Events are kept per session;
// render models (incl. pendingPermissions/pendingQuestions) derive from them.
import { useMemo, useSyncExternalStore } from "react";
import type {
  AgentDescriptor,
  EditorLocation,
  ModelDescriptor,
  Project,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import { createModelCache, emptyModel, type RenderModel } from "./reduce.ts";
import { applySettingsToDom, loadSettings, saveSettings, type PolythSettings } from "./settings.ts";
import { getRailPrefs, setRailLastOpen } from "./railPrefs.ts";

export type AppView = "session" | "files" | "goals" | "multirun" | "fusion" | "walkthrough" | "preview" | "git" | "terminal" | "schedule" | "github";
export type Overlay = "onboarding" | "project-picker" | "palette" | "search" | "settings" | "worktree-session" | null;
/** Right-rail surface id (F17): a registry id such as "files" or a
 *  plugin-contributed "slot:…" id — no longer a closed union. */
export type RailPlugin = string;
/** "all": commands+workspaces+files. "files": file-focused (Mod+P). */
export type PaletteMode = "all" | "files";
export interface WorktreeSessionRequest {
  projectId: string;
  /** Preselect an existing worktree when launched from its Git row. */
  worktreePath?: string;
}

export interface AppState {
  projects: Project[];
  sessions: SessionProjection[];
  events: Record<string, SessionEvent[]>;
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  activeView: AppView;
  gitBranch: string;
  settings: PolythSettings;
  uiError: string | null;
  overlay: Overlay;
  worktreeSessionRequest: WorktreeSessionRequest | null;
  paletteMode: PaletteMode;
  railPlugin: RailPlugin | null;
  moreOpen: boolean;
  sidebarOpen: boolean;
  /** File open in the full-screen editor (files view); null = tree only. */
  editorFile: string | null;
  /** Requested cursor placement for the open file (file refs; go-to-line). */
  editorLocation: EditorLocation | null;
  /** File requested by a changed-file jump into the Changes rail. */
  gitDiffPath: string | null;
}

let state: AppState = {
  projects: [],
  sessions: [],
  events: {},
  models: [],
  agents: [],
  activeProjectId: null,
  activeSessionId: null,
  activeView: "session",
  gitBranch: "",
  settings: loadSettings(),
  uiError: null,
  overlay: null,
  worktreeSessionRequest: null,
  paletteMode: "all",
  railPlugin: getRailPrefs().lastOpen, // F17: last-open surface survives reload
  moreOpen: false,
  sidebarOpen: false,
  editorFile: null,
  editorLocation: null,
  gitDiffPath: null,
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function subscribeStore(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribeStore, () => selector(getState()));
}

const EMPTY_EVENTS: SessionEvent[] = [];
const EMPTY_MODEL: RenderModel = emptyModel();
// Shared per-session incremental cache: new events fold into the previous
// model instead of replaying the whole log on every render (P1 perf fix).
const activeModelCache = createModelCache();

export function useActiveModel(): RenderModel {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? EMPTY_EVENTS);
  return useMemo(() => (sessionId ? activeModelCache.get(sessionId, events) : EMPTY_MODEL), [sessionId, events]);
}

// ---- actions -------------------------------------------------------------

export function setProjects(projects: Project[]): void {
  set({ projects });
}
export function setSessions(sessions: SessionProjection[]): void {
  set({ sessions });
}
export function setModels(models: ModelDescriptor[]): void {
  set({ models });
}
export function setAgents(agents: AgentDescriptor[]): void {
  set({ agents });
}
export function activateProject(id: string | null): void {
  localStorage.setItem("polyth.activeProjectId", id ?? "");
  // Re-activating the current project must not drop the session or branch (UX-04).
  if (id === state.activeProjectId) return;
  set({ activeProjectId: id, activeSessionId: null, gitBranch: "", editorFile: null, editorLocation: null, gitDiffPath: null });
}
export function setActiveView(view: AppView): void {
  set({ activeView: view });
}
export function setGitBranch(branch: string): void {
  set({ gitBranch: branch });
}
export function setOverlay(overlay: Overlay): void {
  // Plain opens reset to the general palette; openPalette() picks the mode.
  set({
    overlay,
    moreOpen: false,
    ...(overlay === "palette" ? { paletteMode: "all" as PaletteMode } : {}),
    ...(overlay !== "worktree-session" ? { worktreeSessionRequest: null } : {}),
  });
}
export function openWorktreeSessionDialog(projectId: string, worktreePath?: string): void {
  set({
    overlay: "worktree-session",
    worktreeSessionRequest: { projectId, ...(worktreePath ? { worktreePath } : {}) },
    moreOpen: false,
  });
}
/** Open the command palette in a specific mode (Mod+P = file-focused). */
export function openPalette(mode: PaletteMode): void {
  set({ overlay: "palette", paletteMode: mode, moreOpen: false });
}

// Settings deep-link: "Change shortcut…" and similar commands land on a page.
let pendingSettingsPage: string | null = null;
export function openSettingsPage(pageId: string): void {
  pendingSettingsPage = pageId;
  set({ overlay: "settings", moreOpen: false });
}
/** One-shot read by SettingsView on mount. */
export function consumePendingSettingsPage(): string | null {
  const v = pendingSettingsPage;
  pendingSettingsPage = null;
  return v;
}
export function setRailPlugin(railPlugin: RailPlugin | null): void {
  setRailLastOpen(railPlugin);
  set({ railPlugin });
}
export function toggleRailPlugin(id: RailPlugin): void {
  const railPlugin = state.railPlugin === id ? null : id;
  setRailLastOpen(railPlugin);
  set({ railPlugin });
}
export function openChanges(path?: string): void {
  setRailLastOpen("changes");
  set({ railPlugin: "changes", ...(path !== undefined ? { gitDiffPath: path } : {}) });
}
export function setGitDiffPath(gitDiffPath: string | null): void {
  set({ gitDiffPath });
}
export function setMoreOpen(moreOpen: boolean): void {
  set({ moreOpen });
}
export function setSidebarOpen(sidebarOpen: boolean): void {
  set({ sidebarOpen });
}
/** Open a file in the full-screen editor; null keeps the view on the tree.
 *  A location asks the editor to select/center that range once loaded. */
export function openEditorFile(path: string | null, location?: EditorLocation): void {
  set({ editorFile: path, editorLocation: location ?? null, activeView: "files" });
}
/** The editor consumed the pending location (one-shot). */
export function clearEditorLocation(): void {
  if (state.editorLocation !== null) set({ editorLocation: null });
}
export function activateSession(id: string | null): void {
  localStorage.setItem("polyth.activeSessionId", id ?? "");
  set({ activeSessionId: id });
}

// Merge + persist local UI preferences and apply the visual ones to <html>.
export function updateSettings(patch: Partial<PolythSettings>): void {
  const settings = { ...state.settings, ...patch };
  saveSettings(settings);
  applySettingsToDom(settings);
  set({ settings });
}

let uiErrorTimer: ReturnType<typeof setTimeout> | undefined;

// Inline error banner (never window.alert). Auto-dismisses after 12s.
export function setUiError(message: string): void {
  if (uiErrorTimer !== undefined) clearTimeout(uiErrorTimer);
  uiErrorTimer = setTimeout(() => set({ uiError: null }), 12_000);
  set({ uiError: message });
}

export function clearUiError(): void {
  if (uiErrorTimer !== undefined) clearTimeout(uiErrorTimer);
  set({ uiError: null });
}

export function upsertSession(p: SessionProjection): void {
  const i = state.sessions.findIndex((s) => s.id === p.id);
  const sessions = i >= 0 ? state.sessions.map((s, j) => (j === i ? p : s)) : [...state.sessions, p];
  set({ sessions });
}

/** First index whose seq >= target (list sorted by seq ascending). */
function seqLowerBound(list: readonly SessionEvent[], seq: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Merge incoming events into a seq-sorted list, copy-on-write. Live events
 *  arrive in order → O(1) append; out-of-order gap-fill binary-inserts; events
 *  whose seq is already present are dropped (WS replay can re-deliver the
 *  boundary event). Returns the original array when nothing new arrived. */
function mergeEvents(list: SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
  let out: SessionEvent[] | null = null;
  for (const ev of incoming) {
    const cur = out ?? list;
    if (cur.length === 0 || ev.seq > cur[cur.length - 1]!.seq) {
      out ??= list.slice();
      out.push(ev);
      continue;
    }
    const i = seqLowerBound(cur, ev.seq);
    if (i < cur.length && cur[i]!.seq === ev.seq) continue; // duplicate
    out ??= list.slice();
    out.splice(i, 0, ev);
  }
  return out ?? list;
}

// Dedupes by (sessionId, seq): WS gap-fill can re-deliver the boundary event.
export function applyEvent(ev: SessionEvent): void {
  applyEvents([ev]);
}

/** Batch ingestion: one store update — and one listener/render pass — per
 *  call regardless of batch size. Session open and WS bursts land here. */
export function applyEvents(evs: readonly SessionEvent[]): void {
  if (evs.length === 0) return;
  const bySession = new Map<string, SessionEvent[]>();
  for (const ev of evs) {
    const group = bySession.get(ev.sessionId);
    if (group) group.push(ev);
    else bySession.set(ev.sessionId, [ev]);
  }
  let next: Record<string, SessionEvent[]> | null = null;
  for (const [sessionId, incoming] of bySession) {
    const list = state.events[sessionId] ?? EMPTY_EVENTS;
    const merged = mergeEvents(list, incoming);
    if (merged === list) continue;
    next ??= { ...state.events };
    next[sessionId] = merged;
  }
  if (next) set({ events: next });
}

export function lastSeq(sessionId: string): number {
  const list = state.events[sessionId];
  return list && list.length > 0 ? list[list.length - 1]!.seq : 0;
}
