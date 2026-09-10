// Minimal useSyncExternalStore-backed store. Events are kept per session;
// render models (incl. pendingPermissions/pendingQuestions) derive from them.
import { useMemo, useSyncExternalStore } from "react";
import type {
  AgentDescriptor,
  EditorLocation,
  ModelDescriptor,
  Project,
  RuntimeFeaturesDto,
  RuntimeUnavailableReport,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import { createModelCache, emptyModel, type RenderModel } from "./reduce.ts";
import { isPlaceholderTitle, titleFromPrompt } from "./format.ts";
import { firstUserText } from "./utils.ts";
import { applySettingsToDom, loadSettings, saveSettings, type PolythSettings } from "./settings.ts";
import { getRailPrefs, setRailLastOpen } from "./railPrefs.ts";
import { loadActiveView, saveActiveView } from "./viewPrefs.ts";
import { isWorkspaceSurface, listSurfaces } from "./surfaces.ts";
import {
  getWorkspacePanePrefs,
  setPersistedPaneMode,
  setPaneLastResource,
  setPaneOpenSurface,
  transitionPaneWindow,
  type PaneMode,
  type PanePreviousMode,
} from "./workspace/panePrefs.ts";
import {
  setWorkbenchProject,
  workbenchCloseSurface,
  workbenchOpenSurface,
  workbenchEscape,
  workbenchOutsideClose,
  workbenchToggleFullscreen,
  workbenchTogglePin,
} from "./workbench/store.ts";
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
import { setWorkspaceMode, setWorkspaceModeProject } from "./widgets/workspaceMode.ts";

// UX-PANE-MODEL: Files, Git, Terminal, and Preview are workspace PANE
// surfaces, not primary views — they open beside (or over) a still-mounted
// Chat through openWorkspacePane(). Only Chat and the workflow pages remain
// primary destinations.
export type AppView = "session" | "goals" | "multirun" | "workflow" | "fusion" | "walkthrough" | "schedule" | "github";
/** Legacy ids that older persisted state / call sites may still send. */
export type LegacyPaneViewId = "files" | "git" | "terminal" | "preview";
const LEGACY_PANE_VIEWS: readonly string[] = ["files", "git", "terminal", "preview"];
const PRIMARY_VIEWS: readonly string[] = ["session", "goals", "multirun", "workflow", "fusion", "walkthrough", "schedule", "github"];
export type Overlay =
  | "onboarding"
  | "project-picker"
  | "palette"
  | "search"
  | "settings"
  | "starter-picker"
  | "worktree-session"
  | null;
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

/** Pure UI intent for the session that will be created by the first send.
 * It never appears in the canonical session list or event log. */
export interface NewSessionIntent {
  projectId: string;
  draft: string;
  title?: string;
  worktreePath?: string;
}

export interface SessionSpawn {
  requestId: number;
  projectId: string;
  sessionId: string | null;
  harnessId?: string;
  harnessName?: string;
}

// A new chat is intentionally not a session yet, so keep its work locally
// rather than creating a visible empty session. One shelf per project lets the
// user return via New session after visiting another surface.
const NEW_SESSION_DRAFT = "polyth.new-session-draft.";

function loadNewSessionDraft(projectId: string): NewSessionIntent | null {
  try {
    const value = JSON.parse(localStorage.getItem(NEW_SESSION_DRAFT + projectId) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const draft = value as Partial<NewSessionIntent>;
    return draft.projectId === projectId && typeof draft.draft === "string"
      ? { projectId, draft: draft.draft, ...(typeof draft.title === "string" ? { title: draft.title } : {}), ...(typeof draft.worktreePath === "string" ? { worktreePath: draft.worktreePath } : {}) }
      : null;
  } catch {
    return null;
  }
}

function saveNewSessionDraft(intent: NewSessionIntent): void {
  try { localStorage.setItem(NEW_SESSION_DRAFT + intent.projectId, JSON.stringify(intent)); } catch { /* best-effort */ }
}

/** Save text typed into the invisible new-session shelf without rerendering the composer. */
export function saveNewSessionDraftText(projectId: string, draft: string): void {
  const current = state.newSessionIntent?.projectId === projectId
    ? state.newSessionIntent
    : loadNewSessionDraft(projectId);
  saveNewSessionDraft({ projectId, draft, ...(current?.title ? { title: current.title } : {}), ...(current?.worktreePath ? { worktreePath: current.worktreePath } : {}) });
}

export function clearNewSessionDraft(projectId: string): void {
  try { localStorage.removeItem(NEW_SESSION_DRAFT + projectId); } catch { /* best-effort */ }
}

type RuntimeFeaturesState = Omit<RuntimeFeaturesDto, "remote" | "materializeAvailable"> & {
  /** Older servers omit these; treated as false at the attachment intersection. */
  remote?: boolean;
  materializeAvailable?: boolean;
};

export interface AppState {
  /** Canonical project-registry truth (UX-ONBOARDING): loading, failed, and
   *  ready are distinct; `projects` has this one owner. */
  projectRegistry: ProjectRegistryState;
  sessions: SessionProjection[];
  events: Record<string, SessionEvent[]>;
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  /** Why the model catalog is empty, when the server knows. Set only while
   *  `models` is empty; a usable catalog clears it. */
  runtimeUnavailable: RuntimeUnavailableReport | null;
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
  newSessionIntent: NewSessionIntent | null;
  /** First-send session creation currently waiting for its native agent. */
  sessionSpawn: SessionSpawn | null;
  paletteMode: PaletteMode;
  railPlugin: RailPlugin | null;
  paneMode: PaneMode;
  panePreviousMode: PanePreviousMode;
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
  /** Server-resolved runtime feature surface keyed by session id. */
  runtimeFeatures: Record<string, RuntimeFeaturesState | undefined>;
}

let state: AppState = {
  projectRegistry: initialProjectRegistry(),
  sessions: [],
  events: {},
  models: [],
  agents: [],
  runtimeUnavailable: null,
  activeProjectId: null,
  activeSessionId: null,
  openingSessionId: null,
  activeView: loadActiveView(), // UX-A390: the selected view survives reload
  gitBranch: "",
  settings: loadSettings(),
  uiError: null,
  overlay: null,
  worktreeSessionRequest: null,
  newSessionIntent: null,
  sessionSpawn: null,
  paletteMode: "all",
  railPlugin: getRailPrefs().lastOpen, // F17: last-open surface survives reload
  paneMode: "dynamic",
  panePreviousMode: "dynamic",
  paneFullscreen: false,
  sidebarOpen: false,
  editorFile: null,
  editorLocation: null,
  gitDiffPath: null,
  runtimeFeatures: {},
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

function refreshTitle(): void {
  if (typeof document === "undefined") return;
  const project = state.projectRegistry.projects.find((p) => p.id === state.activeProjectId);
  document.title = project?.name ? `${project.name} — ${state.settings.productName}` : state.settings.productName;
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  refreshTitle();
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

export function modelForAutoAccept(model: RenderModel, autoAccept: boolean): RenderModel {
  if (!autoAccept || !model.permissions.some((permission) => permission.status === "pending")) {
    return model;
  }
  return {
    ...model,
    permissions: model.permissions.filter((permission) => permission.status !== "pending"),
  };
}

export function useActiveModel(): RenderModel {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? EMPTY_EVENTS);
  const autoAccept = useStore((s) =>
    s.activeSessionId !== null
    && s.sessions.find((session) => session.id === s.activeSessionId)?.autoAccept === true);
  return useMemo(() => {
    const model = reduceSessionModel(sessionId, events);
    // The server resolver remains authoritative. This projection guard only
    // prevents an already-hydrated/stale request from flashing while the
    // durable automatic response is being reconciled after toggle/reconnect.
    return modelForAutoAccept(model, autoAccept);
  }, [sessionId, events, autoAccept]);
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
    newSessionIntent: null,
    gitBranch: "",
    editorFile: null,
    editorLocation: null,
    gitDiffPath: null,
  });
  setWorkspaceModeProject(project.id);
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
    newSessionIntent: null,
    gitBranch: "",
    editorFile: null,
    editorLocation: null,
    gitDiffPath: null,
  });
  setWorkspaceModeProject(activeProjectId);
}

