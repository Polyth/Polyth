import { useMemo, useSyncExternalStore } from "react";
import { openSession, sendMessage } from "../init.ts";
import {
  activateSession,
  closePage,
  closeWorkspacePane,
  getState,
  newSessionOrigin,
  openWorkspacePane,
  setActiveView,
  setSessionPaneKeeper,
  startNewSession,
  togglePaneFullscreen,
  togglePanePin,
  subscribeStore,
  workspaceProjectId,
} from "../store.ts";
import { setWorkspaceEditing, setWorkspaceMode } from "../widgets/workspaceMode.ts";
import {
  activateWorkbenchProfile,
  getActiveProfileId,
  getWorkbenchProjectId,
  getWorkbenchProfileSession,
  rememberWorkbenchProfileSession,
  subscribeWorkbench,
  workbenchSetPresentation,
  workbenchSnapshot,
} from "./store.ts";
import { CONVERSATION_PROFILE_ID, listWorkbenchProfileSummaries, ownerOfSessionPurpose } from "./profiles.ts";
import { bindLanePurposeReader, lanePurposeOf, laneProfileFor, sessionsInLane, type LanePurposePredicate, type LaneSession } from "./lanes.ts";
import { claimedListingPurposes, subscribeSessionListing } from "../sessionListing.ts";
import {
  isWorkbenchProfileOffered,
  setWorkbenchProfileOffered,
  subscribeWorkbenchProfileOffers,
} from "./profileOffers.ts";
import type { WorkbenchProfileSummary } from "@polyth/web-sdk";
import { normalizeCompanionWidth, type CompanionWidth } from "../surfaces.ts";
import { COMPACT_MAX_WIDTH } from "../responsiveShell.ts";
import { compareSessionNavigation } from "../sessionDates.ts";

export type WorkbenchNavigationTarget = "chat" | "canvas" | { profileId: string };

export interface WorkbenchShellPresentation {
  focused: boolean;
  projectsOnly: boolean;
  /** `presentation.mirrored` (legacy `sidebarSide: "end"`): the wide shell
   *  lays out mirrored (shellDirection.ts) while the profile is active. */
  mirrored: boolean;
  splitSurfaces: readonly [string, string] | null;
  /** `presentation.companionWidth`: Chat is a fixed-width companion of the
   *  work surface (`decideFocusedSplit`). Null keeps the ratio dock. */
  companionWidth: CompanionWidth | null;
  /** `presentation.sidebarRailBelow`: automatic project rail below this
   *  viewport width. Null = no automatic collapse. */
  sidebarRailBelow: number | null;
}

const EMPTY_SHELL_PRESENTATION: WorkbenchShellPresentation = {
  focused: false,
  projectsOnly: false,
  mirrored: false,
  splitSurfaces: null,
  companionWidth: null,
  sidebarRailBelow: null,
};

function sidebarRailBelow(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > COMPACT_MAX_WIDTH && value <= 8192
    ? Math.round(value) : null;
}

function splitSurfacePair(value: unknown): readonly [string, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  return typeof value[0] === "string" && typeof value[1] === "string"
    ? [value[0], value[1]]
    : null;
}

export function resolveWorkbenchShellPresentation(
  profile: WorkbenchProfileSummary | undefined,
): WorkbenchShellPresentation {
  if (!profile) return EMPTY_SHELL_PRESENTATION;
  const presentation = profile.presentation;
  return {
    focused: presentation.focused === true,
    projectsOnly: presentation.sidebar === "projects",
    mirrored: presentation.mirrored === true || presentation.sidebarSide === "end",
    splitSurfaces: splitSurfacePair(presentation.splitSurfaces),
    // Size hints only mean something for a focused split.
    companionWidth: presentation.focused === true ? normalizeCompanionWidth(presentation.companionWidth) : null,
    sidebarRailBelow: presentation.focused === true ? sidebarRailBelow(presentation.sidebarRailBelow) : null,
  };
}

