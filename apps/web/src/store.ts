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
import { loadActiveView, saveActiveView } from "./viewPrefs.ts";
import { isWorkspaceSurface, listSurfaces } from "./surfaces.ts";
import {
  getWorkspacePanePrefs,
  setPaneExpanded as persistPaneExpanded,
  setPaneLastResource,
  setPaneOpenSurface,
} from "./workspace/panePrefs.ts";
import {
  beginListRequest,
  initialProjectRegistry,
  mutationVersionOf,
  publishListFailure,
  publishListSuccess,
  removeProject,
  replacementActiveId,
  upsertProject,
  type ListPublishOutcome,
  type ProjectRegistryState,
} from "./projectRegistry.ts";
import { setWorkspaceMode } from "./widgets/workspaceMode.ts";

// UX-PANE-MODEL: Files, Git, Terminal, and Preview are workspace PANE
// surfaces, not primary views — they open beside (or over) a still-mounted
// Chat through openWorkspacePane(). Only Chat and the workflow pages remain
// primary destinations.
export type AppView = "session" | "goals" | "multirun" | "fusion" | "walkthrough" | "schedule" | "github";
/** Legacy ids that older persisted state / call sites may still send. */
export type LegacyPaneViewId = "files" | "git" | "terminal" | "preview";
const LEGACY_PANE_VIEWS: readonly string[] = ["files", "git", "terminal", "preview"];
const PRIMARY_VIEWS: readonly string[] = ["session", "goals", "multirun", "fusion", "walkthrough", "schedule", "github"];
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
  /** Canonical project-registry truth (UX-ONBOARDING): loading, failed, and
   *  ready are distinct; `projects` has this one owner. */
  projectRegistry: ProjectRegistryState;
  sessions: SessionProjection[];
  events: Record<string, SessionEvent[]>;
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  /** Session whose canonical event load (openSession) is in flight. While
   *  set, the session surface shows a loading row instead of the fresh-
   *  session hero (UX-TIMELINE-LAYOUT-01 §8: unresolved replay is loading,
   *  never a false empty state). */
  openingSessionId: string | null;
  activeView: AppView;
  gitBranch: string;
  settings: PolythSettings;
  uiError: string | null;
  overlay: Overlay;
  worktreeSessionRequest: WorktreeSessionRequest | null;
  paletteMode: PaletteMode;
  railPlugin: RailPlugin | null;
  /** Explicit user expansion of the open workspace pane (persisted per
   *  project). Never set by the automatic full-screen fallback. */
  paneExpanded: boolean;
  /** Live presentation truth from the pane host: the open workspace surface
   *  currently covers the workspace (explicit expand, geometry fallback, or
   *  compact). App uses it to make hidden Chat inert. */
  paneFullscreen: boolean;
  sidebarOpen: boolean;
  /** File open in the full-screen editor (files view); null = tree only. */
  editorFile: string | null;
  /** Requested cursor placement for the open file (file refs; go-to-line). */
  editorLocation: EditorLocation | null;
  /** File requested by a changed-file jump into the Changes rail. */
  gitDiffPath: string | null;
}

let state: AppState = {
  projectRegistry: initialProjectRegistry(),
  sessions: [],
  events: {},
  models: [],
  agents: [],
  activeProjectId: null,
  activeSessionId: null,
  openingSessionId: null,
  activeView: loadActiveView(), // UX-A390: the selected view survives reload
  gitBranch: "",
  settings: loadSettings(),
  uiError: null,
  overlay: null,
  worktreeSessionRequest: null,
  paletteMode: "all",
  railPlugin: getRailPrefs().lastOpen, // F17: last-open surface survives reload
  paneExpanded: false,
  paneFullscreen: false,
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

export const COMPOSER_INPUT_SELECTOR = "[data-composer-input]";

/** The one focus path for either the hero or docked composer. */
export function focusComposer(): void {
  setActiveView("session");
  // Retry briefly so view/dialog transitions can commit and release inert
  // before focusing either the hero or docked variant.
  const focusWhenReady = (attempts: number) => {
    if (typeof document === "undefined") return;
    const input = document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT_SELECTOR);
    input?.focus();
    if (document.activeElement === input || attempts <= 0) return;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => focusWhenReady(attempts - 1));
    } else {
      setTimeout(() => focusWhenReady(attempts - 1), 0);
    }
  };
  setTimeout(() => focusWhenReady(24), 0);
}

const EMPTY_EVENTS: SessionEvent[] = [];
const EMPTY_MODEL: RenderModel = emptyModel();
// Shared per-session incremental cache: new events fold into the previous
// model instead of replaying the whole log on every render (P1 perf fix).
const activeModelCache = createModelCache();