// ---- other actions ---------------------------------------------------------

/** Replace ONE project's session projections, keeping every other project's
 *  entries (UX-FILES-TIMELINE-03 finding 9: the sidebar folder mode shows
 *  several projects' sessions at once, so a refresh must not evict them). */
export function setSessions(projectId: string, sessions: SessionProjection[]): void {
  const currentByProject = new Map(
    state.sessions.filter((s) => s.projectId === projectId).map((s) => [s.id, s]),
  );
  const merged = sessions.map((p) => {
    const cur = currentByProject.get(p.id);
    return cur ? preserveTitle(cur, p) : p;
  });
  const others = state.sessions.filter((s) => s.projectId !== projectId);
  const nextSessions = others.length === 0 ? merged : [...others, ...merged];
  set({ sessions: nextSessions });
  const live = new Set(nextSessions.map((session) => session.id));
  const stale = Object.keys(state.runtimeFeatures).filter((id) => !live.has(id));
  if (stale.length > 0) {
    const nextFeatures = { ...state.runtimeFeatures };
    for (const id of stale) delete nextFeatures[id];
    set({ runtimeFeatures: nextFeatures });
  }
}
export function setModels(models: ModelDescriptor[]): void {
  // A usable catalog is proof the runtime came back; a stale reason next to a
  // working composer would be worse than none.
  set(models.length > 0 ? { models, runtimeUnavailable: null } : { models });
}
export function setRuntimeUnavailable(report: RuntimeUnavailableReport | null): void {
  set({ runtimeUnavailable: report });
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
  // Workspace-pane state is project-scoped: only this project's pinned
  // surface is restored. Dynamic/fullscreen windows are transient, and an
  // unavailable persisted surface must not restore as visibly open.
  const pane = id !== null ? getWorkspacePanePrefs(id) : null;
  const restored = pane?.mode === "pinned" && pane.openSurface !== null
    // Keep an as-yet-unregistered package id so late web-package loading can
    // make the pinned window visible without another project activation.
    ? paneSurfaceOf(pane.openSurface)?.id ?? pane.openSurface
    : null;
  // Older records (and a crash during a dynamic/fullscreen window) may still
  // contain a non-pinned open surface. Scrub it so it cannot be restored by a
  // later project activation.
  if (id !== null && pane !== null && pane.openSurface !== null && pane.mode !== "pinned") {
    setPaneOpenSurface(id, null);
  }
  const restoredResource = restored !== null ? pane?.lastResource[restored] : undefined;
  const priorRail = state.railPlugin !== null
    ? listSurfaces().find((surface) => surface.id === state.railPlugin)
    : undefined;
  const railPlugin = restored
    ?? (priorRail !== undefined && !isWorkspaceSurface(priorRail) ? state.railPlugin : null);
  set({
    activeProjectId: id, activeSessionId: null, gitBranch: "",
    newSessionIntent: null,
    editorFile: null, editorLocation: null, gitDiffPath: null,
    railPlugin,
    paneMode: restored !== null ? pane!.mode : "dynamic",
    panePreviousMode: restored !== null ? pane!.previousMode : "dynamic",
    paneFullscreen: false,
    ...(restored !== null && restoredResource !== undefined ? applyPaneResource(restored, restoredResource) : {}),
  });
  setWorkspaceModeProject(id);
  setWorkbenchProject(id);
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
  // Package homes formerly persisted as primary views now resolve through the
  // single package-window registry once their bundles have registered.
  if (view !== "session" && paneSurfaceOf(view) !== null) {
    openWorkspacePane(view);
    return;
  }
  if (!PRIMARY_VIEWS.includes(view)) {
    saveActiveView("session");
    set({ activeView: "session" });
    return;
  }
  // A primary module replaces an open rail/pane. Leaving a fullscreen Files,
  // Git, Terminal, or contextual panel mounted above the newly selected main
  // module made the next navigation frame expose only Chat underneath (the
  // visible "flash back to chat" bug on phone). There is one visible module
  // surface at a time; the shared ModuleView owns its consistent frame.
  if (view !== "session" && state.railPlugin !== null) {
    if (paneSurfaceOf(state.railPlugin) !== null) closeWorkspacePane({ restoreFocus: false });
    else setRailPlugin(null);
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
  const persistedPane = railPlugin === null
    && state.activeProjectId !== null
    && state.railPlugin !== null
    && getWorkspacePanePrefs(state.activeProjectId).openSurface === state.railPlugin;
  if (railPlugin === null && (paneSurfaceOf(state.railPlugin) !== null || persistedPane)) {
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
    if (invoker && invoker.isConnected && invoker.getClientRects().length > 0 && !invoker.closest("[inert]")) {
      invoker.focus();
      if (document.activeElement === invoker) return;
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
  // A workspace pane is always Chat's companion. Canvas CSS must never win a
  // race and hide a pane that the command path has just opened.
  setWorkspaceMode("chat");
  const projectId = state.activeProjectId;
  const selectedResource = resource ?? (surfaceId === "git" ? undefined : projectId !== null
    ? getWorkspacePanePrefs(projectId).lastResource[surfaceId]
    : undefined);
  if (projectId !== null) {
    setPaneOpenSurface(projectId, surfaceId);
    if (resource !== undefined) setPaneLastResource(projectId, surfaceId, resource);
  }
  set({
    railPlugin: surfaceId,
    // Chat is always the companion: the primary surface stays (or becomes)
    // the session view. Reopening the active surface reuses the instance.
    activeView: "session",
    ...(selectedResource !== undefined ? applyPaneResource(surfaceId, selectedResource) : {}),
  });
  saveActiveView("session");
  workbenchOpenSurface(surfaceId);
  return true;
}

export function closeWorkspacePane({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
  const surfaceId = state.railPlugin;
  const open = paneSurfaceOf(surfaceId);
  const projectId = state.activeProjectId;
  const persisted = projectId !== null
    && surfaceId !== null
    && getWorkspacePanePrefs(projectId).openSurface === surfaceId;
  // A package can disappear while its window is still selected (late unload or
  // replacement). Closing must still clear its project preference, otherwise a
  // later project/session transition can resurrect the stale window.
  if (open === null && !persisted) return;
  if (projectId !== null) setPaneOpenSurface(projectId, null);
  if (surfaceId !== null) workbenchCloseSurface(surfaceId);
  set({
    railPlugin: null,
    paneMode: "dynamic",
    panePreviousMode: "dynamic",
    paneFullscreen: false,
  });
  if (restoreFocus && open !== null) restorePaneFocus(open.id);
  else paneInvoker = null;
}

/** Rail-launcher semantic: activating the already-open surface closes it. */
export function toggleWorkspacePane(surfaceId: string): void {
  if (state.railPlugin === surfaceId) closeWorkspacePane();
  else openWorkspacePane(surfaceId);
}

function applyPaneModeTransition(
  transition: Parameters<typeof transitionPaneWindow>[1],
  restoreFocus = true,
): boolean {
  if (paneSurfaceOf(state.railPlugin) === null) return false;
  const surfaceId = state.railPlugin;
  if (transition.type === "toggle-fullscreen") workbenchToggleFullscreen(surfaceId);
  else if (transition.type === "toggle-pin") workbenchTogglePin(surfaceId);
  else if (transition.type === "escape") workbenchEscape(surfaceId);
  else if (transition.type === "outside-close") workbenchOutsideClose(surfaceId);
  const next = transitionPaneWindow(
    { mode: state.paneMode, previousMode: state.panePreviousMode },
    transition,
  );
  if (next === null) {
    closeWorkspacePane({ restoreFocus });
    return true;
  }
  if (next.mode === state.paneMode && next.previousMode === state.panePreviousMode) return false;
  if (state.activeProjectId !== null) setPersistedPaneMode(state.activeProjectId, next);
  set({
    paneMode: next.mode,
    panePreviousMode: next.previousMode,
  });
  return true;
}

export function togglePaneFullscreen(): void {
  applyPaneModeTransition({ type: "toggle-fullscreen" });
}

export function togglePanePin(): void {
  applyPaneModeTransition({ type: "toggle-pin" });
}

/** Outside interaction only dismisses a dynamic package window. */
export function closePaneFromOutside(): void {
  applyPaneModeTransition({ type: "outside-close" }, false);
}

/** Returns true when Escape changed mode or closed the package window. */
export function handlePaneEscape(): boolean {
  return applyPaneModeTransition({ type: "escape" });
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
// ---- cached-history LRU (P2 perf) -------------------------------------------
// Every opened session leaves its full event window in `state.events`; without
// a cap a long browsing spree pins hundreds of logs (plus their render models)
// in memory. Activation touches the session; the least-recently-activated
// entries beyond the cap are dropped — an evicted session simply refetches its
// newest window on the next open, exactly like a first visit.
const MAX_CACHED_SESSIONS = 12;
const sessionTouchOrder: string[] = [];

export function touchSessionCache(id: string): void {
  const at = sessionTouchOrder.indexOf(id);
  if (at >= 0) sessionTouchOrder.splice(at, 1);
  sessionTouchOrder.push(id);
  if (sessionTouchOrder.length <= MAX_CACHED_SESSIONS) return;
  const victims = sessionTouchOrder.splice(0, sessionTouchOrder.length - MAX_CACHED_SESSIONS);
  let next: Record<string, SessionEvent[]> | null = null;
  for (const victim of victims) {
    if (victim === id) continue;
    activeModelCache.drop(victim);
    if (state.events[victim] !== undefined) {
      next ??= { ...state.events };
      delete next[victim];
    }
  }
  if (next) state = { ...state, events: next }; // folded into the caller's set()
}

export function activateSession(id: string | null): void {
  localStorage.setItem("polyth.activeSessionId", id ?? "");
  if (id !== null) touchSessionCache(id);
  // Session activation is also used by deep links and deletion. Keep the
  // same rule as the visible session-navigation path: only pinned workspace
  // windows may cross the session boundary.
  if (state.paneMode !== "pinned") closeWorkspacePane();
  set({
    activeSessionId: id,
    ...(id !== null ? { newSessionIntent: null } : {}),
  });
}

/** Enter the unsaved new-chat surface. The session is deliberately absent
 * until Composer admits the first message. */
export function startNewSession(
  projectId: string,
  options: Omit<NewSessionIntent, "projectId" | "draft"> & { draft?: string } = {},
): void {
  if (state.activeProjectId !== projectId) activateProject(projectId);
  const saved = options.draft === undefined && !options.title && !options.worktreePath
    ? loadNewSessionDraft(projectId)
    : null;
  const intent: NewSessionIntent = {
    projectId,
    draft: options.draft ?? saved?.draft ?? "",
    ...(options.title ?? saved?.title ? { title: options.title ?? saved?.title } : {}),
    ...(options.worktreePath ?? saved?.worktreePath ? { worktreePath: options.worktreePath ?? saved?.worktreePath } : {}),
  };
  saveNewSessionDraft(intent);
  localStorage.setItem("polyth.activeSessionId", "");
  set({
    activeSessionId: null,
    openingSessionId: null,
    newSessionIntent: intent,
  });
  showSessionChat();
}

let nextSessionSpawnRequestId = 0;

export function beginSessionSpawn(
  projectId: string,
  harness?: Pick<SessionSpawn, "harnessId" | "harnessName">,
): number {
  const requestId = ++nextSessionSpawnRequestId;
  set({
    sessionSpawn: {
      requestId,
      projectId,
      sessionId: null,
      ...(harness?.harnessId ? { harnessId: harness.harnessId } : {}),
      ...(harness?.harnessName ? { harnessName: harness.harnessName } : {}),
    },
  });
  return requestId;
}

export function bindSessionSpawn(requestId: number, sessionId: string): void {
  if (state.sessionSpawn?.requestId !== requestId) return;
  set({ sessionSpawn: { ...state.sessionSpawn, sessionId } });
}

export function finishSessionSpawn(requestId: number): void {
  if (state.sessionSpawn?.requestId === requestId) set({ sessionSpawn: null });
}

export function isActiveSessionSpawning(current: AppState): boolean {
  const spawn = current.sessionSpawn;
  if (!spawn || spawn.projectId !== current.activeProjectId) return false;
  return spawn.sessionId === null
    ? current.activeSessionId === null
    : spawn.sessionId === current.activeSessionId;
}

/** A session switch always lands in that session's chat. Non-pinned workspace
 *  windows close through the command path; a pinned window is the shared
 *  companion for every session. */
export function showSessionChat(): void {
  if (state.paneMode !== "pinned") closeWorkspacePane();
  set({ overlay: null });
  setActiveView("session");
  setWorkspaceMode("chat");
}

/** UX-MODULE-STACK §4: the single module close affordance. One call dismisses
 *  every open module — the main-area workspace view AND any right-rail panel
 *  or workspace pane — and returns to the session. Every module's shared
 *  ModuleView close button routes here, so on phone the stacked overlays all
 *  disappear together instead of peeling back one "Back to chat" at a time. */
export function closeAllModules(): void {
  closeWorkspacePane();
  setRailPlugin(null);
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

// Transient error toast. Auto-dismisses after 12s.
export function setUiError(message: string): void {
  if (uiErrorTimer !== undefined) clearTimeout(uiErrorTimer);
  uiErrorTimer = setTimeout(() => set({ uiError: null }), 12_000);
  set({ uiError: message });
}

export function clearUiError(): void {
  if (uiErrorTimer !== undefined) clearTimeout(uiErrorTimer);
  set({ uiError: null });
}


/** A server placeholder title must not clobber a title the client already
 *  derived from the first user message (applyEvents persists it instantly,
 *  before OpenCode's slower semantic title lands). Keeps it durable across
 *  event-cache eviction and projection refreshes. */
function preserveTitle(cur: SessionProjection, inc: SessionProjection): SessionProjection {
  if (!isPlaceholderTitle(cur.title, cur.id) && isPlaceholderTitle(inc.title, inc.id)) {
    return { ...inc, title: cur.title };
  }
  return inc;
}

export function upsertSession(p: SessionProjection): void {
  const i = state.sessions.findIndex((s) => s.id === p.id);
  const cur = i >= 0 ? state.sessions[i] : undefined;
  const incoming = cur ? preserveTitle(cur, p) : p;
  const sessions = i >= 0 ? state.sessions.map((s, j) => (j === i ? incoming : s)) : [...state.sessions, incoming];
  set({ sessions });
}

/** Batched projection snapshot (WS `projections` frame): one store update —
 *  and one render pass — for the whole page instead of one per session. */
export function upsertSessions(list: readonly SessionProjection[]): void {
  if (list.length === 0) return;
  const byId = new Map(list.map((p) => [p.id, p]));
  const sessions = state.sessions.map((s) => {
    const next = byId.get(s.id);
    if (next) {
      byId.delete(s.id);
      return preserveTitle(s, next);
    }
    return s;
  });
  for (const p of byId.values()) sessions.push(p);
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
 *  arrive in order → O(1) append; a backfill batch strictly older than the
 *  list prepends in one splice; out-of-order stragglers binary-insert; events
 *  whose seq is already present are dropped (WS replay can re-deliver the
 *  boundary event). Returns the original array when nothing new arrived. */
function mergeEvents(list: SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
  // Backfill fast path: an already-sorted batch that ends before the list
  // starts (older-history pages) concatenates without per-event inserts.
  if (
    list.length > 0
    && incoming.length > 0
    && incoming[incoming.length - 1]!.seq < list[0]!.seq
    && incoming.every((ev, i) => i === 0 || ev.seq > incoming[i - 1]!.seq)
  ) {
    return [...incoming, ...list];
  }
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
  let nextSessions: SessionProjection[] | null = null;
  for (const [sessionId, incoming] of bySession) {
    const list = state.events[sessionId] ?? EMPTY_EVENTS;
    const merged = mergeEvents(list, incoming);
    if (merged === list) continue;
    next ??= { ...state.events };
    next[sessionId] = merged;
    // Persist the prompt-derived title into the session record as soon as the
    // first user message is visible in the merged log. This handles both the
    // common tail load and older-history backfills, and keeps the title durable
    // across event-cache eviction so sidebar/recent reads don't need events.
    const cur = state.sessions.find((s) => s.id === sessionId);
    if (cur && isPlaceholderTitle(cur.title, sessionId)) {
      const text = firstUserText(merged);
      if (text) {
        nextSessions ??= state.sessions.slice();
        const i = nextSessions.findIndex((s) => s.id === sessionId);
        if (i >= 0) nextSessions[i] = { ...nextSessions[i]!, title: titleFromPrompt(text) };
      }
    }
  }
  if (next) set(nextSessions ? { events: next, sessions: nextSessions } : { events: next });
}

export function lastSeq(sessionId: string): number {
  const list = state.events[sessionId];
  return list && list.length > 0 ? list[list.length - 1]!.seq : 0;
}

/** Smallest cached seq, or 0 when nothing is cached for the session. */
export function oldestSeq(sessionId: string): number {
  const list = state.events[sessionId];
  return list && list.length > 0 ? list[0]!.seq : 0;
}

/** True when the cached window reaches the very first event (seq 1). Paginated
 *  hydration loads the newest window first, so a session can be open and live
 *  while older history is still on the server. */
export function hasFullHistory(sessionId: string): boolean {
  const list = state.events[sessionId];
  return list !== undefined && list.length > 0 && list[0]!.seq === 1;
}

/** Materialize the (possibly empty) canonical event entry after hydration.
 *  An empty server log yields no applyEvents entry, but "hydrated with zero
 *  events" must be distinguishable from "never loaded / LRU-evicted". */
export function ensureEventCache(sessionId: string): void {
  if (state.events[sessionId] !== undefined) return;
  set({ events: { ...state.events, [sessionId]: [] } });
}

/** Instant session spawn (UX): publish the optimistic projection AND an empty
 *  canonical event window in one store transition, so the new session opens
 *  with zero awaited requests. The server projection broadcast / refresh
 *  reconciles moments later; an empty log for a session that has no events
 *  yet is canonical, not a placeholder (event-log-before-UI holds). */
export function seedSessionCache(p: SessionProjection): void {
  const i = state.sessions.findIndex((s) => s.id === p.id);
  const sessions = i >= 0 ? state.sessions.map((s, j) => (j === i ? p : s)) : [...state.sessions, p];
  const events = state.events[p.id] !== undefined
    ? state.events
    : { ...state.events, [p.id]: [] };
  set({ sessions, events });
}

export function setRuntimeFeatures(
  sessionId: string,
  features: AppState["runtimeFeatures"][string],
): void {
  set({ runtimeFeatures: { ...state.runtimeFeatures, [sessionId]: features } });
}

export function clearRuntimeFeatures(sessionId?: string): void {
  if (!sessionId) {
    set({ runtimeFeatures: {} });
    return;
  }
  const next = { ...state.runtimeFeatures };
  delete next[sessionId];
  set({ runtimeFeatures: next });
}