/** `presentation.optional: true`: the tab is opt-in per project, like Canvas. */
export const isOptionalWorkbenchProfile = (profile: WorkbenchProfileSummary): boolean =>
  profile.presentation.optional === true;

/** `presentation.homeSurface`: the profile IS that surface. Entering it
 *  presents the surface over the whole workspace (as Canvas replaces Chat),
 *  and closing the surface leaves the profile for Chat. */
export const workbenchHomeSurfaceOf = (profile: WorkbenchProfileSummary | undefined): string | null =>
  typeof profile?.presentation.homeSurface === "string" && profile.presentation.homeSurface
    ? profile.presentation.homeSurface
    : null;

const primaryProfiles = (profiles: readonly WorkbenchProfileSummary[]) => profiles
  .filter((profile) => profile.id !== CONVERSATION_PROFILE_ID
    && profile.available
    && profile.presentation.navigation === "primary");

// An optional profile the project has not offered stays out of the switch,
// except while this device still sits in it, so it can always switch back.
const navigationProfiles = (profiles: readonly WorkbenchProfileSummary[]) => primaryProfiles(profiles)
  .filter((profile) => !isOptionalWorkbenchProfile(profile)
    || profile.id === getActiveProfileId()
    || isWorkbenchProfileOffered(profile.id, getWorkbenchProjectId()))
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

export function listWorkbenchNavigationProfiles(): readonly WorkbenchProfileSummary[] {
  return navigationProfiles(listWorkbenchProfileSummaries());
}

export interface OptionalWorkbenchProfile {
  profile: WorkbenchProfileSummary;
  offered: boolean;
}

let optionalKey = "";
let optionalValue: readonly OptionalWorkbenchProfile[] = [];

function getOptionalSnapshot(): readonly OptionalWorkbenchProfile[] {
  const projectId = getWorkbenchProjectId();
  const profiles = primaryProfiles(listWorkbenchProfileSummaries())
    .filter(isOptionalWorkbenchProfile)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const key = profiles.map((profile) => `${profile.id}:${profile.label}:${isWorkbenchProfileOffered(profile.id, projectId)}`).join(",");
  if (key !== optionalKey) {
    optionalKey = key;
    optionalValue = profiles.map((profile) => ({ profile, offered: isWorkbenchProfileOffered(profile.id, projectId) }));
  }
  return optionalValue;
}

const subscribeNavigation = (listener: () => void): (() => void) => {
  const offWorkbench = subscribeWorkbench(listener);
  const offOffers = subscribeWorkbenchProfileOffers(listener);
  return () => {
    offWorkbench();
    offOffers();
  };
};

/** Optional profiles for the header menu and project settings. */
export function useOptionalWorkbenchProfiles(): readonly OptionalWorkbenchProfile[] {
  return useSyncExternalStore(subscribeNavigation, getOptionalSnapshot, getOptionalSnapshot);
}

/** Offer an optional profile (switching to it) or withdraw it (returning to
 *  Chat when this device is showing it). */
export function setWorkbenchProfileTabEnabled(profileId: string, enabled: boolean): void {
  if (enabled) {
    switchWorkbenchNavigation({ profileId });
    return;
  }
  setWorkbenchProfileOfferedForProject(profileId, getWorkbenchProjectId(), false);
}

/** Settings: offer or withdraw a profile's tab for any project without
 *  switching to it. Withdrawing the tab this device shows returns to Chat. */
export function setWorkbenchProfileOfferedForProject(profileId: string, projectId: string | null, enabled: boolean): void {
  setWorkbenchProfileOffered(profileId, projectId, enabled);
  if (!enabled && projectId === getWorkbenchProjectId() && navigationProfileId(getActiveProfileId()) === profileId) {
    switchWorkbenchNavigation("chat");
  }
}

/** Project-scoped read for settings, which may configure another project. */
export function workbenchProfileOfferedForProject(profileId: string, projectId: string): boolean {
  return isWorkbenchProfileOffered(profileId, projectId);
}

export { subscribeWorkbenchProfileOffers };

