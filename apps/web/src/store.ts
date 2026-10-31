// Minimal useSyncExternalStore-backed store. Events are kept per session;
// render models (incl. pendingPermissions/pendingQuestions) derive from them.
import { getAccountLimits, getGuardrails, guardedProjectAddAllowed, limitedProjectAddAllowed } from "./guardrails.ts";
import { useMemo, useSyncExternalStore } from "react";
import { appendEventSegments, prependEventSegments } from "./eventSegments.ts";
import { SESSION_SUMMARY_FIELDS } from "@polyth/contracts";
import type {
  AgentDescriptor,
  AttachmentRef,
  EditorLocation,
  HarnessSelection,
  ModelDescriptor,
  ModelRef,
  Project,
  RuntimeFeaturesDto,
  RuntimeUnavailableReport,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import { createModelCache, emptyModel, type PendingPermission, type RenderModel } from "./reduce.ts";
import { isPlaceholderTitle, titleFromPrompt } from "./format.ts";
import { firstUserText } from "./utils.ts";
import { applySettingsToDom, loadSettings, saveSettings, type PolythSettings } from "./settings.ts";
import { getRailPrefs, setRailLastOpen } from "./railPrefs.ts";
import { loadActiveView, saveActiveView } from "./viewPrefs.ts";
import { isWorkspaceSurface, listSurfaces } from "./surfaces.ts";
import { getPage, pagesVersion, subscribePages } from "./pages.ts";
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
import { clientAccountPersistenceScope, clientPersistenceScope, setClientReliabilityProject, setClientReliabilitySpace } from "./reliabilityContext.ts";
export { workspacePresentationKey } from "./reliabilityContext.ts";
import { hydrateClientRecord, readClientRecord, removeClientRecord, writeClientRecord, type PersistenceScope } from "./clientPersistence.ts";
import { MAX_PREVIOUS_NEW_SESSION_DRAFTS, hydrateScopedDraftRecord, loadScopedDraftRecord, scopedDraftCacheKey, updateScopedDraftRecord, type RecoverableNewSessionDraft } from "./draftRecord.ts";
import { seedAttachments } from "./attachments.ts";
import { activeDraftLanePurpose, newSessionLaneDraftId } from "./workbench/lanes.ts";
import { getMobileWorkspaceNavigationSnapshot } from "./mobileWorkspaceNavigation.ts";
import {
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "./projectPresentationSync.ts";

// Files, Git, Terminal, and Preview are workspace PANE
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
  | "archived-sessions"
  | "session-sharing"
  | null;
/** Right-rail surface id: a registry id such as "files" or a
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
  repositoryIds?: string[];
  isolate?: boolean;
}

/** A package page shown in place of Chat (see `openPage`). */
export interface ActivePage {
  pageId: string;
  /** What the page shows (an agent id); null for the page's own home. */
  resource: string | null;
}

export interface SessionSpawn {
  requestId: number;
  projectId: string;
  sessionId: string | null;
  harnessId?: string;
  harnessName?: string;
  model?: ModelRef;
}

/** Presentation-only echo of a prompt the composer has just submitted.
 *  It is NEVER an event: it does not enter `state.events`, is never persisted,
 *  never reaches a reducer and carries no seq. The canonical `user/message`
 *  (or `queue/enqueued`) still establishes the fact; this record only lets the
 *  timeline show the prompt during the admission round trip and retires the
 *  instant the canonical event lands — or when the submission fails. */
export interface PendingSend {
  /** Local id; distinct from any canonical message id. */
  id: string;
  /** null until first-send session creation binds the real id. */
  sessionId: string | null;
  text: string;
  attachments: AttachmentRef[];
  /** Canonical tail captured at staging: only newer events can retire it. */
  afterSeq: number;
  /** Composer selection at submit; chrome can switch to it before admission. */
  model?: ModelRef;
  /** Harness selection at submit; keeps startup chrome on the target runtime. */
  harness?: HarnessSelection;
  /** How this prompt is being admitted; interrupt owns the activity dock immediately. */
  delivery?: "steer" | "interrupt" | "normal";
}

// A new chat is intentionally not a session yet, so keep its work locally
// rather than creating a visible empty session. One shelf per project lets the
// user return via New session after visiting another surface.
const NEW_SESSION_DRAFT = "new-session-draft";
const RESTORED_NAVIGATION = "restored-navigation";
interface StoredNewSessionIntent {
  v: 1;
  projectId: string;
  title?: string;
  worktreePath?: string;
  repositoryIds?: string[];
  isolate?: boolean;
}

export interface RestoredClientNavigation {
  v: 1;
  spaceId: string;
  projectId: string;
  sessionId?: string;
}

function persistClientNavigation(projectId: string | null, sessionId: string | null): void {
  const targetScope = clientAccountPersistenceScope();
  if (!projectId) {
    removeClientRecord(RESTORED_NAVIGATION, targetScope);
    return;
  }
  const project = state.projectRegistry.projects.find((candidate) => candidate.id === projectId);
  const record: RestoredClientNavigation = {
    v: 1,
    spaceId: project?.spaceId ?? "default",
    projectId,
    ...(sessionId ? { sessionId } : {}),
  };
  writeClientRecord(RESTORED_NAVIGATION, targetScope, JSON.stringify(record));
}

/** Legacy browser navigation hints are optional; full/private storage must not block navigation. */
function saveNavigationHint(key: "polyth.activeProjectId" | "polyth.activeSessionId", value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota or unavailable storage */ }
}

export async function hydrateClientNavigation(): Promise<RestoredClientNavigation | null> {
  try {
    const targetScope = clientAccountPersistenceScope();
    const raw = await hydrateClientRecord(RESTORED_NAVIGATION, targetScope);
    const value = JSON.parse(raw ?? "null") as Partial<RestoredClientNavigation> | null;
    return value?.v === 1
      && typeof value.spaceId === "string" && !!value.spaceId
      && typeof value.projectId === "string" && !!value.projectId
      && (value.sessionId === undefined || (typeof value.sessionId === "string" && !!value.sessionId))
      ? value as RestoredClientNavigation
      : null;
  } catch {
    return null;
  }
}

const newSessionPersistenceScope = (projectId: string, capturedScope?: PersistenceScope): PersistenceScope => {
  if (capturedScope) return capturedScope;
  const laneId = newSessionLaneDraftId(activeDraftLanePurpose());
  return clientPersistenceScope({
    projectId,
    ...(laneId ? { sessionId: laneId } : {}),
  });
};

function storedRepositorySelection(value: unknown): { repositoryIds?: string[] } {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every((id) => typeof id === "string" && id.length > 0)
    ? { repositoryIds: [...new Set(value as string[])] } : {};
}

type NewSessionIntentMetadata = Pick<NewSessionIntent, "title" | "worktreePath" | "repositoryIds" | "isolate">;

type HydratedNewSessionRecovery = {
  scope: PersistenceScope;
  revision: number;
  draft: RecoverableNewSessionDraft;
  remaining: RecoverableNewSessionDraft[];
};

type StartNewSessionOptions = Omit<NewSessionIntent, "projectId" | "draft"> & {
  draft?: string;
  restoreDraft?: boolean;
  /** Read-only hydration carries this candidate until the caller's identity
   * fence permits the scoped shelf and attachment promotion. */
  recovery?: HydratedNewSessionRecovery;
};

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

/** Explicit navigation options win over the live intent, which wins over a
 * legacy shelved entry. This keeps a newer branch/title choice attached when
 * an older draft is promoted during navigation or native hydration. */
function sessionIntentMetadata(
  ...sources: readonly (NewSessionIntentMetadata | undefined)[]
): NewSessionIntentMetadata {
  const title = firstDefined(...sources.map((source) => source?.title));
  const worktreePath = firstDefined(...sources.map((source) => source?.worktreePath));
  const repositoryIds = firstDefined(...sources.map((source) => source?.repositoryIds));
  const isolate = firstDefined(...sources.map((source) => source?.isolate));
  return {
    ...(title !== undefined ? { title } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(repositoryIds !== undefined ? { repositoryIds } : {}),
    ...(isolate !== undefined ? { isolate } : {}),
  };
}

function hasNewSessionDraftContent(record: { text: string; attachments: readonly unknown[]; nativeStaged?: readonly unknown[] }): boolean {
  return !!record.text || record.attachments.length > 0 || (record.nativeStaged?.length ?? 0) > 0;
}

function currentNewSessionDraft(
  record: { text: string; attachments: RecoverableNewSessionDraft["attachments"]; nativeStaged?: RecoverableNewSessionDraft["nativeStaged"] },
  intent?: NewSessionIntent | null,
): RecoverableNewSessionDraft | null {
  if (!hasNewSessionDraftContent(record)) return null;
  return {
    text: record.text,
    attachments: record.attachments,
    ...(record.nativeStaged?.length ? { nativeStaged: record.nativeStaged } : {}),
    ...sessionIntentMetadata(intent ?? undefined),
  };
}

function newSessionScopeIsCurrent(capturedScope: PersistenceScope): boolean {
  return scopedDraftCacheKey(null) === scopedDraftCacheKey(null, capturedScope);
}

function applyRestoredNewSessionDraft(
  targetScope: PersistenceScope,
  restored: RecoverableNewSessionDraft,
  remaining: readonly RecoverableNewSessionDraft[],
): void {
  updateScopedDraftRecord(null, {
    text: restored.text,
    attachments: restored.attachments,
    nativeStaged: restored.nativeStaged ?? [],
    seed: undefined,
    dirty: false,
    conflict: undefined,
    previousNewSessionDrafts: remaining.length > 0 ? [...remaining] : undefined,
  }, targetScope);
  seedAttachments(null, restored.attachments);
}

/** Read a legacy shelved draft only when the current new-chat record is still
 * empty. The optional revision fence protects a native hydration read from
 * describing a newer local edit as recoverable. This helper is deliberately
 * side-effect free; promotion waits for the caller's identity fence. */
function readPreviousNewSessionDraft(
  projectId: string,
  capturedScope?: PersistenceScope,
  expectedRevision?: number,
): HydratedNewSessionRecovery | null {
  const targetScope = newSessionPersistenceScope(projectId, capturedScope);
  const current = loadScopedDraftRecord(null, targetScope);
  if (expectedRevision !== undefined && current.revision !== expectedRevision) return null;
  if (hasNewSessionDraftContent(current)) return null;
  const previous = current.previousNewSessionDrafts ?? [];
  const restored = previous.at(-1);
  if (!restored) return null;
  return {
    scope: targetScope,
    revision: current.revision,
    draft: restored,
    remaining: previous.slice(0, -1),
  };
}

function takePreviousNewSessionDraft(
  projectId: string,
  capturedScope?: PersistenceScope,
  expectedRevision?: number,
): RecoverableNewSessionDraft | null {
  const pending = readPreviousNewSessionDraft(projectId, capturedScope, expectedRevision);
  if (!pending) return null;
  applyRestoredNewSessionDraft(pending.scope, pending.draft, pending.remaining);
  return pending.draft;
}

function loadNewSessionDraft(projectId: string, capturedScope?: PersistenceScope): NewSessionIntent | null {
  const targetScope = newSessionPersistenceScope(projectId, capturedScope);
  try {
    const value = JSON.parse(readClientRecord(NEW_SESSION_DRAFT, targetScope) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const stored = value as Partial<StoredNewSessionIntent & NewSessionIntent>;
    if (stored.v === 1 && stored.projectId === projectId) {
      return { projectId, draft: loadScopedDraftRecord(null, targetScope).text, ...(typeof stored.title === "string" ? { title: stored.title } : {}), ...(typeof stored.worktreePath === "string" ? { worktreePath: stored.worktreePath } : {}), ...(typeof stored.isolate === "boolean" ? { isolate: stored.isolate } : {}), ...storedRepositorySelection(stored.repositoryIds) };
    }
    // Legacy local-only configuration remains recoverable; it is never copied
    // automatically because old ownership cannot be proven.
    return null;
  } catch {
    return null;
  }
}

/** Persist the choices attached to the unsent chat, never its text. The text
 * has its own scoped record, and `intent.draft` is only the seed the chat was
 * installed with — the composer persists keystrokes without republishing it. */
function saveNewSessionIntentMetadata(intent: NewSessionIntent, targetScope: PersistenceScope): void {
  const stored: StoredNewSessionIntent = {
    v: 1, projectId: intent.projectId,
    ...(intent.title ? { title: intent.title } : {}),
    ...(intent.worktreePath ? { worktreePath: intent.worktreePath } : {}),
    ...storedRepositorySelection(intent.repositoryIds),
    ...(typeof intent.isolate === "boolean" ? { isolate: intent.isolate } : {}),
  };
  writeClientRecord(NEW_SESSION_DRAFT, targetScope, JSON.stringify(stored));
}

function saveNewSessionDraft(intent: NewSessionIntent): void {
  const targetScope = newSessionPersistenceScope(intent.projectId);
  updateScopedDraftRecord(null, { text: intent.draft }, targetScope);
  saveNewSessionIntentMetadata(intent, targetScope);
}

/** Explicit native restart hook used by boot when hydration can precede mount.
 * It only reads and returns a captured recovery candidate. `startNewSession`
 * promotes that candidate after its scope/identity fence, and also enters
 * this same path when no synchronous native cache exists. */
export async function hydrateNewSessionDraft(projectId: string): Promise<(NewSessionIntent & { recovery?: HydratedNewSessionRecovery }) | null> {
  const targetScope = newSessionPersistenceScope(projectId);
  const [raw, draftRecord] = await Promise.all([
    hydrateClientRecord(NEW_SESSION_DRAFT, targetScope),
    hydrateScopedDraftRecord(null, targetScope),
  ]);
  const saved = loadNewSessionDraft(projectId, targetScope);
  const pending = readPreviousNewSessionDraft(projectId, targetScope, draftRecord.revision);
  if (pending) {
    return {
      projectId,
      draft: pending.draft.text,
      ...sessionIntentMetadata(saved ?? undefined, pending.draft),
      recovery: pending,
    };
  }
  const current = loadScopedDraftRecord(null, targetScope);
  if (!raw) return hasNewSessionDraftContent(current)
    ? { projectId, draft: current.text }
    : null;
  try {
    const value = JSON.parse(raw) as Partial<StoredNewSessionIntent>;
    return value.v === 1 && value.projectId === projectId
      ? { projectId, draft: current.text, ...sessionIntentMetadata(saved ?? undefined) }
      : null;
  } catch {
    return null;
  }
}

/** Save text typed into the invisible new-session shelf without rerendering the composer. */
export function saveNewSessionDraftText(projectId: string, draft: string): void {
  const current = state.newSessionIntent?.projectId === projectId
    ? state.newSessionIntent
    : loadNewSessionDraft(projectId);
  saveNewSessionDraft({ projectId, draft, ...sessionIntentMetadata(current ?? undefined) });
}

export function clearNewSessionDraft(projectId: string, capturedScope?: PersistenceScope): void {
  const targetScope = newSessionPersistenceScope(projectId, capturedScope);
  updateScopedDraftRecord(null, {
    text: "",
    attachments: [],
    nativeStaged: [],
    seed: undefined,
    dirty: false,
    serverUpdatedAt: undefined,
    conflict: undefined,
  }, targetScope);
  removeClientRecord(NEW_SESSION_DRAFT, targetScope);
}

/** Explicit New Chat starts with the newest unsent draft restored. Older
 * shelved drafts remain bounded in the same scoped record so a native restart
 * cannot discard recovery data. Ordinary navigation still restores the active
 * draft through startNewSession(). */
export function startFreshSession(
  projectId: string,
  options: Omit<NewSessionIntent, "projectId" | "draft"> = {},
): void {
  if (state.activeProjectId !== projectId) activateProject(projectId);
  const targetScope = newSessionPersistenceScope(projectId);
  const current = loadScopedDraftRecord(null, targetScope);
  const intent = state.activeSessionId === null && state.newSessionIntent?.projectId === projectId
    ? state.newSessionIntent : loadNewSessionDraft(projectId, targetScope);
  const previous = current.previousNewSessionDrafts ?? [];
  const currentDraft = currentNewSessionDraft(current, intent);
  const restored = currentDraft ?? previous.at(-1) ?? null;
  if (restored) {
    applyRestoredNewSessionDraft(
      targetScope,
      restored,
      currentDraft ? previous : previous.slice(0, -1),
    );
    startNewSession(projectId, {
      draft: restored.text,
      ...sessionIntentMetadata(options, intent ?? undefined, restored),
    });
    return;
  }
  // No synchronous record exists. Let the same async path used by ordinary
  // navigation hydrate the native record before it writes anything locally.
  startNewSession(projectId, { ...options, restoreDraft: true });
}

// Repository-relative attachments only resolve inside the project they were
// picked from; links and browser captures are project independent.
const projectPortableAttachment = (ref: AttachmentRef): boolean =>
  ref.kind === "url" || ref.kind === "browser-context";

/** Retarget the unsent chat to another project from its own location picker.
 * This is not navigation: the New Chat surface stays, the typed text and
 * project-independent attachments move with it, and the target project's
 * remembered chat is never restored. Repository files and native-staged
 * uploads stay in the source project's draft, where their paths resolve. A
 * draft already waiting in the target is shelved, not overwritten. */
export function moveNewSessionDraftToProject(targetProjectId: string, liveText: string): void {
  const target = normalizedProjectId(targetProjectId);
  const source = workspaceProjectId(state);
  if (!target || target === source) return;
  if (state.activeSessionId !== null) {
    activateProject(target);
    return;
  }
  let moved: AttachmentRef[] = [];
  const live = source && state.newSessionIntent?.projectId === source ? state.newSessionIntent : null;
  if (source) {
    const sourceScope = newSessionPersistenceScope(source);
    const attachments = loadScopedDraftRecord(null, sourceScope).attachments;
    moved = attachments.filter(projectPortableAttachment);
    updateScopedDraftRecord(null, { text: "", seed: undefined, dirty: false, conflict: undefined }, sourceScope);
    if (moved.length > 0) seedAttachments(null, attachments.filter((ref) => !projectPortableAttachment(ref)));
  }
  const carries = liveText !== "" || moved.length > 0;
  const intent: NewSessionIntent = {
    projectId: target,
    draft: liveText,
    ...(live?.title ? { title: live.title } : {}),
  };
  if (!carries) {
    // Nothing to carry: show the target's own unsent chat, as New Chat would.
    const saved = loadNewSessionDraft(target, newSessionPersistenceScope(target));
    if (saved) Object.assign(intent, saved);
    else intent.draft = loadScopedDraftRecord(null, newSessionPersistenceScope(target)).text;
  }
  activateProject(target, intent);
  const targetScope = newSessionPersistenceScope(target);
  if (carries) {
    const existing = loadScopedDraftRecord(null, targetScope);
    const shelved = currentNewSessionDraft(existing, loadNewSessionDraft(target, targetScope));
    const previous = [...(existing.previousNewSessionDrafts ?? []), ...(shelved ? [shelved] : [])]
      .slice(-MAX_PREVIOUS_NEW_SESSION_DRAFTS);
    updateScopedDraftRecord(null, {
      text: liveText,
      attachments: moved,
      nativeStaged: [],
      seed: undefined,
      dirty: false,
      conflict: undefined,
      previousNewSessionDrafts: previous.length > 0 ? previous : undefined,
    }, targetScope);
    seedAttachments(null, moved);
    saveNewSessionIntentMetadata(intent, targetScope);
  }
  saveNavigationHint("polyth.activeSessionId", "");
}

export function hasPreviousNewSessionDraft(projectId: string): boolean {
  const current = loadScopedDraftRecord(null, newSessionPersistenceScope(projectId));
  return !!current.previousNewSessionDrafts?.length
    && !current.text && current.attachments.length === 0 && !current.nativeStaged?.length;
}

/** Restore the latest shelved draft only into an empty fresh composer. */
export function restorePreviousNewSessionDraft(projectId: string): boolean {
  if (state.activeProjectId !== projectId || state.activeSessionId !== null) return false;
  const last = takePreviousNewSessionDraft(projectId);
  if (!last) return false;
  startNewSession(projectId, {
    draft: last.text,
    ...sessionIntentMetadata(last),
  });
  return true;
}

type RuntimeFeaturesState = Omit<RuntimeFeaturesDto, "remote" | "materializeAvailable"> & {
  /** Older servers omit these; treated as false at the attachment intersection. */
  remote?: boolean;
  materializeAvailable?: boolean;
};

export interface AppState {
  /** Canonical project-registry truth: loading, failed, and
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
   *  session hero (unresolved replay is loading,
   *  never a false empty state). */
  openingSessionId: string | null;
  activeView: AppView;
  /** A package page shown in place of Chat (an agent opened from the
   *  navigator). Presentation-only navigation: `activeSessionId` keeps the
   *  chat the canvas returns to, and nothing here enters canonical history. */
  activePage: ActivePage | null;
  gitBranch: string;
  settings: PolythSettings;
  uiError: string | null;
  uiErrorAction: UiErrorAction | null;
  /** How the transient notice reads: most are errors, a few are calm words. */
  uiErrorKind: UiErrorKind;
  /** Bumped on every `setUiError`, so the same text raised again is a new
   *  occurrence (its notification restarts its lifetime). */
  uiErrorSeq: number;
  overlay: Overlay;
  worktreeSessionRequest: WorktreeSessionRequest | null;
  /** Project whose archive the "archived-sessions" overlay shows. */
  archivedSessionsProjectId: string | null;
  /** Chat whose audience the "session-sharing" overlay shows. */
  sharingSessionId: string | null;
  newSessionIntent: NewSessionIntent | null;
  /** First-send session creation currently waiting for its native agent. */
  sessionSpawn: SessionSpawn | null;
  /** Submitted prompts still waiting for their canonical event (oldest first). */
  pendingSends: PendingSend[];
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
  /** Explicit opens are distinct from tab-selection synchronization. */
  editorOpenRequest: { id: number; preview: boolean; projectId: string | null; sessionId: string | null; repositoryId?: string } | null;
  editorRepositoryId: string | null;
  /** Requested cursor placement for the open file (file refs; go-to-line). */
  editorLocation: EditorLocation | null;
  /** File requested by a changed-file jump into the Changes rail. */
  gitDiffPath: string | null;
  /** Server-resolved runtime feature surface keyed by session id. */
  runtimeFeatures: Record<string, RuntimeFeaturesState | undefined>;
  /** Per-project git worktree topology revision. The server bumps one project
   *  when its worktrees change — created here, by an agent, by a shell, or by
   *  another app — and surfaces that list worktrees re-read on the change.
   *  Keyed by project so one repository's change never refetches another's. */
  worktreeTopology: Record<string, number>;
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
  activeView: loadActiveView(), // the selected view survives reload
  activePage: null,
  gitBranch: "",
  settings: loadSettings(),
  uiError: null,
  uiErrorAction: null,
  uiErrorKind: "error",
  uiErrorSeq: 0,
  overlay: null,
  worktreeSessionRequest: null,
  archivedSessionsProjectId: null,
  sharingSessionId: null,
  newSessionIntent: null,
  sessionSpawn: null,
  pendingSends: [],
  paletteMode: "all",
  railPlugin: getRailPrefs().lastOpen, // last-open surface survives reload
  paneMode: "dynamic",
  panePreviousMode: "dynamic",
  paneFullscreen: false,
  sidebarOpen: false,
  editorFile: null,
    editorRepositoryId: null,
  editorOpenRequest: null,
  editorLocation: null,
  gitDiffPath: null,
  runtimeFeatures: {},
  worktreeTopology: {},
};

const listeners = new Set<() => void>();
const sessionEventListeners = new Set<(event: SessionEvent) => void>();
type ComposerDraftFlusher = (sessionId: string) => void;
const composerDraftFlushers = new Set<ComposerDraftFlusher>();

export function getState(): AppState {
  return state;
}

function sessionOwnedProjectId(
  sessions: readonly SessionProjection[],
  sessionId: string | null,
): string | null {
  if (!sessionId) return null;
  const projectId = sessions.find((row) => row.id === sessionId)?.projectId;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
}

function normalizedProjectId(id: string | null | undefined): string | null {
  return typeof id === "string" && id.length > 0 ? id : null;
}

type WorkspaceProjectSnapshot =
  Pick<AppState, "activeProjectId" | "activeSessionId" | "sessions">
  & Partial<Pick<AppState, "newSessionIntent" | "sessionSpawn" | "projectRegistry">>;

function readyRegistryProjectId(
  snapshot: WorkspaceProjectSnapshot,
  candidate: string | null | undefined,
): string | null {
  const id = normalizedProjectId(candidate);
  const registry = snapshot.projectRegistry;
  if (!id || !registry || registry.status !== "ready") return null;
  return registry.projects.some((project) => project.id === id) ? id : null;
}

function routedWorkspaceProjectId(snapshot: WorkspaceProjectSnapshot): string | null {
  if (typeof location === "undefined") return null;
  const match = /^\/p\/([^/]+)(?:\/|$)/.exec(location.pathname);
  if (!match?.[1]) return null;
  try {
    return readyRegistryProjectId(snapshot, decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function persistedWorkspaceProjectId(snapshot: WorkspaceProjectSnapshot): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return readyRegistryProjectId(snapshot, localStorage.getItem("polyth.activeProjectId"));
  } catch {
    return null;
  }
}

function firstReadyWorkspaceProjectId(snapshot: WorkspaceProjectSnapshot): string | null {
  const registry = snapshot.projectRegistry;
  if (!registry || registry.status !== "ready") return null;
  return normalizedProjectId(registry.projects[0]?.id);
}

/** Resolve the project that owns the current workspace.
 *
 * `activeProjectId` is canonical, but hydration/navigation transitions can
 * briefly leave it empty after the project registry is already ready. Preserve
 * every unambiguous owner first, then recover from the validated route/persisted
 * selection, and finally use the same first-project fallback as boot restore.
 * A ready registry with projects must never render project-scoped panes as
 * "No project selected". */
export function workspaceProjectId(
  snapshot: WorkspaceProjectSnapshot = state,
): string | null {
  return normalizedProjectId(snapshot.activeProjectId)
    ?? sessionOwnedProjectId(snapshot.sessions, snapshot.activeSessionId)
    ?? normalizedProjectId(snapshot.newSessionIntent?.projectId)
    ?? normalizedProjectId(snapshot.sessionSpawn?.projectId)
    ?? routedWorkspaceProjectId(snapshot)
    ?? persistedWorkspaceProjectId(snapshot)
    ?? firstReadyWorkspaceProjectId(snapshot);
}

export function subscribeStore(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Register the mounted Composer's local-only draft flush. Session deletion
 * invokes this before clearing the active id, so an uncontrolled textarea has
 * one synchronous chance to persist a newer edit before its layout transition
 * runs. The callback is deliberately UI-owned; the store never reads DOM. */
export function registerComposerDraftFlusher(flusher: ComposerDraftFlusher): () => void {
  composerDraftFlushers.add(flusher);
  return () => { composerDraftFlushers.delete(flusher); };
}

export function flushComposerDraftBeforeSessionRemoval(sessionId: string): void {
  for (const flusher of [...composerDraftFlushers]) flusher(sessionId);
}

/** Package-facing event notification. Durable history remains in `state.events`;
 * this callback only tells package UI that new canonical facts were accepted. */
export function subscribeSessionEvents(cb: (event: SessionEvent) => void): () => void {
  sessionEventListeners.add(cb);
  return () => { sessionEventListeners.delete(cb); };
}

function refreshTitle(): void {
  if (typeof document === "undefined") return;
  const project = state.projectRegistry.projects.find((p) => p.id === workspaceProjectId(state));
  const title = project?.name ? `${project.name} — ${state.settings.productName}` : state.settings.productName;
  if (document.title !== title) document.title = title;
}

/** Note that one project's worktree topology moved. Surfaces that list
 *  worktrees depend on `worktreeTopology[projectId]` and refetch when it
 *  changes; nothing is cached here, so a stale list can never be served. */
export function bumpWorktreeTopology(projectId: string): void {
  if (!projectId) return;
  set({
    worktreeTopology: {
      ...state.worktreeTopology,
      [projectId]: (state.worktreeTopology[projectId] ?? 0) + 1,
    },
  });
}

export function worktreeTopologyRevision(projectId: string | null | undefined): number {
  return (projectId && state.worktreeTopology[projectId]) || 0;
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  if (patch.projectRegistry || patch.activeProjectId !== undefined || patch.activeSessionId !== undefined || patch.settings || patch.sessions) refreshTitle();
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

type AutoAcceptFlags = Pick<SessionProjection, "autoAccept" | "autoAcceptAll">;

/** Whether the session's effective auto-accept policy will answer this
 *  pending request on the server. Full access answers every agent request;
 *  routine Auto-Approve holds one the preview marks high risk (the preview
 *  carries the same assessment that gates it); composer-shell confirmations
 *  stay manual. A subagent's or workflow node's request mirrored into its
 *  parent is answered only by that child's policy, which the server already
 *  applied before mirroring it, so the parent's policy never hides it. When
 *  this returns false, the request needs a person. */
export function autoAcceptAnswers(permission: PendingPermission, flags: AutoAcceptFlags | null | undefined): boolean {
  if (flags?.autoAccept !== true || permission.manual || permission.sourceSessionId) return false;
  return flags.autoAcceptAll === true || permission.preview?.risk !== "high";
}

/** Pending requests that need a person under the session's policy. */
const openPermissionCount = (model: RenderModel, flags: AutoAcceptFlags | null | undefined): number =>
  model.permissions.filter((p) => p.status === "pending" && !autoAcceptAnswers(p, flags)).length;

/** Whether a session's cached events may overrule its projection's attention
 *  counts. The socket streams events for the active session alone; any other
 *  session's window stopped when the subscription moved on, or is a bounded
 *  prefetch tail, so it misses requests opened after (or before) it. The
 *  server fills every projection's counts from its durable open-request
 *  table, so those stand for a background session, and its events only fill
 *  in a projection that arrived without counts. */
const eventsGovernAttention = (session: Pick<SessionProjection, "id" | "attention">): boolean =>
  session.id === state.activeSessionId || session.attention === undefined;

export function modelForAutoAccept(model: RenderModel, flags: AutoAcceptFlags | null | undefined): RenderModel {
  const answered = (permission: PendingPermission) => permission.status === "pending" && autoAcceptAnswers(permission, flags);
  if (!model.permissions.some(answered)) return model;
  return {
    ...model,
    permissions: model.permissions.filter((permission) => !answered(permission)),
  };
}

export function useActiveModel(): RenderModel {
  return useSessionModel(useStore((s) => s.activeSessionId));
}

/** The render model of any cached session — the active chat's, or a split
 *  view companion's, which renders a background session through the same
 *  Timeline. */
export function useSessionModel(sessionId: string | null): RenderModel {
  const events = useStore((s) => (sessionId ? s.events[sessionId] : undefined) ?? EMPTY_EVENTS);
  const autoAccept = useStore((s) =>
    sessionId !== null
    && s.sessions.find((session) => session.id === sessionId)?.autoAccept === true);
  const autoAcceptAll = useStore((s) =>
    sessionId !== null
    && s.sessions.find((session) => session.id === sessionId)?.autoAcceptAll === true);
  return useMemo(() => {
    const model = reduceSessionModel(sessionId, events);
    // The server resolver remains authoritative. This projection guard only
    // prevents an already-hydrated/stale request from flashing while the
    // durable automatic response is being reconciled after toggle/reconnect.
    // A request the policy holds for a person stays visible.
    return modelForAutoAccept(model, { autoAccept, autoAcceptAll });
  }, [sessionId, events, autoAccept, autoAcceptAll]);
}

// ---- project registry actions -----------------------------
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
  if (result.outcome === "published") {
    const active = result.state.projects.find((project) => project.id === state.activeProjectId);
    setClientReliabilitySpace(active?.spaceId ?? "default");
    setClientReliabilityProject(state.activeProjectId);
    set({ projectRegistry: result.state });
    // Project-list hydration can finish before the async navigation record.
    // Heal from the synchronous persisted/new-chat/session context immediately
    // so project-scoped workspace panes never observe a false ready-empty scope.
    reconcileWorkspaceProjectFromSession();
  }
  return result.outcome;
}

export function failProjectList(ticket: ProjectListTicket, error: string): void {
  set({ projectRegistry: publishListFailure(state.projectRegistry, ticket.requestId, error) });
}

/** Rename (and other in-place mutations): upsert the server-returned project. */
export function applyProjectUpsert(project: Project): void {
  if (project.id === state.activeProjectId) {
    setClientReliabilitySpace(project.spaceId ?? "default");
    setClientReliabilityProject(project.id);
  }
  set({ projectRegistry: upsertProject(state.projectRegistry, project) });
}

/** Add/Create success — one atomic client transaction: the server-returned
 *  project is in the registry AND active in the same store transition, so the
 *  picker can observe the commit before it closes. Stale session/branch/editor
 *  state from another project is cleared here; no session is created. */
export function applyProjectAdded(project: Project): void {
  setClientReliabilitySpace(project.spaceId ?? "default");
  setClientReliabilityProject(project.id);
  saveNavigationHint("polyth.activeProjectId", project.id);
  const projectRegistry = upsertProject(state.projectRegistry, project);
  if (state.activeProjectId === project.id) {
    persistClientNavigation(project.id, state.activeSessionId);
    set({ projectRegistry });
    return;
  }
  set({
    projectRegistry,
    activeProjectId: project.id,
    activeSessionId: null,
    activePage: null,
    newSessionIntent: null,
    gitBranch: "",
    editorFile: null,
    editorRepositoryId: null,
    editorLocation: null,
    gitDiffPath: null,
  });
  persistClientNavigation(project.id, null);
  setWorkspaceModeProject(project.id);
}

/** Delete success: remove the confirmed id and resolve a replacement active. */
export function applyProjectRemoved(id: string): void {
  const projectRegistry = removeProject(state.projectRegistry, id);
  const activeProjectId = replacementActiveId(projectRegistry.projects, state.activeProjectId);
  const active = projectRegistry.projects.find((project) => project.id === activeProjectId);
  setClientReliabilitySpace(active?.spaceId ?? "default");
  setClientReliabilityProject(activeProjectId);
  saveNavigationHint("polyth.activeProjectId", activeProjectId ?? "");
  if (activeProjectId === state.activeProjectId) {
    persistClientNavigation(activeProjectId, state.activeSessionId);
    set({ projectRegistry });
    return;
  }
  set({
    projectRegistry,
    activeProjectId,
    activeSessionId: null,
    activePage: null,
    newSessionIntent: null,
    gitBranch: "",
    editorFile: null,
    editorRepositoryId: null,
    editorLocation: null,
    gitDiffPath: null,
  });
  persistClientNavigation(activeProjectId, null);
  setWorkspaceModeProject(activeProjectId);
}

// ---- other actions ---------------------------------------------------------

/** Replace ONE project's session projections, keeping every other project's
 *  entries (the sidebar folder mode shows
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
  const nextSessions = withOptimisticSessionChanges(others.length === 0 ? merged : [...others, ...merged]);
  set({ sessions: nextSessions });
  reconcileWorkspaceProjectFromSession();
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

function projectPanePresentation(projectId: string | null): Pick<
  AppState,
  "railPlugin" | "paneMode" | "panePreviousMode" | "paneFullscreen" | "editorFile" | "editorLocation" | "gitDiffPath"
> {
  const pane = projectId !== null ? getWorkspacePanePrefs(projectId) : null;
  const restored = pane?.mode === "pinned" && pane.openSurface !== null
    // Keep an as-yet-unregistered package id so late web-package loading can
    // make the pinned window visible without another project activation.
    ? paneSurfaceOf(pane.openSurface)?.id ?? pane.openSurface
    : null;
  // Older records (and a crash during a dynamic/fullscreen window) may still
  // contain a non-pinned open surface. Scrub it so it cannot be restored by a
  // later project activation.
  if (projectId !== null && pane !== null && pane.openSurface !== null && pane.mode !== "pinned") {
    setPaneOpenSurface(projectId, null);
  }
  const restoredResource = restored !== null ? pane?.lastResource[restored] : undefined;
  const resourceState = restored !== null && restoredResource !== undefined
    ? applyPaneResource(restored, restoredResource)
    : {};
  const priorRail = state.railPlugin !== null
    ? listSurfaces().find((surface) => surface.id === state.railPlugin)
    : undefined;
  const railPlugin = restored
    ?? (priorRail !== undefined && !isWorkspaceSurface(priorRail) ? state.railPlugin : null);
  return {
    railPlugin,
    paneMode: restored !== null ? pane!.mode : "dynamic",
    panePreviousMode: restored !== null ? pane!.previousMode : "dynamic",
    paneFullscreen: false,
    editorFile: resourceState.editorFile ?? null,
    editorLocation: resourceState.editorLocation ?? null,
    gitDiffPath: resourceState.gitDiffPath ?? null,
  };
}

if (typeof window !== "undefined") {
  window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, (event) => {
    const projectId = projectPresentationEventProjectId(event);
    if (projectId === null || projectId !== state.activeProjectId || !projectPresentationEventHasKey(event, "workspacePane")) return;
    // A same-project record rehydrate — boot, WebSocket reconnect, or a
    // cross-device sync — is NOT a project transition. `projectPanePresentation`
    // intentionally treats the persisted record as authoritative (it restores
    // only a PINNED surface and scrubs dynamic ones), so applying it here would
    // close every dynamic package window on each rehydrate even though the user
    // never closed it. Only activateProject() may restore/replace the visible
    // surface from the record; an open window stays exactly as the user left it.
    if (state.railPlugin !== null) return;
    set(projectPanePresentation(projectId));
  });
}

function bindReliabilityForProject(projectId: string | null): void {
  const project = state.projectRegistry.projects.find((candidate) => candidate.id === projectId);
  setClientReliabilitySpace(project?.spaceId ?? "default");
  setClientReliabilityProject(projectId);
  saveNavigationHint("polyth.activeProjectId", projectId ?? "");
}

/** Fill a missing canonical project from any unambiguous workspace owner.
 * Kept under the historical export name because reconnect/open callers already
 * use it; the resolver now also covers new-chat, spawn and persisted hydration. */
export function reconcileWorkspaceProjectFromSession(): void {
  if (normalizedProjectId(state.activeProjectId)) return;
  const owned = workspaceProjectId(state);
  if (!owned) return;
  bindReliabilityForProject(owned);
  set({
    activeProjectId: owned,
    gitBranch: "",
    ...projectPanePresentation(owned),
  });
  persistClientNavigation(owned, state.activeSessionId);
  setWorkspaceModeProject(owned);
  setWorkbenchProject(owned);
}

export function activateProject(id: string | null, newSessionIntent: NewSessionIntent | null = null): void {
  const nextId = normalizedProjectId(id);
  bindReliabilityForProject(nextId);
  // Re-activating the current project must not drop the session or branch.
  if (nextId === normalizedProjectId(state.activeProjectId)) {
    if (state.activeProjectId !== nextId) set({ activeProjectId: nextId });
    persistClientNavigation(nextId, state.activeSessionId);
    return;
  }
  // An intent installed in the same publish tells project subscribers (the
  // workbench lane restore) that the user is composing here, not navigating.
  // Another project's page (an agent) never stays on screen over this one.
  set({
    activeProjectId: nextId, activeSessionId: null, activePage: null, gitBranch: "",
    newSessionIntent: newSessionIntent?.projectId === nextId ? newSessionIntent : null,
    ...projectPanePresentation(nextId),
  });
  persistClientNavigation(nextId, null);
  setWorkspaceModeProject(nextId);
  setWorkbenchProject(nextId);
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
  // Protected mode: the server refuses project add / folder browse.
  if (overlay === "project-picker" && (!guardedProjectAddAllowed(getGuardrails()) || !limitedProjectAddAllowed(getAccountLimits()))) return;
  // Plain opens reset to the general palette; openPalette() picks the mode.
  set({
    overlay,
    ...(overlay === "palette" ? { paletteMode: "all" as PaletteMode } : {}),
    ...(overlay !== "worktree-session" ? { worktreeSessionRequest: null } : {}),
    ...(overlay !== "archived-sessions" ? { archivedSessionsProjectId: null } : {}),
    ...(overlay !== "session-sharing" ? { sharingSessionId: null } : {}),
  });
}
export function openSessionSharing(sessionId: string): void {
  set({ overlay: "session-sharing", sharingSessionId: sessionId, worktreeSessionRequest: null, archivedSessionsProjectId: null });
}
export function openArchivedSessions(projectId: string): void {
  set({ overlay: "archived-sessions", archivedSessionsProjectId: projectId, worktreeSessionRequest: null });
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
export interface PendingSettingsNavigation {
  pageId: string;
  target?: SettingsNavigationTarget;
}
let pendingSettingsNavigation: PendingSettingsNavigation | null = null;
export function openSettingsPage(pageId: string, target?: SettingsNavigationTarget): void {
  pendingSettingsNavigation = { pageId, ...(target ? { target } : {}) };
  set({ overlay: "settings" });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new window.CustomEvent("polyth:settings-page", {
      detail: pendingSettingsNavigation,
    }));
  }
}
/** One-shot read by SettingsView on mount. */
export function consumePendingSettingsPage(): string | null {
  return consumePendingSettingsNavigation()?.pageId ?? null;
}
/** One-shot settings route, including an optional page-local target. */
export function consumePendingSettingsNavigation(): PendingSettingsNavigation | null {
  const value = pendingSettingsNavigation;
  pendingSettingsNavigation = null;
  return value;
}
export function setRailPlugin(railPlugin: RailPlugin | null): void {
  // Contextual surfaces persist globally. Workspace panes go through
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

// ---- workspace pane command path ------------------------------
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

const TEXT_ENTRY = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** A touch device raises its software keyboard for any text entry that takes
 *  focus. Closing a window there never hands focus to one: on the iOS app the
 *  composer took it as a phone package closed, and the keyboard flashed up
 *  until the leaving Workspace returned focus to Tools a moment later. */
function focusRaisesKeyboard(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** Focus the exact invoker when still connected, else the surface's launcher,
 *  else Chat's composer — on a touch device the phone's Tools control instead
 *  of any text entry. Without `fallback` only the invoker is tried: another
 *  layer owns focus when it cannot take it. */
function restorePaneFocus(surfaceId: string | null, { fallback = true }: { fallback?: boolean } = {}): void {
  if (typeof document === "undefined") return;
  const invoker = paneInvoker;
  paneInvoker = null;
  // Defer one tick so the pane is hidden and launchers reflect the new state.
  setTimeout(() => {
    const touch = focusRaisesKeyboard();
    if (invoker && invoker.isConnected && invoker.getClientRects().length > 0 && !invoker.closest("[inert]")
      && !(touch && invoker.matches(TEXT_ENTRY))) {
      invoker.focus();
      if (document.activeElement === invoker) return;
    }
    if (!fallback) return;
    const launcher = surfaceId !== null
      ? document.querySelector<HTMLElement>(`[data-pane-launcher="${surfaceId}"]`)
      : null;
    if (launcher) {
      launcher.focus();
      return;
    }
    if (!touch) {
      focusComposer();
      return;
    }
    // The phone header's Tools control leads back to the window that closed.
    document.querySelector<HTMLElement>("[data-workspace-trigger]")?.focus({ preventScroll: true });
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
  const projectId = workspaceProjectId(state);
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
  const projectId = workspaceProjectId(state);
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
  // A phone Back names the Workspace as the destination before the window
  // closes (ModuleView, native Back, the edge swipe). That layer takes focus
  // itself once it is revealed (Sheet's modal surface reclaims it for a few
  // frames), so only the invoker (the Workspace tile) is restored: a fallback
  // racing the Workspace focused the composer whenever the Workspace could
  // not take focus yet, and the keyboard opened over it.
  const toWorkspace = getMobileWorkspaceNavigationSnapshot().homeOpen;
  if (restoreFocus && open !== null) restorePaneFocus(open.id, { fallback: !toWorkspace });
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
/** Sync the kept-alive editor selection without navigating to Files. A Canvas
 *  widget owns its own pane host, so it publishes the selection — plus an
 *  optional one-shot reveal range — here instead of using the navigating
 *  `openEditorFile` adapter. */
export function setEditorFile(editorFile: string | null, repositoryId?: string, location?: EditorLocation | null): void {
  set({ editorFile, editorLocation: location ?? null, editorRepositoryId: repositoryId ?? null });
}
let editorOpenSequence = 0;
/** Compatibility adapter: open the Files surface and the stable
 *  "file:<path>" provider resource. Never sets the primary view. A location
 *  asks the editor to select/center that range once loaded. */
export function openEditorFile(path: string | null, location?: EditorLocation, options: { preview?: boolean; repositoryId?: string } = {}): void {
  set({
    editorFile: path,
    editorRepositoryId: options.repositoryId ?? null,
    editorLocation: location ?? null,
    editorOpenRequest: path === null ? null : {
      id: ++editorOpenSequence,
      preview: options.preview !== false,
      ...(options.repositoryId ? { repositoryId: options.repositoryId } : {}),
      projectId: workspaceProjectId(state),
      sessionId: state.activeSessionId,
    },
  });
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
const MAX_INACTIVE_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_INACTIVE_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_INACTIVE_SESSION_EVENTS = 8_000;
const sessionTouchOrder: string[] = [];
/** Sessions on screen besides the active chat (a split view's companion
 *  pane): the inactive-cache bound never evicts them from under their view. */
const pinnedCacheSessions = new Set<string>();

/** Keep one background session's history cached while a view shows it.
 *  Returns the release. */
export function pinSessionCache(id: string): () => void {
  pinnedCacheSessions.add(id);
  touchSessionCache(id);
  return () => { pinnedCacheSessions.delete(id); };
}
const historyBytes = new WeakMap<readonly SessionEvent[], number>();
const eventBytes = new WeakMap<SessionEvent, number>();
function sizeOfEvent(event: SessionEvent): number {
  let size = eventBytes.get(event);
  // Conservative UTF-16 allocation estimate; objects/array nodes add overhead.
  if (size === undefined) { size = JSON.stringify(event).length * 2 + 256; eventBytes.set(event, size); }
  return size;
}
function sizeOfHistory(events: readonly SessionEvent[]): number {
  let size = historyBytes.get(events);
  if (size === undefined) { size = events.reduce((total, event) => total + sizeOfEvent(event), 0); historyBytes.set(events, size); }
  return size;
}

/** All ingress paths use this owner. Evict entire inactive caches: truncating
 * canonical prefixes without a semantic checkpoint would lose pending state. */
function boundedInactiveHistories(histories: Record<string, SessionEvent[]>, activeId = state.activeSessionId): Record<string, SessionEvent[]> {
  const ids = Object.keys(histories);
  for (const id of ids) if (!sessionTouchOrder.includes(id)) sessionTouchOrder.push(id);
  let bytes = 0;
  let count = ids.length;
  const victims = new Set<string>();
  for (const id of ids) {
    if (id === activeId || id === state.openingSessionId || pinnedCacheSessions.has(id)) continue;
    const list = histories[id]!;
    const size = sizeOfHistory(list);
    if (size > MAX_INACTIVE_SESSION_BYTES || list.length > MAX_INACTIVE_SESSION_EVENTS) victims.add(id);
    else bytes += size;
  }
  count -= victims.size;
  for (const id of sessionTouchOrder) {
    if (count <= MAX_CACHED_SESSIONS && bytes <= MAX_INACTIVE_CACHE_BYTES) break;
    if (id === activeId || id === state.openingSessionId || pinnedCacheSessions.has(id) || victims.has(id) || !histories[id]) continue;
    victims.add(id); count--; bytes -= sizeOfHistory(histories[id]!);
  }
  if (!victims.size) return histories;
  const next = { ...histories };
  for (const id of victims) {
    delete next[id]; activeModelCache.drop(id);
    const position = sessionTouchOrder.indexOf(id); if (position >= 0) sessionTouchOrder.splice(position, 1);
  }
  return next;
}

export function touchSessionCache(id: string): void {
  const at = sessionTouchOrder.indexOf(id);
  if (at >= 0) sessionTouchOrder.splice(at, 1);
  sessionTouchOrder.push(id);
  if (sessionTouchOrder.length <= MAX_CACHED_SESSIONS) return;
  const victims = sessionTouchOrder.splice(0, sessionTouchOrder.length - MAX_CACHED_SESSIONS);
  let next: Record<string, SessionEvent[]> | null = null;
  for (const victim of victims) {
    if (victim === id) continue;
    // A pinned view keeps its history; it stays first in line for later.
    if (pinnedCacheSessions.has(victim)) { sessionTouchOrder.unshift(victim); continue; }
    activeModelCache.drop(victim);
    if (state.events[victim] !== undefined) {
      next ??= { ...state.events };
      delete next[victim];
    }
  }
  if (next) state = { ...state, events: next }; // folded into the caller's set()
}

/** Whether an open workspace window stays across a chat switch beyond the
 *  pinned rule. Workbench navigation registers it (a home surface that owns
 *  its chat lane keeps its window across that lane's chats); the store stays
 *  free of workbench imports. `targetSessionId` undefined = the active chat. */
type SessionPaneKeeper = (surfaceId: string, targetSessionId: string | null | undefined) => boolean;
let sessionPaneKeeper: SessionPaneKeeper | null = null;
export function setSessionPaneKeeper(keeper: SessionPaneKeeper | null): void {
  sessionPaneKeeper = keeper;
}
function closePaneForChatChange(targetSessionId: string | null | undefined): void {
  if (state.paneMode === "pinned") return;
  const surfaceId = state.railPlugin;
  if (surfaceId !== null && paneSurfaceOf(surfaceId) !== null && sessionPaneKeeper?.(surfaceId, targetSessionId)) return;
  closeWorkspacePane();
}

export function activateSession(id: string | null): void {
  if (id !== state.activeSessionId && (state.uiError !== null || state.uiErrorAction !== null)) {
    clearUiError();
  }
  saveNavigationHint("polyth.activeSessionId", id ?? "");
  if (id !== null) touchSessionCache(id);
  // Session activation is also used by deep links and deletion. Keep the
  // same rule as the visible session-navigation path: only pinned workspace
  // windows (and a lane's home surface, see setSessionPaneKeeper) may cross
  // the session boundary.
  closePaneForChatChange(id);
  const owned = id ? sessionOwnedProjectId(state.sessions, id) : null;
  const adopt = owned !== null && normalizedProjectId(state.activeProjectId) === null;
  if (adopt && owned) bindReliabilityForProject(owned);
  set({
    activeSessionId: id,
    events: boundedInactiveHistories(state.events, id),
    ...(id !== null ? { newSessionIntent: null } : {}),
    ...(adopt && owned ? {
      activeProjectId: owned,
      gitBranch: "",
      ...projectPanePresentation(owned),
    } : {}),
  });
  persistClientNavigation(state.activeProjectId, id);
  if (adopt && owned) {
    setWorkspaceModeProject(owned);
    setWorkbenchProject(owned);
  }
}

/** Enter the unsaved new-chat surface. The session is deliberately absent
 * until Composer admits the first message. */
export function startNewSession(
  projectId: string,
  options: StartNewSessionOptions = {},
): void {
  if (state.activeSessionId !== null && (state.uiError !== null || state.uiErrorAction !== null)) {
    clearUiError();
  }
  if (options.recovery && !newSessionScopeIsCurrent(options.recovery.scope)) return;
  if (state.activeProjectId !== projectId) activateProject(projectId);
  const targetScope = newSessionPersistenceScope(projectId);
  const restoring = options.recovery !== undefined
    || options.restoreDraft === true
    || (options.draft === undefined && !options.title && !options.worktreePath && options.repositoryIds === undefined && options.isolate === undefined);
  const saved = restoring
    ? loadNewSessionDraft(projectId, targetScope)
    : null;
  const recovered = restoring
    ? options.recovery
      ? takePreviousNewSessionDraft(projectId, options.recovery.scope, options.recovery.revision)
      : takePreviousNewSessionDraft(projectId, targetScope)
    : null;
  const intent: NewSessionIntent = {
    projectId,
    draft: options.recovery
      ? recovered?.text ?? saved?.draft ?? ""
      : options.draft ?? recovered?.text ?? saved?.draft ?? "",
    ...(options.recovery
      ? sessionIntentMetadata(saved ?? undefined, recovered ?? undefined)
      : sessionIntentMetadata(options, saved ?? undefined, recovered ?? undefined)),
  };
  // Native records live behind an async loopback adapter. Enter the surface
  // immediately, but do not write an empty placeholder over a not-yet-read
  // process-restart draft. A concurrent keystroke increments the persistence
  // generation and therefore wins the hydration race.
  const restoreKey = scopedDraftCacheKey(null);
  const restore = restoring && !options.recovery && !recovered && (options.restoreDraft === true || !saved)
    ? hydrateNewSessionDraft(projectId) : null;
  if (!restore) saveNewSessionDraft(intent);
  saveNavigationHint("polyth.activeSessionId", "");
  set({
    activeSessionId: null,
    openingSessionId: null,
    newSessionIntent: intent,
  });
  persistClientNavigation(projectId, null);
  showSessionChat();
  if (restore) void restore.then((persisted) => {
    if (scopedDraftCacheKey(null) !== restoreKey
      || state.activeProjectId !== projectId
      || state.activeSessionId !== null
      || state.newSessionIntent !== intent) return;
    if (persisted?.recovery && !newSessionScopeIsCurrent(persisted.recovery.scope)) return;
    if (persisted?.recovery) {
      takePreviousNewSessionDraft(projectId, persisted.recovery.scope, persisted.recovery.revision);
    }
    const current = loadScopedDraftRecord(null);
    const next: NewSessionIntent = {
      projectId,
      draft: current.updatedAt > 0 ? current.text : persisted?.draft ?? "",
      ...sessionIntentMetadata(options, persisted ?? undefined),
    };
    saveNewSessionDraft(next);
    set({ newSessionIntent: next });
  }).catch(() => {
    // Keep the in-memory draft usable. Persistence errors surface on flush.
  });
}

// A navigation installs an intent; a checkout or repository choice republishes
// a derived copy so subscribers see the new metadata. The copy is the same
// unsent chat, so it maps to the intent it was derived from (`null` when there
// was none). Anything not recorded here is its own origin.
const intentOrigins = new WeakMap<NewSessionIntent, NewSessionIntent | null>();

/** The intent a navigation installed for the unsent chat on screen. Metadata
 * choices keep it, so the composer can re-seed its input exactly when the chat
 * changes and never because a choice was made. */
export function newSessionOrigin(intent: NewSessionIntent | null): NewSessionIntent | null {
  if (!intent) return null;
  return intentOrigins.has(intent) ? intentOrigins.get(intent)! : intent;
}

/** Change a choice attached to the unsent chat. It never touches the draft:
 * the live text is owned by the composer, and `draft` here may be a stale seed. */
function updateNewSessionMetadata(projectId: string, apply: (next: NewSessionIntent) => void): void {
  if (state.activeSessionId || workspaceProjectId(state) !== projectId) return;
  const live = state.newSessionIntent?.projectId === projectId ? state.newSessionIntent : null;
  const next: NewSessionIntent = { ...(live ?? { projectId, draft: loadScopedDraftRecord(null).text }) };
  apply(next);
  intentOrigins.set(next, newSessionOrigin(live));
  saveNewSessionIntentMetadata(next, newSessionPersistenceScope(projectId));
  set({ newSessionIntent: next });
}

/** Advanced new-session preference; creation still waits for the first send. */
export function setNewSessionRepositories(projectId: string, repositoryIds?: readonly string[]): void {
  updateNewSessionMetadata(projectId, (next) => {
    if (repositoryIds === undefined) delete next.repositoryIds;
    else next.repositoryIds = [...repositoryIds];
  });
}

/** Persist the user's checkout choice without creating a session or worktree. */
export function setNewSessionIsolation(projectId: string, isolate: boolean): void {
  updateNewSessionMetadata(projectId, (next) => { next.isolate = isolate; });
}

let nextSessionSpawnRequestId = 0;

export function beginSessionSpawn(
  projectId: string,
  harness?: Pick<SessionSpawn, "harnessId" | "harnessName" | "model">,
): number {
  const requestId = ++nextSessionSpawnRequestId;
  set({
    sessionSpawn: {
      requestId,
      projectId,
      sessionId: null,
      ...(harness?.harnessId ? { harnessId: harness.harnessId } : {}),
      ...(harness?.harnessName ? { harnessName: harness.harnessName } : {}),
      ...(harness?.model ? { model: harness.model } : {}),
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

let nextPendingSendId = 0;

function createPendingSend(
  input: Pick<PendingSend, "sessionId" | "text" | "attachments" | "model" | "harness" | "delivery">,
): PendingSend {
  return {
    ...input,
    id: `pending-send-${++nextPendingSendId}`,
    afterSeq: input.sessionId ? lastSeq(input.sessionId) : 0,
  };
}

/** Stage the optimistic echo for a prompt that is being submitted now. */
export function beginPendingSend(
  input: Pick<PendingSend, "sessionId" | "text" | "attachments" | "model" | "harness" | "delivery">,
): string {
  const pending = createPendingSend(input);
  set({ pendingSends: [...state.pendingSends, pending] });
  return pending.id;
}

/** Publish one durable event and its replacement echo in one store snapshot.
 * Regenerate uses this so no renderer can observe the old prompt and the new
 * echo together, even outside React's automatic batching boundary. */
export function applyEventWithPendingSend(
  event: SessionEvent,
  input: Pick<PendingSend, "sessionId" | "text" | "attachments" | "model" | "harness" | "delivery">,
): string {
  const pending = createPendingSend(input);
  applyEvents([event], { pendingSend: pending });
  if (!getState().pendingSends.some((send) => send.id === pending.id)) {
    set({ pendingSends: [...getState().pendingSends, pending] });
  }
  return pending.id;
}

/** First-send creation resolved its session id; re-anchor the echo's tail. */
export function bindPendingSend(id: string, sessionId: string): void {
  const at = state.pendingSends.findIndex((p) => p.id === id);
  if (at < 0 || state.pendingSends[at]!.sessionId !== null) return;
  const next = state.pendingSends.slice();
  next[at] = { ...next[at]!, sessionId, afterSeq: lastSeq(sessionId) };
  set({ pendingSends: next });
}

/** Drop an echo whose submission failed. A rejected prompt has no canonical
 *  event to wait for, so the composer takes its text back instead. */
export function endPendingSend(id: string): void {
  if (!state.pendingSends.some((p) => p.id === id)) return;
  set({ pendingSends: state.pendingSends.filter((p) => p.id !== id) });
}

/** FIFO retirement: each canonical admission newer than the oldest echo's
 *  captured tail replaces exactly one echo. `queue/enqueued` counts because a
 *  normal send the server falls back to the queue produces that instead of a
 *  `user/message`. Interrupt parks the same text on the queue until abort
 *  finishes — that enqueue must not retire the echo or the timeline blanks.
 *  Steer persists a `user/message` before I/O; `delivery/steered` is only
 *  confirmation and must not count as a second admission. */
export function retiredPendingSends(
  pending: readonly PendingSend[],
  merged: readonly SessionEvent[],
): PendingSend[] {
  const oldest = pending[0];
  if (!oldest) return [];
  let landed = 0;
  for (let i = merged.length - 1; i >= 0 && merged[i]!.seq > oldest.afterSeq; i -= 1) {
    const type = merged[i]!.type;
    if (type === "user/message") {
      landed += 1;
      continue;
    }
    if (type === "queue/enqueued") {
      const delivery = (merged[i]!.data as { delivery?: unknown } | undefined)?.delivery;
      if (delivery === "interrupt") continue;
      landed += 1;
    }
  }
  return pending.slice(0, landed);
}

/** Presentation overlay while a prompt is in flight: the session looks like
 *  work already started, including a model the composer just selected. */
export function overlaySessionProjection(
  session: SessionProjection | null | undefined,
  pendingSends: readonly PendingSend[],
): SessionProjection | null | undefined {
  if (!session) return session;
  const pending = pendingSends.findLast((item) => item.sessionId === session.id);
  const cachedEvents = state.events[session.id];
  let attention = session.attention;
  let policyAnswering = false;
  if (cachedEvents && cachedEvents.length > 0 && eventsGovernAttention(session)) {
    const model = activeModelCache.get(session.id, cachedEvents);
    const openPermissions = openPermissionCount(model, session);
    const openQuestions = model.questions.filter((q) => q.status === "pending").length;
    if (attention === undefined || attention.permissions !== openPermissions || attention.questions !== openQuestions) {
      attention = {
        questions: openQuestions,
        permissions: openPermissions,
        unread: attention?.unread ?? 0,
        ...(attention?.goalStatus ? { goalStatus: attention.goalStatus } : {}),
      };
    }
    // Choosing Auto-Approve or Full access on a card publishes the policy
    // before the server answers the request it covers. In between, the
    // session is still `waiting` with nothing left for a person, which would
    // read as "waiting for your reply". The agent is about to continue.
    policyAnswering = session.status === "waiting" && openPermissions === 0 && openQuestions === 0
      && model.permissions.some((p) => p.status === "pending" && autoAcceptAnswers(p, session));
  }
  const withAttention = attention !== session.attention || policyAnswering
    ? { ...session, attention, ...(policyAnswering ? { status: "working" as const } : {}) }
    : session;
  if (!pending) return withAttention;
  if (
    withAttention.status === "archived"
    || withAttention.status === "failed"
    || withAttention.status === "epoch-pending"
  ) return withAttention;
  return {
    ...withAttention,
    status: "working",
    ...(pending.model ? { model: pending.model } : {}),
  };
}

const NO_PENDING_SENDS: PendingSend[] = [];

type PendingSendSurface = Pick<AppState, "pendingSends" | "sessionSpawn" | "activeProjectId">;

/** Echoes that belong to the surface currently on screen. An echo staged
 *  before first-send creation resolved belongs only to the new-chat surface
 *  that spawned it, or to the session that spawn has been bound to — never to
 *  another chat the user switches to while creation is still running. */
export function pendingSendsForSurface(
  current: PendingSendSurface,
  sessionId: string | null,
): PendingSend[] {
  if (current.pendingSends.length === 0) return NO_PENDING_SENDS;
  const spawn = current.sessionSpawn;
  const adoptUnbound = spawn !== null
    && spawn.projectId === current.activeProjectId
    && spawn.sessionId === sessionId;
  const mine = current.pendingSends.filter((p) =>
    p.sessionId === sessionId || (p.sessionId === null && adoptUnbound));
  return mine.length === 0 ? NO_PENDING_SENDS : mine;
}

export function hasInFlightPrompt(current: PendingSendSurface, sessionId: string | null): boolean {
  return pendingSendsForSurface(current, sessionId).length > 0;
}

export function usePendingSends(sessionId: string | null): PendingSend[] {
  const pendingSends = useStore((s) => s.pendingSends);
  const sessionSpawn = useStore((s) => s.sessionSpawn);
  const activeProjectId = useStore((s) => s.activeProjectId);
  return useMemo(
    () => pendingSendsForSurface({ pendingSends, sessionSpawn, activeProjectId }, sessionId),
    [pendingSends, sessionSpawn, activeProjectId, sessionId],
  );
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
  closePaneForChatChange(undefined);
  set({ overlay: null, activePage: null });
  setActiveView("session");
  setWorkspaceMode("chat");
}

/** The single module close affordance. One call dismisses
 *  every open module — the main-area workspace view AND any right-rail panel
 *  or workspace pane — and returns to the session. Every module's shared
 *  ModuleView close button routes here, so on phone the stacked overlays all
 *  disappear together instead of peeling back one "Back to chat" at a time. */
export function closeAllModules(): void {
  closeWorkspacePane();
  setRailPlugin(null);
  set({ overlay: null, activePage: null });
  setActiveView("session");
  setWorkspaceMode("chat");
}

/** Dismiss only the package window that is on top (rail pane, contextual
 *  panel or non-Chat view) and leave every other layer alone. This is the
 *  "pop" half of phone Back: the caller decides which layer becomes the
 *  foreground; `closeAllModules` is the dismiss-everything counterpart. */
export function closePackageWindow(): void {
  if (state.railPlugin !== null) setRailPlugin(null);
  else if (state.activeView !== "session") setActiveView("session");
}

/** Show a registered package page in place of Chat — an agent opened from
 *  the navigator. Like a chat switch, it closes a floating package window
 *  and keeps a pinned one; `projectId` first moves the workspace to the
 *  page's project. The chat the canvas returns to stays `activeSessionId`. */
export function openPage(pageId: string, resource: string | null = null, options: { projectId?: string } = {}): boolean {
  if (!getPage(pageId)) return false;
  const projectId = options.projectId ? normalizedProjectId(options.projectId) : null;
  if (projectId !== null && projectId !== normalizedProjectId(state.activeProjectId)) activateProject(projectId);
  closePaneForChatChange(undefined);
  const current = state.activePage;
  set({
    overlay: null,
    activeView: "session",
    ...(current?.pageId === pageId && current.resource === resource ? {} : { activePage: { pageId, resource } }),
  });
  saveActiveView("session");
  setWorkspaceMode("chat");
  return true;
}

/** The page shown in place of Chat, while its package is registered. */
export function useOpenPage(): ActivePage | null {
  useSyncExternalStore(subscribePages, pagesVersion);
  return useStore((s) => s.activePage !== null && getPage(s.activePage.pageId) ? s.activePage : null);
}

/** Return the canvas to Chat. */
export function closePage(): void {
  if (state.activePage !== null) set({ activePage: null });
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

export interface UiErrorAction {
  label: string;
  run(): void | Promise<void>;
}

/** `error` by default; `warning`/`info` for calm words that are no failure
 *  (e.g. "Nothing to compact yet", "That chat is no longer available"). */
export type UiErrorKind = "error" | "warning" | "info";

let uiErrorTimer: ReturnType<typeof setTimeout> | undefined;
let uiErrorKey: string | undefined;
let uiErrorPresenters = 0;
const seenUiErrorKeys = new Set<string>();
const UI_ERROR_KEY_CAP = 512;
const UI_ERROR_FALLBACK_MS = 7_000;

// One host-owned transient error surface. New failures replace stale ones.
// Keyed notices are remembered for this tab so remounting a session cannot
// replay a durable notification that the server already recorded.
export function setUiError(
  message: string,
  action: UiErrorAction | null = null,
  dedupeKey?: string,
  kind: UiErrorKind = "error",
): void {
  if (dedupeKey !== undefined) {
    if (seenUiErrorKeys.has(dedupeKey)) return;
    seenUiErrorKeys.add(dedupeKey);
    // ponytail: bound tab-lifetime replay memory; persist only if reload replay
    // becomes a product requirement.
    if (seenUiErrorKeys.size > UI_ERROR_KEY_CAP) {
      seenUiErrorKeys.delete(seenUiErrorKeys.values().next().value!);
    }
  }
  if (uiErrorTimer !== undefined) clearTimeout(uiErrorTimer);
  uiErrorTimer = undefined;
  // With a presenter mounted its notification's pausable countdown is the
  // error's lifetime; this timer would close a card the person is reading.
  if (uiErrorPresenters === 0) {
    uiErrorTimer = setTimeout(() => {
      uiErrorTimer = undefined;
      uiErrorKey = undefined;
      set({ uiError: null, uiErrorAction: null, uiErrorKind: "error" });
    }, UI_ERROR_FALLBACK_MS);
  }
  uiErrorKey = dedupeKey;
  set({ uiError: message, uiErrorAction: action, uiErrorKind: kind, uiErrorSeq: state.uiErrorSeq + 1 });
}

export function clearUiError(): void {
  if (uiErrorTimer !== undefined) clearTimeout(uiErrorTimer);
  uiErrorTimer = undefined;
  uiErrorKey = undefined;
  set({ uiError: null, uiErrorAction: null, uiErrorKind: "error" });
}

/** A mounted presenter (ConnectionFeedback) owns the error's lifetime from now
 *  on; without one an error still expires on the store's fallback timer.
 *  Returns the release. */
export function claimUiErrorLifetime(): () => void {
  uiErrorPresenters += 1;
  if (uiErrorTimer !== undefined) clearTimeout(uiErrorTimer);
  uiErrorTimer = undefined;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    uiErrorPresenters -= 1;
  };
}

/** Withdraw a keyed notice that no longer applies, leaving any newer error. */
export function dismissUiError(dedupeKey: string): void {
  if (uiErrorKey === dedupeKey) clearUiError();
}


/** A server placeholder title must not clobber a title the client already
 *  derived from the first user message (applyEvents persists it instantly,
 *  before OpenCode's slower semantic title lands). Keeps it durable across
 *  event-cache eviction and projection refreshes. */
function preserveTitle(cur: SessionProjection, inc: SessionProjection): SessionProjection {
  if (inc.summary) {
    const retained = Object.fromEntries(Object.entries(cur).filter(([key]) => !(SESSION_SUMMARY_FIELDS as readonly string[]).includes(key)));
    inc = { ...retained, ...inc };
    // A summary can invalidate old isolation/detail metadata. Keep cached
    // content for paint, but the summary marker forces a full read on open.
    if (!inc.isolationSummary) delete inc.isolation;
  }
  // Session ownership is immutable. A malformed/partial live projection must
  // never detach an already-known session from its project: that makes every
  // workspace surface (Files/Git/Terminal/Browser) appear project-less while
  // Chat can still render the cached session title.
  const projectId = normalizedProjectId(inc.projectId) ?? normalizedProjectId(cur.projectId);
  let base = projectId && projectId !== inc.projectId ? { ...inc, projectId } : inc;
  if (!isPlaceholderTitle(cur.title, cur.id) && isPlaceholderTitle(base.title, base.id)) {
    const titleSource = cur.titleSource === "manual"
      || cur.titleSource === "native"
      || cur.titleSource === "generated"
      || cur.titleSource === "polyth"
      ? cur.titleSource
      : "polyth" as const;
    base = { ...base, title: cur.title, titleSource };
  }
  if (!inc.summary && base.attention === undefined && cur.attention !== undefined) {
    base = { ...base, attention: cur.attention };
  }
  if (!inc.summary && base.autoAccept === undefined && cur.autoAccept !== undefined) {
    base = {
      ...base,
      autoAccept: cur.autoAccept,
      ...(base.autoAcceptAll === undefined && cur.autoAcceptAll !== undefined ? { autoAcceptAll: cur.autoAcceptAll } : {}),
    };
  }
  return base;
}

/** Canonical content the client already holds for a session: conversation or
 *  workflow history, as opposed to creation/mutation bookkeeping. */
const CONTENT_EVENT_PREFIXES = ["user/", "assistant/", "turn/", "tool/", "workflow/"];
const hasCachedContent = (sessionId: string): boolean =>
  (state.events[sessionId] ?? []).some((event) =>
    CONTENT_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix)));
/** The open session is never swept away under the person viewing it; its
 *  failed/unknown status stays visible instead. */
const keepVisible = (sessionId: string): boolean =>
  sessionId === state.activeSessionId || hasCachedContent(sessionId);

export function upsertSession(p: SessionProjection): void {
  // Drop empty zombie sessions — creation failed before any user turn. A
  // session whose history is already on screen (e.g. a workflow parent that
  // a runtime restart marked unknown) is not empty and must stay visible.
  if (!p.historyImport && (p.status === "failed" || p.status === "unknown") && p.lastTurnAt == null
    && !keepVisible(p.id)) {
    removeSession(p.id);
    return;
  }
  const i = state.sessions.findIndex((s) => s.id === p.id);
  const cur = i >= 0 ? state.sessions[i] : undefined;
  const incoming = cur ? preserveTitle(cur, p) : p;
  const sessions = i >= 0 ? state.sessions.map((s, j) => (j === i ? incoming : s)) : [...state.sessions, incoming];
  set({ sessions: withOptimisticSessionChanges(sessions) });
  reconcileWorkspaceProjectFromSession();
}

/** Batched projection snapshot (WS `projections` frame): one store update —
 *  and one render pass — for the whole page instead of one per session. */
export function upsertSessions(list: readonly SessionProjection[]): void {
  if (list.length === 0) return;
  // Drop empty zombie sessions — creation failed before any user turn.
  const zombieIds = new Set(
    list.filter((p) => !p.historyImport && (p.status === "failed" || p.status === "unknown") && p.lastTurnAt == null
      && !keepVisible(p.id)).map((p) => p.id),
  );
  const byId = new Map(list.filter((p) => !zombieIds.has(p.id)).map((p) => [p.id, p]));
  const sessions = state.sessions
    .filter((s) => !zombieIds.has(s.id))
    .map((s) => {
      const next = byId.get(s.id);
      if (next) {
        byId.delete(s.id);
        return preserveTitle(s, next);
      }
      return s;
    });
  for (const p of byId.values()) sessions.push(p);
  if (zombieIds.size) {
    const events = { ...state.events };
    const runtimeFeatures = { ...state.runtimeFeatures };
    for (const id of zombieIds) { delete events[id]; delete runtimeFeatures[id]; activeModelCache.drop(id); }
    set({ sessions: withOptimisticSessionChanges(sessions), events, runtimeFeatures });
  } else set({ sessions: withOptimisticSessionChanges(sessions) });
  reconcileWorkspaceProjectFromSession();
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
  const ordered = incoming.every((ev, i) => i === 0 || ev.seq > incoming[i - 1]!.seq);
  if (incoming.length && ordered && (!list.length || incoming[0]!.seq > list.at(-1)!.seq)) {
    return appendEventSegments(list, incoming);
  }
  // Backfill fast path: an already-sorted batch that ends before the list
  // starts (older-history pages) concatenates without per-event inserts.
  if (
    list.length > 0
    && incoming.length > 0
    && incoming[incoming.length - 1]!.seq < list[0]!.seq
    && incoming.every((ev, i) => i === 0 || ev.seq > incoming[i - 1]!.seq)
  ) {
    return prependEventSegments(list, incoming);
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
 *  call regardless of batch size. Session open and WS bursts land here.
 *  `notifySessionEvents` is reserved for live delivery: callers hydrating
 *  durable history leave package observers quiet so replay cannot trigger a
 *  new surface reveal. */
export function applyEvents(
  evs: readonly SessionEvent[],
  options: {
    notifySessionEvents?: boolean;
    notifyEventKeys?: ReadonlySet<string>;
    pendingSend?: PendingSend;
  } = {},
): void {
  if (evs.length === 0) return;
  const bySession = new Map<string, SessionEvent[]>();
  for (const ev of evs) {
    const group = bySession.get(ev.sessionId);
    if (group) group.push(ev);
    else bySession.set(ev.sessionId, [ev]);
  }
  let next: Record<string, SessionEvent[]> | null = null;
  let nextSessions: SessionProjection[] | null = null;
  let retiredEchoes: Set<string> | null = null;
  const acceptedEvents: SessionEvent[] = [];
  for (const [sessionId, incoming] of bySession) {
    const list = state.events[sessionId] ?? EMPTY_EVENTS;
    const merged = mergeEvents(list, incoming);
    if (merged === list) continue;
    const batchSeqs = new Set<number>();
    let addedBytes = 0;
    for (const event of incoming) {
      const position = seqLowerBound(list, event.seq);
      const alreadyStored = position < list.length && list[position]!.seq === event.seq;
      if (!alreadyStored && !batchSeqs.has(event.seq)) {
        batchSeqs.add(event.seq);
        acceptedEvents.push(event);
        addedBytes += sizeOfEvent(event);
      }
    }
    next ??= { ...state.events };
    historyBytes.set(merged, sizeOfHistory(list) + addedBytes);
    next[sessionId] = merged;
    // The canonical prompt has landed: retire the optimistic echo that stood in
    // for it. Same store transition, so the timeline swaps them in one commit.
    if (state.pendingSends.length > 0) {
      for (const echo of retiredPendingSends(
        state.pendingSends.filter((p) => p.sessionId === sessionId),
        merged,
      )) {
        (retiredEchoes ??= new Set()).add(echo.id);
      }
    }
    // Persist the prompt-derived title into the session record as soon as the
    // first user message is visible in the merged log. This handles both the
    // common tail load and older-history backfills, and keeps the title durable
    // across event-cache eviction so sidebar/recent reads don't need events.
    const cur = state.sessions.find((s) => s.id === sessionId);
    if (cur) {
      let titlePatch: string | undefined;
      if (isPlaceholderTitle(cur.title, sessionId)) {
        const text = firstUserText(merged);
        if (text) titlePatch = titleFromPrompt(text);
      }
      const model = eventsGovernAttention(cur) ? activeModelCache.get(sessionId, merged) : undefined;
      const openPermissions = model ? openPermissionCount(model, cur) : 0;
      const openQuestions = model ? model.questions.filter((q) => q.status === "pending").length : 0;
      const needsAttentionUpdate = model !== undefined && (
        cur.attention === undefined
        || cur.attention.permissions !== openPermissions
        || cur.attention.questions !== openQuestions);
      if (titlePatch || needsAttentionUpdate) {
        nextSessions ??= state.sessions.slice();
        const i = nextSessions.findIndex((s) => s.id === sessionId);
        if (i >= 0) {
          const prev = nextSessions[i]!;
          nextSessions[i] = {
            ...prev,
            ...(titlePatch ? { title: titlePatch, titleSource: "polyth" as const } : {}),
            ...(needsAttentionUpdate ? {
              attention: {
                questions: openQuestions,
                permissions: openPermissions,
                unread: prev.attention?.unread ?? 0,
                ...(prev.attention?.goalStatus ? { goalStatus: prev.attention.goalStatus } : {}),
              },
              ...(openPermissions > 0 || openQuestions > 0 ? { status: "waiting" } : {}),
            } : {}),
          };
        }
      }
    }
  }
  if (next) {
    const retired = retiredEchoes;
    const withPending = options.pendingSend
      ? [...state.pendingSends, options.pendingSend]
      : state.pendingSends;
    set({
      events: boundedInactiveHistories(next),
      ...(nextSessions ? { sessions: nextSessions } : {}),
      ...(retired
        ? { pendingSends: withPending.filter((p) => !retired.has(p.id)) }
        : options.pendingSend ? { pendingSends: withPending } : {}),
    });
  }
  if (next && options.notifySessionEvents !== false) {
    for (const event of acceptedEvents) {
      if (options.notifyEventKeys && !options.notifyEventKeys.has(`${event.sessionId}:${event.seq}`)) continue;
      for (const listener of [...sessionEventListeners]) {
        try {
          listener(event);
        } catch {
          // Package observers are presentation-only and must not interrupt
          // canonical event ingestion or the remaining observers.
        }
      }
    }
  }
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
  set({ events: boundedInactiveHistories({ ...state.events, [sessionId]: [] }) });
}

/** Instant session spawn (UX): publish the optimistic projection AND an empty
 *  canonical event window in one store transition, so the new session opens
 *  with zero awaited requests. The server projection broadcast / refresh
 *  reconciles moments later; an empty log for a session that has no events
 *  yet is canonical, not a placeholder (event-log-before-UI holds). */
export function seedSessionCache(p: SessionProjection): void {
  const i = state.sessions.findIndex((s) => s.id === p.id);
  const current = i >= 0 ? state.sessions[i] : undefined;
  const projection = current ? preserveTitle(current, p) : p;
  const sessions = i >= 0 ? state.sessions.map((s, j) => (j === i ? projection : s)) : [...state.sessions, projection];
  const events = state.events[p.id] !== undefined
    ? state.events
    : { ...state.events, [p.id]: [] };
  set({ sessions, events: boundedInactiveHistories(events) });
  reconcileWorkspaceProjectFromSession();
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

/** A confirmed delete is explicit; an incomplete summary page is not one. */
export function removeSession(sessionId: string): void {
  const events = { ...state.events };
  const runtimeFeatures = { ...state.runtimeFeatures };
  delete events[sessionId];
  delete runtimeFeatures[sessionId];
  activeModelCache.drop(sessionId);
  const at = sessionTouchOrder.indexOf(sessionId);
  if (at >= 0) sessionTouchOrder.splice(at, 1);
  set({ sessions: state.sessions.filter((session) => session.id !== sessionId), events, runtimeFeatures });
}

/** Optimistic session verbs (delete/archive/rename/pin) reflect the user's
 *  action immediately. While the request is in flight every projection write
 *  (list page, WS broadcast) passes through the pending change, so an older
 *  server view cannot resurrect a hidden row or revert a patched field. The
 *  change is presentation only: the server stays the authority, `settle`
 *  hands the row back to normal reconciliation and `rollback` restores the
 *  pre-action projection fields. A later change for the same id supersedes an
 *  earlier one; the earlier handle then becomes a no-op. */
export type OptimisticSessionChange =
  | { kind: "hide" }
  | { kind: "patch"; patch: Partial<SessionProjection> };

export interface OptimisticSessionHandle {
  settle(): void;
  rollback(): void;
}

const optimisticSessionChanges = new Map<string, { token: number; change: OptimisticSessionChange }>();
let optimisticSessionToken = 0;

function withOptimisticSessionChanges(list: SessionProjection[]): SessionProjection[] {
  if (optimisticSessionChanges.size === 0) return list;
  const out: SessionProjection[] = [];
  for (const session of list) {
    const pending = optimisticSessionChanges.get(session.id);
    if (!pending) out.push(session);
    else if (pending.change.kind === "patch") out.push({ ...session, ...pending.change.patch });
  }
  return out;
}

export function isSessionOptimisticallyHidden(sessionId: string): boolean {
  return optimisticSessionChanges.get(sessionId)?.change.kind === "hide";
}

export function beginOptimisticSessionChange(
  sessionId: string,
  change: OptimisticSessionChange,
): OptimisticSessionHandle {
  const token = ++optimisticSessionToken;
  const before = state.sessions.find((session) => session.id === sessionId);
  optimisticSessionChanges.set(sessionId, { token, change });
  if (before) set({ sessions: withOptimisticSessionChanges(state.sessions) });
  const owns = () => optimisticSessionChanges.get(sessionId)?.token === token;
  return {
    settle() {
      if (owns()) optimisticSessionChanges.delete(sessionId);
    },
    rollback() {
      if (!owns()) return;
      optimisticSessionChanges.delete(sessionId);
      if (!before) return;
      const i = state.sessions.findIndex((session) => session.id === sessionId);
      if (change.kind === "hide") {
        if (i < 0) set({ sessions: [...state.sessions, before] });
        return;
      }
      if (i < 0) return;
      const restored: Record<string, unknown> = { ...state.sessions[i] };
      const previous = before as unknown as Record<string, unknown>;
      for (const key of Object.keys(change.patch)) {
        if (key in previous) restored[key] = previous[key];
        else delete restored[key];
      }
      set({ sessions: state.sessions.map((session, j) => (j === i ? restored as unknown as SessionProjection : session)) });
    },
  };
}

export function pruneRuntimeFeatures(live: ReadonlySet<string>): void {
  const stale = Object.keys(state.runtimeFeatures).filter((id) => !live.has(id));
  if (!stale.length) return;
  const next = { ...state.runtimeFeatures };
  for (const id of stale) delete next[id];
  set({ runtimeFeatures: next });
}