/** Reduce an immutable event batch once per session. The shared incremental
 * cache folds append-only suffixes while safely rebuilding replacements. */
export function reduceSessionModel(
  sessionId: string | null,
  events: readonly SessionEvent[],
): RenderModel {
  return sessionId ? activeModelCache.get(sessionId, events) : EMPTY_MODEL;
}

export function useActiveModel(): RenderModel {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? EMPTY_EVENTS);
  return useMemo(() => reduceSessionModel(sessionId, events), [sessionId, events]);
}

// ---- project registry actions (UX-ONBOARDING) -----------------------------
// All project mutations go through these; direct component writes equivalent
// to `setProjects(await listProjects())` no longer exist.

/** Monotonic list-request generation — one per document, never reused. */
let nextProjectRequestId = 0;

export interface ProjectListTicket {
  requestId: number;
  /** mutationVersion captured when the request began; a mutation completing
   *  after that makes the response stale even when the requestId is current. */
  mutationVersion: number;
}

export function beginProjectListRequest(): ProjectListTicket {
  const requestId = ++nextProjectRequestId;
  const mutationVersion = mutationVersionOf(state.projectRegistry);
  set({ projectRegistry: beginListRequest(state.projectRegistry, requestId) });
  return { requestId, mutationVersion };
}

export function publishProjectList(ticket: ProjectListTicket, projects: Project[]): ListPublishOutcome {
  const result = publishListSuccess(state.projectRegistry, ticket.requestId, ticket.mutationVersion, projects);
  if (result.outcome === "published") set({ projectRegistry: result.state });
  return result.outcome;
}

export function failProjectList(ticket: ProjectListTicket, error: string): void {
  set({ projectRegistry: publishListFailure(state.projectRegistry, ticket.requestId, error) });
}

/** Rename (and other in-place mutations): upsert the server-returned project. */
export function applyProjectUpsert(project: Project): void {
  set({ projectRegistry: upsertProject(state.projectRegistry, project) });
}

/** Add/Create success — one atomic client transaction: the server-returned
 *  project is in the registry AND active in the same store transition, so the
 *  picker can observe the commit before it closes. Stale session/branch/editor
 *  state from another project is cleared here; no session is created. */
export function applyProjectAdded(project: Project): void {
  localStorage.setItem("polyth.activeProjectId", project.id);
  const projectRegistry = upsertProject(state.projectRegistry, project);
  if (state.activeProjectId === project.id) {
    set({ projectRegistry });
    return;
  }
  set({
    projectRegistry,
    activeProjectId: project.id,
    activeSessionId: null,
    gitBranch: "",
    editorFile: null,
    editorLocation: null,
    gitDiffPath: null,
  });
}

/** Delete success: remove the confirmed id and resolve a replacement active. */
export function applyProjectRemoved(id: string): void {
  const projectRegistry = removeProject(state.projectRegistry, id);
  const activeProjectId = replacementActiveId(projectRegistry.projects, state.activeProjectId);
  localStorage.setItem("polyth.activeProjectId", activeProjectId ?? "");
  if (activeProjectId === state.activeProjectId) {
    set({ projectRegistry });
    return;
  }
  set({
    projectRegistry,
    activeProjectId,
    activeSessionId: null,
    gitBranch: "",
    editorFile: null,
    editorLocation: null,
    gitDiffPath: null,
  });
}

// ---- other actions ---------------------------------------------------------

/** Replace ONE project's session projections, keeping every other project's
 *  entries (UX-FILES-TIMELINE-03 finding 9: the sidebar folder mode shows
 *  several projects' sessions at once, so a refresh must not evict them). */
export function setSessions(projectId: string, sessions: SessionProjection[]): void {
  const others = state.sessions.filter((s) => s.projectId !== projectId);
  set({ sessions: others.length === 0 ? sessions : [...others, ...sessions] });
}
export function setModels(models: ModelDescriptor[]): void {
  set({ models });
}
export function setAgents(agents: AgentDescriptor[]): void {
  set({ agents });
}
/** Is this id an enabled, registered workspace pane surface right now? */
function paneSurfaceOf(id: string | null) {
  if (id === null) return null;
  const surface = listSurfaces().find((s) => s.id === id);
  if (!surface || !isWorkspaceSurface(surface)) return null;
  return surface;
}