let snapshotKey = "";
let snapshotValue: {
  profiles: readonly WorkbenchProfileSummary[];
  activeProfileId: string;
} = { profiles: [], activeProfileId: CONVERSATION_PROFILE_ID };

function navigationProfileId(profileId: string): string {
  if (profileId === CONVERSATION_PROFILE_ID) return CONVERSATION_PROFILE_ID;
  const profile = listWorkbenchNavigationProfiles().find((candidate) => candidate.id === profileId);
  return profile ? profileId : CONVERSATION_PROFILE_ID;
}

export function getWorkbenchNavigationProfileId(profileId = getActiveProfileId()): string {
  return navigationProfileId(profileId);
}

function getNavigationSnapshot() {
  const profiles = listWorkbenchNavigationProfiles();
  const key = `${getActiveProfileId()}|${profiles.map((profile) => `${profile.id}:${profile.order}:${profile.available}:${profile.presentation.navigation ?? ""}:${profile.presentation.focused ?? ""}:${profile.presentation.sidebar ?? ""}:${profile.presentation.sidebarSide ?? ""}:${profile.presentation.mirrored ?? ""}:${JSON.stringify(profile.presentation.splitSurfaces ?? null)}:${JSON.stringify(profile.presentation.companionWidth ?? null)}:${String(profile.presentation.sidebarRailBelow ?? "")}:${workbenchHomeSurfaceOf(profile) ?? ""}:${profile.sessionPurpose ?? ""}`).join(",")}`;
  if (key !== snapshotKey) {
    snapshotKey = key;
    snapshotValue = { profiles, activeProfileId: navigationProfileId(getActiveProfileId()) };
  }
  return snapshotValue;
}

export function useWorkbenchNavigation() {
  return useSyncExternalStore(subscribeNavigation, getNavigationSnapshot, getNavigationSnapshot);
}

/** A home-surface profile shows no chat of its own, so it keeps whichever
 *  session is active (its handoffs target that chat) instead of switching to
 *  a remembered or fresh one. A purpose lane still owns its sessions. */
function keepsActiveSession(profileId: string): boolean {
  const profile = listWorkbenchNavigationProfiles().find((candidate) => candidate.id === profileId);
  return workbenchHomeSurfaceOf(profile) !== null && !profile?.sessionPurpose;
}

/** The home surface of the profile this device shows, if it has one. */
export function activeWorkbenchHomeSurface(): string | null {
  const profileId = navigationProfileId(getActiveProfileId());
  if (profileId === CONVERSATION_PROFILE_ID) return null;
  return workbenchHomeSurfaceOf(listWorkbenchNavigationProfiles().find((profile) => profile.id === profileId));
}

export function useActiveWorkbenchHomeSurface(): string | null {
  return useSyncExternalStore(subscribeNavigation, activeWorkbenchHomeSurface, activeWorkbenchHomeSurface);
}

/** The same lane rule drives desktop/mobile lists and profile navigation. */
export function useLaneSessions<T extends LaneSession>(sessions: readonly T[]): T[] {
  const { profiles, activeProfileId } = useWorkbenchNavigation();
  const listedElsewhere = useSyncExternalStore(subscribeSessionListing, claimedListingPurposes, claimedListingPurposes);
  return useMemo(() => {
    const purpose = profiles.find((profile) => profile.id === activeProfileId)?.sessionPurpose;
    const available = new Set(profiles.flatMap((profile) => profile.sessionPurpose ? [profile.sessionPurpose] : []));
    return sessionsInLane(
      sessions,
      purpose,
      available,
      listedElsewhere,
      (candidate) => isLanePurpose(candidate, available),
    );
  }, [sessions, profiles, activeProfileId, listedElsewhere]);
}

export function useWorkbenchShellPresentation(): WorkbenchShellPresentation {
  const navigation = useWorkbenchNavigation();
  return resolveWorkbenchShellPresentation(
    navigation.profiles.find((profile) => profile.id === navigation.activeProfileId),
  );
}

