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
import { buildModel, type RenderModel } from "./reduce.ts";
import { applySettingsToDom, loadSettings, saveSettings, type PolythSettings } from "./settings.ts";

export type AppView = "session" | "files" | "goals" | "multirun" | "fusion" | "walkthrough" | "preview" | "git" | "terminal" | "schedule" | "github";
export type Overlay = "onboarding" | "palette" | "search" | "settings" | "worktree-session" | null;
export type RailPlugin = "files" | "changes" | "context" | "usage" | "events" | "knowledge";
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
  railPlugin: null,
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

export function useActiveModel(): RenderModel {
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? EMPTY_EVENTS);
  return useMemo(() => buildModel(events), [events]);
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
  set({ railPlugin });
}
export function toggleRailPlugin(id: RailPlugin): void {
  set({ railPlugin: state.railPlugin === id ? null : id });
}
export function openChanges(path?: string): void {
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

// Dedupes by (sessionId, seq): WS gap-fill can re-deliver the boundary event.
export function applyEvent(ev: SessionEvent): void {
  const list = state.events[ev.sessionId];
  if (list && list.some((e) => e.seq === ev.seq)) return;
  const next = [...(list ?? []), ev].sort((a, b) => a.seq - b.seq);
  set({ events: { ...state.events, [ev.sessionId]: next } });
}

export function lastSeq(sessionId: string): number {
  const list = state.events[sessionId];
  return list && list.length > 0 ? list[list.length - 1]!.seq : 0;
}