export function activateProject(id: string | null): void {
  localStorage.setItem("polyth.activeProjectId", id ?? "");
  // Re-activating the current project must not drop the session or branch (UX-04).
  if (id === state.activeProjectId) return;
  // Workspace-pane state is project-scoped: restore this project's open
  // surface/expansion, and never carry another project's pane across. An
  // unavailable persisted surface must not restore as visibly open.
  const pane = id !== null ? getWorkspacePanePrefs(id) : null;
  const restored = pane !== null ? paneSurfaceOf(pane.openSurface)?.id ?? null : null;
  const railPlugin = restored
    ?? (state.railPlugin !== null && paneSurfaceOf(state.railPlugin) !== null ? null : state.railPlugin);
  set({
    activeProjectId: id, activeSessionId: null, gitBranch: "",
    editorFile: null, editorLocation: null, gitDiffPath: null,
    railPlugin, paneExpanded: restored !== null ? pane!.expanded : false, paneFullscreen: false,
  });
}
export function setActiveView(view: AppView | LegacyPaneViewId): void {
  // One-time legacy adapter: a stored/contributed "files"/"git"/"terminal"/
  // "preview" view id becomes Chat plus the corresponding workspace pane.
  if (LEGACY_PANE_VIEWS.includes(view)) {
    if (!openWorkspacePane(view)) {
      saveActiveView("session");
      set({ activeView: "session" });
    }
    return;
  }
  if (!PRIMARY_VIEWS.includes(view)) {
    saveActiveView("session");
    set({ activeView: "session" });
    return;
  }
  saveActiveView(view as AppView);
  set({ activeView: view as AppView });
}
export function setGitBranch(branch: string): void {
  set({ gitBranch: branch });
}
export function setOverlay(overlay: Overlay): void {
  // Plain opens reset to the general palette; openPalette() picks the mode.
  set({
    overlay,
    ...(overlay === "palette" ? { paletteMode: "all" as PaletteMode } : {}),
    ...(overlay !== "worktree-session" ? { worktreeSessionRequest: null } : {}),
  });
}
export function openWorktreeSessionDialog(projectId: string, worktreePath?: string): void {
  set({
    overlay: "worktree-session",
    worktreeSessionRequest: { projectId, ...(worktreePath ? { worktreePath } : {}) },
  });
}
/** Open the command palette in a specific mode (Mod+P = file-focused). */
export function openPalette(mode: PaletteMode): void {
  set({ overlay: "palette", paletteMode: mode });
}

// Settings deep-link: "Change shortcut…" and similar commands land on a page.
let pendingSettingsPage: string | null = null;
export function openSettingsPage(pageId: string): void {
  pendingSettingsPage = pageId;
  set({ overlay: "settings" });
}
/** One-shot read by SettingsView on mount. */
export function consumePendingSettingsPage(): string | null {
  const v = pendingSettingsPage;
  pendingSettingsPage = null;
  return v;
}
export function setRailPlugin(railPlugin: RailPlugin | null): void {
  // Contextual surfaces persist globally (F17). Workspace panes go through
  // the command path below so their persistence stays project-scoped.
  if (paneSurfaceOf(railPlugin) !== null) {
    openWorkspacePane(railPlugin!);
    return;
  }
  if (railPlugin === null && paneSurfaceOf(state.railPlugin) !== null) {
    closeWorkspacePane();
    return;
  }
  setRailLastOpen(railPlugin);
  set({ railPlugin });
}
export function toggleRailPlugin(id: RailPlugin): void {
  if (paneSurfaceOf(id) !== null) {
    toggleWorkspacePane(id);
    return;
  }
  const railPlugin = state.railPlugin === id ? null : id;
  setRailLastOpen(railPlugin);
  set({ railPlugin });
}

// ---- workspace pane command path (UX-PANE-MODEL) ------------------------------
// The ONE way Files/Git/Terminal/Preview open. Header controls, the rail,
// bottom navigation, Sidebar actions, palette/file references, Settings
// links, and hotkeys all land here; none of them set a primary view for
// these four surfaces.

/** Invoking element captured for deterministic focus return on close. */
let paneInvoker: HTMLElement | null = null;