/** A purpose belongs to a lane when a workbench profile declares it now
 *  (available or not), a package declared it earlier this run, or a package
 *  claims to present those sessions in its own UI. An unclaimed purpose is
 *  session metadata — a workflow node marker, for example — and the session
 *  keeps its nearest ancestor's lane instead of being dropped from every list. */
function isLanePurpose(
  purpose: string,
  livePurposes: ReadonlySet<string>,
): boolean {
  return livePurposes.has(purpose)
    || ownerOfSessionPurpose(purpose) !== undefined
    || claimedListingPurposes().has(purpose);
}

function liveLanePurposes(): ReadonlySet<string> {
  return new Set(listWorkbenchProfileSummaries()
    .flatMap((profile) => profile.sessionPurpose ? [profile.sessionPurpose] : []));
}

/** Owning profile of a loaded session; undefined while it is not loaded. */
function laneOfSession(sessionId: string): string | undefined {
  const byId = new Map<string, LaneSession>(getState().sessions.map((session) => [session.id, session]));
  const session = byId.get(sessionId);
  if (!session) return undefined;
  const live = liveLanePurposes();
  return laneProfileFor(
    lanePurposeOf(session, byId, (purpose) => isLanePurpose(purpose, live)),
    listWorkbenchNavigationProfiles(),
    CONVERSATION_PROFILE_ID,
  );
}

function profilePurpose(profileId: string): string | undefined {
  if (profileId === CONVERSATION_PROFILE_ID) return undefined;
  return listWorkbenchNavigationProfiles().find((profile) => profile.id === profileId)?.sessionPurpose;
}

/** A profile's remembered chat. Purpose lanes drop a chat once it is known to
 *  belong elsewhere. Profiles without a lane keep the chat they remembered. */
export function laneSession(profileId: string): string | null | undefined {
  const sessionId = getWorkbenchProfileSession(profileId);
  if (!sessionId) return sessionId;
  const state = getState();
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session && session.projectId !== workspaceProjectId(state)) return null;
  if (profileId !== CONVERSATION_PROFILE_ID && !profilePurpose(profileId)) return sessionId;
  const lane = laneOfSession(sessionId);
  return lane === undefined || lane === profileId ? sessionId : null;
}

/** The chat at the top of a lane's list in the workspace project: pinned
 *  first, then most recent; spawned children and archived chats never lead. */
function firstListedLaneSession(profileId: string): string | null {
  const state = getState();
  const projectId = workspaceProjectId(state);
  if (projectId === null) return null;
  const candidates = state.sessions
    .filter((session) => session.projectId === projectId
      && !session.parentId
      && session.status !== "archived"
      && laneOfSession(session.id) === profileId)
    .sort(compareSessionNavigation);
  return candidates[0]?.id ?? null;
}

/** Hide a chat that belongs to another purpose lane before the profile paints. */
function releaseForeignLaneChat(profileId: string): void {
  const active = getState().activeSessionId;
  if (!active) return;
  const lane = laneOfSession(active);
  if (lane === undefined || lane === profileId) return;
  const crossesPurpose = profilePurpose(profileId) !== undefined
    || profilePurpose(lane) !== undefined
    || (profileId === CONVERSATION_PROFILE_ID && lane !== CONVERSATION_PROFILE_ID);
  if (crossesPurpose) activateSession(null);
}

/** Session purpose for a chat created now: the active lane's, if any. */
export function activeLanePurpose(): string | undefined {
  const profileId = navigationProfileId(getActiveProfileId());
  return listWorkbenchNavigationProfiles().find((profile) => profile.id === profileId)?.sessionPurpose;
}

let suppressLaneCapture = false;
let lastCapturedLaneKey = "";

// Session creation/opening updates the canonical activeSessionId after a
// profile switch. Capture those ordinary changes immediately so a reload does
// not lose a newly-created profile chat. Project alignment is required because
// activateProject publishes the app store before the workbench store changes.
function adoptOwningProfile(sessionId: string): boolean {
  const owning = laneOfSession(sessionId);
  if (!owning) return false;
  const current = navigationProfileId(getActiveProfileId());
  if (owning === current) return false;
  if (!profilePurpose(current) && !profilePurpose(owning)) return false;
  suppressLaneCapture = true;
  try {
    if (!activateWorkbenchProfile(owning)) return false;
    if (owning === CONVERSATION_PROFILE_ID) closeWorkspacePane({ restoreFocus: false });
    else mirrorCompanion();
    setActiveView("session");
    setWorkspaceMode("chat");
    rememberWorkbenchProfileSession(owning, sessionId);
    return true;
  } finally {
    suppressLaneCapture = false;
  }
}

subscribeStore(() => {
  if (suppressLaneCapture) return;
  const state = getState();
  if (getWorkbenchProjectId() !== workspaceProjectId(state)) return;
  const sessionId = state.activeSessionId;
  if (sessionId && adoptOwningProfile(sessionId)) {
    lastCapturedLaneKey = `${workspaceProjectId(state) ?? ""}|${navigationProfileId(getActiveProfileId())}|${sessionId}`;
    return;
  }
  const profileId = navigationProfileId(getActiveProfileId());
  const key = `${workspaceProjectId(state) ?? ""}|${profileId}|${sessionId ?? ""}`;
  if (key === lastCapturedLaneKey) return;
  lastCapturedLaneKey = key;
  rememberWorkbenchProfileSession(profileId, sessionId);
});

// Identity of the chat a lane shows: the session, or the unsent new chat by
// its origin (a metadata republish keeps the origin, a fresh New chat does not).
const newChatOrigins = new WeakMap<object, number>();
let newChatOriginCount = 0;
function laneChatKey(state: ReturnType<typeof getState>): string {
  const project = workspaceProjectId(state) ?? "";
  if (state.activeSessionId) return `${project}|${state.activeSessionId}`;
  const origin = newSessionOrigin(state.newSessionIntent);
  if (!origin) return `${project}|`;
  let id = newChatOrigins.get(origin);
  if (id === undefined) newChatOrigins.set(origin, id = ++newChatOriginCount);
  return `${project}|new:${id}`;
}

// A lane's home surface stays up while navigation moves between the lane's
// own chats (openSession re-activates a chat and shows "its chat" after
// loading; a first send activates the chat it created). A chat that belongs to
// another lane still closes it, and lane capture then routes that profile.
setSessionPaneKeeper((surfaceId, targetSessionId) => {
  const home = activeWorkbenchHomeSurface();
  if (home === null || surfaceId !== home || activeLanePurpose() === undefined) return false;
  if (!targetSessionId) return true;
  const lane = laneOfSession(targetSessionId);
  return lane === undefined || lane === navigationProfileId(getActiveProfileId());
});

// A home-surface profile is its surface: when that window closes for any
// reason (its close control, the launcher toggle, a session opening), the
// device returns to Chat with the session that is active now, instead of
// staying on a tab that shows Chat. Transitions that briefly close the pane
// (profile switches, companion mirroring) re-open it before the check runs.
//
// A home surface whose profile owns a chat lane (`sessionPurpose`) is that
// lane's home instead: its chats are the surface's documents. Every chat
// boundary inside the lane (another lane chat, a new chat, the chat its first
// send creates) presents a closed surface again, and an explicit close only
// reveals the lane chat beneath it — returning to Chat could not show that chat.
let homePaneOpen = false;
let homeLaneChat = "";
subscribeStore(() => {
  const home = activeWorkbenchHomeSurface();
  const state = getState();
  const open = home !== null && state.railPlugin === home;
  const closed = homePaneOpen && !open && home !== null;
  homePaneOpen = open;
  const laneHome = home !== null && activeLanePurpose() !== undefined;
  const chat = laneHome ? laneChatKey(state) : "";
  const boundary = laneHome && chat !== homeLaneChat;
  homeLaneChat = chat;
  if (suppressLaneCapture || profileTransitionBusy) return;
  if (laneHome) {
    // A session switch closes the window before (or after) it changes the
    // chat, so decide once both have landed.
    if (!boundary) return;
    const profileId = navigationProfileId(getActiveProfileId());
    queueMicrotask(() => {
      const now = getState();
      if (activeWorkbenchHomeSurface() !== home || navigationProfileId(getActiveProfileId()) !== profileId) return;
      if (now.railPlugin === home || getWorkbenchProjectId() !== workspaceProjectId(now)) return;
      mirrorCompanion();
    });
    return;
  }
  if (!closed) return;
  queueMicrotask(() => {
    const state = getState();
    if (activeWorkbenchHomeSurface() !== home || state.railPlugin === home) return;
    if (getWorkbenchProjectId() !== workspaceProjectId(state)) return;
    // A session that is still opening becomes Chat's through the ordinary
    // lane capture once it is active.
    rememberWorkbenchProfileSession(CONVERSATION_PROFILE_ID, state.activeSessionId);
    switchWorkbenchNavigation("chat");
  });
});