function recordPaneInvoker(): void {
  if (typeof document === "undefined") return;
  paneInvoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Focus the exact invoker when still connected, else the surface's launcher,
 *  else Chat's composer. */
function restorePaneFocus(surfaceId: string | null): void {
  if (typeof document === "undefined") return;
  const invoker = paneInvoker;
  paneInvoker = null;
  // Defer one tick so the pane is hidden and launchers reflect the new state.
  setTimeout(() => {
    if (invoker && invoker.isConnected) {
      invoker.focus();
      return;
    }
    const launcher = surfaceId !== null
      ? document.querySelector<HTMLElement>(`[data-pane-launcher="${surfaceId}"]`)
      : null;
    if (launcher) {
      launcher.focus();
      return;
    }
    focusComposer();
  }, 0);
}

/** Apply a provider resource to the matching surface's channel. Stable
 *  schemes: "file:<path>" (Files) and "changes:<path>" (Git diff). */
function applyPaneResource(surfaceId: string, resource: string): Partial<AppState> {
  if (surfaceId === "files" && resource.startsWith("file:")) {
    return { editorFile: resource.slice("file:".length) };
  }
  if (surfaceId === "git" && resource.startsWith("changes:")) {
    return { gitDiffPath: resource.slice("changes:".length) };
  }
  return {};
}

/** Open (or keep open) a workspace pane beside Chat. Returns false when the
 *  surface is not a registered, enabled workspace surface. Docked versus
 *  full-screen is decided by the pane host from measured geometry. */
export function openWorkspacePane(surfaceId: string, resource?: string): boolean {
  const surface = paneSurfaceOf(surfaceId);
  if (surface === null) return false;
  if (state.railPlugin !== surfaceId) recordPaneInvoker();
  const projectId = state.activeProjectId;
  if (projectId !== null) {
    setPaneOpenSurface(projectId, surfaceId);
    if (resource !== undefined) setPaneLastResource(projectId, surfaceId, resource);
  }
  set({
    railPlugin: surfaceId,
    // Chat is always the companion: the primary surface stays (or becomes)
    // the session view. Reopening the active surface reuses the instance.
    activeView: "session",
    ...(resource !== undefined ? applyPaneResource(surfaceId, resource) : {}),
  });
  saveActiveView("session");
  return true;
}

export function closeWorkspacePane(): void {
  const open = paneSurfaceOf(state.railPlugin);
  if (open === null) return;
  const projectId = state.activeProjectId;
  if (projectId !== null) setPaneOpenSurface(projectId, null);
  set({ railPlugin: null, paneExpanded: false, paneFullscreen: false });
  restorePaneFocus(open.id);
}

/** Rail-launcher semantic: activating the already-open surface closes it. */
export function toggleWorkspacePane(surfaceId: string): void {
  if (state.railPlugin === surfaceId) closeWorkspacePane();
  else openWorkspacePane(surfaceId);
}

/** Explicit expansion: the pane occupies the workspace, Chat stays mounted. */
export function expandWorkspacePane(): void {
  if (paneSurfaceOf(state.railPlugin) === null || state.paneExpanded) return;
  const projectId = state.activeProjectId;
  if (projectId !== null) persistPaneExpanded(projectId, true);
  set({ paneExpanded: true });
}

/** Collapse back to the exact preferred dock width (host re-caps it). */
export function collapseWorkspacePane(): void {
  if (!state.paneExpanded) return;
  const projectId = state.activeProjectId;
  if (projectId !== null) persistPaneExpanded(projectId, false);
  set({ paneExpanded: false });
}

/** Pane-host presentation truth (never persisted as user intent). */
export function setPaneFullscreen(paneFullscreen: boolean): void {
  if (state.paneFullscreen !== paneFullscreen) set({ paneFullscreen });
}

/** Compatibility adapter: open the canonical Git surface and select that
 *  exact diff in it. Never sets the primary view. */
export function openChanges(path?: string): void {
  if (path !== undefined) set({ gitDiffPath: path });
  openWorkspacePane("git", path !== undefined ? `changes:${path}` : undefined);
}
export function setGitDiffPath(gitDiffPath: string | null): void {
  set({ gitDiffPath });
}
export function setSidebarOpen(sidebarOpen: boolean): void {
  set({ sidebarOpen });
}
/** Compatibility adapter: open the Files surface and the stable
 *  "file:<path>" provider resource. Never sets the primary view. A location
 *  asks the editor to select/center that range once loaded. */
export function openEditorFile(path: string | null, location?: EditorLocation): void {
  set({ editorFile: path, editorLocation: location ?? null });
  if (path !== null) openWorkspacePane("files", `file:${path}`);
}
/** The editor consumed the pending location (one-shot). */
export function clearEditorLocation(): void {
  if (state.editorLocation !== null) set({ editorLocation: null });
}
export function activateSession(id: string | null): void {
  localStorage.setItem("polyth.activeSessionId", id ?? "");
  set({ activeSessionId: id });
}

/** UX-FILES-TIMELINE-03 finding 8: a session switch always lands in that
 *  session's chat. The visible workspace pane closes through the command
 *  path (metadata-only — keep-alive scope caches survive per UX-PANE-MODEL)
 *  and the primary view returns to "session". */
export function showSessionChat(): void {
  closeWorkspacePane();
  set({ overlay: null });
  setActiveView("session");
  setWorkspaceMode("chat");
}

/** Claim/clear the in-flight session open (see AppState.openingSessionId). */
export function setOpeningSession(id: string | null): void {
  if (state.openingSessionId !== id) set({ openingSessionId: id });
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