type CompanionPresentation = "pinned" | "dynamic" | "fullscreen";

function companionFromSnapshot(snapshot: ReturnType<typeof workbenchSnapshot>):
  { surfaceId: string; presentation: CompanionPresentation } | null {
  if (snapshot.fullscreen !== null && snapshot.fullscreen !== "session") {
    return { surfaceId: snapshot.fullscreen, presentation: "fullscreen" };
  }
  for (const region of ["primary", "start", "end", "bottom"] as const) {
    const active = snapshot.regions[region].active;
    if (active !== null && active !== "session") {
      return { surfaceId: active, presentation: "pinned" };
    }
  }
  const floating = [...snapshot.floating].reverse().find((surfaceId) => surfaceId !== "session");
  return floating === undefined ? null : { surfaceId: floating, presentation: "dynamic" };
}

/** Bring the canonical profile layout through the legacy single-pane host. */
function mirrorCompanion(): void {
  // A home-surface profile always shows its surface over the workspace: the
  // layout reducers return fullscreen to its docked home on reload and at
  // session boundaries, which must not turn the tab into a side panel.
  const home = activeWorkbenchHomeSurface();
  const companion = home !== null
    ? { surfaceId: home, presentation: "fullscreen" as const }
    : companionFromSnapshot(workbenchSnapshot());
  closeWorkspacePane({ restoreFocus: false });
  if (companion === null || !openWorkspacePane(companion.surfaceId)) return;

  // openWorkspacePane starts in the dynamic state. The transition helpers
  // also update the workbench layout, so restore the profile's presentation
  // after changing the compatibility state.
  const currentMode = getState().paneMode;
  if (companion.presentation === "pinned") {
    if (currentMode === "fullscreen") togglePaneFullscreen();
    if (getState().paneMode === "dynamic") togglePanePin();
  } else if (companion.presentation === "dynamic") {
    if (currentMode === "fullscreen") togglePaneFullscreen();
    if (getState().paneMode === "pinned") togglePanePin();
  } else if (currentMode !== "fullscreen") {
    togglePaneFullscreen();
  }
  workbenchSetPresentation(
    companion.surfaceId,
    companion.presentation === "pinned"
      ? "docked"
      : companion.presentation === "fullscreen" ? "fullscreen" : "floating",
  );
}

let navigationGeneration = 0;
let profileTransitionBusy = false;
let observedWorkbenchProjectId = getWorkbenchProjectId();
let observedNavigationProfileId = navigationProfileId(getActiveProfileId());

/** Restore a profile after the registry removes the previously active one. */
function restoreProfileAfterTransition(targetProfileId: string, outgoingProfileId?: string): void {
  if (profileTransitionBusy) return;
  const generation = ++navigationGeneration;
  profileTransitionBusy = true;
  suppressLaneCapture = true;
  try {
    if (outgoingProfileId !== undefined) {
      rememberWorkbenchProfileSession(outgoingProfileId, getState().activeSessionId);
    }
    const sessionId = keepsActiveSession(targetProfileId) ? getState().activeSessionId : laneSession(targetProfileId);
    setActiveView("session");
    const applyShell = () => {
      if (targetProfileId === CONVERSATION_PROFILE_ID) closeWorkspacePane({ restoreFocus: false });
      else mirrorCompanion();
      setActiveView("session");
      setWorkspaceMode("chat");
    };
    if (keepsActiveSession(targetProfileId)) {
      applyShell();
      return;
    }
    if (!sessionId) {
      const projectId = workspaceProjectId(getState());
      if (projectId !== null) startNewSession(projectId);
      rememberWorkbenchProfileSession(targetProfileId, null);
      applyShell();
      return;
    }
    releaseForeignLaneChat(targetProfileId);
    applyShell();
    if (getState().activeSessionId === sessionId) return;
    void openSession(sessionId, { showChat: false }).then(() => {
      if (generation !== navigationGeneration || getActiveProfileId() !== targetProfileId) return;
      if (getState().railPlugin === null && targetProfileId !== CONVERSATION_PROFILE_ID) mirrorCompanion();
    }).catch(() => {
      if (generation !== navigationGeneration || getActiveProfileId() !== targetProfileId) return;
      rememberWorkbenchProfileSession(targetProfileId, null);
      const projectId = workspaceProjectId(getState());
      if (projectId !== null) startNewSession(projectId);
      applyShell();
    });
  } finally {
    suppressLaneCapture = false;
    profileTransitionBusy = false;
  }
}

// Profile unregister/availability changes reconcile the raw workbench profile
// without changing AppState.activeSessionId. Restore the incoming lane so an
// outgoing primary profile's chat cannot silently become Conversation chat.
subscribeWorkbench(() => {
  const nextProfileId = getActiveProfileId();
  const nextProjectId = getWorkbenchProjectId();
  const previousProjectId = observedWorkbenchProjectId;
  const previousNavigationId = observedNavigationProfileId;
  observedWorkbenchProjectId = nextProjectId;
  const incomingNavigationId = navigationProfileId(nextProfileId);
  observedNavigationProfileId = incomingNavigationId;
  if (suppressLaneCapture || profileTransitionBusy) return;
  const state = getState();
  if (nextProjectId !== workspaceProjectId(state)) return;
  const projectChanged = nextProjectId !== previousProjectId;
  const outgoingNavigationId = previousNavigationId;
  if (!projectChanged && outgoingNavigationId === incomingNavigationId) return;
  // An unsent chat retargeted to this project keeps the New Chat surface; the
  // project's remembered chat must not open over it.
  if (projectChanged
    && state.activeSessionId === null
    && state.newSessionIntent?.projectId === nextProjectId) return;
  if (projectChanged
    && incomingNavigationId === CONVERSATION_PROFILE_ID
    && !laneSession(incomingNavigationId)) return;
  if (state.openingSessionId !== null) return;
  restoreProfileAfterTransition(
    incomingNavigationId,
    projectChanged ? undefined : outgoingNavigationId,
  );
});

/** Switch Chat/Canvas or a package-registered primary workbench profile. */
export function switchWorkbenchNavigation(target: WorkbenchNavigationTarget): boolean {
  const generation = ++navigationGeneration;
  const targetProfileId = target === "chat" || target === "canvas"
    ? CONVERSATION_PROFILE_ID
    : target.profileId;
  // Choosing an optional profile is the explicit choice that offers it, as
  // entering Canvas offers Canvas.
  const optional = target !== "chat" && target !== "canvas"
    ? primaryProfiles(listWorkbenchProfileSummaries()).find((profile) => profile.id === target.profileId)
    : undefined;
  if (optional && isOptionalWorkbenchProfile(optional)) {
    setWorkbenchProfileOffered(optional.id, getWorkbenchProjectId(), true);
  }
  suppressLaneCapture = true;
  try {
    const currentProfileId = navigationProfileId(getActiveProfileId());
    const currentSessionId = getState().activeSessionId;
    rememberWorkbenchProfileSession(currentProfileId, currentSessionId);
    closeWorkspacePane({ restoreFocus: false });
    if (!activateWorkbenchProfile(targetProfileId)) return false;
    // An open package page (an agent's screen) renders over every workspace
    // mode, so a switch that left it open would change nothing on screen.
    const leavingPage = getState().activePage !== null;
    closePage();

    if (keepsActiveSession(targetProfileId)) {
      rememberWorkbenchProfileSession(targetProfileId, currentSessionId);
      setActiveView("session");
      mirrorCompanion();
      setWorkspaceMode("chat");
      return true;
    }
    // Leaving a page with no remembered chat lands on the lane's first listed
    // chat rather than an empty new one.
    const sessionId = laneSession(targetProfileId)
      || (leavingPage ? firstListedLaneSession(targetProfileId) : null);
    setActiveView("session");
    if (!sessionId) {
      const projectId = workspaceProjectId(getState());
      if (projectId !== null) startNewSession(projectId);
      rememberWorkbenchProfileSession(targetProfileId, null);
      if (target === "chat" || target === "canvas") closeWorkspacePane({ restoreFocus: false });
      else mirrorCompanion();
      setWorkspaceMode(target === "canvas" ? "widgets" : "chat");
      return true;
    }

    const applyShell = () => {
      if (target === "chat" || target === "canvas") closeWorkspacePane({ restoreFocus: false });
      else mirrorCompanion();
      setActiveView("session");
      setWorkspaceMode(target === "canvas" ? "widgets" : "chat");
    };
    releaseForeignLaneChat(targetProfileId);
    applyShell();
    if (getState().activeSessionId === sessionId) return true;

    // Do not let an old profile switch reclaim the pane or mode after a newer
    // switch. openSession has its own session-generation guard; this token adds
    // profile-generation protection around the compatibility shell.
    void openSession(sessionId, { showChat: false }).then(() => {
      if (generation !== navigationGeneration || navigationProfileId(getActiveProfileId()) !== targetProfileId) return;
      // Activating a session closes dynamic legacy panes. Restore only the pane
      // selected by this profile when the user has not selected another pane
      // in the meantime; never close a newer user-owned surface here.
      if (getState().railPlugin === null && target !== "chat" && target !== "canvas") mirrorCompanion();
    }).catch(() => {
      if (generation !== navigationGeneration || navigationProfileId(getActiveProfileId()) !== targetProfileId) return;
      // A deleted/stale remembered chat must not leave the previous profile's
      // session visible under this profile. Forget it and enter the same fresh
      // unsaved-chat state used by a profile with no remembered session.
      rememberWorkbenchProfileSession(targetProfileId, null);
      const projectId = workspaceProjectId(getState());
      if (projectId !== null) startNewSession(projectId);
      if (target === "chat" || target === "canvas") closeWorkspacePane({ restoreFocus: false });
      else mirrorCompanion();
      setActiveView("session");
      setWorkspaceMode(target === "canvas" ? "widgets" : "chat");
    });
    return true;
  } finally {
    suppressLaneCapture = false;
  }
}

/** Keep Chat, Canvas, and workspace-edit transitions consistent across shell controls. */
export function switchWorkspaceMode(next: "chat" | "widgets" | "edit"): void {
  if (next === "chat") {
    switchWorkbenchNavigation("chat");
  } else if (next === "widgets") {
    switchWorkbenchNavigation("canvas");
  } else {
    setWorkspaceEditing(true);
  }
}

export function activateWorkbenchNavigationProfile(profileId: string): boolean {
  if (profileId !== CONVERSATION_PROFILE_ID && getWorkbenchNavigationProfileId(profileId) !== profileId) return false;
  return switchWorkbenchNavigation({ profileId });
}

export function sendToConversation(sessionId: string, text: string, options?: { delivery?: "normal" | "queue" | "interrupt" }): Promise<boolean> {
  return sendMessage(text, undefined, undefined, { targetSessionId: sessionId, delivery: options?.delivery });
}

bindLanePurposeReader(() => activeLanePurpose());
