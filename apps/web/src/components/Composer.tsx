import {
  Fragment, memo, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useSyncExternalStore,
  type ClipboardEvent, type CSSProperties, type Ref, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode,
} from "react";
import {
  activateProject,
  moveNewSessionDraftToProject,
  beginPendingSend,
  beginSessionSpawn,
  bindPendingSend,
  bindSessionSpawn,
  clearNewSessionDraft,
  endPendingSend,
  finishSessionSpawn,
  getState,
  hasInFlightPrompt,
  overlaySessionProjection,
  pendingSendsForSurface,
  registerComposerDraftFlusher,
  isActiveSessionSpawning,
  lastSeq,
  newSessionOrigin,
  openSessionSharing,
  openSettingsPage,
  setUiError,
  setNewSessionIsolation,
  setNewSessionRepositories,
  saveNewSessionDraftText,
  startFreshSession,
  startNewSession,
  useActiveModel,
  usePendingSends,
  useStore,
  workspaceProjectId,
  COMPOSER_INPUT_SELECTOR,
} from "../store.ts";
import {
  sendMessage,
  abortSession,
  createSession,
  createDefaultWorktree,
  startIsolatedSession,
  rememberProjectModelSelection,
  reconnectSync,
  recheckRuntimeCatalog,
  getSyncStatus,
  subscribeSyncStatus,
  withOptimisticSessionChange,
  warmSessionRuntime,
} from "../init.ts";
import {
  api,
  errorCodeOf,
  type ComposerCatalogResult,
  type GitBranches,
  type SlashCommand,
  type SnippetDef,
  type Worktree,
} from "@polyth/session/web-api";
import { loadDraft, saveDraft, syncDraftToServer, cancelDraftSync, flushDraftToServer, saveDraftToServerNow } from "../utils.ts";
import { sessionDraftPreview } from "@polyth/contracts";
import type { ComposerAddMenuItem, ComposerContributionContext, ComposerDraftContext, ComposerMode, ComposerSuggestionOffer } from "@polyth/web-sdk";
import SlotHost from "./slots/SlotHost.tsx";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import MobileComposerRail, { MobileComposerEditEntry } from "./mobile/MobileComposerRail.tsx";
import { mobileRailKey, subscribeMobileRailEditRequest } from "../composer/mobileRail.ts";
import { setNewChatModel } from "../composer/newChatModel.ts";
import { useHeroWidgetPrefs } from "./mobile/HeroWidgets.tsx";
import { activeBrowserAccountId } from "../accountStorage.ts";
import { assignPersonTones, personToneOf } from "../personIdentity.ts";
import { dragKind, dropIntoSession } from "../dnd.ts";
import {
  addAttachment, attachNativeStagedUpload, attachText, attachUpload, clearAttachments, isLargeTextPaste, PASTED_TEXT_NAME, pendingAttachments, recoverNativeStagedUploads, removeAttachment, seedAttachments, usePendingAttachments,
} from "../attachments.ts";
import AttachmentPills from "./AttachmentPills.tsx";
import {
  COMPOSER_DICTATION,
  COMPOSER_SUBMIT,
  type ComposerSubmitRequest,
  COMPOSER_INSERT,
  COMPOSER_REPLACE,
  COMPOSER_COMPARE_REPLACE,
  drainComposerReplacement,
  drainInserts,
  requestComposerReplace,
  requestComposerCompareReplace,
  type ComposerCompareReplace,
  type ComposerDictationUpdate,
} from "../composerInsert.ts";
import {
  applyTranscriptSpan,
  beginTranscriptSpan,
  type TranscriptSpan,
} from "../composer/transcriptSpan.ts";
import { activeToken, completeToken, shellCommand, type PromptToken } from "../composer/language.ts";
import { isTransportFailure } from "../errorPresentation.ts";
import { useRecentlyActiveProjects } from "../projectRecency.ts";
import { retryAfterReconnect } from "../retryAfterReconnect.ts";
import { composerLayoutState } from "../composerLayout.ts";
import { applyComposerEditorHeight, measureComposerEditor } from "../composerAutoGrow.ts";
import { useComposerMorph } from "../composerMorph.ts";
import {
  advanceModelAbsenceGate,
  catalogFromResult,
  commandAutocomplete,
  composerModelAbsence,
  harnessModelCatalog,
  IDLE_MODEL_ABSENCE_GATE,
  mergeCommandCatalog,
  MODEL_ABSENCE_GRACE_MS,
  modelIdentityMatches,
  nativeCommandInput,
  mentionAndFileAutocomplete,
  groupAutocompleteOptions,
  OPEN_PROJECT_FIRST,
  planCommandInsert,
  planShellEntry,
  planSigilInsert,
  composerChipModel,
  lastChosenHarnessModel,
  nextTurnModelRef,
  routeDefaultModel,
  routeMovingTransition,
  routeSwitchedByPerson,
  sendableRouteModel,
  visibleFallbackModel,
  emptyModelCatalogReason,
  snippetAutocomplete,
  type AutocompleteViewState,
  type AutocompleteOption,
  type CatalogState,
  type ComposerCommand,
  type InsertPlan,
  type ModelAbsenceGate,
} from "../composer/discovery.ts";
import { composerPromptSuggestion, visiblePromptSuggestion } from "../composer/promptSuggestion.ts";
import { isHostOnlyExtensionCommand } from "../composer/extensionCommandGate.ts";
import { compactBlockReason, isCompactCommand, isNothingToCompactError } from "../composer/compactCommand.ts";
import {
  loadComposerConfig, saveComposerConfig, consumeComposerConfig,
  withAutoThinking, withExplicitThinking, withModelForNextTurn,
  withDraftHarnessForNextTurn, withHarnessForNextTurn,
  type ComposerConfig,
} from "../composerConfig.ts";
import { shouldHandlePromptHistoryKey } from "../composer/history.ts";
import { usePromptHistory } from "../composer/usePromptHistory.ts";
import { executionSelectionChanged, immediateFollowUpDelivery } from "../followUpDelivery.ts";
import AdaptiveTextInput, { type TextInputHandle } from "./input/AdaptiveTextInput.tsx";
import ComposerAddMenu from "./ComposerAddMenu.tsx";
import ComposerFocusDialog from "./ComposerFocusDialog.tsx";
import ContextLiquid, { contextLiquidLabel, useActiveContextGauge } from "./ContextLiquid.tsx";
import ContextPie, { contextPieVisible } from "./ContextPie.tsx";
import QueuedMessageList, { latestSteerableQueuedItem } from "./QueuedMessageList.tsx";
import {
  composerContributionsVersion,
  composerMode,
  listComposerAddMenuItems,
  listComposerModes,
  listComposerPasteHandlers,
  listenComposerModeRequests,
  publishComposerActiveMode,
  runComposerSessionCreatedHooks,
  subscribeComposerContributions,
} from "../composer/contributions.ts";
import { detectModeTrigger, isModeLeaveKey, modeText } from "../composer/modes.ts";
import "../composer/composerModes.css";
import { announce } from "./a11y/live.tsx";
import { successFeedback } from "../haptics.ts";
import {
  composerThinkingChoice,
  getModelThinking,
  noteModelUsed,
  recordedSessionThinking,
  rememberHarnessModel,
  resolveComposerThinking,
  setModelThinking,
  useLastHarnessModels,
  useModelPrefs,
  useModelThinking,
} from "@polyth/models/web-prefs";
import { hiddenModelMatcher } from "@polyth/models";
import { getUiSettings, setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { migrateFavoritesOnce, profilesLoaded, useProfiles } from "../profiles.ts";
import { useSpaces } from "../spaces.ts";
import { useProjectInterfaceMode } from "../projectInterfaceScope.ts";
import { isManagedIsolationBranch, projectIsolatesByDefault, projectIsolationLevel } from "@polyth/contracts";
import type {
  AttachmentRef,
  DraftExecutionConfig,
  HarnessSelection,
  ModelDescriptor,
  ModelRef,
  QueueItemDto,
  SessionProjection,
} from "@polyth/contracts";
import { friendlyError, isMutationOutcomeUnknown, matchesSendShortcut, modKeyLabel, parseModelRef } from "../settings.ts";
import { Icon } from "../icons.tsx";
import ModelPicker from "@polyth/models/model-picker";
import { modelSupportsThinking, thinkingVariantLabel } from "@polyth/models/model-presentation";
import { composerRecoveryKind, retryUnavailableRuntimeCatalogs, useCatalogRevision, useOtherHarnessModels, useHarnessColors, useRuntimeCatalog, useVisibleHarnessIds } from "@polyth/models/runtime-catalog";
import { resolveProjectModelDefault, useSessionDefaults } from "../sessionDefaults.ts";
import { newChatPersonDefault, newChatRouteChosen, usePersonHarnessDefault } from "../personHarnessDefault.ts";
import { contextTokensUsed } from "../reduce.ts";
import { effectiveAttachmentSupport, attachmentModality } from "@polyth/contracts";
import { useShellMode } from "../responsiveShell.ts";
import {
  getGuardrails, guardedModelSwitcherVisible, guardedShellAllowed, useGuardrails,
} from "../guardrails.ts";
import {
  clearDraftExecutionConfig,
  emptyDraftExecutionConfig,
  newChatDraftRoute,
  preferredVisibleHarness,
  readDraftExecutionConfig,
  subscribeDraftExecutionConfig,
  updateDraftExecutionConfig,
  writeDraftExecutionConfig,
} from "../executionDraft.ts";
import { useViewportMetrics } from "../mobileViewport.ts";
import { tr } from "../i18n/index.ts";
import SessionContextBar, {
  type ContextChoice,
  type ProjectContextChoice,
  type RepositoryContextChoice,
  type SessionContextBarProps,
} from "./mobile/SessionContextBar.tsx";
import { projectRepositories } from "@polyth/contracts/workspace";
import { executionRepositoryOf, normalizeRepositoryScope, primaryRepositoryIdOf } from "../composer/repositoryScope.ts";
import { openProjectSettings } from "../projectSettings.ts";
import { soloPersonalProject } from "../personalProject.ts";
import { AssistIcon, BotIcon, Button, CheckIcon, ChevronDownIcon, CloseIcon, CommandIcon, FileIcon, GlassDock, Icon as UiIcon, IconButton, Menu, Notice, QueueSendIcon, SendIcon, SettingsIcon, ShowIcon, StopIcon, Switch, type MenuEntry } from "./ui/index.ts";
import { canCollaborateSession, canManageSession, loadSessionSharing, ownerName } from "../sessionSharing.ts";
import { getSendFailure, subscribeSendFailures } from "../sendFailure.ts";
import { isNativeMobile } from "@polyth/mobile/runtime";
import { pickNativeFiles, readNativeStagedFile, removeNativeStagedFile } from "@polyth/mobile/native";
import { adoptServerDraft, loadScopedDraftRecord, scopedDraftCacheKey, updateScopedDraftRecord } from "../draftRecord.ts";
import { flushClientPersistence, type PersistenceScope } from "../clientPersistence.ts";
import { clientPersistenceScope, persistenceScopeIsCurrent } from "../reliabilityContext.ts";
import { activeLanePurpose } from "../workbench/profileNavigation.ts";
import { newSessionLaneDraftId } from "../workbench/lanes.ts";
import { stripRecoveryContextBlocks } from "../recoveryDisplay.ts";
import { forgetComposerSelection, rememberComposerSelection, takeComposerSelection, visibleComposerDraft } from "../drafts.ts";
import { holdLaunchReveal } from "../launchReveal.ts";
import {
  beginConversationSelection, endConversationSelection, openConversationStart, useConversationSelection,
} from "../conversationSelection.ts";
import {
  cachedMentionCandidates, forgetPersonMessageOperation, loadMentionCandidates, personInitials, personMessageOperationId,
  postPersonMessage,
} from "../sessionPeople.ts";
import {
  conversationSendLabel, livePersonMentions, peopleModeActive, peopleSendLabel, showCarryToAgent, type ComposerPersonMention,
} from "../composer/people.ts";

// Per-project command/snippet catalog cache: the composer remounts on every
// session change (including a fresh spawn), and each mount refetched both
// catalogs. Slash commands and snippets change rarely — a short TTL removes
// two requests from every session switch/spawn while staying fresh enough
// for editing workflows. Only fully successful results are cached so an
// `unavailable` outcome retries on the next mount.
const COMPOSER_CATALOG_TTL_MS = 30_000;
const composerCatalogCache = new Map<string, { at: number; result: ComposerCatalogResult }>();

async function loadComposerCatalog(projectId: string): Promise<ComposerCatalogResult> {
  const hit = composerCatalogCache.get(projectId);
  if (hit && Date.now() - hit.at < COMPOSER_CATALOG_TTL_MS) return hit.result;
  const result = await api.composerCatalog(projectId);
  if (result.commands.ok && result.snippets.ok) {
    composerCatalogCache.set(projectId, { at: Date.now(), result });
  }
  return result;
}

const PROFILE_MISSING_NOTE = tr("composer.profileUnavailableChooseAnother");
const MODEL_WARNING_DELAY_MS = 8_000;
/** Press and hold Send keeps the message as a draft chat instead. */
const SEND_HOLD_MS = 500;
/** How long Send shows its "kept as a draft" check after a hold. */
const SEND_PARKED_MS = 1_400;

const isComposerInputFocused = (): boolean =>
  typeof document !== "undefined" && document.activeElement instanceof Element
  && document.activeElement.matches(COMPOSER_INPUT_SELECTOR);

/** The surface a send belongs to: its session, or the project's new chat. */
const sendSurfaceKey = (sessionId: string | null, projectId: string | null | undefined): string =>
  sessionId ?? `new:${projectId ?? ""}`;

// A send to a session outlives the Composer that started it: the first send
// remounts the composer (hero → transcript), and a slow open remounts it again
// behind the loading layer. Unsettled admissions are therefore counted here,
// not per instance, so every mount keeps the staged recovery copy out of its
// input and holds draft persistence until the admission settles. The new-chat
// surface stays per instance: a fresh new chat in the same project must not
// wait for an earlier chat's creation.
const admittingSessions = new Map<string, number>();
const admissionListeners = new Set<() => void>();
let admissionVersion = 0;
const subscribeAdmissions = (listener: () => void) => {
  admissionListeners.add(listener);
  return () => { admissionListeners.delete(listener); };
};
const admissionSnapshot = () => admissionVersion;
const sessionAdmitting = (sessionId: string | null | undefined): boolean =>
  !!sessionId && (admittingSessions.get(sessionId) ?? 0) > 0;
function markSessionAdmitting(sessionId: string, value: boolean): void {
  const count = (admittingSessions.get(sessionId) ?? 0) + (value ? 1 : -1);
  if (count > 0) admittingSessions.set(sessionId, count);
  else admittingSessions.delete(sessionId);
  admissionVersion += 1;
  for (const listener of [...admissionListeners]) listener();
}

// A rejected prompt goes back to the composer it came from. When that
// instance is gone, the one now showing the session takes it instead.
type ReturnedPrompt = { sessionId: string; scopeKey: string; text: string };
const returnedPromptListeners = new Set<(prompt: ReturnedPrompt) => boolean>();
const returnRejectedPrompt = (prompt: ReturnedPrompt): void => {
  for (const listener of [...returnedPromptListeners]) if (listener(prompt)) return;
};

type NewSessionTarget =
  | { kind: "main" }
  | { kind: "new-worktree"; base?: string }
  | { kind: "worktree"; path: string }
  /** Check the branch out in a fresh linked worktree. `base` is set for a
   *  remote-only branch — the new local branch starts from that remote ref. */
  | { kind: "branch"; branch: string; base?: string }
  /** Start the session in a Polyth-managed isolated worktree based on a
   *  branch with a live checkout. `checkout` names a branch that has none
   *  yet: it is checked out in a linked worktree first (from `checkout.base`
   *  for a remote-only branch), because isolation merges back into a
   *  live checkout. */
  | { kind: "isolation"; base?: string; checkout?: { branch: string; base?: string } };

type LocationChoice = ContextChoice & {
  target: NewSessionTarget;
};

/** Project/worktree context is composer chrome, not fresh-session chrome.
 * Keeping it here makes every chat call site render the same complete entity. */
function useComposerLocation(session: SessionProjection | null, readLiveText?: () => string): {
  contextBar: SessionContextBarProps;
  newSessionTarget: NewSessionTarget;
  /** The unsent chat's repository scope; omitted means every repository. */
  newSessionRepositoryIds: string[] | undefined;
} {
  const projects = useStore((state) => state.projectRegistry.projects);
  const projectId = useStore(workspaceProjectId);
  const spaceId = useSpaces().activeSpaceId ?? "";
  // Re-read the branch/worktree choices when this project's worktrees change
  // anywhere — the Git UI, an agent, a shell.
  const worktreeTopology = useStore((state) => (projectId && state.worktreeTopology[projectId]) || 0);
  const newSessionIntent = useStore((state) => state.newSessionIntent);
  const branch = useStore((state) => state.gitBranch);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  // A multi-repository project chooses its repository scope before the
  // checkout. Linked worktrees and an isolation base branch belong to the
  // execution repository — the primary while it is in scope — so the worktree
  // picker locks to "current checkout" when the primary is left out.
  const repositories = useMemo<RepositoryContextChoice[]>(() => {
    if (!project) return [];
    try {
      return projectRepositories(project).map(({ id, alias, path }) => ({ id, alias, path }));
    } catch { return []; }
  }, [project]);
  const multiRepository = repositories.length > 1;
  const primaryRepositoryId = primaryRepositoryIdOf(project, repositories);
  const draftRepositoryIds = !session && newSessionIntent?.projectId === projectId
    ? newSessionIntent.repositoryIds
    : undefined;
  const repositoryScope = useMemo(
    () => multiRepository ? normalizeRepositoryScope(repositories, draftRepositoryIds) : undefined,
    [multiRepository, repositories, draftRepositoryIds],
  );
  const executionRepository = multiRepository
    ? executionRepositoryOf(repositories, repositoryScope, primaryRepositoryId)
    : undefined;
  const checkoutLocked = !!executionRepository && executionRepository.id !== primaryRepositoryId;
  const intendedWorktree = session?.worktreePath
    ?? (newSessionIntent?.projectId === projectId ? newSessionIntent.worktreePath : undefined);
  const locationKey = JSON.stringify([
    clientPersistenceScope(projectId ? { projectId } : {}),
    spaceId,
    worktreeTopology,
  ]);
  const [location, setLocation] = useState<{
    key: string;
    worktrees: Worktree[];
    branches: GitBranches;
  } | null>(null);
  const cachedLocation = location?.key === locationKey ? location : null;
  const worktrees = cachedLocation?.worktrees ?? [];
  const branches = cachedLocation?.branches ?? { current: "", branches: [] };
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchRefreshing, setBranchRefreshing] = useState(false);
  const branchRefreshRunRef = useRef(0);
  // One reconnect-and-retry per location after a transport loss; a second
  // loss for the same location surfaces instead of reconnecting forever.
  const [branchReload, setBranchReload] = useState(0);
  const branchTransportRetryRef = useRef<string | null>(null);
  // The store's branch label usually lands while the choices below are being
  // read (boot, project switch). That read picks it up; throwing it away to
  // read again kept the chip changing for seconds after a launch. Only a later
  // switch of the checkout's branch re-reads the choices.
  const branchRef = useRef(branch);
  branchRef.current = branch;
  const branchReadInFlight = useRef(false);
  const lastBranchLabel = useRef(branch);
  const userBranchChoiceRef = useRef(0);
  const [selectedBranchId, setSelectedBranchId] = useState(
    intendedWorktree ? `worktree:${intendedWorktree}` : "main",
  );
  // Isolation is opt-in per project; until a project enables a level it does
  // not exist as a choice at all. When on, the worktree picker lists only live
  // checkouts that can be returned to safely after merge-back. The unsent
  // chat's own choice wins; otherwise the project default preselects it.
  const isolationEnabled = projectIsolationLevel(project?.defaults) !== "off";
  const isolateByDefault = projectIsolatesByDefault(project?.defaults);
  const chosenIsolation = !session && newSessionIntent?.projectId === projectId
    ? newSessionIntent.isolate
    : undefined;
  const intendedIsolation = !session && isolationEnabled && (chosenIsolation ?? isolateByDefault);
  const [workInIsolation, setWorkInIsolation] = useState(intendedIsolation);
  // Opening the branch picker pulls the remote once per project so branches
  // that only exist on the server show up as fork points.
  const remoteFetchedRef = useRef<string | null>(null);

  useEffect(() => {
    userBranchChoiceRef.current += 1;
    setSelectedBranchId(intendedWorktree ? `worktree:${intendedWorktree}` : "main");
  }, [spaceId, projectId, session?.id, intendedWorktree]);
  useEffect(() => {
    setWorkInIsolation(intendedIsolation);
  }, [spaceId, projectId, session?.id, intendedIsolation]);

  useEffect(() => {
    const previous = lastBranchLabel.current;
    lastBranchLabel.current = branch;
    if (!branch || !previous || branch === previous || branchReadInFlight.current) return;
    setBranchReload((value) => value + 1);
  }, [branch]);

  useEffect(() => {
    let active = true;
    const run = ++branchRefreshRunRef.current;
    const choiceAtStart = userBranchChoiceRef.current;
    setBranchRefreshing(false);
    const sessionId = session?.id;
    const sessionBranch = session?.branch;
    // Retain this project's last result while a session is open. Returning to
    // New Chat then has usable choices immediately while we revalidate them.
    if (session || !projectId) {
      setBranchLoading(false);
      return () => {
        active = false;
        branchRefreshRunRef.current += 1;
      };
    }
    setBranchLoading(true);
    branchReadInFlight.current = true;
    // The branch chip is part of a launch's first screen: hold the
    // veil until its label is final instead of letting it change width later.
    const releaseLaunch = holdLaunchReveal();
    let cancelRetry = (): void => undefined;
    void Promise.all([api.listWorktrees(projectId), api.gitBranches(projectId, sessionId)])
      .then(([nextWorktrees, nextBranches]) => {
        if (!active || branchRefreshRunRef.current !== run) return;
        branchTransportRetryRef.current = null;
        setLocation({
          key: locationKey,
          worktrees: nextWorktrees.filter((worktree) => !isManagedIsolationBranch(worktree.branch)),
          branches: nextBranches,
        });
        const currentWorktree = intendedWorktree
          ? nextWorktrees.find((worktree) => worktree.path === intendedWorktree)
          : nextWorktrees.find((worktree) =>
              worktree.branch === (nextBranches.current || sessionBranch || branchRef.current));
        if (userBranchChoiceRef.current === choiceAtStart) {
          setSelectedBranchId(currentWorktree?.isMain
            ? "main"
            : currentWorktree
              ? `worktree:${currentWorktree.path}`
              : intendedWorktree
                ? `worktree:${intendedWorktree}`
                : "main");
        }
      })
      .catch((error) => {
        if (!active || branchRefreshRunRef.current !== run) return;
        // A phone resuming from the background loses this read before the
        // socket notices. Reconnect and read again instead of a dead-end toast.
        if (isTransportFailure(error) && branchTransportRetryRef.current !== locationKey) {
          branchTransportRetryRef.current = locationKey;
          cancelRetry = retryAfterReconnect(
            { getStatus: getSyncStatus, subscribe: subscribeSyncStatus, reconnect: reconnectSync },
            () => setBranchReload((value) => value + 1),
          );
          return;
        }
        setUiError(friendlyError(tr("composer.couldnTLoadWorktrees"), error));
      })
      .finally(() => {
        releaseLaunch();
        if (active && branchRefreshRunRef.current === run) {
          branchReadInFlight.current = false;
          setBranchLoading(false);
        }
      });
    return () => {
      active = false;
      branchReadInFlight.current = false;
      branchRefreshRunRef.current += 1;
      releaseLaunch();
      cancelRetry();
    };
  }, [locationKey, projectId, session?.id, session?.worktreePath, session?.branch, newSessionIntent?.worktreePath, branchReload]);

  // Fired when the branch picker opens: fetch the remote (best effort) and
  // re-read the branch list so server-only branches become selectable. Runs
  // at most once per project so reopening the picker stays instant.
  const refreshBranchesFromRemote = useCallback((force = false) => {
    if (session || !projectId || branchRefreshing || (!force && remoteFetchedRef.current === locationKey)) return;
    const run = ++branchRefreshRunRef.current;
    remoteFetchedRef.current = locationKey;
    setBranchRefreshing(true);
    void (async () => {
      try {
        await api.gitFetch(projectId).catch(() => undefined);
        const [nextWorktrees, nextBranches] = await Promise.all([
          api.listWorktrees(projectId),
          api.gitBranches(projectId),
        ]);
        if (branchRefreshRunRef.current !== run) return;
        setLocation({
          key: locationKey,
          worktrees: nextWorktrees.filter((worktree) => !isManagedIsolationBranch(worktree.branch)),
          branches: nextBranches,
        });
      } catch {
        // A failed refresh leaves the already-loaded local branches in place.
        if (branchRefreshRunRef.current === run) remoteFetchedRef.current = null;
      } finally {
        if (branchRefreshRunRef.current === run) {
          setBranchRefreshing(false);
          setBranchLoading(false);
        }
      }
    })();
  }, [branchRefreshing, locationKey, projectId, session]);

  // With the primary out of scope the row shows the execution repository's
  // own current branch, read once per project/topology/repository.
  const executionBranchKey = checkoutLocked && executionRepository && projectId && !session
    ? `${locationKey}:${executionRepository.id}`
    : null;
  const [executionBranch, setExecutionBranch] = useState<{ key: string; name: string } | null>(null);
  useEffect(() => {
    const key = executionBranchKey;
    if (!key || !projectId || !executionRepository) return;
    let active = true;
    void api.gitBranches(projectId, undefined, executionRepository.id)
      .then((next) => { if (active) setExecutionBranch({ key, name: next.current ?? "" }); })
      .catch(() => { if (active) setExecutionBranch({ key, name: "" }); });
    return () => { active = false; };
  }, [executionBranchKey]);
  const executionBranchLoaded = executionBranch !== null && executionBranch.key === executionBranchKey;
  const lockedBranchName = executionBranchLoaded ? executionBranch.name : "";

  const currentBranchName = worktrees.find((worktree) => worktree.isMain)?.branch
    || branches.current
    || branch
    || "";
  // The project default never isolates where none can exist (a project
  // without Git), and the control stays hidden there. An explicit choice keeps
  // its no-fallback semantics and stays visible so it can be switched off.
  const isolationUnavailable = !projectId || (checkoutLocked
    ? executionBranchLoaded && !lockedBranchName
    : cachedLocation !== null && !branchLoading && !currentBranchName);
  const isolating = isolationEnabled && workInIsolation && !(chosenIsolation === undefined && isolationUnavailable);
  const showIsolationControl = isolationEnabled
    && (isolating || !!(checkoutLocked ? lockedBranchName : currentBranchName));

  const branchChoices = useMemo<LocationChoice[]>(() => {
    const userWorktrees = worktrees.filter((worktree) => !worktree.branch?.startsWith("polyth/isolate/"));
    const linkedBranches = new Set(userWorktrees.map((worktree) => worktree.branch).filter(Boolean));
    const localBranches = branches.branches.filter((candidate) => !candidate.remote && !candidate.name.startsWith("polyth/isolate/"));
    // Branches that only exist on a remote, keyed by the local name a checkout
    // would create. `ref` (e.g. `origin/foo`) is the start point.
    const localNames = new Set(localBranches.map((candidate) => candidate.name));
    const remoteOnly: Array<{ short: string; ref: string }> = [];
    const seenRemote = new Set<string>();
    for (const candidate of branches.branches) {
      if (!candidate.remote) continue;
      const short = candidate.name.slice(candidate.remote.length + 1);
      if (isManagedIsolationBranch(short) || !short || short === "HEAD" || short.startsWith("HEAD ")) continue;
      if (localNames.has(short) || seenRemote.has(short)) continue;
      seenRemote.add(short);
      remoteOnly.push({ short, ref: candidate.name });
    }

    if (isolating) {
      // Isolation starts from a live checkout so merge-back has a truthful cwd.
      const seen = new Set<string>();
      const choices: LocationChoice[] = [];
      if (currentBranchName && !isManagedIsolationBranch(currentBranchName)) {
        seen.add(currentBranchName);
        choices.push({
          id: `branch:${currentBranchName}`,
          label: currentBranchName,
          detail: tr("gitview.current"),
          target: { kind: "isolation", base: currentBranchName },
        });
      }
      for (const worktree of userWorktrees) {
        const name = worktree.branch;
        if (!name || isManagedIsolationBranch(name) || seen.has(name)) continue;
        seen.add(name);
        choices.push({
          id: `branch:${name}`,
          label: name,
          target: { kind: "isolation", base: name },
        });
      }
      // Every other branch stays a valid origin: it is checked out in a
      // linked worktree on send, then isolated from that live checkout.
      for (const candidate of localBranches) {
        if (seen.has(candidate.name)) continue;
        seen.add(candidate.name);
        choices.push({
          id: `branch:${candidate.name}`,
          label: candidate.name,
          detail: tr("composer.openInANewWorktree"),
          target: { kind: "isolation", base: candidate.name, checkout: { branch: candidate.name } },
        });
      }
      for (const remote of remoteOnly) {
        if (seen.has(remote.short)) continue;
        seen.add(remote.short);
        choices.push({
          id: `remote:${remote.ref}`,
          label: remote.short,
          detail: tr("gitview.remote"),
          target: { kind: "isolation", base: remote.short, checkout: { branch: remote.short, base: remote.ref } },
        });
      }
      return choices;
    }

    const choices: LocationChoice[] = [
      {
        id: "new-worktree",
        label: tr("gitview.newWorktree"),
        detail: currentBranchName || tr("composer.openInANewWorktree"),
        target: { kind: "new-worktree", ...(currentBranchName ? { base: currentBranchName } : {}) },
      },
      {
        id: "main",
        label: currentBranchName || tr("composer.mainWorkspace"),
        detail: tr("composer.mainWorkspace"),
        target: { kind: "main" },
      },
    ];
    for (const worktree of worktrees.filter((candidate) => !candidate.isMain)) {
      choices.push({
        id: `worktree:${worktree.path}`,
        label: worktree.branch || worktree.path.split("/").pop() || tr("composer.worktree"),
        detail: tr("composer.existingWorktree"),
        target: { kind: "worktree", path: worktree.path },
      });
    }
    for (const candidate of localBranches) {
      if (linkedBranches.has(candidate.name)) continue;
      choices.push({
        id: `branch:${candidate.name}`,
        label: candidate.name,
        detail: tr("composer.openInANewWorktree"),
        target: { kind: "branch", branch: candidate.name },
      });
    }
    for (const remote of remoteOnly) {
      if (linkedBranches.has(remote.short)) continue;
      choices.push({
        id: `remote:${remote.ref}`,
        label: remote.short,
        detail: tr("gitview.remote"),
        target: { kind: "branch", branch: remote.short, base: remote.ref },
      });
    }
    return choices;
  }, [worktrees, branches, branch, isolating, currentBranchName]);

  const selectedChoice = branchChoices.find((choice) => choice.id === selectedBranchId);
  // A locked checkout never sends a primary-repository worktree or base branch:
  // every repository in scope starts from its own current checkout.
  const newSessionTarget: NewSessionTarget = checkoutLocked
    ? (isolating ? { kind: "isolation" } : { kind: "main" })
    : selectedChoice?.target
      ?? (isolating
        ? { kind: "isolation", ...(currentBranchName ? { base: currentBranchName } : {}) }
        : intendedWorktree
          ? { kind: "worktree", path: intendedWorktree }
          : { kind: "main" });
  const rawBranchLabel = selectedChoice?.label
    || session?.branch
    || branch
    || intendedWorktree?.split("/").pop()
    || tr("composer.mainWorkspace");
  const branchName = checkoutLocked
    ? lockedBranchName || tr("mobile.sessioncontextbar.currentCheckout")
    : rawBranchLabel;
  const primaryRepository = repositories.find((repository) => repository.id === primaryRepositoryId);
  const projectName = project?.name || project?.path || tr("composer.noProject");
  // A fresh chat lists the projects with the most recent chats first.
  const rankedProjects = useRecentlyActiveProjects(projects, !session, spaceId);
  const projectChoices: ProjectContextChoice[] = rankedProjects.map((candidate) => ({
    id: candidate.id,
    label: candidate.name || candidate.path,
    detail: candidate.name && !candidate.personal ? candidate.path : "",
    icon: candidate.icon,
    color: candidate.color,
    remote: candidate.remote,
  }));

  const pickBranch = (id: string) => {
    const choice = branchChoices.find((candidate) => candidate.id === id);
    if (!choice || id === selectedBranchId) return;
    userBranchChoiceRef.current += 1;
    setSelectedBranchId(id);
    if (!session || !projectId) return;

    if (choice.target.kind === "main") {
      startFreshSession(projectId);
    } else if (choice.target.kind === "worktree") {
      startFreshSession(projectId, { worktreePath: choice.target.path });
    } else if (choice.target.kind === "branch") {
      setBranchLoading(true);
      void api.createWorktree(projectId, choice.target.branch, undefined, choice.target.base)
        .then((worktree) => startFreshSession(projectId, { worktreePath: worktree.path }))
        .catch((error) => setUiError(friendlyError(tr("composer.couldnTCreateTheWorktree"), error)))
        .finally(() => setBranchLoading(false));
    } else {
      // The isolation origin is recorded on send; don't create a workspace yet.
    }
  };

  // Toggling keeps the selected checkout meaningful across the ordinary and
  // isolated views. Both list every branch under the same `branch:` /
  // `remote:` ids; only the main checkout, linked worktrees and the
  // new-worktree row map onto their branch.
  const toggleWorkInIsolation = (on: boolean) => {
    userBranchChoiceRef.current += 1;
    setWorkInIsolation(on);
    if (!session && projectId) setNewSessionIsolation(projectId, on);
    setSelectedBranchId((prev) => {
      if (on) {
        if (prev === "main") return currentBranchName ? `branch:${currentBranchName}` : prev;
        if (prev.startsWith("worktree:")) {
          const path = prev.slice("worktree:".length);
          const checkout = worktrees.find((candidate) => candidate.path === path);
          if (checkout?.branch) return `branch:${checkout.branch}`;
        }
        if (prev.startsWith("branch:") || prev.startsWith("remote:")) return prev;
        return currentBranchName ? `branch:${currentBranchName}` : prev;
      }
      if (prev.startsWith("branch:")) {
        const branch = prev.slice("branch:".length);
        const checkout = worktrees.find((candidate) => candidate.branch === branch);
        if (checkout?.isMain) return "main";
        if (checkout) return `worktree:${checkout.path}`;
      }
      return prev;
    });
  };

  return {
    newSessionTarget,
    newSessionRepositoryIds: repositoryScope,
    contextBar: {
      projectName,
      ...(projectId ? { projectId } : {}),
      projects: projectChoices,
      onPickProject: (id) => {
        if (id) moveNewSessionDraftToProject(id, readLiveText?.() ?? "");
        else activateProject(null);
      },
      ...(multiRepository && projectId ? {
        repositories,
        ...(repositoryScope ? { repositoryIds: repositoryScope } : {}),
        ...(primaryRepositoryId ? { primaryRepositoryId } : {}),
        onPickRepositories: (ids: string[] | undefined) => setNewSessionRepositories(projectId, ids),
        onManageRepositories: () => openProjectSettings(projectId, "files.repositories"),
        ...(executionRepository ? { checkoutRepositoryAlias: executionRepository.alias } : {}),
        ...(checkoutLocked && executionRepository ? {
          branchLockedReason: tr("mobile.sessioncontextbar.checkoutLockedReason", {
            primary: primaryRepository?.alias ?? tr("mobile.sessioncontextbar.primaryRepository"),
            repository: executionRepository.alias,
          }),
        } : {}),
      } : {}),
      branchName,
      branchId: selectedBranchId,
      branches: branchChoices,
      onPickBranch: pickBranch,
      onBranchPickerOpen: refreshBranchesFromRemote,
      onRefreshBranches: () => refreshBranchesFromRemote(true),
      branchRefreshing: branchRefreshing || branchLoading,
      ...(showIsolationControl ? {
        workInIsolation: isolating,
        onToggleWorkInIsolation: toggleWorkInIsolation,
      } : {}),
    },
  };
}

type QueueEdit = {
  id: string;
  sessionId: string;
  /** Preserve an unrelated composer draft while the queued item is edited. */
  draftBefore: string;
};

/** A hidden file picker behind Add. Memoized: React re-applies an input's
 *  `type` and `name` attributes whenever it renders, and the composer renders
 *  on every keystroke; each such write restyled `:has()` subjects shell-wide.
 *  `capture` opens the camera directly in mobile browsers and the native shell. */
const ComposerFileInput = memo(function ComposerFileInput({ inputRef, onFiles, accept, capture }: {
  inputRef: Ref<HTMLInputElement>;
  onFiles: (files: File[]) => void;
  accept?: string;
  capture?: "environment";
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      multiple={!capture}
      {...(accept ? { accept } : {})}
      {...(capture ? { capture } : {})}
      hidden
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
        onFiles(files);
      }}
    />
  );
});

export default function Composer(props: { variant?: "docked" | "widget" }) {
  // Primitive selector: the wrapper re-renders only when access changes.
  // View-only still writes to people — people mode is the only mode there.
  const peopleOnly = useStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId);
    return !!session && (session.purpose === "conversation" || !canCollaborateSession(session));
  });
  const conversation = useStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId);
    return session?.purpose === "conversation";
  });
  return <ComposerBody {...props} peopleOnly={peopleOnly} conversation={conversation} />;
}

function ComposerBody({
  variant = "docked",
  peopleOnly = false,
  conversation = false,
}: {
  variant?: "docked" | "widget";
  /** A view-only reader: people messages only, never an agent turn. */
  peopleOnly?: boolean;
  /** A people-first conversation: no agent controls even when the reader
   *  could collaborate in an ordinary chat. */
  conversation?: boolean;
}) {
  const [mobileRailEditing, setMobileRailEditing] = useState(false);
  const [contributedDialogs, setContributedDialogs] = useState<Array<{ key: number; contributionId: string; render: () => ReactNode }>>([]);
  const [goalAttachBusy, setGoalAttachBusy] = useState(false);
  // "inherit" until a level is picked: the new chat then follows the Space's
  // "Full access always" default, which the approval widget shows.
  const [newSessionAutoApprove, setNewSessionAutoApprove] = useState<"inherit" | "off" | "on" | "all">("inherit");
  const [newSessionGoal, setNewSessionGoal] = useState(false);
  const creatingSession = useStore(isActiveSessionSpawning);
  const activeProjectId = useStore(workspaceProjectId);
  const [draftExecutionRevision, setDraftExecutionRevision] = useState(0);
  const draftExecution = useMemo<DraftExecutionConfig>(() =>
    activeProjectId ? readDraftExecutionConfig(activeProjectId) : emptyDraftExecutionConfig(),
  [activeProjectId, draftExecutionRevision]);
  useEffect(() => subscribeDraftExecutionConfig(() => setDraftExecutionRevision((revision) => revision + 1)), []);
  const profiles = useProfiles();
  const spaceId = useSpaces().activeSpaceId ?? undefined;
  // The phone composer buttons follow the shared-or-per-project interface choice.
  useProjectInterfaceMode();
  const globalModels = useStore((s) => s.models);
  const globalAgents = useStore((s) => s.agents);
  const activeProject = useStore((s) =>
    s.projectRegistry.projects.find((candidate) => candidate.id === workspaceProjectId(s)));
  const settings = useStore((s) => s.settings);
  const sessionDefaults = useSessionDefaults();
  const sessionRecord = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const pendingSends = useStore((s) => s.pendingSends);
  const session = overlaySessionProjection(sessionRecord, pendingSends) ?? null;
  const [cfg, setCfg] = useState<ComposerConfig>(() => loadComposerConfig(session?.id ?? null));
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const draftProfile = !session && draftExecution.profileId
    ? profiles.find((profile) => profile.id === draftExecution.profileId)
    : undefined;
  // Spaces §13: a new chat nothing was chosen for runs on the person's own
  // default harness, which outranks the project default on the server. The
  // picker shows it; the create then names no route so the server pins it.
  const catalogRevision = useCatalogRevision();
  // Account limits and shared-account allowlists can hide a harness this
  // browser remembered or the project defaults to. Such a route can never run
  // for this person, so a new chat quietly takes the harness of a favorite or
  // recent model they may use, else the first available one (nothing is
  // rewritten: the pick returns if the owner allows the harness again).
  const visibleHarnessIds = useVisibleHarnessIds(activeProjectId ?? undefined, spaceId);
  const harnessColors = useHarnessColors(activeProjectId ?? undefined, spaceId);
  const modelPrefs = useModelPrefs();
  const projectHarnessDefault = activeProject?.defaults?.harness;
  const draftRoute = useMemo(
    () => newChatDraftRoute(draftExecution, projectHarnessDefault, visibleHarnessIds),
    [draftExecution, projectHarnessDefault, visibleHarnessIds],
  );
  const fallbackDraftHarness = draftRoute.hidden
    ? preferredVisibleHarness(modelPrefs, visibleHarnessIds)
    : undefined;
  const personDefaultHarnessId = usePersonHarnessDefault(spaceId, catalogRevision);
  const newChatPersonHarness = session
    ? undefined
    : newChatPersonDefault(personDefaultHarnessId, newChatRouteChosen(draftRoute.draft, cfg));
  const selectedDraftHarness = !session
    ? newChatPersonHarness ?? (draftRoute.draft.harnessSelection.mode === "pinned"
      ? draftRoute.draft.harnessSelection.harnessId
      : !draftRoute.draft.harnessSelectionExplicit && draftProfile
        ? draftProfile.harnessId ?? "opencode"
      : !draftRoute.draft.harnessSelectionExplicit && draftRoute.projectHarness?.mode === "pinned"
        ? draftRoute.projectHarness.harnessId
        : fallbackDraftHarness)
    : undefined;
  const stagedHarnessId = cfg.harness?.mode === "pinned"
    ? cfg.harness.harnessId
    : undefined;
  const pendingSessionHarnessId = session ? stagedHarnessId : undefined;
  const transitionHarnessId = session?.harnessTransition?.targetHarnessId;
  const movingTransition = routeMovingTransition(session?.harnessTransition, session?.resolvedHarnessId);
  const prospectiveHarnessId = stagedHarnessId ?? transitionHarnessId ?? selectedDraftHarness;
  const routeSwitched = routeSwitchedByPerson({
    hasSession: Boolean(session),
    ...(pendingSessionHarnessId ? { stagedHarnessId: pendingSessionHarnessId } : {}),
    ...(session?.resolvedHarnessId ? { resolvedHarnessId: session.resolvedHarnessId } : {}),
    draftHarnessExplicit: draftRoute.draft.harnessSelectionExplicit === true,
  });
  const routeCatalog = useRuntimeCatalog(session, globalModels, globalAgents, {
    spaceId,
    projectId: activeProjectId ?? undefined,
    cwd: activeProject?.path,
    harnessId: prospectiveHarnessId,
  });
  const catalogHarnessId = stagedHarnessId
    ?? transitionHarnessId
    ?? session?.resolvedHarnessId
    ?? routeCatalog.harnessId
    ?? selectedDraftHarness;
  const effectiveDraftHarness = session ? undefined : catalogHarnessId;
  // Model search also reaches every other runnable harness. A pending switch
  // is retargeted through the harness tabs' server call, not by staging, so
  // cross-harness results pause until it settles.
  const otherHarnessModels = useOtherHarnessModels({
    projectId: activeProjectId ?? undefined,
    spaceId,
    cwd: activeProject?.path,
    excludeHarnessId: catalogHarnessId,
    enabled: !session?.harnessTransition,
  });
  const models = catalogHarnessId
    ? routeCatalog.models.filter((item) => !item.harnessId || item.harnessId === catalogHarnessId)
    : routeCatalog.models;
  // The four honest states, so "still discovering" and "this engine is not
  // signed in" never render as "this engine has no models".
  const modelCatalog: CatalogState<ModelDescriptor> = harnessModelCatalog({
    models: routeCatalog.models,
    ...(catalogHarnessId ? { harnessId: catalogHarnessId } : {}),
    discovery: routeCatalog.discovery,
  });
  const chatModels = modelCatalog.state === "available" ? modelCatalog.items : [];
  const modelAbsence = composerModelAbsence({
    catalog: modelCatalog,
    nativeDefault: routeCatalog.nativeDefault,
  });
  // A route with no ready engine has nothing to reconnect to: send the user to
  // the Harnesses settings instead of retrying a transport that is not broken.
  // Every other unavailable cause keeps the Reconnect retry.
  const modelRecovery = composerRecoveryKind(routeCatalog.discovery);
  // The server knows which kind of empty answer this is. "Check that the
  // backend is running" is a guess; a structured empty cause is not.
  const modelAbsenceReason = modelCatalog.state === "unavailable"
    ? modelCatalog.reason
    : emptyModelCatalogReason(routeCatalog.discovery);
  const failedSend = useSyncExternalStore(
    subscribeSendFailures,
    () => getSendFailure(session?.id ?? null),
    () => null,
  );
  const newSessionIntent = useStore((s) => s.newSessionIntent);
  // Which unsent chat the input belongs to. A checkout or repository choice
  // republishes the intent without changing it.
  const newSessionChat = useStore((s) => newSessionOrigin(s.newSessionIntent));
  const { contextBar, newSessionTarget, newSessionRepositoryIds } = useComposerLocation(
    session,
    // The input owns live text; the intent's draft is only its seed.
    () => inputRef.current?.getText() ?? committedTextRef.current,
  );
  const model = useActiveModel();
  const working = model.turn?.status === "working";
  // While a turn runs, its primary action doubles as the context gauge.
  const contextGauge = useActiveContextGauge(model);
  const contextLabel = contextLiquidLabel(contextGauge);
  const rewindActive = model.rewind !== null;
  // The session projection can lag the event log (e.g. a re-attach marks the
  // session `unknown` after the turn already stopped). A terminal turn status
  // is authoritative: never offer Stop for a turn the log has already closed.
  const canStop = working;
  const abortPendingRef = useRef(false);
  const stopPointerAt = useRef(0);
  const [abortPending, setAbortPending] = useState(false);
  // A `/compact` submission is a host action with no user turn; this only
  // blocks a second submission while the request is in flight.
  const [compactPending, setCompactPending] = useState(false);
  // A Polyth-owned compaction answers once under way and reports progress on
  // the context window; messages sent meanwhile queue for the fresh context.
  const compactionRunning = compactPending || session?.contextWindow?.compaction?.active === true;
  /** Compaction for `/compact` and the context card's button: the runtime's
   *  own, or Polyth's when it has none. False when there is nothing to
   *  compact (an error is already shown). */
  const startCompact = (target: string | null): boolean => {
    const active = target
      ? getState().sessions.find((candidate) => candidate.id === target) ?? session
      : session;
    const blocked = compactBlockReason({
      sessionId: target,
      backendSessionId: active?.backendSessionId,
      hasConversation: model.messages.some((message) => message.kind === "user" || message.kind === "assistant"),
    });
    if (blocked) {
      setUiError(tr("composer.nothingToCompact"), null, undefined, "info");
      return false;
    }
    // Already under way: the timeline row shows its progress.
    if (active?.contextWindow?.compaction?.active !== true) {
      setCompactPending(true);
      void api.compact(target!)
        .catch((error: unknown) => {
          if (isNothingToCompactError(error)) setUiError(tr("composer.nothingToCompact"), null, undefined, "info");
          else setUiError(friendlyError(tr("composer.couldNotCompact"), error));
        })
        .finally(() => setCompactPending(false));
    }
    return true;
  };
  useEffect(() => {
    if (!canStop) {
      abortPendingRef.current = false;
      setAbortPending(false);
    }
  }, [canStop]);
  const stopActiveTurn = useCallback(async (event?: { detail?: number }) => {
    // One stop intent per active turn. If the stream settles while the request
    // is in flight, the idle Send state wins and the late response is ignored.
    if (!canStop || abortPendingRef.current) return;
    // Send and Stop occupy the same slot. A remount can fire click on Stop
    // without pointerdown on that button (the down started on Send).
    if (event && event.detail !== 0 && Date.now() - stopPointerAt.current > 1000) return;
    abortPendingRef.current = true;
    setAbortPending(true);
    try {
      await abortSession("composer");
    } finally {
      abortPendingRef.current = false;
      setAbortPending(false);
    }
  }, [canStop]);
  const noModels = modelAbsence !== "none";
  // The server-known cause, when there is one. "Check that the backend is
  // running" is a guess; this is what actually went wrong.
  const runtimeUnavailable = useStore((s) => s.runtimeUnavailable);
  // A harness switch replaces the qualified catalogue, so `loading` is usually a
  // route change — not an engine without models. The gate holds the notice back
  // for the grace period and then keeps it for a minimum beat, so a catalogue
  // that answers just after the grace cannot blink the row. `unavailable` is a
  // named failure and stays immediate; `empty` keeps its cold-backend delay.
  const [absenceGate, setAbsenceGate] = useState<ModelAbsenceGate>(IDLE_MODEL_ABSENCE_GATE);
  const absencePending = modelAbsence === "loading" || modelAbsence === "empty";
  const absenceDelay = modelAbsence === "empty" ? MODEL_WARNING_DELAY_MS : MODEL_ABSENCE_GRACE_MS;
  useEffect(() => {
    setAbsenceGate((current) => advanceModelAbsenceGate(current, absencePending, Date.now(), absenceDelay));
  }, [absencePending, absenceDelay]);
  useEffect(() => {
    if (absenceGate.nextChangeAt === null) return;
    const timer = setTimeout(() => {
      setAbsenceGate((current) => advanceModelAbsenceGate(current, absencePending, Date.now(), absenceDelay));
    }, Math.max(0, absenceGate.nextChangeAt - Date.now()));
    return () => clearTimeout(timer);
  }, [absenceGate, absencePending, absenceDelay]);
  const showModelWarning = modelAbsence === "unavailable" || absenceGate.visible;
  // Send is blocked only by a real absence, or by one that outlived the grace.
  const modelAbsenceBlocksSend = modelAbsence === "unavailable"
    || modelAbsence === "empty"
    || (modelAbsence === "loading" && absenceGate.visible);
  const widgetMode = variant === "widget";
  // A fresh composer's location row (and its Isolate switch) can be switched
  // off from the new chat's Customize panel; values still apply when hidden.
  const heroChrome = useHeroWidgetPrefs().chrome;
  // Only the personal project: there is no project or checkout to choose, so
  // nothing sits above the composer.
  const soloPersonal = useStore((s) => s.projectRegistry.status === "ready"
    && soloPersonalProject(s.projectRegistry.projects) !== null);
  const shellLayout = useShellMode();

  // IME-safe input: the DOM owns live text; `text` tracks committed edits only.
  const inputRef = useRef<TextInputHandle>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const sessionScopeKeyRef = useRef(scopedDraftCacheKey(session?.id ?? null));
  const inFlightPrompt = usePendingSends(session?.id ?? null).length > 0;
  useSyncExternalStore(subscribeAdmissions, admissionSnapshot);
  const [text, setText] = useState(() => visibleComposerDraft(
    session?.id ? loadDraft(session.id) : newSessionIntent?.draft ?? "",
    hasInFlightPrompt(getState(), session?.id ?? null) || sessionAdmitting(session?.id),
  ));
  const [queueEdit, setQueueEdit] = useState<QueueEdit | null>(null);
  const [queueEditStarting, setQueueEditStarting] = useState(false);
  const [queueEditSaving, setQueueEditSaving] = useState(false);
  // The composer empties on submit, but the submitted text stays staged in the
  // scoped draft until admission is authoritative. Draft persistence is held
  // off for that window so the now-empty input cannot overwrite the recovery
  // copy; the admission result writes the record explicitly either way.
  // Pending is per surface (session id, or the project's new-chat surface): a
  // first send that is still creating its session must not freeze the
  // composer of whichever chat the user moved on to. Session surfaces are
  // shared by every mounted composer (see admittingSessions).
  const sendPendingSurfacesRef = useRef(new Map<string, number>());
  const [, setSendPendingVersion] = useState(0);
  const composerSurface = sendSurfaceKey(session?.id ?? null, activeProjectId);
  const composerSurfaceRef = useRef(composerSurface);
  composerSurfaceRef.current = composerSurface;
  const surfacePending = useCallback((surface: string) => surface.startsWith("new:")
    ? (sendPendingSurfacesRef.current.get(surface) ?? 0) > 0
    : sessionAdmitting(surface), []);
  const sendPending = surfacePending(composerSurface);
  const sendPendingRef = useRef(sendPending);
  sendPendingRef.current = sendPending;
  // API admission can finish before the optimistic echo leaves the store;
  // keep this witness until the echo is gone so newer typing is still visible
  // to a deletion flush in that interval.
  const submittedDraftRevisionRef = useRef<{ sessionId: string | null; revision: number } | null>(null);
  const removalFlushRef = useRef<string | null>(null);
  const markSendPending = useCallback((surface: string, value: boolean) => {
    if (surface.startsWith("new:")) {
      const surfaces = sendPendingSurfacesRef.current;
      const count = (surfaces.get(surface) ?? 0) + (value ? 1 : -1);
      if (count > 0) surfaces.set(surface, count);
      else surfaces.delete(surface);
    } else {
      markSessionAdmitting(surface, value);
    }
    sendPendingRef.current = surfacePending(composerSurfaceRef.current);
    setSendPendingVersion((version) => version + 1);
  }, [surfacePending]);
  const [queuedItems, setQueuedItems] = useState<QueueItemDto[]>([]);
  const [steeringQueuedId, setSteeringQueuedId] = useState<string | null>(null);
  const steeringQueuedBySessionRef = useRef(new Map<string, string>());
  const queueEditRef = useRef<QueueEdit | null>(null);
  queueEditRef.current = queueEdit;
  const committedTextRef = useRef(text);
  committedTextRef.current = text;
  // Generic composer contribution seam: feature packages publish Add-menu items
  // and paste handlers; the composer renders/activates them without naming a
  // package. Dialogs a contribution opens mount here.
  const contributionDialogSeq = useRef(0);
  const openContributionDialog = useCallback((contributionId: string, render: (close: () => void) => ReactNode) => {
    const key = ++contributionDialogSeq.current;
    const close = () => setContributedDialogs((current) => current.filter((dialog) => dialog.key !== key));
    setContributedDialogs((current) => [...current, { key, contributionId, render: () => render(close) }]);
    return close;
  }, []);
  const closeContributionDialogs = useCallback((contributionId: string) => {
    setContributedDialogs((current) => current.filter((dialog) => dialog.contributionId !== contributionId));
  }, []);
  const buildContributionContext = useCallback((contributionId: string): ComposerContributionContext => ({
    projectId: getState().activeProjectId,
    sessionId: sessionIdRef.current,
    draftText: inputRef.current?.getText() ?? committedTextRef.current,
    openDialog: (render) => openContributionDialog(contributionId, render),
    close: () => closeContributionDialogs(contributionId),
    insertText: (value) => inputRef.current?.insertText(value),
    error: (message) => setUiError(message),
    setMode: (modeId) => { enterModeRef.current(modeId); },
  }), [openContributionDialog, closeContributionDialogs]);
  const contributionsVersion = useSyncExternalStore(
    subscribeComposerContributions,
    composerContributionsVersion,
    composerContributionsVersion,
  );
  const composerContributions = useMemo<ComposerAddMenuItem[]>(() =>
    listComposerAddMenuItems().filter((item) => {
      if (!item.isAvailable) return true;
      try { return item.isAvailable(buildContributionContext(item.id)); }
      catch { return false; }
    }), [contributionsVersion, buildContributionContext, activeProjectId, session?.id, text]);
  // Composer modes (web-sdk `ComposerMode`): a package-owned way to submit the
  // draft somewhere other than the session — never queued, steered, blocked by
  // a running turn or creating a session. The host owns the chip, the gestures
  // and the reset on a session change; a people-only composer offers none.
  const [activeModeId, setActiveModeId] = useState<string | null>(null);
  const activeModeIdRef = useRef<string | null>(null);
  const modeAvailable = useCallback((mode: ComposerMode): boolean => {
    if (peopleOnly) return false;
    if (!mode.isAvailable) return true;
    try { return mode.isAvailable(buildContributionContext(`mode:${mode.id}`)); }
    catch { return false; }
  }, [peopleOnly, buildContributionContext]);
  const registeredModes = useMemo(() => listComposerModes(), [contributionsVersion]);
  const activeMode = useMemo<ComposerMode | null>(() => {
    if (!activeModeId) return null;
    const mode = registeredModes.find((candidate) => candidate.id === activeModeId);
    return mode && modeAvailable(mode) ? mode : null;
  }, [activeModeId, registeredModes, modeAvailable, activeProjectId, session]);
  activeModeIdRef.current = activeMode?.id ?? null;
  const activeModeRef = useRef(activeMode);
  activeModeRef.current = activeMode;
  const modeTriggerSourcesRef = useRef<() => ComposerMode[]>(() => []);
  modeTriggerSourcesRef.current = () => registeredModes.filter((mode) => mode.trigger && modeAvailable(mode));
  const activeModeLabel = activeMode ? modeText(activeMode.label) : "";
  const leaveMode = useCallback(() => {
    const leaving = activeModeIdRef.current;
    if (!leaving) return;
    activeModeIdRef.current = null;
    setActiveModeId(null);
    const left = composerMode(leaving);
    if (left) announce(tr("composer.mode.left", { mode: modeText(left.label) }));
  }, []);
  const enterModeRef = useRef<(modeId: string | null) => boolean>(() => false);
  enterModeRef.current = (modeId) => {
    if (modeId === null) {
      if (!activeModeIdRef.current) return false;
      leaveMode();
      return true;
    }
    const mode = composerMode(modeId);
    if (!mode || queueEditRef.current || !modeAvailable(mode)) return false;
    if (activeModeIdRef.current !== modeId) {
      activeModeIdRef.current = modeId;
      setActiveModeId(modeId);
      announce(tr("composer.mode.entered", { mode: modeText(mode.label) }));
    }
    inputRef.current?.focus();
    return true;
  };
  // A session change leaves the mode before the new chat paints.
  useLayoutEffect(() => {
    activeModeIdRef.current = null;
    setActiveModeId(null);
  }, [session?.id]);
  // A mode that became unavailable (or was unregistered) is left, not paused:
  // it must not come back on its own when availability returns.
  useEffect(() => {
    if (activeModeId && !activeMode) setActiveModeId(null);
  }, [activeModeId, activeMode]);
  useEffect(() => listenComposerModeRequests((modeId, targetSessionId) => {
    if (targetSessionId !== undefined && targetSessionId !== sessionIdRef.current) return false;
    return enterModeRef.current(modeId);
  }), []);
  useEffect(() => {
    const sessionId = session?.id ?? null;
    publishComposerActiveMode(sessionId, activeMode?.id ?? null);
    return () => publishComposerActiveMode(sessionId, null);
  }, [session?.id, activeMode?.id]);
  const [modeSubmitting, setModeSubmitting] = useState(false);
  const modeSubmittingRef = useRef(false);
  // The mode receives the trimmed draft; the draft clears once it accepts and
  // stays (with a notice) when it refuses. The mode stays on for a follow-up.
  const submitMode = useCallback((override?: string) => {
    const mode = activeModeRef.current;
    if (!mode || modeSubmittingRef.current) return;
    const raw = (override ?? inputRef.current?.getText() ?? "").trim();
    if (!raw) return;
    const target = sessionIdRef.current;
    const scopeKeyAtSubmit = sessionScopeKeyRef.current;
    modeSubmittingRef.current = true;
    setModeSubmitting(true);
    const settle = () => {
      modeSubmittingRef.current = false;
      setModeSubmitting(false);
    };
    const refuse = (error: unknown) => setUiError(friendlyError(tr("composer.mode.submitFailed", { mode: modeText(mode.label) }), error));
    let result: void | Promise<void>;
    try {
      result = mode.submit(buildContributionContext(`mode:${mode.id}`), raw);
    } catch (error) {
      settle();
      refuse(error);
      return;
    }
    void Promise.resolve(result).then(() => {
      if (sessionIdRef.current !== target || sessionScopeKeyRef.current !== scopeKeyAtSubmit) return;
      if ((inputRef.current?.getText() ?? "").trim() !== raw) return;
      setText("");
      inputRef.current?.replaceText("");
      if (target) {
        saveDraft(target, "");
        cancelDraftSync(target);
      }
    }, refuse).finally(settle);
  }, [buildContributionContext]);
  const draftRevisionRef = useRef(0);
  const pendingLocalTextRef = useRef<{ scopeKey: string; text: string } | null>(null);
  // True while a switch puts the stored draft back into the input. That is a
  // restore, not an edit, so it is never saved as the new chat's text.
  const restoringDraftRef = useRef(false);
  const transcriptSpanRef = useRef<TranscriptSpan | null>(null);
  // Set by a dictation update: once the input is resized, scroll it to the
  // caret so the newest spoken words stay visible past the height cap.
  const followDictationRef = useRef(false);
  const [focusMode, setFocusMode] = useState(false);
  // On phones the composer is a compact resting
  // control that expands into the full model/mode surface once the user
  // engages with it. Text, attachments, an active run, and shell mode all
  // count as "in use".
  //
  // Engagement is deliberately NOT plain input focus: tapping the model,
  // thinking, or mode control blurs the textarea, and collapsing on that blur
  // would unmount the control under the finger before its click ever lands.
  // The composer stays engaged until a pointer goes down outside it.
  const [inputFocused, setInputFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keyboard geometry is one source of truth —
  // mobileViewport.ts publishes --visual-vh / --visual-bottom / --keyboard-inset
  // and the phone CSS keeps the frame on the visible band. The composer reads
  // the metrics for auto-grow; it never re-derives its own transform.
  // A widget composer responds to its host container below; viewport shell
  // mode must not turn an embedded card into the docked-phone interaction.
  const isPhone = shellLayout === "phone" && !widgetMode;
  const sendShortcut = isPhone ? settings.mobileSendShortcut : settings.desktopSendShortcut;
  const sendKey = sendShortcut === "none" ? `${modKeyLabel()}↵` : sendShortcut === "shift-enter" ? "⇧↵" : "↵";
  const uiPrefs = useUiSettings();
  const promptHistoryNav = usePromptHistory({
    sessionId: session?.id ?? null,
    projectId: activeProjectId,
    worktreePath: session?.worktreePath ?? newSessionIntent?.worktreePath,
    scope: uiPrefs.promptHistoryScope,
    limit: uiPrefs.promptHistoryLimit,
  });
  const promptHistoryNavRef = useRef(promptHistoryNav);
  promptHistoryNavRef.current = promptHistoryNav;
  const promoteHistoryDraft = () => {
    const nav = promptHistoryNavRef.current;
    if (!nav.isBrowsing()) return;
    const sid = sessionIdRef.current;
    const displayed = nav.displayedAttachments ?? [];
    nav.reset();
    seedAttachments(sid, displayed);
  };
  // Protected mode: `!` is plain text; the server refuses shell for the account.
  const guardrails = useGuardrails();
  const shellAllowed = !conversation && guardedShellAllowed(guardrails);
  const shell = shellAllowed && !activeMode ? shellCommand(text) : null;
  const shellMode = shell !== null && !peopleOnly;

  // One pending execution configuration (profile / model /
  // agent) per canonical session, persisted with the draft. Selections flow
  // through composerConfig transitions so profile and explicit overrides
  // clear each other.
  const effectiveProfileId = cfg.profile.kind === "id"
    ? cfg.profile.id
    : cfg.profile.kind === "none"
      ? undefined
      : session?.agentProfileId ?? draftExecution.profileId;
  const effectiveProfile = effectiveProfileId
    ? profiles.find((profile) => profile.id === effectiveProfileId)
    : undefined;
  const priorRoute = useRef({ sessionId: session?.id, harnessId: session?.resolvedHarnessId });
  useEffect(() => {
    if (!routeCatalog.ready) return;
    if (priorRoute.current.sessionId === session?.id && priorRoute.current.harnessId !== session?.resolvedHarnessId) {
      const harnessId = session?.resolvedHarnessId;
      // Catalog discovery may be partial or unavailable. The explicit route
      // identity, not membership in that response, decides compatibility.
      const compatibleModel = cfg.model && (!harnessId
        || (cfg.model.harnessId ?? "opencode") === harnessId);
      const compatibleAgent = cfg.agent && routeCatalog.agents.some((agent) =>
        agent.name === cfg.agent && (!harnessId || agent.harnessId === harnessId));
      const profileId = cfg.profile.kind === "id" ? cfg.profile.id : undefined;
      const compatibleProfile = !profileId || profiles.some((profile) =>
        profile.id === profileId && (!harnessId || profile.harnessId === harnessId));
      const next: ComposerConfig = {
        profile: compatibleProfile ? cfg.profile : { kind: "inherit" },
        ...(compatibleModel ? { model: cfg.model } : {}),
        ...(compatibleAgent ? { agent: cfg.agent } : {}),
        ...(compatibleModel && cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
      };
      saveComposerConfig(session?.id, next);
      setCfg(next);
    }
    priorRoute.current = { sessionId: session?.id, harnessId: session?.resolvedHarnessId };
  }, [session?.id, session?.resolvedHarnessId, cfg, routeCatalog.ready, routeCatalog.models, routeCatalog.agents, profiles]);
  // The last model the composer displayed for this session. A harness switch
  // clears the selection for correctness (an incompatible model must never be
  // sent), so the chip keeps this display-only anchor until the new route
  // publishes a model of its own. The label therefore never falls through to an
  // arbitrary first catalogue entry of the target harness.
  const routeLabelAnchor = useRef<{
    sessionId: string | null;
    model: ModelRef & { harnessId?: string; name?: string };
  } | null>(null);
  const displayedRouteModel = cfg.model
    ?? (session?.model
      ? { ...session.model, ...(session.resolvedHarnessId ? { harnessId: session.resolvedHarnessId } : {}) }
      : undefined);
  const displayedRouteModelKey = displayedRouteModel
    ? `${displayedRouteModel.harnessId ?? ""}|${displayedRouteModel.providerID}/${displayedRouteModel.modelID}`
    : "";
  useEffect(() => {
    if (!displayedRouteModel) return;
    const descriptor = routeCatalog.models.find((candidate) => modelIdentityMatches(candidate, displayedRouteModel));
    routeLabelAnchor.current = {
      sessionId: session?.id ?? null,
      model: { ...displayedRouteModel, ...(descriptor?.name ? { name: descriptor.name } : {}) },
    };
    // `displayedRouteModelKey` is the anchor's real dependency; the object is a
    // fresh copy on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, displayedRouteModelKey, routeCatalog.models]);
  const updateCfg = useCallback((next: ComposerConfig) => {
    cfgRef.current = next;
    setCfg(next);
    saveComposerConfig(sessionIdRef.current, next);
  }, []);
  const priorDraftHarness = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (session) {
      priorDraftHarness.current = undefined;
      return;
    }
    if (!effectiveDraftHarness) {
      priorDraftHarness.current = undefined;
      return;
    }
    if (!routeCatalog.ready) return;
    if (priorDraftHarness.current === effectiveDraftHarness) return;
    priorDraftHarness.current = effectiveDraftHarness;
    const compatibleModel = cfg.model
      && (cfg.model.harnessId ?? "opencode") === effectiveDraftHarness;
    const compatibleAgent = cfg.agent && routeCatalog.agents.some((agent) =>
      (!agent.harnessId || agent.harnessId === effectiveDraftHarness) && agent.name === cfg.agent);
    const draftProfileId = cfg.profile.kind === "id" ? cfg.profile.id : undefined;
    const compatibleProfile = !draftProfileId || profiles.some((profile) =>
      profile.id === draftProfileId && (profile.harnessId ?? "opencode") === effectiveDraftHarness);
    const next: ComposerConfig = {
      profile: compatibleProfile ? cfg.profile : { kind: "inherit" },
      ...(cfg.harness ? { harness: cfg.harness } : {}),
      ...(compatibleModel ? { model: cfg.model } : {}),
      ...(compatibleAgent ? { agent: cfg.agent } : {}),
      ...(compatibleModel && cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
    };
    if (!compatibleProfile && draftProfileId && activeProjectId) {
      updateDraftExecutionConfig(activeProjectId, { profileId: undefined });
    }
    saveComposerConfig(null, next);
    setCfg(next);
  }, [session, effectiveDraftHarness, cfg, routeCatalog.ready, routeCatalog.models, routeCatalog.agents, profiles, activeProjectId]);

  // Blur commits the local copy. An unchanged blur must not restart the idle
  // server timer; toolbar taps can otherwise generate needless broadcasts.
  // Session/page lifecycle transitions still flush the dirty draft.
  const persistComposerDraft = useCallback((flushServerNow: boolean, localOnly = false) => {
    const id = sessionIdRef.current;
    if (id === null || ((sendPendingRef.current || isActiveSessionSpawning(getState())) && !localOnly)) return;
    if (scopedDraftCacheKey(id) !== sessionScopeKeyRef.current) return;
    const editing = queueEditRef.current;
    const nav = promptHistoryNavRef.current;
    const live = nav.isBrowsing()
      ? (nav.snapshot()?.text ?? inputRef.current?.getText() ?? committedTextRef.current)
      : inputRef.current?.getText() ?? committedTextRef.current;
    const draft = editing?.sessionId === id ? editing.draftBefore : live;
    const inFlight = hasInFlightPrompt(getState(), id) || sessionAdmitting(id);
    const submittedRevision = submittedDraftRevisionRef.current?.sessionId === id
      ? submittedDraftRevisionRef.current.revision
      : null;
    // The cleared textarea belongs to the submitted prompt while its echo is
    // in flight. A revision after that clear is a real newer edit (including
    // an explicit clear), so persist it instead of preserving the staged text.
    if (inFlight && (submittedRevision === null || draftRevisionRef.current === submittedRevision)) return;
    const changed = loadDraft(id) !== draft;
    if (changed) saveDraft(id, draft);
    if (!localOnly && (changed || flushServerNow)) syncDraftToServer(id, draft);
    if (!localOnly && flushServerNow) flushDraftToServer(id);
  }, []);
  const flushComposerDraft = useCallback(() => persistComposerDraft(true), [persistComposerDraft]);

  useLayoutEffect(() => registerComposerDraftFlusher((targetSessionId) => {
    if (sessionIdRef.current !== targetSessionId) return;
    // The delete path runs this while the session is still active. Remember
    // that local-only flush so the following outgoing layout effect does not
    // enqueue a server PATCH for the row that has just been deleted.
    removalFlushRef.current = targetSessionId;
    persistComposerDraft(false, true);
  }), [persistComposerDraft]);

  // Session switch: restore the draft through the command handle (never a
  // controlled replay), and never while the user is mid-composition. The
  // pending execution configuration is per-session and reloads with it.
  // Deliberately NOT reactive to session.draft: live cross-client draft
  // updates apply below, only when the composer is empty.
  //
  // First-send creation remounts this composer onto the new session while the
  // submitted prompt is still staged for crash recovery. That copy already
  // appears as the echo; do not put it back in the input.
  //
  // Layout phase: the newcomer's draft and per-session config must be
  // committed before the first frame of the switch is painted, or that frame
  // still shows the outgoing session's draft and the text jumps a frame later.
  // The outgoing flush stays first in this same effect so the previous draft
  // is persisted exactly once, before the swap. This effect is registered
  // after usePromptHistory(); the hook must not destroy the browse snapshot on
  // sessionId change, or this flush would persist the recalled textarea
  // instead of the canonical draft.
  //
  // A new chat re-seeds from its intent only when the chat itself changes.
  // Keystrokes never republish the intent, so its `draft` is just the seed the
  // chat started with; re-running for a checkout or repository choice would put
  // that seed over what was typed since (see newSessionOrigin).
  useLayoutEffect(() => {
    const outgoing = sessionIdRef.current;
    if (outgoing !== null && outgoing !== (session?.id ?? null)) {
      const flushedForRemoval = removalFlushRef.current === outgoing;
      removalFlushRef.current = null;
      const outgoingInput = inputRef.current;
      if (outgoingInput) rememberComposerSelection(sessionScopeKeyRef.current, outgoingInput.getText(), outgoingInput.getSelection());
      if (!flushedForRemoval) flushComposerDraft();
      const editing = queueEditRef.current;
      if (editing?.sessionId === outgoing) void api.queueEditCancel(outgoing, editing.id).catch(() => {});
    }
    sessionIdRef.current = session?.id ?? null;
    sessionScopeKeyRef.current = scopedDraftCacheKey(session?.id ?? null);
    // The hero Composer is replaced by a fresh timeline Composer after
    // first-send creation. Seed that instance's silent baseline before the
    // created pending echo binds and can trigger another render; subsequent
    // input events then advance the fresh instance's revision witness.
    if (session?.id && submittedDraftRevisionRef.current?.sessionId !== session.id) {
      submittedDraftRevisionRef.current = { sessionId: session.id, revision: draftRevisionRef.current };
    }
    setPendingLargePaste(null);
    // The echo can leave before admission settles (the canonical prompt lands
    // first); the stored text is still the recovery copy until it does.
    const inFlight = hasInFlightPrompt(getState(), session?.id ?? null) || sessionAdmitting(session?.id);
    const serverDraft = session?.draft;
    const localDraft = session?.id
      ? (serverDraft !== undefined || session.draftUpdatedAt !== undefined
        ? adoptServerDraft(session.id, serverDraft ?? "", session.draftUpdatedAt).text
        : loadDraft(session.id))
      : newSessionIntent?.draft ?? "";
    const t = visibleComposerDraft(localDraft, inFlight);
    setText(t);
    const restoredSelection = takeComposerSelection(sessionScopeKeyRef.current, t);
    // On a reload the project is active before its unsent chat is restored,
    // so the first mount has no intent and seeds "". Saving that would replace
    // the stored prompt before boot reads it back.
    restoringDraftRef.current = true;
    try {
      inputRef.current?.replaceText(t, inFlight ? undefined : restoredSelection ?? undefined, inFlight ? { silent: true } : undefined);
    } finally {
      restoringDraftRef.current = false;
    }
    promptHistoryNav.reset();
    setCfg(loadComposerConfig(session?.id ?? null));
    setAcToken(null);
    acTokenRef.current = null;
    fileSearchSeq.current++;
    setQueueEdit(null);
    setQueueEditStarting(false);
    setQueueEditSaving(false);
    setQueuedItems([]);
    setSteeringQueuedId(null);
  }, [session?.id, newSessionChat, flushComposerDraft]);

  // First-send creation remounts this composer (hero → timeline). The staged
  // recovery copy is still the submitted prompt; keep it out of the input so
  // the echo is the only visible copy. Layout timing beats the first paint.
  useLayoutEffect(() => {
    if (!inFlightPrompt) return;
    const live = inputRef.current?.getText() ?? committedTextRef.current;
    if (live === "") return;
    const pending = pendingSendsForSurface(getState(), session?.id ?? null);
    if (!pending.some((item) => item.text === live)) return;
    setText("");
    inputRef.current?.replaceText("", undefined, { silent: true });
  }, [inFlightPrompt, session?.id]);

  // A prompt rejected after its composer was remounted comes back here, but
  // only into this session's still-empty input.
  useEffect(() => {
    const take = (prompt: ReturnedPrompt) => {
      if (sessionIdRef.current !== prompt.sessionId || sessionScopeKeyRef.current !== prompt.scopeKey) return false;
      const input = inputRef.current;
      if (!input || input.getText() !== "") return false;
      setText(prompt.text);
      input.replaceText(prompt.text);
      return true;
    };
    returnedPromptListeners.add(take);
    return () => { returnedPromptListeners.delete(take); };
  }, []);

  // Settings / project change is not a session switch: restore the snapshot
  // into the textarea, then end browse. Never flush the live historical text.
  useEffect(() => {
    promptHistoryNavRef.current.cancelToDraft((draft) => {
      setText(draft.text);
      inputRef.current?.replaceText(draft.text, { anchor: draft.text.length }, { silent: true });
    });
  }, [uiPrefs.promptHistoryScope, uiPrefs.promptHistoryLimit, activeProjectId]);

  // Disengage after an outside click has reached its target. Collapsing on
  // pointer-down can move a timeline control before pointer-up and swallow the
  // activation on short phone viewports.
  useEffect(() => {
    if (!inputFocused) return;
    const onClick = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (rootRef.current?.contains(target)) return;
      // Sheets and popovers are portalled to <body>; an action inside one is
      // still composer interaction and must not collapse the surface behind it.
      if (target?.closest?.(".sheet-backdrop")) return;
      if (target?.closest?.(".ui-popover")) return;
      setInputFocused(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [inputFocused]);

  // Pane and session transitions must not depend on the debounce. Flush the
  // canonical draft synchronously on pagehide and unmount.
  const flushComposerDraftOnLifecycle = useCallback(() => {
    // A successful delete already flushed locally while this session was
    // active. Its layout/unmount cleanup must not server-sync the deleted row.
    if (sessionIdRef.current !== null && removalFlushRef.current === sessionIdRef.current) return;
    flushComposerDraft();
  }, [flushComposerDraft]);
  useEffect(() => {
    window.addEventListener("pagehide", flushComposerDraftOnLifecycle);
    return () => {
      window.removeEventListener("pagehide", flushComposerDraftOnLifecycle);
      flushComposerDraftOnLifecycle();
      const editing = queueEditRef.current;
      if (editing) void api.queueEditCancel(editing.sessionId, editing.id).catch(() => {});
    };
  }, [flushComposerDraftOnLifecycle]);
  // New chat <-> session swaps the hero and timeline composer instances, so the
  // switch effect never sees an outgoing session. Record the caret on unmount;
  // layout cleanup runs before the child input handle detaches.
  useLayoutEffect(() => () => {
    const input = inputRef.current;
    if (input) rememberComposerSelection(sessionScopeKeyRef.current, input.getText(), input.getSelection());
  }, []);

  // Debounced local persistence while typing (refresh-safe). Server sync runs
  // only after idle time, or immediately on session/page lifecycle changes.
  useEffect(() => {
    const id = session?.id;
    if (!id || queueEdit?.sessionId === id || creatingSession || sendPending || inFlightPrompt) return;
    if (promptHistoryNavRef.current.isBrowsing()) return;
    const scopeKey = scopedDraftCacheKey(id);
    const t = setTimeout(() => {
      if (scopedDraftCacheKey(id) !== scopeKey) return;
      if (loadDraft(id) !== text) {
        saveDraft(id, text);
        syncDraftToServer(id, text);
      }
      if (pendingLocalTextRef.current?.scopeKey === scopeKey
        && pendingLocalTextRef.current.text === text) pendingLocalTextRef.current = null;
    }, 250);
    return () => clearTimeout(t);
  }, [session?.id, text, queueEdit, activeProjectId, creatingSession, sendPending, inFlightPrompt]);

  // Apply server-side draft updates from other clients when the composer is
  // empty (user hasn't started typing). Active local edits always win — the
  // focus-loss flush ensures the server catches up.
  const lastServerDraftRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const serverDraft = session?.draft;
    if (!session?.id || (serverDraft === undefined && session.draftUpdatedAt === undefined)) return;
    // Canonical events can retire the optimistic echo before POST admission
    // settles. The staged recovery draft still belongs to that send, so a
    // projection must not replay it into the input or advance its revision.
    // The shared spawn also protects a freshly remounted first-send Composer.
    if (creatingSession || sendPending || inFlightPrompt) return;
    const fingerprint = `${session.id}\0${session.draftUpdatedAt ?? "legacy"}\0${serverDraft ?? ""}`;
    if (fingerprint === lastServerDraftRef.current) return;
    lastServerDraftRef.current = fingerprint;
    // The input has a committed edit that the 250ms local timer has not yet
    // written. Preserve it before reconciling a projection from the network.
    const pending = pendingLocalTextRef.current;
    if (pending?.scopeKey === scopedDraftCacheKey(session.id)) {
      if (loadDraft(session.id) !== pending.text) saveDraft(session.id, pending.text);
      pendingLocalTextRef.current = null;
    }
    const reconciled = adoptServerDraft(session.id, serverDraft ?? "", session.draftUpdatedAt);
    if (reconciled.conflict) return;
    if (reconciled.text !== text) {
      setText(reconciled.text);
      inputRef.current?.replaceText(reconciled.text);
    }
  }, [session?.draft, session?.draftUpdatedAt, session?.id, text, creatingSession, sendPending, inFlightPrompt]);

  // Drag-and-drop: tree paths and desktop files become attachment pills.
  const [dropHint, setDropHint] = useState<"path" | "files" | null>(null);

  // Pending attachment pills live in the per-session draft store.
  // History browsing overlays recalled refs locally; the canonical store is
  // untouched until a genuine edit or send.
  const pending = usePendingAttachments(session?.id ?? null);
  // Submitted attachments remain in the scoped draft until admission finishes
  // so a failed request can be recovered, but they are no longer composer UI.
  const attachments = creatingSession || sendPending || inFlightPrompt
    ? []
    : promptHistoryNav.displayedAttachments ?? pending;

  // ---- people talking in this session ---------------------------------------
  // Candidates are cached per session; a picker open renders the cached list
  // and refreshes it. A draft session has no session id, so it has no People
  // group and stays on the ordinary prompt path.
  const sessionIdForPeople = session?.id ?? null;
  const [mentionCandidates, setMentionCandidates] = useState(() =>
    sessionIdForPeople ? cachedMentionCandidates(sessionIdForPeople) : []);
  useEffect(() => {
    if (!sessionIdForPeople) {
      setMentionCandidates([]);
      return;
    }
    setMentionCandidates(cachedMentionCandidates(sessionIdForPeople));
    let live = true;
    void loadMentionCandidates(sessionIdForPeople, { refresh: true })
      .then((items) => { if (live) setMentionCandidates(items); })
      .catch(() => { /* keep the cached list; the picker never empties on a failed refresh */ });
    return () => { live = false; };
  }, [sessionIdForPeople]);

  // The picker shows each person in their colour in this chat.
  const mentionTones = useMemo(
    () => assignPersonTones([activeBrowserAccountId(), ...mentionCandidates.map((candidate) => candidate.userId)]),
    [mentionCandidates],
  );

  const [personMentions, setPersonMentions] = useState<ComposerPersonMention[]>([]);
  const personMentionsRef = useRef(personMentions);
  personMentionsRef.current = personMentions;
  const [agentMentionOverride, setAgentMentionOverride] = useState(false);
  const [carryToAgent, setCarryToAgent] = useState(false);
  const carryToAgentRef = useRef(carryToAgent);
  carryToAgentRef.current = carryToAgent;
  const [peopleSending, setPeopleSending] = useState(false);
  const peopleSendingRef = useRef(false);
  // A deleted mention token removes the person from the request.
  useEffect(() => {
    setPersonMentions((current) => {
      const next = livePersonMentions(text, current);
      if (next.length === current.length && next.every((item, index) => item.userId === current[index]?.userId)) {
        return current;
      }
      return next;
    });
  }, [text]);

  const selection = useConversationSelection(conversation ? session?.id ?? null : null);
  const selectingConversation = selection.sessionId !== null;
  const viewOnlyComposer = peopleOnly;
  const peopleMode = peopleModeActive({
    mentionCount: personMentions.length,
    agentOverride: agentMentionOverride,
    viewOnly: viewOnlyComposer,
  });
  const peopleModeRef = useRef(peopleMode);
  peopleModeRef.current = peopleMode;
  const carryControlVisible = !peopleOnly && personMentions.length > 0
    && showCarryToAgent(session, viewOnlyComposer);
  const peopleLabel = conversation ? conversationSendLabel(personMentions) : peopleSendLabel(personMentions);

  const addPersonMention = useCallback((mention: ComposerPersonMention) => {
    setPersonMentions((current) => current.some((item) => item.userId === mention.userId)
      ? current
      : [...current, mention]);
    setAgentMentionOverride(false);
    setCarryToAgent(false);
  }, []);

  const sendPeopleMessage = useCallback((override?: string) => {
    const target = sessionIdRef.current;
    const raw = (override ?? inputRef.current?.getText() ?? text).trim();
    if (!target || raw === "" || peopleSendingRef.current) return;
    const mentions = personMentionsRef.current.map((mention) => ({ userId: mention.userId, name: mention.name }));
    const carry = carryToAgentRef.current && !peopleOnly;
    const operationKey = [target, raw, mentions.map((mention) => mention.userId).join(","), carry ? "carry" : ""].join("\u0000");
    const clientOperationId = personMessageOperationId(operationKey);
    peopleSendingRef.current = true;
    setPeopleSending(true);
    const scopeKeyAtSend = scopedDraftCacheKey(target);
    const textAtSend = raw;
    void postPersonMessage(target, {
      text: raw,
      ...(mentions.length > 0 ? { mentions: mentions.map((mention) => mention.userId) } : {}),
      ...(carry ? { carryToAgent: true } : {}),
      clientOperationId,
    }).then(() => {
      forgetPersonMessageOperation(operationKey);
      if (getState().activeSessionId !== target || scopedDraftCacheKey(target) !== scopeKeyAtSend) return;
      if ((inputRef.current?.getText() ?? "") !== textAtSend) return;
      setText("");
      inputRef.current?.replaceText("");
      setPersonMentions([]);
      setAgentMentionOverride(false);
      setCarryToAgent(false);
      saveDraft(target, "");
      cancelDraftSync(target);
    }).catch((error) => {
      // Keep the draft (and the operation id) so retry is idempotent.
      setUiError(friendlyError(tr("composer.people.sendFailed"), error));
    }).finally(() => {
      peopleSendingRef.current = false;
      setPeopleSending(false);
    });
  }, [peopleOnly, text]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [pendingLargePaste, setPendingLargePaste] = useState<{
    text: string;
    projectId: string;
    sessionId: string | null;
  } | null>(null);
  useEffect(() => {
    if (!isNativeMobile() || !activeProjectId) return;
    const target = session?.id ?? null;
    void recoverNativeStagedUploads(activeProjectId, target, {
      read: readNativeStagedFile,
      remove: removeNativeStagedFile,
    }).then((results) => {
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) setUiError(failed.reason);
    });
  }, [activeProjectId, session?.id]);
  const attachFiles = useCallback((files: File[]) => {
    const projectId = getState().activeProjectId;
    if (!projectId || files.length === 0) return;
    const target = sessionIdRef.current;
    if (promptHistoryNavRef.current.isBrowsing()) promoteHistoryDraft();
    for (const f of files) {
      void attachUpload(projectId, target, f).then((r) => {
        if (!r.ok) {
          setUiError(tr("composer.couldNotAttachValue", {
            name: f.name || tr("composer.discovery.file"),
            reason: r.reason,
          }));
        }
      });
    }
  }, []);
  const attachPastedText = useCallback((pasted: string, projectId: string, sessionId: string | null) => {
    if (promptHistoryNavRef.current.isBrowsing()) promoteHistoryDraft();
    void attachText(projectId, sessionId, pasted).then((r) => {
      if (!r.ok) {
        setUiError(tr("composer.couldNotAttachValue", {
          name: PASTED_TEXT_NAME,
          reason: r.reason,
        }));
      }
    });
  }, []);
  const resolveLargePaste = (action: "attach" | "inline" | "always-attach") => {
    if (!pendingLargePaste) return;
    setPendingLargePaste(null);
    if (action === "inline") {
      inputRef.current?.insertText(pendingLargePaste.text);
      return;
    }
    if (action === "always-attach") setUiSettings({ largeTextPasteBehavior: "attach" });
    attachPastedText(pendingLargePaste.text, pendingLargePaste.projectId, pendingLargePaste.sessionId);
  };
  const openAttachmentPicker = useCallback((source: "files" | "photos" | "camera") => {
    // The camera is the platform's own capture sheet in every shell; its photo
    // arrives as an ordinary File like a paste.
    if (source === "camera") {
      cameraInputRef.current?.click();
      return;
    }
    if (!isNativeMobile()) {
      (source === "photos" ? photoInputRef : fileInputRef).current?.click();
      return;
    }
    const projectId = getState().activeProjectId;
    if (!projectId) return;
    const target = sessionIdRef.current;
    const pickerScope = scopedDraftCacheKey(target);
    void pickNativeFiles(source).then(async (result) => {
      if (result.status === "picked") {
        if (scopedDraftCacheKey(target) !== pickerScope) {
          await Promise.all(result.metadata.map((metadata) => removeNativeStagedFile(metadata)));
          setUiError(tr("composer.attachmentContextChanged"));
          return;
        }
        for (const metadata of result.metadata) {
          const attached = await attachNativeStagedUpload(projectId, target, metadata, {
            read: readNativeStagedFile,
            remove: removeNativeStagedFile,
          });
          if (!attached.ok) setUiError(tr("composer.couldNotAttachValue", {
            name: metadata.name,
            reason: attached.reason,
          }));
        }
      }
      else if (result.status === "denied" || result.status === "failed") setUiError(result.message);
      // Native cancellation is a normal no-op and keeps the draft untouched.
    });
  }, []);

  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const projectId = getState().activeProjectId;
    if (!projectId) return;
    promoteHistoryDraft();
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      attachFiles(files);
      return;
    }
    const pasted = e.clipboardData?.getData("text/plain") ?? "";
    if (isLargeTextPaste(pasted)) {
      const behavior = getUiSettings().largeTextPasteBehavior;
      if (behavior === "inline") return; // allow default paste
      e.preventDefault();
      const target = sessionIdRef.current;
      if (behavior === "attach") {
        attachPastedText(pasted, projectId, target);
        return;
      }
      setPendingLargePaste({
        text: pasted,
        projectId,
        sessionId: target,
      });
      return;
    }
    const pasteHandler = listComposerPasteHandlers().find((handler) => {
      try { return handler.match(pasted); } catch { return false; }
    });
    if (!pasteHandler) return;
    e.preventDefault();
    void pasteHandler.handle(buildContributionContext(pasteHandler.id), pasted)
      .then((consumed) => { if (!consumed) inputRef.current?.insertText(pasted); })
      .catch(() => { inputRef.current?.insertText(pasted); });
  }, [attachFiles, attachPastedText, buildContributionContext]);

  // ---- capability catalogs --------------------------------------------------
  // Strict independent command/snippet outcomes; an HTTP failure is
  // `unavailable`, never a successful empty list.
  const globalDefaultModel = sessionDefaults.defaultModel ?? parseModelRef(settings.defaultModel);
  // Nobody chose the catalogue fallback, so it must be one this account still
  // shows: the picker keeps a recommended model listed even when hidden, and a
  // hidden first entry would otherwise surface there and be sent with.
  // It prefers a favorite, then a recently used model, then the first shown.
  const { hiddenProviders, hiddenModels, shownModels, favorites, recents } = modelPrefs;
  const isHiddenModel = useMemo(
    () => hiddenModelMatcher({ hiddenProviders, hiddenModels, shownModels }),
    [hiddenProviders, hiddenModels, shownModels],
  );
  const fallbackModel = useMemo(() => visibleFallbackModel(
    chatModels,
    isHiddenModel,
    catalogHarnessId,
    [...favorites, ...recents],
  ), [chatModels, isHiddenModel, catalogHarnessId, favorites, recents]);
  // The model last chosen in this harness's chat picker, while it still runs here.
  const lastHarnessModels = useLastHarnessModels();
  const rememberedHarnessModel = catalogHarnessId ? lastHarnessModels[catalogHarnessId] : undefined;
  const lastChosenModel = useMemo(
    () => lastChosenHarnessModel(chatModels, isHiddenModel, catalogHarnessId, rememberedHarnessModel),
    [chatModels, isHiddenModel, catalogHarnessId, rememberedHarnessModel],
  );
  const resolvedDefaultModel = resolveProjectModelDefault(
    activeProject?.defaults,
    globalDefaultModel,
    fallbackModel,
  );
  // After a harness switch, the model last chosen there (when it has one);
  // `routeModel` is the one this route's catalogue lists, so what the chip
  // shows and a send commits.
  const { preferred: preferredModel, route: routeModel } = routeDefaultModel({
    models: chatModels,
    switched: routeSwitched,
    ...(lastChosenModel ? { lastChosen: lastChosenModel } : {}),
    ...(resolvedDefaultModel ? { resolvedDefault: resolvedDefaultModel } : {}),
    ...(fallbackModel ? { fallback: fallbackModel } : {}),
  });
  const [catalog, setCatalog] = useState<ComposerCatalogResult | null>(null);
  const catalogSeq = useRef(0);
  const runtimeFeatures = useStore((s) => session?.id ? s.runtimeFeatures[session.id] : undefined);
  const nativeCommandsRevision = session?.nativeCommandsRevision ?? 0;
  const selectedCommandRef = useRef<ComposerCommand | undefined>(undefined);

  useEffect(() => {
    const seq = ++catalogSeq.current;
    setCatalog(null);
    if (!activeProjectId) return;
    void loadComposerCatalog(activeProjectId).then((r) => {
      if (seq === catalogSeq.current) setCatalog(r);
    });
  }, [activeProjectId]);

  useEffect(() => {
    selectedCommandRef.current = undefined;
  }, [session?.id, session?.resolvedHarnessId, nativeCommandsRevision]);

  const polythCommandCatalog: CatalogState<SlashCommand> = !activeProjectId
    ? { state: "unavailable", reason: OPEN_PROJECT_FIRST }
    : catalogFromResult(catalog?.commands ?? null);
  const nativeCommands = runtimeFeatures?.commands ?? [];
  const commandCatalog: CatalogState<ComposerCommand> = (() => {
    if (polythCommandCatalog.state === "available") {
      return { state: "available", items: mergeCommandCatalog(polythCommandCatalog.items, nativeCommands) };
    }
    if (nativeCommands.length > 0) {
      return { state: "available", items: mergeCommandCatalog([], nativeCommands) };
    }
    return polythCommandCatalog;
  })();
  const snippetCatalog: CatalogState<SnippetDef> = !activeProjectId
    ? { state: "unavailable", reason: OPEN_PROJECT_FIRST }
    : catalogFromResult(catalog?.snippets ?? null);

  // ---- token autocomplete -----------------------------------------------------
  // The active token is state so catalog transitions (loading → available)
  // re-derive the popup; Escape closes the popup but keeps the token text.
  const [acToken, setAcToken] = useState<PromptToken | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const acTokenRef = useRef<PromptToken | null>(null);
  const fileSearchSeq = useRef(0);
  const [fileSearch, setFileSearch] = useState<{ query: string; phase: "pending" | "done"; hits: Array<{ path: string; kind: "file" | "dir" }> }>(
    { query: "", phase: "done", hits: [] },
  );

  // One-time favorites → profiles migration once models are known.
  useEffect(() => {
    if (models.length > 0) void migrateFavoritesOnce(models);
  }, [models]);

  // Re-grow the input (below, beside the composer morph) when the visible band
  // changes (keyboard, toolbar, rotation): its cap depends on it. Reactive —
  // reading getViewportMetrics() during render never re-fires on change.
  const bandHeight = useViewportMetrics().height;

  // Composer inserts (Files @, drag-drop, starter chips). preventDefault marks
  // the event consumed; anything queued while unmounted drains now. Inserts go
  // through the command handle so an active composition is never interrupted.
  useEffect(() => {
    const replaceText = (detail: string) => {
      draftRevisionRef.current += 1;
      const visible = sessionIdRef.current === null ? stripRecoveryContextBlocks(detail) : detail;
      setText(visible);
      inputRef.current?.replaceText(visible);
    };
    const insert = (detail: string) => {
      const h = inputRef.current;
      if (!h) return;
      draftRevisionRef.current += 1;
      const visible = sessionIdRef.current === null ? stripRecoveryContextBlocks(detail) : detail;
      const cur = h.getText();
      h.replaceText(cur ? `${cur} ${visible}` : visible);
    };
    // Live dictation writes straight into the draft so spoken words are visible
    // as they land. The transcript is cumulative, so each update rewrites the
    // run's span rather than appending; the caret follows the words.
    const dictate = (update: ComposerDictationUpdate) => {
      const h = inputRef.current;
      if (!h) return;
      // An IME composition owns the text; a deferred replace would apply a
      // stale transcript later. Skip it — the next cumulative update catches up.
      if (h.isComposing() && !update.final) return;
      const run = transcriptSpanRef.current?.runId === update.runId
        ? transcriptSpanRef.current
        : beginTranscriptSpan(update.runId, h.getText());
      transcriptSpanRef.current = update.final ? null : run;
      // An empty update says nothing: a provider reconnect resetting its
      // transcript must not blank the draft, and an empty final (a failed
      // transport) leaves the words already heard in place. Only an explicit
      // discard (a spoken command) takes the run's words back out.
      if (!update.text && !update.discard) return;
      const next = applyTranscriptSpan(run, h.getText(), update.discard ? "" : update.text);
      draftRevisionRef.current += 1;
      // The caret lands at the end of the draft; setSelectionRange does not
      // scroll an unfocused textarea, so follow it explicitly — now and again
      // after the resize effect re-measures the height.
      followDictationRef.current = true;
      h.replaceText(next, { anchor: next.length });
      const el = h.element();
      if (el) el.scrollTop = el.scrollHeight;
    };
    const queuedReplacement = drainComposerReplacement();
    if (queuedReplacement !== undefined) replaceText(queuedReplacement);
    for (const queued of drainInserts()) insert(queued);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      e.preventDefault();
      insert(detail);
    };
    const replace = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      e.preventDefault();
      replaceText(detail);
    };
    const dictation = (e: Event) => {
      const detail = (e as CustomEvent).detail as Partial<ComposerDictationUpdate> | undefined;
      if (typeof detail?.runId !== "string" || typeof detail.text !== "string") return;
      e.preventDefault();
      dictate({
        runId: detail.runId,
        text: detail.text,
        final: detail.final === true,
        ...(detail.discard === true ? { discard: true } : {}),
      });
    };
    const compareReplace = (e: Event) => {
      const detail = (e as CustomEvent).detail as Partial<ComposerCompareReplace> | undefined;
      const input = inputRef.current;
      if (!input || input.isComposing() || sendPendingRef.current) return;
      if (typeof detail?.text !== "string" || typeof detail.expectedText !== "string") return;
      if (detail.scopeKey !== scopedDraftCacheKey(sessionIdRef.current)
        || input.getText() !== detail.expectedText) return;
      e.preventDefault();
      replaceText(detail.text);
    };
    window.addEventListener(COMPOSER_INSERT, handler);
    window.addEventListener(COMPOSER_REPLACE, replace);
    window.addEventListener(COMPOSER_COMPARE_REPLACE, compareReplace);
    // A hands-free voice turn sends the draft exactly like the Send control.
    // The first mounted composer takes it; a composition in progress refuses.
    const submit = (e: Event) => {
      const input = inputRef.current;
      if (e.defaultPrevented || !input || !sendRef.current || input.isComposing()) return;
      e.preventDefault();
      const delivery = ((e as CustomEvent).detail as ComposerSubmitRequest | undefined)?.delivery;
      sendRef.current(undefined, delivery === "queue" || delivery === "steer" || delivery === "interrupt" ? delivery : undefined);
    };
    window.addEventListener(COMPOSER_DICTATION, dictation);
    window.addEventListener(COMPOSER_SUBMIT, submit);
    return () => {
      window.removeEventListener(COMPOSER_SUBMIT, submit);
      window.removeEventListener(COMPOSER_INSERT, handler);
      window.removeEventListener(COMPOSER_REPLACE, replace);
      window.removeEventListener(COMPOSER_COMPARE_REPLACE, compareReplace);
      window.removeEventListener(COMPOSER_DICTATION, dictation);
    };
  }, []);

  // A selected profile that was deleted after selection blocks Send with a
  // visible state; it is never silently substituted.
  const explicitProfileId = cfg.profile.kind === "id" ? cfg.profile.id : (!session ? draftExecution.profileId : undefined);
  const profileMissing = profilesLoaded()
    && !!explicitProfileId
    && !profiles.some((p) => p.id === explicitProfileId);

  const beginQueuedEdit = useCallback((item: QueueItemDto) => {
    if (queueEditRef.current || queueEditStarting) {
      announce(tr("composer.finishEditingCurrentQueuedMessageFirst"));
      return;
    }
    const target = sessionIdRef.current;
    if (!target || target !== item.sessionId) return;
    const targetScope = scopedDraftCacheKey(target);
    setQueueEditStarting(true);
    void api.queueEditStart(target, item.id)
      .then((reserved) => {
        if (sessionIdRef.current !== target || scopedDraftCacheKey(target) !== targetScope) {
          void api.queueEditCancel(target, reserved.id);
          return;
        }
        const draftBefore = inputRef.current?.getText() ?? committedTextRef.current;
        // The queue text is an editing buffer, not this session's normal draft.
        // Save any existing composer text before replacing it so it can return
        // immediately after this queued message is updated.
        saveDraft(target, draftBefore);
        setQueueEdit({ id: reserved.id, sessionId: target, draftBefore });
        setText(reserved.text);
        inputRef.current?.replaceText(reserved.text);
        inputRef.current?.focus();
        setInputFocused(true);
        announce(tr("composer.editingQueuedMessageValueInComposer", { position: reserved.position + 1 }));
      })
      .catch((error) => setUiError(friendlyError("Couldn’t start editing queued message", error)))
      .finally(() => setQueueEditStarting(false));
  }, [queueEditStarting]);

  const cancelQueuedEdit = useCallback((): boolean => {
    const editing = queueEditRef.current;
    if (!editing) return false;
    setQueueEdit(null);
    setText(editing.draftBefore);
    inputRef.current?.replaceText(editing.draftBefore);
    saveDraft(editing.sessionId, editing.draftBefore);
    void api.queueEditCancel(editing.sessionId, editing.id).catch(() => {});
    announce(tr("composer.queuedMessageEditingCancelled"));
    return true;
  }, []);

  const updateQueuedItems = useCallback((sourceSessionId: string, items: QueueItemDto[]) => {
    if (sessionIdRef.current === sourceSessionId) setQueuedItems(items);
  }, []);

  const steerQueuedItem = useCallback(async (item: QueueItemDto) => {
    const target = item.sessionId;
    if (sessionIdRef.current !== target || steeringQueuedBySessionRef.current.has(target)) return;
    steeringQueuedBySessionRef.current.set(target, item.id);
    setSteeringQueuedId(item.id);
    const cfgSent = cfg;
    const selectedProfileId = cfgSent.profile.kind === "id"
      ? cfgSent.profile.id
      : cfgSent.profile.kind === "inherit"
        ? session?.agentProfileId ?? draftExecution.profileId
        : undefined;
    const selectedProfile = selectedProfileId
      ? profiles.find((profile) => profile.id === selectedProfileId)
      : undefined;
    const selected = nextTurnModelRef({
      ...(cfgSent.model ? { configModel: cfgSent.model } : {}),
      stagedHarness: Boolean(cfgSent.harness),
      movingTransition: Boolean(routeMovingTransition(session?.harnessTransition, session?.resolvedHarnessId)),
      ...(session?.model ? { sessionModel: session.model } : {}),
      ...(selectedProfile ? { profileModel: { providerID: selectedProfile.providerID, modelID: selectedProfile.modelID } } : {}),
      ...(preferredModel ? { preferred: preferredModel } : {}),
    });
    const descriptor = selected && chatModels.find((candidate) => modelIdentityMatches(candidate, selected));
    const recordedThinking = recordedSessionThinking(selected, session?.model, session?.resolvedHarnessId);
    const thinking = resolveComposerThinking({
      ...(descriptor ? { descriptor } : {}),
      configThinking: cfgSent.thinking !== undefined ? cfgSent.thinking : selectedProfile?.thinking,
      recordedThinking,
      savedThinking: getModelThinking(descriptor ?? selected),
      ...(sessionDefaults.defaultThinking ? { sessionDefault: sessionDefaults.defaultThinking } : {}),
    }).variant;
    const selectedModel = selected && descriptor
      ? { providerID: selected.providerID, modelID: selected.modelID, ...(thinking ? { variant: thinking } : {}) }
      : undefined;
    const profile = cfgSent.profile.kind === "none"
      ? null
      : selectedProfile
        ? selectedProfile.id
        : undefined;
    const delivery = immediateFollowUpDelivery({
      requested: "steer",
      steering: runtimeFeatures?.capabilities.steering === true,
      executionChanged: executionSelectionChanged(session, {
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(cfgSent.agent ? { agent: cfgSent.agent } : {}),
        ...(cfgSent.harness ? { harness: cfgSent.harness } : {}),
      }),
      hasAttachments: Boolean(item.attachments?.length),
      hasCommand: Boolean(item.command),
    });
    setQueuedItems((items) => items.filter((candidate) => candidate.id !== item.id));
    const echoId = beginPendingSend({
      sessionId: target,
      text: item.text,
      attachments: item.attachments ?? [],
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(cfgSent.harness ? { harness: cfgSent.harness } : {}),
      delivery,
    });
    let reserved = false;
    let promoted = false;
    try {
      // Reserve before promotion so turn completion cannot dispatch the same
      // queue row while this request is sending it.
      const current = await api.queueEditStart(target, item.id);
      reserved = true;
      const ok = await sendMessage(current.text, selectedModel, cfgSent.agent, {
        targetSessionId: target,
        delivery,
        ...(cfgSent.harness ? { harness: cfgSent.harness } : {}),
        ...(current.attachments?.length ? { attachments: current.attachments } : {}),
        dismissPending: true,
        ...(profile !== undefined ? { agentProfileId: profile } : {}),
      });
      if (!ok) {
        endPendingSend(echoId);
        if (sessionIdRef.current === target) {
          setQueuedItems((items) => items.some((candidate) => candidate.id === item.id)
            ? items
            : [...items, item]);
        }
        return;
      }
      promoted = true;
      consumeComposerConfig(target, cfgSent);
      if (sessionIdRef.current === target) setCfg(loadComposerConfig(target));
      await api.queueRemove(target, current.id).catch(() => {});
    } catch (error) {
      if (promoted) return;
      const code = errorCodeOf(error);
      endPendingSend(echoId);
      if (code === "not-found" || (reserved && code === "conflict")) {
        setQueuedItems((items) => items.filter((candidate) => candidate.id !== item.id));
      } else if (code !== "conflict") {
        setUiError(friendlyError(tr("common.error"), error));
        if (sessionIdRef.current === target) {
          setQueuedItems((items) => items.some((candidate) => candidate.id === item.id)
            ? items
            : [...items, item]);
        }
      }
    } finally {
      // Also restarts queue dispatch if the turn ended while the row was held.
      if (reserved) await api.queueEditCancel(target, item.id).catch(() => {});
      if (steeringQueuedBySessionRef.current.get(target) === item.id) {
        steeringQueuedBySessionRef.current.delete(target);
      }
      setSteeringQueuedId((current) => current === item.id ? null : current);
    }
  }, [
    cfg, session, preferredModel, chatModels, sessionDefaults.defaultThinking,
    profiles, draftExecution.profileId, runtimeFeatures?.capabilities.steering,
  ]);

  const followUp = getUiSettings().followUpBehavior;
  const emptySteerItem = working
    && followUp === "queue"
    && !queueEdit
    && !text.trim()
    && attachments.length === 0
    ? latestSteerableQueuedItem(queuedItems)
    : null;

  const retryModelConnection = useCallback(() => {
    recheckRuntimeCatalog();
    retryUnavailableRuntimeCatalogs();
    reconnectSync();
  }, []);

  // Latest send callback for recovery actions (a transport failure during
  // first-send creation must be retryable without capturing a stale closure).
  const sendRef = useRef<((override?: string, deliveryOverride?: "steer" | "queue" | "interrupt", hiddenUserMessage?: boolean, parkAsDraft?: boolean) => void) | null>(null);

  const send = useCallback((
    override?: string,
    deliveryOverride?: "steer" | "queue" | "interrupt",
    hiddenUserMessage = false,
    // Send held: keep the message as a draft chat in the navigator instead.
    parkAsDraft = false,
  ) => {
    // A composer mode takes the draft instead of the session: never queued,
    // steered, parked or blocked by the running turn.
    if (activeModeRef.current && !queueEdit) {
      if (!parkAsDraft) submitMode(override);
      return;
    }
    // People mode never queues behind or steers the agent turn: it records a
    // person message and stops there, even while the agent is working.
    if (peopleModeRef.current && !queueEdit && sessionIdRef.current) {
      sendPeopleMessage((override ?? inputRef.current?.getText() ?? "").trim());
      return;
    }
    if (creatingSession || sendPending || compactPending) return;
    if (!parkAsDraft && session?.status === "epoch-pending" && session.runtimeControl === "borrowed") return;
    const t = (override ?? inputRef.current?.getText() ?? text).trim();
    const target = sessionIdRef.current;
    if (parkAsDraft && queueEdit) return;
    if (parkAsDraft && target) {
      // An open chat already owns its composer text as its draft: save it to
      // the server now, so every client's navigator marks the chat at once.
      saveDraft(target, inputRef.current?.getText() ?? text);
      void saveDraftToServerNow(target).then((saved) => {
        if (!saved) setUiError(tr("composer.couldNotSaveDraft"));
      });
      return;
    }
    if (queueEdit) {
      if (!target || target !== queueEdit.sessionId || !t || queueEditSaving) return;
      const editing = queueEdit;
      const targetScope = scopedDraftCacheKey(target);
      setQueueEditSaving(true);
      const echoId = deliveryOverride === "interrupt"
        ? beginPendingSend({
          sessionId: target,
          text: t,
          attachments: [],
          ...(session?.model ? { model: session.model } : {}),
          delivery: "interrupt",
        })
        : null;
      if (echoId) {
        setQueueEdit(null);
        setText(editing.draftBefore);
        inputRef.current?.replaceText(editing.draftBefore);
        saveDraft(target, editing.draftBefore);
        promptHistoryNav.reset();
      }
      const save = deliveryOverride === "interrupt"
        ? api.queueSendNow(target, editing.id, t)
        : api.queueEdit(target, editing.id, t);
      void save
        .then(() => {
          // The server updates the existing queue row, so it retains its
          // position and delivery metadata instead of becoming a new message.
          if (echoId) return;
          if (queueEditRef.current?.id === editing.id) setQueueEdit(null);
          if (sessionIdRef.current !== target || scopedDraftCacheKey(target) !== targetScope) return;
          setText(editing.draftBefore);
          inputRef.current?.replaceText(editing.draftBefore);
          saveDraft(target, editing.draftBefore);
          promptHistoryNav.reset();
          announce(tr("composer.queuedMessageValueUpdatedInPlace", { id: editing.id }));
        })
        .catch((error) => {
          if (echoId) endPendingSend(echoId);
          setUiError(friendlyError("Couldn’t update queued message", error));
        })
        .finally(() => setQueueEditSaving(false));
      return;
    }
    // A parked draft is text, never a shell command or a host action.
    const command = !parkAsDraft && guardedShellAllowed(getGuardrails()) ? shellCommand(t) : null;
    const hasPills = command === null && attachments.length > 0;
    if (!t && !hasPills) {
      if (emptySteerItem) void steerQueuedItem(emptySteerItem);
      return;
    }
    if (command === "") return;
    const selectedNativeCommand = command === null && commandCatalog.state === "available"
      ? nativeCommandInput(t, commandCatalog.items, selectedCommandRef.current)
      : undefined;
    const hostOnlyExtensionCommand = isHostOnlyExtensionCommand(selectedNativeCommand)
      && attachments.length === 0;
    // `/compact` is a host action: it runs the runtime's native compaction (the
    // durable `session/compacted` block) instead of spending a model turn that
    // echoed the command and answered in prose. It never creates a session.
    if (!parkAsDraft && command === null && commandCatalog.state === "available"
      && isCompactCommand(t, commandCatalog.items, selectedCommandRef.current)) {
      if (!startCompact(target)) return;
      // The command produced no user turn; clear the composer it was typed in.
      setText("");
      inputRef.current?.replaceText("");
      selectedCommandRef.current = undefined;
      promptHistoryNav.reset();
      return;
    }
    if (command === null && modelAbsenceBlocksSend && !hostOnlyExtensionCommand && !parkAsDraft) {
      // Never a silent no-op: pressing Enter while the model catalog is empty
      // (backend still starting / restarting) surfaces the same guidance as
      // the composer banner instead of appearing to swallow the message. A
      // transient route-change load is not an absence, so Send and Enter agree.
      setUiError(
        // The engine's own reason beats a guess about the backend.
        modelAbsenceReason
          ?? runtimeUnavailable?.message
          ?? tr("composer.noModelsAvailableCheckThatTheBackend"),
      );
      return;
    }
    if (command === null && profileMissing && !hostOnlyExtensionCommand && !parkAsDraft) return;
    // Capture the target session at send time — project/session switches must
    // never reroute a send (delivery admission handles active turns server-side).
    // Keep text/pills in the scoped draft until admission is authoritative.
    // This costs one brief pending state and survives response loss/process kill
    // without inventing a second client mutation ledger.
    const recalled = promptHistoryNav.takeDisplayedForSend();
    const atts = command === null ? (recalled ?? pendingAttachments(target)) : [];
    const nativeStagedAtSend = command === null
      ? loadScopedDraftRecord(target).nativeStaged ?? []
      : [];
    const draftRevisionAtSend = draftRevisionRef.current;
    // Revert is only a visual/history marker while the current turn runs.
    // Submitting its edited prompt is the commit point: interrupt the stale
    // runtime leg so the server can branch from the rewound prefix before it
    // admits this replacement.
    const requestedDelivery = working
      ? rewindActive ? "interrupt" : deliveryOverride ?? getUiSettings().followUpBehavior
      : undefined;
    const cfgSent = cfg;
    const selectedProfileId = cfgSent.profile.kind === "id"
      ? cfgSent.profile.id
      : cfgSent.profile.kind === "inherit"
        ? session?.agentProfileId ?? draftExecution.profileId
        : undefined;
    const selectedProfile = selectedProfileId
      ? profiles.find((profile) => profile.id === selectedProfileId)
      : undefined;
    const wire = cfgSent.profile.kind === "none"
      ? null
      : selectedProfile
        ? selectedProfile.id
        : undefined;
    const selected = nextTurnModelRef({
      ...(cfgSent.model ? { configModel: cfgSent.model } : {}),
      stagedHarness: Boolean(cfgSent.harness),
      movingTransition: Boolean(routeMovingTransition(session?.harnessTransition, session?.resolvedHarnessId)),
      ...(session?.model ? { sessionModel: session.model } : {}),
      ...(selectedProfile ? { profileModel: { providerID: selectedProfile.providerID, modelID: selectedProfile.modelID } } : {}),
      ...(preferredModel ? { preferred: preferredModel } : {}),
    });
    // Only a model this route's catalogue can actually route may be committed:
    // a route change replaces the qualified catalogue, so the previous
    // harness's selection is dropped instead of sent.
    const selectedDescriptor = sendableRouteModel(chatModels, selected);
    const recordedThinking = recordedSessionThinking(selected, session?.model, session?.resolvedHarnessId);
    const sentThinking = resolveComposerThinking({
      ...(selectedDescriptor ? { descriptor: selectedDescriptor } : {}),
      configThinking: cfgSent.thinking !== undefined ? cfgSent.thinking : selectedProfile?.thinking,
      recordedThinking,
      savedThinking: getModelThinking(selectedDescriptor ?? selected),
      ...(sessionDefaults.defaultThinking ? { sessionDefault: sessionDefaults.defaultThinking } : {}),
    }).variant;
    // A new chat following the person default sends no model, harness or
    // agent; the server picks the default harness and its own model.
    const followsPersonDefault = target ? undefined : newChatPersonHarness;
    const sentModel = !followsPersonDefault && selected && selectedDescriptor
      ? {
          providerID: selected.providerID,
          modelID: selected.modelID,
          ...(sentThinking ? { variant: sentThinking } : {}),
        }
      : undefined;
    const modelHarnessId = selectedDescriptor?.harnessId ?? draftRoute.draft.model?.harnessId;
    const creationHarness = followsPersonDefault
      ? undefined
      : selectedProfile
      ? { mode: "pinned" as const, harnessId: selectedProfile.harnessId ?? "opencode" }
      : modelHarnessId
        ? { mode: "pinned" as const, harnessId: modelHarnessId }
        : cfgSent.harness
          ? cfgSent.harness
          : draftRoute.draft.harnessSelectionExplicit
            ? draftRoute.draft.harnessSelection
            // A dropped hidden route runs where the composer showed it would.
            : draftRoute.projectHarness ?? (draftRoute.hidden && catalogHarnessId
              ? { mode: "pinned" as const, harnessId: catalogHarnessId }
              : undefined);
    // New-session creation already commits its harness before the first turn.
    // Only an existing session needs the staged submit-time route.
    const submittedHarness = target ? cfgSent.harness : undefined;
    const delivery = requestedDelivery === "steer"
      ? immediateFollowUpDelivery({
          requested: "steer",
          steering: runtimeFeatures?.capabilities.steering === true,
          executionChanged: executionSelectionChanged(session, {
            ...(sentModel ? { model: sentModel } : {}),
            ...(cfgSent.agent ? { agent: cfgSent.agent } : {}),
            ...(submittedHarness ? { harness: submittedHarness } : {}),
          }),
          hasAttachments: atts.length > 0,
          hasCommand: Boolean(selectedNativeCommand),
        })
      : requestedDelivery;
    type StagedDraft = { revision: number; scopeKey: string; scope: PersistenceScope };
    const lanePurpose = activeLanePurpose();
    const laneDraftId = newSessionLaneDraftId(lanePurpose);
    const reliabilityScopeAtSend = clientPersistenceScope({
      ...(activeProjectId ? { projectId: activeProjectId } : {}),
      ...(laneDraftId ? { sessionId: laneDraftId } : {}),
    });
    const stageTargetDraft = (targetSessionId: string, capturedScope: PersistenceScope): StagedDraft => {
      cancelDraftSync(targetSessionId, capturedScope);
      const scopeKey = scopedDraftCacheKey(targetSessionId, capturedScope);
      const staged = updateScopedDraftRecord(targetSessionId, {
        text: t,
        dirty: true,
        attachments: atts,
        nativeStaged: nativeStagedAtSend,
        conflict: undefined,
      }, capturedScope);
      return { revision: staged.revision, scopeKey, scope: capturedScope };
    };
    // Instant echo (UX): the prompt leaves the composer and appears at the tail
    // on the submit frame, not when admission returns. Presentation only — the
    // canonical `user/message` still establishes the fact and replaces this row
    // the moment it lands. A queued prompt is excluded because it belongs to
    // the queue list, and a shell command produces no user turn at all.
    const echoId = command === null && delivery !== "queue" && !hiddenUserMessage && !parkAsDraft
      ? beginPendingSend({
        sessionId: target,
        text: t,
        attachments: atts,
        ...(sentModel ? { model: sentModel } : {}),
        ...(cfgSent.harness ? { harness: cfgSent.harness } : {}),
        ...(delivery === "steer" || delivery === "interrupt" ? { delivery } : {}),
      })
      : null;
    // Emptying the input is itself a draft revision; anything typed after this
    // mark is a newer draft that a rejected send must not overwrite.
    let revisionAfterSubmit = draftRevisionAtSend;
    const clearComposerNow = () => {
      setText("");
      inputRef.current?.replaceText("");
      forgetComposerSelection(scopedDraftCacheKey(target));
      revisionAfterSubmit = draftRevisionRef.current;
      if (echoId) submittedDraftRevisionRef.current = { sessionId: target, revision: revisionAfterSubmit };
    };
    // A rejected prompt has no canonical row coming. Drop the echo and hand the
    // exact text back to the composer it was taken from — but never over a
    // newer draft, another session, or a changed reliability scope.
    const rejectEcho = (targetSessionId: string, stagedDraft?: StagedDraft) => {
      if (!echoId) return;
      endPendingSend(echoId);
      const sentDraft = stagedDraft ?? stagedRevisions.get(targetSessionId);
      if (!sentDraft || scopedDraftCacheKey(targetSessionId) !== sentDraft.scopeKey) return;
      if (getState().activeSessionId !== targetSessionId) return;
      // The first send remounts the composer; its successor takes the text.
      if (!inputRef.current) {
        returnRejectedPrompt({ sessionId: targetSessionId, scopeKey: sentDraft.scopeKey, text: t });
        return;
      }
      if (draftRevisionRef.current !== revisionAfterSubmit) return;
      if (inputRef.current.getText() !== "") return;
      setText(t);
      inputRef.current.replaceText(t);
    };
    const deliver = (targetSessionId: string, stagedDraft?: StagedDraft, deleteIfFailedToStart = false) => {
      const deliveryScope = stagedDraft?.scope
        ?? stagedRevisions.get(targetSessionId)?.scope
        ?? { ...reliabilityScopeAtSend, sessionId: targetSessionId };
      if (command !== null) return Promise.resolve().then(() => {
        if (scopedDraftCacheKey(targetSessionId) !== scopedDraftCacheKey(targetSessionId, deliveryScope)) {
          throw Object.assign(new Error("client context changed before command admission"), {
            code: "client-context-changed",
            status: 409,
          });
        }
        return api.runShell(targetSessionId, command);
      }).then(() => {
          promptHistoryNav.reload();
        }).catch(
          (err) => setUiError(tr("composer.couldNotRunShellCommand", {
            reason: err instanceof Error ? err.message : String(err),
          })),
        );
      return sendMessage(
          t,
          sentModel,
          cfgSent.agent,
          {
            targetSessionId,
            ...(submittedHarness ? { harness: submittedHarness } : {}),
            ...(selectedNativeCommand ? { command: selectedNativeCommand } : {}),
            ...(atts.length > 0 ? { attachments: atts } : {}),
            ...(delivery ? { delivery } : {}),
            ...(hiddenUserMessage ? { hiddenUserMessage: true } : {}),
            dismissPending: true,
            ...(wire !== undefined ? { agentProfileId: wire } : {}),
            reliabilityScope: deliveryScope,
            ...(deleteIfFailedToStart ? { deleteIfFailedToStart: true } : {}),
          },
        ).then((ok) => {
          if (!ok) {
            rejectEcho(targetSessionId, stagedDraft);
            return;
          }
          const sentDraft = stagedDraft ?? stagedRevisions.get(targetSessionId);
          if (!sentDraft) return;
          const sentRecord = loadScopedDraftRecord(targetSessionId, sentDraft.scope);
          // A projection can bump the revision without changing the text; the
          // record still holds only the sent prompt then, so it is consumed too.
          if (sentRecord.revision === sentDraft.revision || sentRecord.text === t) {
            updateScopedDraftRecord(targetSessionId, {
              text: "",
              dirty: true,
              attachments: [],
              conflict: undefined,
            }, sentDraft.scope);
            syncDraftToServer(targetSessionId, "", sentDraft.scope);
          }
          const stillCurrent = scopedDraftCacheKey(targetSessionId) === sentDraft.scopeKey;
          if (stillCurrent && getState().activeSessionId === targetSessionId
            && draftRevisionRef.current === revisionAfterSubmit) {
            setText("");
            inputRef.current?.replaceText("");
          }
          if (stillCurrent) {
            const currentAttachments = pendingAttachments(targetSessionId);
            if (currentAttachments.length === atts.length
              && currentAttachments.every((attachment, index) => attachment.id === atts[index]?.id)) {
              clearAttachments(targetSessionId);
            }
          }
          promptHistoryNav.reload();
          // The server recorded the sent configuration in the projection and
          // durable log; drop the local pending record only when it still
          // equals what was sent, then reflect the authoritative state.
          consumeComposerConfig(target, cfgSent);
          if (sessionIdRef.current === target) setCfg(loadComposerConfig(target));
        });
    };
    // After Send the new chat is its own unit of work: navigating to another
    // chat or project never aborts it. Only a changed connection, account or
    // Space stops it — the captured drafts and recovery intents no longer
    // belong to the current identity.
    const assertScopeStillCurrent = () => {
      if (!persistenceScopeIsCurrent(reliabilityScopeAtSend)) {
        throw Object.assign(new Error("client context changed during session creation"), {
          code: "client-context-changed",
          status: 409,
        });
      }
    };
    // One creation path for a sent and a parked new chat: the same route,
    // workspace target and lane, so a draft later sends as it would have now.
    const createNewChat = async (projectId: string, activate: (id: string) => boolean): Promise<string> => {
      if (newSessionTarget.kind === "isolation") {
        if (newSessionTarget.checkout) {
          await api.createWorktree(
            projectId,
            newSessionTarget.checkout.branch,
            undefined,
            newSessionTarget.checkout.base,
          );
          assertScopeStillCurrent();
        }
        return startIsolatedSession(projectId, {
          harness: creationHarness,
          ...(newSessionRepositoryIds ? { repositoryIds: newSessionRepositoryIds } : {}),
          ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
          ...(sentModel ? { model: sentModel } : {}),
          ...(cfgSent.agent ? { agent: cfgSent.agent } : {}),
          ...(newSessionTarget.base ? { targetBranch: newSessionTarget.base } : {}),
          ...(lanePurpose ? { purpose: lanePurpose } : {}),
          ...(followsPersonDefault ? { personDefaultHarnessId: followsPersonDefault } : {}),
          precache: true,
          activate,
        });
      } else {
        let worktreePath = newSessionTarget.kind === "main"
          ? undefined
          : newSessionIntent?.worktreePath;
        if (newSessionTarget.kind === "worktree") {
          worktreePath = newSessionTarget.path;
        } else if (newSessionTarget.kind === "new-worktree") {
          worktreePath = await createDefaultWorktree(
            projectId,
            undefined,
            newSessionTarget.base,
          );
          assertScopeStillCurrent();
        } else if (newSessionTarget.kind === "branch") {
          worktreePath = (await api.createWorktree(
            projectId,
            newSessionTarget.branch,
            undefined,
            newSessionTarget.base,
          )).path;
          assertScopeStillCurrent();
        }
        return createSession(projectId, {
          harness: creationHarness,
          ...(newSessionRepositoryIds ? { repositoryIds: newSessionRepositoryIds } : {}),
          ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
          ...(sentModel ? { model: sentModel } : {}),
          ...(cfgSent.agent ? { agent: cfgSent.agent } : {}),
          ...(worktreePath ? { worktreePath } : {}),
          ...(lanePurpose ? { purpose: lanePurpose } : {}),
          ...(followsPersonDefault ? { personDefaultHarnessId: followsPersonDefault } : {}),
          precache: true,
          activate,
        });
      }
    };
    const stagedRevisions = new Map<string, StagedDraft>();
    if (target) {
      if (command === null) stagedRevisions.set(target, stageTargetDraft(target, {
        ...reliabilityScopeAtSend,
        sessionId: target,
      }));
      markSendPending(target, true);
      // The echo now carries the prompt, so the input empties on this frame.
      if (echoId) clearComposerNow();
      void deliver(target).finally(() => markSendPending(target, false));
    } else if (activeProjectId && parkAsDraft) {
      // Send held on a new chat: create the chat exactly as Send would, but
      // keep the message as its unsent draft and stay here. The navigator
      // lists it with the draft mark; opening it puts the message back in the
      // composer, ready to send. No turn, no echo, no spawn surface.
      const projectId = activeProjectId;
      const surface = sendSurfaceKey(null, projectId);
      markSendPending(surface, true);
      void (async () => {
        const created = await createNewChat(projectId, () => false);
        assertScopeStillCurrent();
        const scope = { ...reliabilityScopeAtSend, projectId, sessionId: created };
        // The chat's own scoped record takes the text and attachment pills,
        // durably, before the new-chat record lets go of them.
        stageTargetDraft(created, scope);
        await flushClientPersistence();
        clearNewSessionDraft(projectId, reliabilityScopeAtSend);
        if (scopedDraftCacheKey(null) === scopedDraftCacheKey(null, reliabilityScopeAtSend)) {
          clearAttachments(null);
        }
        clearDraftExecutionConfig(projectId);
        if (newSessionAutoApprove !== "inherit") {
          assertScopeStillCurrent();
          await api.autoAcceptSet(created, newSessionAutoApprove);
          setNewSessionAutoApprove("inherit");
        }
        const preview = sessionDraftPreview(t);
        const saved = await withOptimisticSessionChange(
          created,
          { kind: "patch", patch: preview ? { draftPreview: preview } : {} },
          () => saveDraftToServerNow(created, scope),
        );
        if (!saved) setUiError(tr("composer.couldNotSaveDraft"));
      })()
        .catch((error) => {
          const transport = isTransportFailure(error);
          if (transport) reconnectSync();
          setUiError(transport || isMutationOutcomeUnknown(error)
            ? `${tr("composer.newChatNotConfirmed")}: ${tr("composer.newChatOutcomeUnknown")}`
            : friendlyError(tr("composer.couldNotSaveDraft"), error));
          // Hand the message back to the new chat it was taken from, unless
          // the person has moved on or typed something new there.
          const current = getState();
          if (current.activeProjectId === projectId
            && current.activeSessionId === null
            && scopedDraftCacheKey(null) === scopedDraftCacheKey(null, reliabilityScopeAtSend)
            && (inputRef.current?.getText() ?? "") === "") {
            startNewSession(projectId, {
              draft: t,
              ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
              ...(newSessionIntent?.worktreePath ? { worktreePath: newSessionIntent.worktreePath } : {}),
            });
            for (const attachment of atts) addAttachment(null, attachment);
          }
        })
        .finally(() => markSendPending(surface, false));
    } else if (activeProjectId) {
      const spawnHarnessId = creationHarness?.mode === "pinned"
        ? creationHarness.harnessId
        : catalogHarnessId ?? modelHarnessId;
      const spawnRequestId = beginSessionSpawn(activeProjectId, {
        ...(spawnHarnessId ? { harnessId: spawnHarnessId } : {}),
        ...(routeCatalog.harnessName ? { harnessName: routeCatalog.harnessName } : {}),
        ...(sentModel ? { model: sentModel } : {}),
      });
      const spawnSurface = sendSurfaceKey(null, activeProjectId);
      markSendPending(spawnSurface, true);
      let created: string | undefined;
      // The created session is admitting from the moment it exists, before its
      // composer mounts, until the first prompt's admission settles.
      let admitting: string | undefined;
      const markCreatedAdmitting = (id: string) => {
        if (admitting) return;
        admitting = id;
        markSendPending(id, true);
      };
      void (async () => {
        // Focus follows the send only while the user still watches its spawn;
        // otherwise the session keeps working in the background, listed but
        // not pulled into view.
        const stillOnSpawnSurface = (id: string) => {
          // Bind before focus: an unbound echo is shown only on the spawn
          // surface, so the new chat must already own its prompt when it opens.
          bindSessionSpawn(spawnRequestId, id);
          if (echoId) bindPendingSend(echoId, id);
          markCreatedAdmitting(id);
          const current = getState();
          return current.sessionSpawn?.requestId === spawnRequestId
            && current.activeProjectId === activeProjectId
            && current.activeSessionId === null;
        };
        created = await createNewChat(activeProjectId, stillOnSpawnSurface);
        markCreatedAdmitting(created);
        assertScopeStillCurrent();
        bindSessionSpawn(spawnRequestId, created);
        if (echoId) {
          bindPendingSend(echoId, created);
          submittedDraftRevisionRef.current = { sessionId: created, revision: revisionAfterSubmit };
        }
        let createdDraft: StagedDraft | undefined;
        if (command === null) {
          createdDraft = stageTargetDraft(created, {
            ...reliabilityScopeAtSend,
            projectId: activeProjectId,
            sessionId: created,
          });
          // Once session creation is authoritative, transfer the fresh draft
          // durably before clearing its project-scoped recovery record.
          await flushClientPersistence();
        }
        clearNewSessionDraft(activeProjectId, reliabilityScopeAtSend);
        // clearNewSessionDraft updates persistence directly; clear the live
        // hero entry too, or a later New Chat would resurrect the sent pill.
        if (scopedDraftCacheKey(null) === scopedDraftCacheKey(null, reliabilityScopeAtSend)) {
          clearAttachments(null);
        }
        clearDraftExecutionConfig(activeProjectId);
        if (newSessionAutoApprove !== "inherit") {
          assertScopeStillCurrent();
          await api.autoAcceptSet(created, newSessionAutoApprove);
        }
        if (newSessionGoal) {
          assertScopeStillCurrent();
          await api.goalAttach(created, t);
        }
        assertScopeStillCurrent();
        await runComposerSessionCreatedHooks({ projectId: activeProjectId, sessionId: created, text: t });
        await deliver(created, createdDraft, true);
        setNewSessionAutoApprove("inherit");
        setNewSessionGoal(false);
      })()
        .catch((error) => {
          // A dropped Polyth Link/network transport rejects the create request
          // with the engine's transport TypeError (iOS reports this exact case
          // as "Load failed"). A missing response does not prove that creation
          // failed. Keep the draft, reconnect, and do not offer blind replay.
          // Say what was uncertain and what to do here, where both are known:
          // the chat may exist, and the typed text is restored below.
          const transport = isTransportFailure(error);
          if (transport) reconnectSync();
          setUiError(transport || isMutationOutcomeUnknown(error)
            ? `${tr("composer.newChatNotConfirmed")}: ${tr("composer.newChatOutcomeUnknown")}`
            : friendlyError(tr("common.error"), error));
          if (echoId) endPendingSend(echoId);
          // The draft was cleared optimistically below; a failed worktree or
          // session creation must never lose the typed prompt or its pills.
          // Restore only while still on the fresh-session surface — never into
          // another session's draft.
          const current = getState();
          if (current.sessionSpawn?.requestId === spawnRequestId
            && current.activeProjectId === activeProjectId
            && current.activeSessionId === null
            && scopedDraftCacheKey(null) === scopedDraftCacheKey(null, reliabilityScopeAtSend)) {
            startNewSession(activeProjectId, {
              draft: t,
              ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
              ...(newSessionIntent?.worktreePath ? { worktreePath: newSessionIntent.worktreePath } : {}),
            });
            for (const attachment of atts) addAttachment(null, attachment);
          }
        })
        .finally(() => {
          finishSessionSpawn(spawnRequestId);
          markSendPending(spawnSurface, false);
          if (admitting) markSendPending(admitting, false);
        });
    }
    if (!target || command !== null) {
      clearComposerNow();
      promptHistoryNav.reset();
    }
    setAcToken(null);
    acTokenRef.current = null;
    selectedCommandRef.current = undefined;
  }, [
    text, attachments, cfg, profileMissing, modelAbsenceBlocksSend, runtimeUnavailable, modelAbsenceReason, working, rewindActive, activeProjectId, queueEdit, queueEditSaving,
    emptySteerItem, steerQueuedItem, promptHistoryNav, sendPending, failedSend,
    session?.model, session?.status, session?.runtimeControl, session?.harnessTransition, session?.resolvedHarnessId, preferredModel,
    sessionDefaults.defaultThinking, chatModels, creatingSession, newSessionTarget, newSessionRepositoryIds,
    newSessionAutoApprove, newSessionGoal, newSessionIntent, commandCatalog, compactPending,
    catalogHarnessId, routeCatalog.harnessName, runtimeFeatures?.capabilities.steering,
    draftExecution, draftRoute, profiles, activeProject?.defaults?.harness, newChatPersonHarness,
    sendPeopleMessage, submitMode,
  ]);
  useEffect(() => { sendRef.current = send; }, [send]);

  // Press and hold Send keeps the message as a draft chat instead of sending
  // it: a ring fills around Send over the hold, then Send shows a check. Only
  // a message that can be kept starts a hold; anything else is a plain press.
  // Touch/pen Send is admitted on pointerup — once the gesture is known not
  // to be a hold — and pointerdown is cancelled so the editor keeps focus and
  // the keyboard stays open for the next message. The delayed click from the
  // same gesture is consumed so it cannot send twice. Mouse holds swallow
  // their click; keyboard activation retains the normal click path.
  const primaryActivationRef = useRef({ touch: false, keyboard: false, staleTouchClick: false });
  const canParkRef = useRef<() => boolean>(() => false);
  // People mode sends a person message, never a draft chat: holding Send there
  // must not announce a saved draft while the message goes out to people.
  canParkRef.current = () => !peopleModeRef.current && !activeModeRef.current && !queueEdit && !creatingSession && !sendPending && !compactPending
    && Boolean(sessionIdRef.current || activeProjectId)
    && ((inputRef.current?.getText() ?? text).trim() !== "" || attachments.length > 0);
  const holdRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const [holding, setHolding] = useState(false);
  const [parked, setParked] = useState(false);
  const parkedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHold = useCallback(() => {
    const hold = holdRef.current;
    if (hold.timer !== null) clearTimeout(hold.timer);
    hold.timer = null;
    setHolding(false);
  }, []);
  useEffect(() => () => {
    cancelHold();
    if (parkedTimerRef.current !== null) clearTimeout(parkedTimerRef.current);
  }, [cancelHold]);
  const startHold = useCallback(() => {
    const hold = holdRef.current;
    if (hold.timer !== null) clearTimeout(hold.timer);
    hold.fired = false;
    if (!canParkRef.current()) return;
    setHolding(true);
    hold.timer = setTimeout(() => {
      hold.timer = null;
      setHolding(false);
      if (!canParkRef.current()) return;
      hold.fired = true;
      sendRef.current?.(undefined, undefined, false, true);
      successFeedback();
      announce(tr("composer.savedAsDraft"));
      if (parkedTimerRef.current !== null) clearTimeout(parkedTimerRef.current);
      setParked(true);
      parkedTimerRef.current = setTimeout(() => {
        parkedTimerRef.current = null;
        setParked(false);
      }, SEND_PARKED_MS);
    }, SEND_HOLD_MS);
  }, []);
  const onPrimaryPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const activation = primaryActivationRef.current;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") {
      activation.touch = false;
      activation.keyboard = false;
      activation.staleTouchClick = false;
      if (event.button === 0) startHold();
      return;
    }
    activation.touch = true;
    activation.keyboard = false;
    activation.staleTouchClick = false;
    event.preventDefault();
    startHold();
  }, [startHold]);
  const onPrimaryPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const held = holdRef.current.fired;
    cancelHold();
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (held) return;
    // A finger that slid off Send before lifting changed its mind.
    const rect = event.currentTarget.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (inside || (rect.width === 0 && rect.height === 0)) send();
  }, [cancelHold, send]);
  const onPrimaryPointerCancel = useCallback(() => {
    cancelHold();
  }, [cancelHold]);
  const onPrimaryKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const activation = primaryActivationRef.current;
    activation.staleTouchClick = activation.touch;
    activation.touch = false;
    activation.keyboard = true;
  }, []);
  const onPrimaryClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const activation = primaryActivationRef.current;
    const keyboardClick = event.detail === 0;
    if (holdRef.current.fired && !keyboardClick) {
      holdRef.current.fired = false;
      activation.touch = false;
      return;
    }
    if (activation.staleTouchClick && !keyboardClick) {
      activation.staleTouchClick = false;
      return;
    }
    if (activation.touch && !keyboardClick) {
      activation.touch = false;
      return;
    }
    activation.touch = false;
    activation.keyboard = false;
    activation.staleTouchClick = false;
    send();
  }, [send]);

  const retryFailedSend = useCallback(() => {
    const draft = (inputRef.current?.getText() ?? text).trim();
    const lastUser = [...model.messages].reverse().find((message) => message.kind === "user");
    const lastAttachments = lastUser?.kind === "user" ? lastUser.attachments ?? [] : [];
    const sameAttachments = lastAttachments.length === attachments.length
      && lastAttachments.every((attachment, index) => attachment.id === attachments[index]?.id);
    const alreadyVisible = lastUser?.kind === "user"
      && (lastUser.raw ?? lastUser.text).trim() === draft
      && sameAttachments;
    send(undefined, undefined, alreadyVisible);
  }, [attachments, model.messages, send, text]);

  const applyCompletion = useCallback((item: AutocompleteOption) => {
    const token = acTokenRef.current;
    if (!token) return false;
    if (item.destination) {
      selectedCommandRef.current = undefined;
      acTokenRef.current = null;
      setAcToken(null);
      openSettingsPage(item.destination.pageId);
      return true;
    }
    const h = inputRef.current;
    if (!h) return false;
    const cur = h.getText();
    const r = completeToken(cur, token, item.value);
    if (item.person) addPersonMention(item.person);
    selectedCommandRef.current = token.kind === "command" ? item.command : undefined;
    // replaceText fires onTextChange, which re-derives the token/popup state.
    h.replaceText(r.text, { anchor: r.caret });
    h.focus();
    return true;
  }, [addPersonMention]);

  // ---- derived popup view (honest four-state projection) ----------------------
  const acView: AutocompleteViewState | null = (() => {
    if (!acToken) return null;
    if (acToken.kind === "command") return commandAutocomplete(commandCatalog, acToken.value);
    if (acToken.kind === "snippet") return snippetAutocomplete(snippetCatalog, acToken.value);
    if (!activeProjectId) return null;
    const fresh = fileSearch.query === acToken.path;
    return mentionAndFileAutocomplete(
      sessionIdForPeople ? mentionCandidates : [],
      acToken.path,
      fresh ? fileSearch.phase : "pending",
      fresh && fileSearch.phase === "done" ? fileSearch.hits : [],
    );
  })();
  const acOptions = acView?.options ?? [];
  const acSel = acOptions.length > 0 ? Math.min(acIndex, acOptions.length - 1) : -1;
  // `@` offers only people who can open the chat, so a private chat lists
  // nobody. When the Space has other members, an empty list says why and
  // opens sharing instead of staying silent.
  const privateMentionSessionId = acView?.kind === "file" && acOptions.length === 0
    && !peopleOnly && !conversation && mentionCandidates.length === 0
    && session?.sharing?.visibility === "private" && canManageSession(session)
    ? session.id : null;
  const [spacePeople, setSpacePeople] = useState<{ sessionId: string; count: number } | null>(null);
  useEffect(() => {
    if (!privateMentionSessionId || spacePeople?.sessionId === privateMentionSessionId) return;
    let live = true;
    void loadSessionSharing(privateMentionSessionId)
      .then((dto) => { if (live) setSpacePeople({ sessionId: privateMentionSessionId, count: dto.people.length }); })
      .catch(() => { /* no hint without a known audience */ });
    return () => { live = false; };
  }, [privateMentionSessionId, spacePeople?.sessionId]);
  const privateMentionHint = privateMentionSessionId !== null
    && spacePeople?.sessionId === privateMentionSessionId && spacePeople.count > 0;
  const acGroups = acView?.kind === "cmd" || acView?.kind === "file"
    ? groupAutocompleteOptions(acOptions)
    : [];
  const acOptionIndex = new Map(acOptions.map((option, index) => [option.id, index]));

  const renderAutocompleteOption = (item: AutocompleteOption, index: number) => {
    const selected = index === acSel;
    const presentation = item.presentation;
    const ItemIcon = presentation?.kind === "skill"
      ? AssistIcon
      : presentation?.kind === "settings"
        ? SettingsIcon
        : presentation?.kind === "file"
            ? FileIcon
            : presentation
              ? CommandIcon
              : null;
    const accessibleLabel = [
      item.label,
      presentation?.kindLabel,
      item.detail,
      item.argumentHint,
      presentation?.sourceLabel ?? presentation?.groupLabel,
    ].filter(Boolean).join(", ");
    return (
      <div
        key={item.id}
        id={item.id}
        role="option"
        aria-label={accessibleLabel}
        aria-selected={selected}
        ref={selected ? (element) => element?.scrollIntoView({ block: "nearest" }) : null}
        className={`ac-item ${selected ? "ac-active" : ""}`}
        data-kind={presentation?.kind}
        onMouseDown={(event) => {
          event.preventDefault();
          setAcIndex(index);
          applyCompletion(item);
        }}
        onMouseEnter={() => setAcIndex(index)}
      >
        {presentation?.kind === "person"
          ? (
            <span className="ac-icon person-mark" data-person-tone={personToneOf(mentionTones, item.person?.userId) ?? undefined} aria-hidden="true">
              {personInitials(item.label)}
            </span>
          )
          : ItemIcon && <span className="ac-icon" aria-hidden="true"><ItemIcon size={16} strokeWidth={1.75} /></span>}
        <span className="ac-copy">
          <span className="ac-label">{item.label}</span>
          {(item.detail || item.argumentHint) && (
            <span className="ac-detail">
              {item.detail}
              {item.argumentHint && <span className="ac-argument">{item.argumentHint}</span>}
            </span>
          )}
        </span>
        {presentation?.sourceLabel && (
          <span className="ac-meta" aria-hidden="true">
            <span className="ac-source">{presentation.sourceLabel}</span>
          </span>
        )}
      </div>
    );
  };

  // One polite announcement per status transition — never per render and never
  // duplicating the active option name (aria-activedescendant covers that).
  const lastAnnounced = useRef<string | null>(null);
  const statusText = acView?.status?.text ?? null;
  useEffect(() => {
    if (statusText !== lastAnnounced.current) announce(statusText);
    lastAnnounced.current = statusText;
  }, [statusText]);

  const completeAutocomplete = (): boolean => {
    if (!acView || acOptions.length === 0) return false;
    const item = acOptions[acSel];
    if (!item) return false;
    return applyCompletion(item);
  };

  // A guess at the next prompt: the harness's own (Claude Code's prompt
  // suggestions) or one a `composer.suggestion` source offers (Session Assist).
  // It shows only in an idle, empty composer as one chip: Tab takes it as an
  // editable draft (never sends), Esc dismisses it, typing simply ignores it.
  const [dismissedSuggestion, setDismissedSuggestion] = useState("");
  const [offeredSuggestion, setOfferedSuggestion] = useState<ComposerSuggestionOffer | null>(null);
  const offerSuggestion = useCallback((offer: ComposerSuggestionOffer | null) => {
    setOfferedSuggestion((current) => current?.sessionId === offer?.sessionId && current?.text === offer?.text
      && current?.preferred === offer?.preferred
      ? current
      : offer ? { sessionId: offer.sessionId, text: offer.text, ...(offer.preferred ? { preferred: true } : {}) } : null);
  }, []);
  // A next prompt is for the agent: a composer that writes only to people
  // (a conversation, a view-only reader) neither shows nor asks for one.
  const promptSuggestion = !peopleOnly && visiblePromptSuggestion({
    suggestion: composerPromptSuggestion({
      sessionId: session?.id,
      harness: session?.promptSuggestion,
      offer: offeredSuggestion,
    }),
    dismissed: dismissedSuggestion,
    text,
    working: working || session?.status === "working",
    blocked: shellMode || Boolean(queueEdit) || creatingSession || Boolean(activeMode),
  });
  const acceptPromptSuggestion = () => {
    const input = inputRef.current;
    if (!promptSuggestion || !input) return;
    input.replaceText(promptSuggestion, { anchor: promptSuggestion.length });
    input.focus();
  };

  const onKeyIntercept = (e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean => {
    // IME composition: never send, never navigate autocomplete, never hotkey.
    if (composing) return false;
    if (e.key === "Escape" && cancelQueuedEdit()) return true;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
      setFocusMode(true);
      return true;
    }
    if (acView) {
      // Arrows move the active descendant; Enter/Tab insert only when a
      // selectable option exists (Tab otherwise follows normal focus order).
      // Consume arrows even while loading or empty so history cannot steal them.
      if (e.key === "ArrowDown") {
        if (acOptions.length > 0) setAcIndex((i) => (i + 1) % acOptions.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        if (acOptions.length > 0) setAcIndex((i) => (i - 1 + acOptions.length) % acOptions.length);
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && acOptions.length > 0) {
        if (completeAutocomplete()) return true;
      }
      if (e.key === "Escape") {
        // Close the popup only; the token text and editor focus stay put.
        setAcToken(null);
        return true;
      }
    }
    if (promptSuggestion && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "Tab") {
        acceptPromptSuggestion();
        return true;
      }
      if (e.key === "Escape") {
        setDismissedSuggestion(promptSuggestion);
        return true;
      }
    }
    if (activeModeIdRef.current) {
      const input = inputRef.current;
      const selection = input?.getSelection() ?? { start: 0, end: 0 };
      if (isModeLeaveKey({
        key: e.key,
        text: input?.getText() ?? text,
        selectionStart: selection.start,
        selectionEnd: selection.end,
        composing,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      })) {
        leaveMode();
        return true;
      }
    }
    if (e.key === "Escape") {
      const restored = promptHistoryNav.cancelToDraft((draft) => {
        setText(draft.text);
        inputRef.current?.replaceText(draft.text, { anchor: draft.text.length }, { silent: true });
      });
      if (restored) return true;
    }
    if (e.key === "Enter") {
      if (e.metaKey || e.ctrlKey) {
        send();
        return true;
      }
      if (matchesSendShortcut(sendShortcut, e.shiftKey)) {
        send();
        return true;
      }
    }
    return false;
  };

  const onUnmovedArrow = (key: "ArrowUp" | "ArrowDown") => {
    if (!shouldHandlePromptHistoryKey({
      key,
      composing: false,
      autocompleteActive: Boolean(acView),
      queueEditActive: Boolean(queueEdit),
    })) return;
    if ((promptHistoryNav?.items?.length ?? 0) === 0) {
      promptHistoryNav?.reload?.();
      return;
    }
    const current = {
      text: inputRef.current?.getText() ?? text,
      attachments: pendingAttachments(sessionIdRef.current),
    };
    promptHistoryNav.step(current, key === "ArrowUp" ? "up" : "down", (draft) => {
      setText(draft.text);
      inputRef.current?.replaceText(draft.text, { anchor: draft.text.length }, { silent: true });
    });
  };

  // Token-based autocomplete on committed text changes. File searches keep the
  // sequence guard: a project, session, token, or query change invalidates the
  // in-flight request, so a stale response never reopens or replaces results.
  const onTextChange = useCallback(
    (val: string) => {
      // A mode's trigger typed at the start of the draft ("/btw ") enters the
      // mode and leaves only the words after it. A restored draft never does.
      if (!activeModeIdRef.current && !restoringDraftRef.current && !queueEditRef.current) {
        const hit = detectModeTrigger(val, modeTriggerSourcesRef.current());
        if (hit && enterModeRef.current(hit.modeId)) {
          inputRef.current?.replaceText(hit.rest, { anchor: hit.rest.length });
          return;
        }
      }
      draftRevisionRef.current += 1;
      promoteHistoryDraft();
      setText(val);
      // Observe the submit-time clear and newer typing even while admission
      // owns persistence. Reconciliation must use the current input when it
      // resumes, never the pending edit from before Send.
      if (sessionIdRef.current !== null) {
        pendingLocalTextRef.current = { scopeKey: sessionScopeKeyRef.current, text: val };
        // Typing is the signal a turn is coming; a restored or synced draft
        // landing in an unfocused input is not.
        if (val && !restoringDraftRef.current && isComposerInputFocused()) warmSessionRuntime(sessionIdRef.current);
      }
      // The first submit clears the visible input before admission. Keep its
      // recovery copy until the created session owns the staged draft.
      if (sessionIdRef.current === null && activeProjectId && !sendPendingRef.current && !restoringDraftRef.current) {
        saveNewSessionDraftText(activeProjectId, val);
      }
      const caret = inputRef.current?.getSelection().end ?? val.length;
      const token = activeToken(val, caret);
      acTokenRef.current = token;
      setAcToken(token);
      setAcIndex(0);
      if (!token || token.kind !== "file") {
        fileSearchSeq.current++;
        return;
      }
      const q = token.path;
      const seq = ++fileSearchSeq.current;
      if (!activeProjectId || q.length === 0) {
        setFileSearch({ query: q, phase: "done", hits: [] });
        return;
      }
      setFileSearch({ query: q, phase: "pending", hits: [] });
      void api.filesSearchScored(activeProjectId, q, 8, true, getState().activeSessionId ?? undefined).then((hits) => {
        if (seq !== fileSearchSeq.current) return; // stale
        setFileSearch({ query: q, phase: "done", hits: hits.map((h) => ({ path: h.path, kind: h.kind })) });
      });
    },
    [activeProjectId],
  );

  // ---- Add menu insertions (through the IME-safe handle only) ----------------
  const applyPlan = useCallback((plan: InsertPlan) => {
    const h = inputRef.current;
    if (!h) return;
    h.replaceText(plan.text, { anchor: plan.caret });
    h.focus();
  }, []);
  const currentDraft = () => {
    const h = inputRef.current;
    const cur = h?.getText() ?? text;
    return { cur, caret: h?.getSelection().end ?? cur.length };
  };
  const menuMention = () => {
    const { cur, caret } = currentDraft();
    applyPlan(planSigilInsert(cur, caret, "@"));
  };
  const menuSnippet = () => {
    const { cur, caret } = currentDraft();
    applyPlan(planSigilInsert(cur, caret, "#"));
  };
  const menuCommand = () => {
    const { cur, caret } = currentDraft();
    applyPlan(planCommandInsert(cur, caret));
  };
  const menuShell = () => {
    // The menu row is disabled with a visible reason for nonempty drafts;
    // this guard keeps the rule even if activated programmatically.
    const plan = planShellEntry(inputRef.current?.getText() ?? text);
    if (plan.ok) applyPlan({ text: plan.text, caret: plan.caret });
  };

  // ---- execution configuration projections ------------------------------------
  const requestedSessionHarnessId = pendingSessionHarnessId ?? transitionHarnessId;
  const hasDifferentSessionRoute = Boolean(requestedSessionHarnessId
    && requestedSessionHarnessId !== session?.resolvedHarnessId);
  // A route change — a staged selection, a pending transition, or a catalogue
  // that has not answered for the new route yet — has no confirmed model of its
  // own. Until it does, the chip shows the last known label rather than a model
  // nobody chose. The anchor is display-only and never reaches a send.
  // What the route itself names for the chip (see `composerChipModel`): a
  // staged harness's route model, a server-side transition's recorded launch,
  // else the chat's model or the route model.
  const chipRoute = {
    stagedHarness: Boolean(cfg.harness),
    ...(movingTransition ? { movingTransition } : {}),
    ...(session?.model
      ? { sessionModel: { ...session.model, ...(session.resolvedHarnessId ? { harnessId: session.resolvedHarnessId } : {}) } }
      : {}),
    ...(routeModel ? { routeModel } : {}),
  };
  const routeLabelPinned = Boolean(routeLabelAnchor.current?.sessionId === (session?.id ?? null))
    && !cfg.model
    && !session?.model
    && !composerChipModel(chipRoute)
    && (hasDifferentSessionRoute
      || Boolean(session?.harnessTransition)
      || routeCatalog.discovery.state === "pending");
  // A switch still waiting for its harness's catalogue already names the model
  // last chosen there, on the same display-only terms: a send before the
  // catalogue answers commits no model, as with the anchor above.
  const rememberedRouteModel = catalogHarnessId && rememberedHarnessModel
    ? { ...rememberedHarnessModel, harnessId: catalogHarnessId }
    : undefined;
  const switchedRouteAnchor = routeSwitched && !cfg.model && modelCatalog.state === "loading"
    && rememberedRouteModel && !isHiddenModel(rememberedRouteModel)
    ? rememberedRouteModel
    : undefined;
  const pendingRouteModel = switchedRouteAnchor
    ?? (routeLabelPinned ? routeLabelAnchor.current!.model : undefined);
  // A staged harness shows what the send (and `selectedModel` below) commit; a
  // server-side transition shows what it recorded to launch.
  const recommendedModel = composerChipModel({
    ...chipRoute,
    ...(pendingRouteModel ? { pendingRouteModel } : {}),
  });
  const pickComposerModel = (ref?: ModelRef & { harnessId?: string }) => {
    if (!ref) return;
    const selectedCatalogHarnessId = catalogHarnessId ?? routeCatalog.harnessId;
    // A search hit from another harness is accepted only from the catalogs the
    // picker was offered, and moves the route before binding the model there.
    const crossHarness = ref.harnessId && selectedCatalogHarnessId && ref.harnessId !== selectedCatalogHarnessId
      ? otherHarnessModels.find((group) => group.harnessId === ref.harnessId)?.models
        .find((candidate) => modelIdentityMatches(candidate, ref))
      : undefined;
    const descriptor = crossHarness ?? routeCatalog.models.find((candidate) =>
      modelIdentityMatches(candidate, ref)
      && (!selectedCatalogHarnessId || (candidate.harnessId ?? "opencode") === selectedCatalogHarnessId));
    // A model row can outlive the route that rendered it while a transition
    // updates the picker. Only accept a model still present in this route's
    // catalog; otherwise a late click could restore the source harness model.
    if (!descriptor) return;
    // Same staging as choosing that harness's tab (clears runtime-owned
    // choices); the model below then pins the route to it for the next turn.
    if (crossHarness) pickComposerHarness({ mode: "pinned", harnessId: ref.harnessId! });
    // The model picker owns thinking selection. An explicit `variant` key is
    // also how its Auto choice is distinguished from merely choosing a model.
    const hasThinkingChoice = Object.prototype.hasOwnProperty.call(ref, "variant");
    const nextCfg = withModelForNextTurn(cfgRef.current, ref);
    updateCfg(hasThinkingChoice
      ? (ref.variant ? withExplicitThinking(nextCfg, ref.variant) : withAutoThinking(nextCfg))
      : nextCfg);
    if (hasThinkingChoice) setModelThinking(descriptor, ref.variant ?? "");
    noteModelUsed(`${descriptor.harnessId ? `${descriptor.harnessId}::` : ""}${ref.providerID}/${ref.modelID}`);
    // What a later switch back to this harness selects first.
    rememberHarnessModel(descriptor.harnessId ?? selectedCatalogHarnessId ?? "opencode", {
      providerID: ref.providerID,
      modelID: ref.modelID,
      name: descriptor.name,
    });
    if (!session && activeProjectId && descriptor.harnessId) {
      updateDraftExecutionConfig(activeProjectId, {
        harnessSelection: { mode: "pinned", harnessId: descriptor.harnessId },
        harnessSelectionExplicit: true,
        model: { ...ref, harnessId: descriptor.harnessId },
      });
    }
    if (activeProjectId) {
      // Harness-qualified so the server pins the project harness with it.
      const harnessId = descriptor.harnessId ?? selectedCatalogHarnessId ?? "opencode";
      void rememberProjectModelSelection(activeProjectId, { ...ref, harnessId }).catch((error) => {
        setUiError(friendlyError(tr("composer.couldnTRememberTheProjectModel"), error));
      });
    }
  };
  const pickComposerHarness = (selection: HarnessSelection) => {
    // A native command belongs to the currently catalogued runtime and must
    // never survive a staged route change into another harness.
    selectedCommandRef.current = undefined;
    if (!session) {
      const currentDraft = activeProjectId
        ? readDraftExecutionConfig(activeProjectId)
        : draftExecution;
      updateCfg(withHarnessForNextTurn(cfgRef.current, selection, {
        ...(effectiveDraftHarness ? { harnessId: effectiveDraftHarness } : {}),
        ...(currentDraft.profileId ? { profileId: currentDraft.profileId } : {}),
      }, profiles));
      if (activeProjectId) {
        writeDraftExecutionConfig(
          activeProjectId,
          withDraftHarnessForNextTurn(currentDraft, selection, profiles),
        );
      }
      return;
    }
    updateCfg(withHarnessForNextTurn(cfgRef.current, selection, {
      harnessId: session.resolvedHarnessId,
      profileId: session.agentProfileId,
    }, profiles));
  };
  const selectedModel = (() => {
    // As the send resolves it.
    const nextTurn = nextTurnModelRef({
      ...(cfg.model ? { configModel: cfg.model } : {}),
      stagedHarness: Boolean(cfg.harness),
      movingTransition: Boolean(movingTransition),
      ...(session?.model ? { sessionModel: session.model } : {}),
      ...(effectiveProfile ? { profileModel: { providerID: effectiveProfile.providerID, modelID: effectiveProfile.modelID } } : {}),
      ...(preferredModel ? { preferred: preferredModel } : {}),
    });
    return nextTurn
      ? chatModels.find((candidate) => modelIdentityMatches(candidate, nextTurn))
      : undefined;
  })();
  // A fresh chat tells the new-chat screen's widgets which model it would use.
  const newChatModelHarness = session ? undefined : selectedModel?.harnessId ?? catalogHarnessId;
  useEffect(() => {
    if (session) return;
    setNewChatModel(selectedModel && newChatModelHarness
      ? { harnessId: newChatModelHarness, providerID: selectedModel.providerID, modelID: selectedModel.modelID }
      : null);
  }, [session, newChatModelHarness, selectedModel?.providerID, selectedModel?.modelID]);
  // Same inputs the server admits with: harness support intersected with the
  // next-turn model, under the project's real remote/materialize policy. A
  // hardcoded `false` here is what let the composer offer an attachment the
  // send then refused.
  const composerAttachmentSupport = runtimeFeatures
    ? effectiveAttachmentSupport(
        {
          ...runtimeFeatures.capabilities,
          attachments: { modalities: runtimeFeatures.attachmentSupport },
        },
        selectedModel?.capabilities,
        runtimeFeatures.remote === true,
        runtimeFeatures.materializeAvailable === true,
      )
    : undefined;
  const savedThinking = useModelThinking(selectedModel);
  // Reopening a chat restores the effort its own model recorded, not the last
  // effort this model was given in another chat. The record applies only while
  // the next-turn selection is still that chat's model.
  const sessionThinking = recordedSessionThinking(selectedModel, session?.model, session?.resolvedHarnessId);
  const thinkingResolution = resolveComposerThinking({
    ...(selectedModel ? { descriptor: selectedModel } : {}),
    configThinking: cfg.thinking,
    recordedThinking: sessionThinking,
    savedThinking,
    ...(sessionDefaults.defaultThinking ? { sessionDefault: sessionDefaults.defaultThinking } : {}),
  });
  const selectedThinking = thinkingResolution.variant;
  // Workflow launches inherit the exact next-turn route from Chat. Explicit
  // assignments in a workflow still win for the nodes that need them.
  const workflowModel = selectedModel
    ? {
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        ...(selectedThinking ? { variant: selectedThinking } : {}),
      }
    : undefined;
  const workflowHarness = selectedModel?.harnessId
    ? { mode: "pinned" as const, harnessId: selectedModel.harnessId }
    : cfg.harness
      ?? (session?.resolvedHarnessId
        ? { mode: "pinned" as const, harnessId: session.resolvedHarnessId }
        : session?.harness
          ?? (effectiveDraftHarness
            ? { mode: "pinned" as const, harnessId: effectiveDraftHarness }
            : undefined));
  const workflowAgent = cfg.agent ?? session?.agent ?? effectiveProfile?.agent;
  // Only project a controlled choice into the picker. The fully resolved value
  // may be an inherited session/model default; passing that as controlled would
  // overwrite a canonical ModelRef.variant and turn a row click into a newly
  // persisted preference.
  const pickerThinking = composerThinkingChoice({
    configThinking: cfg.thinking,
    recordedThinking: sessionThinking,
    savedThinking,
  });
  // Honest attachment note from the next-turn model's normalized capabilities:
  // `input:image` = supported (no note); an input report without
  // image support names the block when an image pill is pending; no report
  // keeps the legacy "not reported" line.
  const attachNote = (() => {
    if (attachments.length === 0) return null;
    // No capability report is not a claim of incompatibility — most providers
    // simply don't report it, and it works. Only an explicit unsupported
    // modality is worth interrupting the draft for.
    if (!composerAttachmentSupport) return null;
    for (const attachment of attachments) {
      const modality = attachmentModality(attachment);
      if (!modality) continue;
      const level = composerAttachmentSupport[modality];
      if (level === "native" || level === "emulated") continue;
      if (modality === "image") return tr("composer.discovery.attachmentImagesOmitted");
      if (modality === "pdf") return tr("composer.discovery.currentlyUnavailable");
      if (modality === "audio") return tr("composer.discovery.currentlyUnavailable");
      if (modality === "file") return tr("composer.discovery.currentlyUnavailable");
      return tr("composer.discovery.currentlyUnavailable");
    }
    return null;
  })();
  const uploadDisabledReason = (() => {
    if (!composerAttachmentSupport) return undefined;
    const anySupported = Object.values(composerAttachmentSupport).some(
      (level) => level === "native" || level === "emulated",
    );
    return anySupported ? undefined : tr("composer.discovery.currentlyUnavailable");
  })();
  // A variant remembered for one model can be meaningless on the next. Drop
  // the stale value so the control shows the effective one instead of a
  // preference that would be discarded at send.
  const reconciledThinkingKey = thinkingResolution.reconciled && selectedModel
    ? `${selectedModel.harnessId ?? ""}/${selectedModel.providerID}/${selectedModel.modelID}`
    : "";
  useEffect(() => {
    if (!reconciledThinkingKey || !selectedModel) return;
    if (getModelThinking(selectedModel)) setModelThinking(selectedModel, undefined);
    if (typeof cfg.thinking === "string") {
      updateCfg(selectedThinking ? withExplicitThinking(cfgRef.current, selectedThinking) : withAutoThinking(cfgRef.current));
    }
  }, [reconciledThinkingKey]);
  const autoApproveOn = session
    ? session.autoAccept === true
    : newSessionAutoApprove === "inherit" ? undefined : newSessionAutoApprove !== "off";
  const autoApproveAll = session
    ? session.autoAcceptAll === true
    : newSessionAutoApprove === "inherit" ? undefined : newSessionAutoApprove === "all";
  const toggleGoal = () => {
    const objective = (inputRef.current?.getText() ?? text).trim();
    if (!objective) {
      // With a session the package-owned mini-widget opens its own attach form
      // (the host supplies no toggle for the empty-draft session case); here the
      // draft is empty with no session, so toggle "first message is the goal".
      setNewSessionGoal((current) => !current);
      return;
    }
    if (!session) {
      setNewSessionGoal(true);
      announce(tr("composer.thisMessageWillBeSavedAsTheGoal"));
      return;
    }
    if (goalAttachBusy) return;
    const target = sessionIdRef.current;
    if (!target || target !== session.id) return;
    const targetScope = scopedDraftCacheKey(target);
    setGoalAttachBusy(true);
    void api.goalAttach(target, objective)
      .then(() => {
        // A session switch mid-attach must not clear a different composer.
        if (sessionIdRef.current !== target || scopedDraftCacheKey(target) !== targetScope) return;
        setText("");
        inputRef.current?.replaceText("");
        saveDraft(target, "");
        syncDraftToServer(target, "");
        announce(tr("composer.goalAttached"));
      })
      .catch((error) => setUiError(friendlyError(tr("composer.couldnTAttachTheGoal"), error)))
      .finally(() => setGoalAttachBusy(false));
  };
  const workflowDraftTarget = session?.id ?? null;
  const workflowDraftScope = scopedDraftCacheKey(workflowDraftTarget);
  const consumeWorkflowDraft = (expectedText = text): boolean => {
    if (scopedDraftCacheKey(workflowDraftTarget) !== workflowDraftScope) return false;
    if (!requestComposerCompareReplace({ scopeKey: workflowDraftScope, expectedText, text: "" })) return false;
    // Keep newly attached items; the accepted launch owns only its submitted refs.
    const submitted = new Set(attachments.map((attachment) => attachment.id));
    seedAttachments(workflowDraftTarget, pendingAttachments(workflowDraftTarget).filter((attachment) => !submitted.has(attachment.id)));
    promptHistoryNav.reset();
    if (workflowDraftTarget) {
      saveDraft(workflowDraftTarget, "");
      syncDraftToServer(workflowDraftTarget, "");
    } else if (activeProjectId) saveNewSessionDraftText(activeProjectId, "");
    return true;
  };
  const restoreWorkflowDraft = (value: string, refs: AttachmentRef[] = []): boolean => {
    if (scopedDraftCacheKey(workflowDraftTarget) !== workflowDraftScope) return false;
    if (!requestComposerCompareReplace({ scopeKey: workflowDraftScope, expectedText: "", text: value })) return false;
    for (const ref of refs) addAttachment(workflowDraftTarget, ref);
    if (workflowDraftTarget) {
      saveDraft(workflowDraftTarget, value);
      syncDraftToServer(workflowDraftTarget, value);
    } else if (activeProjectId) saveNewSessionDraftText(activeProjectId, value);
    return true;
  };
  const phoneLayout = isPhone;
  useEffect(() => setMobileRailEditing(false), [phoneLayout, spaceId, activeProjectId]);
  // Arranging the buttons puts the keyboard away so the whole rail is in view.
  const editMobileRail = (editing: boolean) => {
    setMobileRailEditing(editing);
    if (editing) inputRef.current?.element()?.blur();
  };
  // The new chat's Customize panel hands phone users to this rail's editor;
  // only the fresh-chat composer answers, never a widget or open-chat one.
  const answersRailEditRequest = phoneLayout && !session && !widgetMode;
  useEffect(() => answersRailEditRequest
    ? subscribeMobileRailEditRequest(() => {
      setMobileRailEditing(true);
      inputRef.current?.element()?.blur();
    })
    : undefined, [answersRailEditRequest]);
  const newSessionHarnessSelection: HarnessSelection = stagedHarnessId
    ? { mode: "pinned", harnessId: stagedHarnessId }
    : selectedDraftHarness
      ? { mode: "pinned", harnessId: selectedDraftHarness }
      : draftRoute.draft.harnessSelection;
  const executionPickerContext = {
    spaceId,
    sessionId: session?.id,
    projectId: activeProjectId ?? undefined,
    sessionStatus: session?.status,
    harnessSelection: session ? session.harness : newSessionHarnessSelection,
    resolvedHarnessId: session?.resolvedHarnessId ?? effectiveDraftHarness,
    harnessTransition: session?.harnessTransition,
    pendingHarnessSelection: cfg.harness,
    onSelectHarness: pickComposerHarness,
    projectHarnessDefault: draftRoute.projectHarness,
    // The effective next-turn route, so a package can describe the model that
    // would actually run without re-deriving it from the store.
    model: selectedModel,
    thinking: selectedThinking,
  };
  const modelControl = activeProjectId && guardedModelSwitcherVisible(guardrails) ? (
    <ModelPicker
      models={chatModels}
      harnessId={catalogHarnessId}
      value={cfg.model}
      recommended={recommendedModel}
      pendingModel={pendingRouteModel}
      thinking={pickerThinking}
      header={<SlotHost slot="modelPicker.header" context={executionPickerContext} />}
      direction="up"
      usage={model.contextUsage ? contextTokensUsed(model) : undefined}
      catalogLoading={modelCatalog.state === "loading"}
      otherHarnesses={otherHarnessModels}
      harnessColors={harnessColors}
      onPick={pickComposerModel}
    />
  ) : null;
  // Effort reuses the picker's own row contract instead of reconciling twice:
  // an explicit choice wins, the model's advertised default is the visible
  // fallback, and Auto is checked while nothing explicit is pending.
  const effortVariants = selectedModel ? [...new Set(selectedModel.variants ?? [])] : [];
  const explicitEffort = pickerThinking && effortVariants.includes(pickerThinking) ? pickerThinking : undefined;
  const defaultEffort = selectedModel?.defaultVariant && effortVariants.includes(selectedModel.defaultVariant)
    ? selectedModel.defaultVariant
    : undefined;
  const effortDisplay = pickerThinking === null ? undefined : explicitEffort ?? defaultEffort;
  const effortLabel = effortDisplay ? thinkingVariantLabel(effortDisplay) : tr("composer.auto");
  const pickEffort = (variant: string | undefined) => {
    if (selectedModel) setModelThinking(selectedModel, variant ?? "");
    updateCfg(variant ? withExplicitThinking(cfgRef.current, variant) : withAutoThinking(cfgRef.current));
    if (!session && activeProjectId) updateDraftExecutionConfig(activeProjectId, {
      ...(variant ? { thinking: variant } : { thinking: undefined }),
    });
  };
  const effortEntries: MenuEntry[] = [
    {
      id: "auto",
      label: tr("composer.auto"),
      kind: "radio",
      checked: explicitEffort === undefined,
      onSelect: () => pickEffort(undefined),
    },
    ...effortVariants.map((variant): MenuEntry => ({
      id: variant,
      label: thinkingVariantLabel(variant),
      kind: "radio",
      checked: explicitEffort === variant,
      onSelect: () => pickEffort(variant),
    })),
  ];
  // A quiet chip, not a second picker: the choice itself stays in the model's
  // catalog, this only exposes the pending effort beside the model.
  const effortControl = !noModels && modelSupportsThinking(selectedModel) ? (
    <Menu
      label={tr("composer.thinking")}
      title={tr("composer.thinking")}
      entries={effortEntries}
      align="end"
    >
      {({ ref, onClick, ...triggerProps }) => (
        <button
          ref={ref}
          type="button"
          className="config-chip composer-effort-trigger"
          title={tr("composer.thinkingEffortValue", { value: effortLabel })}
          aria-label={tr("composer.thinkingEffortValue", { value: effortLabel })}
          {...triggerProps}
          onClick={onClick}
        >
          <span className="config-chip-text">{effortLabel}</span>
          <span className="config-chip-caret" aria-hidden="true"><Icon.chevronDown /></span>
        </button>
      )}
    </Menu>
  ) : null;
  // The context pie follows effort on the same quiet line. On a resting phone
  // the line itself is hidden and only the pie stays, right after Add.
  const contextPie = session && contextPieVisible(contextGauge)
    ? <ContextPie
        key={session.id}
        gauge={contextGauge}
        phone={phoneLayout}
        sessionId={session.id}
        projectId={session.projectId}
        pressureLevel={model.contextPressureLevel}
        {...(runtimeFeatures ? {
          compact: {
            pending: compactionRunning,
            disabled: session.status !== "idle",
            run: () => { startCompact(session.id); },
          },
        } : {})}
      />
    : null;
  const readComposerDraft = () => {
    const state = getState();
    const currentSessionId = state.activeSessionId;
    return {
      projectId: state.activeProjectId,
      sessionId: currentSessionId,
      text: inputRef.current?.getText() ?? committedTextRef.current,
      revision: draftRevisionRef.current,
      latestSeq: currentSessionId ? lastSeq(currentSessionId) : 0,
    };
  };
  const composerDraft: ComposerDraftContext = {
    ...readComposerDraft(),
    text,
    busy: working || creatingSession || sendPending || inFlightPrompt,
    read: readComposerDraft,
    replace: requestComposerReplace,
    offerSuggestion,
    ...(session?.promptSuggestion ? { harnessSuggestion: session.promptSuggestion } : {}),
    harnessSuggests: runtimeFeatures?.capabilities.promptSuggestions === true,
  };
  const slotContext = {
    ...executionPickerContext,
    variant,
    // People-only composers (a conversation, a view-only reader) leave out the
    // widgets that act on the agent's turn (WidgetDef.agentOnly).
    agentless: peopleOnly,
    working,
    autoApproveOn,
    autoApproveAll,
    setDraftAutoApprove: setNewSessionAutoApprove,
    goalOn: newSessionGoal,
    goalBusy: goalAttachBusy,
    // With a session and an empty draft the package mini-widget opens its own
    // attach form, so no host toggle is offered for that case.
    ...(session && !text.trim() ? {} : { toggleGoal }),
    workflowDraftText: text,
    workflowAttachmentCount: attachments.length,
    workflowAttachments: attachments,
    workflowBusy: creatingSession || sendPending || inFlightPrompt,
    workflowModel,
    workflowHarness,
    workflowAgent,
    consumeWorkflowDraft,
    restoreWorkflowDraft,
    composerDraft,
  };

  const borrowedEpochPending = session?.status === "epoch-pending"
    && session.runtimeControl === "borrowed";
  const draftNativeCommand = !queueEdit && !shellMode && commandCatalog.state === "available"
    ? nativeCommandInput(text.trim(), commandCatalog.items, selectedCommandRef.current)
    : undefined;
  const draftCompactCommand = !queueEdit && !shellMode && commandCatalog.state === "available"
    && isCompactCommand(text.trim(), commandCatalog.items, selectedCommandRef.current);
  const hostOnlyCommandReady = (isHostOnlyExtensionCommand(draftNativeCommand) || draftCompactCommand)
    && attachments.length === 0;
  const sendDisabled = creatingSession
    || Boolean(session?.historyImport && session.historyImport.state !== "complete")
    || sendPending
    || compactPending
    || queueEditSaving
    || borrowedEpochPending
    || (queueEdit ? !text.trim() : (!text.trim() && attachments.length === 0))
    || (!queueEdit && !shellMode && (modelAbsenceBlocksSend || profileMissing) && !hostOnlyCommandReady);
  const hasDraft = text.trim() !== "" || attachments.length > 0;
  const peopleSendDisabled = peopleSending || text.trim() === "";
  const runningHasSend = !sendDisabled;
  const runningPrimaryLabel = queueEdit
    ? tr("composer.saveQueuedMessageInIts")
    : rewindActive || followUp === "interrupt"
      ? tr("composer.sendNow")
      : followUp === "steer"
        ? tr("settings.pages.steer")
        : tr("composer.queue");
  const runningPrimaryTitle = !queueEdit && !rewindActive && followUp === "queue"
    ? tr("composer.queueMessageUntilTheCurrentResponseFinishes")
    : runningPrimaryLabel;
  const runningPrimaryGlyph = queueEdit
    ? <CheckIcon />
    : !rewindActive && followUp === "queue"
      ? <QueueSendIcon aria-hidden="true" />
      : <SendIcon aria-hidden="true" />;
  const withContextLabel = (label: string) => contextLabel ? `${label} · ${contextLabel}` : label;
  // Mobile keeps the customizable launcher strip below the writing surface;
  // running state alone never changes its geometry.
  // Attachments, commands and snippets are agent input; a people-only
  // composer offers none of them (`@` still mentions people).
  const addControl = peopleOnly ? null : (
    <ComposerAddMenu
      hasProject={!!activeProjectId}
      hasSession={!!session?.id}
      draftText={text}
      commands={commandCatalog}
      snippets={snippetCatalog}
      {...(uploadDisabledReason ? { uploadDisabledReason } : {})}
      direction="up"
      onUpload={() => openAttachmentPicker("files")}
      onChoosePhotos={() => openAttachmentPicker("photos")}
      onTakePhoto={() => openAttachmentPicker("camera")}
      onInsertMention={menuMention}
      onInsertCommand={menuCommand}
      onInsertSnippet={menuSnippet}
      onEnterShell={menuShell}
      shellHidden={!shellAllowed}
      contributions={composerContributions}
      onActivateContribution={(item) => item.activate(buildContributionContext(item.id))}
    />
  );
  // A phone rail has room for a glyph; the label stays the accessible name.
  const startSessionEntry = conversation && session && canCollaborateSession(session) ? (
    phoneLayout ? (
      <IconButton
        icon={BotIcon}
        label={tr("conversation.startSession")}
        className="composer-start-session"
        onClick={() => beginConversationSelection(session.id)}
      />
    ) : (
      <Button
        size="sm"
        variant="quiet"
        iconStart={BotIcon}
        className="composer-start-session"
        onClick={() => beginConversationSelection(session.id)}
      >{tr("conversation.startSession")}</Button>
    )
  ) : null;
  const modeSubmitLabel = activeMode ? modeText(activeMode.submitLabel) || tr("composer.sendMessage") : "";
  const primaryAction = activeMode ? (
    <>
    {/* A side question never stops the agent, but the person still can. */}
    {canStop && (
      <IconButton
        icon={StopIcon}
        label={tr("common.stop")}
        variant="ghost"
        className="composer-mode-stop"
        busy={abortPending}
        onClick={() => void stopActiveTurn()}
      />
    )}
    <button
      type="button"
      className="send composer-mode-send"
      onClick={() => submitMode()}
      aria-label={modeSubmitLabel}
      title={`${modeSubmitLabel} (${sendKey})`}
      disabled={modeSubmitting || text.trim() === ""}
      aria-busy={modeSubmitting || undefined}
    >
      <span className="send-plane" aria-hidden="true"><Icon.send /></span>
      <span className="composer-action-label">{modeSubmitLabel}</span>
    </button>
    </>
  ) : peopleMode ? (
    <>
    {startSessionEntry}
    <button
      className="send composer-people-send"
      onClick={() => sendPeopleMessage()}
      aria-label={peopleLabel}
      title={peopleLabel}
      disabled={peopleSendDisabled}
      aria-busy={peopleSending}
    >
      <span className="send-plane" aria-hidden="true"><Icon.send /></span>
      <span className="composer-action-label">{peopleLabel}</span>
    </button>
    </>
  ) : (
    <>
      {canStop ? (
      runningHasSend ? (
        <div className="composer-send-split">
          <button
            className={`send composer-delivery${queueEdit ? "" : " composer-running-send"} context-liquid-host`}
            onPointerDown={onPrimaryPointerDown}
            onPointerUp={onPrimaryPointerUp}
            onPointerCancel={onPrimaryPointerCancel}
            onPointerLeave={onPrimaryPointerCancel}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={onPrimaryKeyDown}
            onClick={onPrimaryClick}
            data-holding={holding || undefined}
            aria-label={runningPrimaryTitle}
            title={withContextLabel(runningPrimaryTitle)}
          >
            {runningPrimaryGlyph}
            <span className="composer-action-label">{runningPrimaryLabel}</span>
            <ContextLiquid key={session?.id} gauge={contextGauge}>{runningPrimaryGlyph}</ContextLiquid>
          </button>
          <Menu
            label={tr("composer.moreActiveRunActions")}
            align="end"
            className="composer-send-menu"
            entries={[
              {
                id: "send-now",
                label: tr("composer.sendNow"),
                icon: SendIcon,
                onSelect: () => send(undefined, "interrupt"),
              },
              {
                id: "stop",
                label: tr("common.stop"),
                icon: StopIcon,
                disabled: abortPending,
                onSelect: () => void stopActiveTurn(),
              },
            ]}
          >
            {(trigger) => (
              <button
                className="composer-send-options"
                aria-label={tr("composer.moreActiveRunActions")}
                {...trigger}
              >
                <ChevronDownIcon />
              </button>
            )}
          </Menu>
        </div>
      ) : (
        <button
          className="stop composer-stop-primary context-liquid-host"
          title={withContextLabel(tr("composer.stopTheCurrentResponse"))}
          aria-label={tr("composer.stopTheCurrentResponse")}
          aria-busy={abortPending}
          disabled={abortPending}
          onPointerDown={() => { stopPointerAt.current = Date.now(); }}
          onClick={(event) => void stopActiveTurn(event)}
        >
          <Icon.stop /><span className="composer-action-label">{tr("common.stop")}</span>
          <ContextLiquid key={session?.id} gauge={contextGauge}><Icon.stop /></ContextLiquid>
        </button>
      )
            ) : (
      <button className="send" onPointerDown={onPrimaryPointerDown} onPointerUp={onPrimaryPointerUp}
        onPointerCancel={onPrimaryPointerCancel} onPointerLeave={onPrimaryPointerCancel}
        onContextMenu={(event) => event.preventDefault()} onKeyDown={onPrimaryKeyDown} onClick={onPrimaryClick}
        data-holding={holding || undefined}
        data-parked={parked || undefined}
        title={`${shellMode ? tr("composer.runShellCommand") : tr("composer.sendMessage")} (${sendKey}) · ${tr("composer.holdToSaveDraft")}`}
        aria-label={shellMode ? tr("composer.runShellCommand") : tr("composer.sendMessage")}
        disabled={sendDisabled && !parked}>
        <span className="send-plane" aria-hidden="true">{parked ? <Icon.check /> : <Icon.send />}</span>
        <svg className="send-hold-ring" viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="22.5" pathLength="100" />
        </svg>
      </button>
            )}
    </>
  );
  const layoutState = composerLayoutState({ phoneLayout, inputFocused, shellMode: shellMode || Boolean(activeMode), hasDraft, railEditing: mobileRailEditing });
  const expanded = layoutState !== "phone-resting";
  // Auto-grow (§20). The ceiling follows the VISUAL viewport, so an open
  // keyboard shrinks the input instead of pushing the send button offscreen;
  // past the ceiling the textarea scrolls internally. A layout effect keyed on
  // the layout state, declared before the morph: the card is measured as it
  // will settle, editor included. A passive effect left the resting row's 46px
  // editor in the engaged card while the morph took its end height, so the
  // card overshot its settled height by ~10px and snapped back at the finish.
  useLayoutEffect(() => {
    const el = inputRef.current?.element();
    if (!el) return;
    const visible = bandHeight || window.innerHeight;
    // Phones collapse to zero first: `auto` resolves to the `rows` attribute,
    // which would keep an empty composer three lines tall (§7). Wider layouts
    // keep the roomier three-row resting size. Measured on an inert twin so
    // a keystroke never resizes the dock just to measure it
    // (composerAutoGrow.ts); the height is written only when it changes.
    const phone = isPhone;
    const natural = measureComposerEditor(el, phone);
    // The visible viewport supplies the emergency cap; the shared
    // --composer-max-input-height token supplies the normal five-line cap.
    // On phones the input never grows past the room its own chrome (model
    // header, actions, context bar) needs on a keyboard-squeezed viewport.
    const cap = phone
      ? Math.max(44, Math.min(visible * 0.42, visible - 240))
      : Math.max(44, visible * 0.42);
    applyComposerEditorHeight(el, Math.min(natural + 2, cap));
    if (followDictationRef.current) {
      followDictationRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [text, inputFocused, layoutState, isPhone, bandHeight]);
  // Resting row ⇄ engaged card eases on the keyboard's curve instead of jumping;
  // resting, the card stays presented as engaged until it has shrunk to the row.
  const presentedExpanded = useComposerMorph(rootRef, expanded, layoutState !== "desktop");
  const stateClass = layoutState === "desktop"
    ? ""
    : ` composer-mobile composer-mobile-grid ${presentedExpanded ? "composer-expanded" : "composer-collapsed"}${inputFocused ? " composer-input-active" : ""}${hasDraft ? " composer-has-draft" : ""}`;
  const attachmentStrip = attachments.length > 0 && (
    <AttachmentPills
      attachments={attachments}
      onRemove={(id) => {
        const sid = session?.id ?? null;
        if (promptHistoryNavRef.current.isBrowsing()) promoteHistoryDraft();
        removeAttachment(sid, id);
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      // A touch on any composer control, or on a picker it opens, acts on the
      // first tap and leaves the software keyboard open (mobileViewport.ts).
      data-keep-keyboard=""
      // The band the keyboard leaves, for the long-draft editor cap
      // (mobileViewport.css): here it restyles only the composer, where the
      // root frame variables restyle the whole app and arrive only once a
      // ridden keyboard has landed.
      style={phoneLayout && bandHeight > 0 ? { "--composer-band": `${bandHeight}px` } as CSSProperties : undefined}
      className={`composer ${widgetMode ? "composer-widget" : "composer-chat"} composer-simple${widgetMode ? "" : " composer-focus-light"}${stateClass}`}
      aria-busy={creatingSession || undefined}
    >
      {/* The project/worktree pickers only make sense before a session exists:
          in an open session the location is fixed, and picking here silently
          switched project or spawned a new session instead of retargeting. */}
      {!session && attachmentStrip}
      {!session && !creatingSession && !soloPersonal && heroChrome.location && (
        <SessionContextBar {...contextBar} showIsolation={heroChrome.isolation} />
      )}
      {/* Widget-areas (WA4): the project/branch meta row is a widget area. */}
      <SlotHost slot="composer.meta" context={slotContext} customizable />
      {failedSend?.kind === "unavailable" && (
        <Notice
          tone="warning"
          className="composer-send-failure"
          role="alert"
          actions={<Button size="sm" onClick={retryFailedSend}>{tr("common.retry")}</Button>}
        >{tr("composer.sendUnavailableDraftPreserved")}</Notice>
      )}
      {/* Widget-areas (WA4): the uncommitted-changes bar area, above the box. */}
      <SlotHost slot="composer.pending" context={slotContext} customizable />
      {session?.id && (
        <QueuedMessageList
          sessionId={session.id}
          editingId={queueEdit?.sessionId === session.id ? queueEdit.id : null}
          launchingId={steeringQueuedId}
          onEdit={beginQueuedEdit}
          onSteer={steerQueuedItem}
          onItemsChange={updateQueuedItems}
        />
      )}
      {session && attachmentStrip}
      {/* Headless next-prompt sources (Session Assist): mounted for every agent
          chat whatever the rail shows, so hiding a rail button never turns
          suggestions off. They draw nothing and offer through composerDraft. */}
      {session && !peopleOnly && <SlotHost slot="composer.suggestion" context={slotContext} />}
      {/* The suggested next prompt (harness or Session Assist) sits on the composer's pending
          writing stack, never inside the editor: the whole chip takes it as
          an editable draft, × (or Esc) dismisses it, Tab is the shortcut. */}
      {promptSuggestion && (
        <div className="composer-suggestion" role="group" aria-label={tr("composer.promptSuggestionLabel")}>
          <button
            type="button"
            className="composer-suggestion-use"
            title={tr("composer.promptSuggestionHint")}
            aria-label={`${tr("composer.promptSuggestionAccept")}: ${promptSuggestion}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={acceptPromptSuggestion}
          >
            <UiIcon icon={AssistIcon} size="sm" className="composer-suggestion-icon" />
            <span className="composer-suggestion-text">{promptSuggestion}</span>
            <kbd className="composer-suggestion-key" aria-hidden="true">Tab</kbd>
          </button>
          <IconButton
            className="composer-suggestion-dismiss"
            icon={CloseIcon}
            label={tr("composer.promptSuggestionDismiss")}
            size="sm"
            variant="ghost"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setDismissedSuggestion(promptSuggestion)}
          />
        </div>
      )}
      <GlassDock
        className={`composer-card${selectingConversation ? " is-choosing-messages" : ""}${activeMode ? " is-composer-mode" : ""}`}
        {...(activeMode ? { "data-composer-mode": activeMode.id } : {})}
        onDragOver={(e) => { const k = dragKind(e.dataTransfer); if (k) { e.preventDefault(); setDropHint(k); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(null); }}
        onDrop={(e) => {
          const k = dragKind(e.dataTransfer);
          setDropHint(null);
          if (!k || !activeProjectId) return;
          e.preventDefault();
          void dropIntoSession(e.dataTransfer, activeProjectId, sessionIdRef.current,
            (reason) => setUiError(tr("composer.couldNotAttach", { reason })));
        }}
      >
      {dropHint && (
        <div className="drop-hint">{dropHint === "path" ? tr("composer.attachToChat") : tr("composer.dropToAttach")}</div>
      )}
      {pendingLargePaste && (
        <Notice className="composer-note composer-large-paste" role="status" actions={<>
          <Button size="sm" onClick={() => resolveLargePaste("attach")}>{tr("composer.largePasteAttach")}</Button>
          <Button size="sm" onClick={() => resolveLargePaste("inline")}>{tr("composer.largePasteInline")}</Button>
          <Button size="sm" onClick={() => resolveLargePaste("always-attach")}>{tr("composer.largePasteAlwaysAttach")}</Button>
        </>}>
          {tr("composer.largePasteBanner")}
        </Notice>
      )}
      {!conversation && showModelWarning && !hostOnlyCommandReady && (
        <div className="composer-note composer-runtime-unavailable" role="status">
          <span>
            {modelAbsence === "loading"
              ? tr("common.loading")
              : modelAbsenceReason
                ?? runtimeUnavailable?.message
                ?? tr("composer.noModelsAvailableCheckThatTheBackend")}
          </span>
          {modelAbsence !== "loading" && (modelRecovery === "manage-harnesses"
            ? <Button size="sm" onClick={() => openSettingsPage("harnesses")}>{tr("composer.manageHarnesses")}</Button>
            : <Button size="sm" onClick={retryModelConnection}>{tr("sidebar.reconnect")}</Button>)}
        </div>
      )}
      {!conversation && profileMissing && !hostOnlyCommandReady && (
        <div className="composer-note composer-profile-missing" role="alert">
          {PROFILE_MISSING_NOTE}
        </div>
      )}
      {attachments.length > 0 && !noModels && attachNote && (
        <div className="composer-attach-note">{attachNote}</div>
      )}
      {/* Three rows: the model, its pending effort and the context pie share
          one quiet line above the editor (model over the Add control, effort
          and the pie immediately beside it), then the editor, then the rail.
          `composer.config` sits on that same line, so a package can speak about
          the selected route beside the chip that names it. */}
      {!peopleOnly && !peopleMode && (modelControl || effortControl || contextPie || phoneLayout) && (
        <div className="composer-config composer-config-row">
          {modelControl}
          {effortControl}
          {contextPie}
          <SlotHost slot="composer.config" context={slotContext} />
          {phoneLayout && <MobileComposerEditEntry editing={mobileRailEditing} onChange={editMobileRail} />}
        </div>
      )}
      {selectingConversation && (
        <div className="composer-selection" role="region" aria-label={tr("conversation.startSession")}>
          <span className="composer-selection-count" role="status">
            {selection.seqs.length === 0
              ? tr("conversation.selectHint")
              : tr("conversation.selectedCount", { count: selection.seqs.length })}
          </span>
          <Button size="sm" variant="quiet" onClick={endConversationSelection}>{tr("common.cancel")}</Button>
          <Button size="sm" variant="primary" disabled={selection.seqs.length === 0} onClick={openConversationStart}>
            {tr("common.continue")}
          </Button>
        </div>
      )}
      {/* Choosing messages takes the editor's place; the draft stays mounted. */}
      <div className="composer-input">
        {activeMode && (
          <div className="composer-mode-chip-row">
            <span className="composer-mode-chip" data-mode={activeMode.id}>
              {activeMode.icon && <span className="composer-mode-chip-icon" aria-hidden="true">{activeMode.icon()}</span>}
              <span className="composer-mode-chip-label">{activeModeLabel}</span>
              <button
                type="button"
                className="composer-mode-chip-leave"
                aria-label={tr("composer.mode.leave", { mode: activeModeLabel })}
                title={`${tr("composer.mode.leave", { mode: activeModeLabel })} (${tr("composer.esc")})`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  leaveMode();
                  inputRef.current?.focus();
                }}
              ><UiIcon icon={CloseIcon} size="sm" /></button>
            </span>
          </div>
        )}
        {shellMode && <div className="composer-mode-label">{tr("composer.shellCommandPermissionCheckedOutputAddedTo")}</div>}
        {!shellMode && !activeMode && ((peopleOnly && !conversation) || (!peopleOnly && personMentions.length > 0)) && (
          <div className="composer-people-mode">
            {peopleOnly && (
              <span className="composer-view-only" role="status">
                <UiIcon icon={ShowIcon} size="sm" />
                <span>{tr("sharing.viewOnly")}</span>
                {session?.sharing?.owner && (
                  <span className="composer-view-only-hint">
                    {tr("composer.people.viewerAskOwner", { name: ownerName(session.sharing.owner) })}
                  </span>
                )}
              </span>
            )}
            {!peopleOnly && (
              <div className="composer-people-toggle" role="radiogroup" aria-label={tr("composer.people.mode")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={peopleMode}
                  onClick={() => setAgentMentionOverride(false)}
                >{tr("composer.people.people")}</button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!peopleMode}
                  onClick={() => setAgentMentionOverride(true)}
                >{tr("composer.agent")}</button>
              </div>
            )}
            {peopleMode && carryControlVisible && (
              <label className="composer-people-carry">
                <Switch checked={carryToAgent} onChange={setCarryToAgent} labelledBy="composer-people-carry-label" />
                <span id="composer-people-carry-label">{tr("composer.people.shareWithAgent")}</span>
              </label>
            )}
          </div>
        )}
        <AdaptiveTextInput
          ref={inputRef}
          data-composer-input=""
          disabled={creatingSession}
          initialText={text}
          rows={3}
          className="composer-editor"
          ariaLabel={tr("composer.message")}
          placeholder={activeMode
            ? modeText(activeMode.placeholder) || activeModeLabel
            : shellMode
            ? tr("composer.enterAWorkspaceShellCommand")
            : peopleOnly
              ? tr(shellLayout === "phone" ? "composer.people.placeholderShort" : "composer.people.placeholder")
              : shellLayout === "phone"
                ? tr("composer.messagePolythShort")
                : tr("composer.messageTheAgentTagFilesOrUse")}
          {...(acView ? {
            role: "combobox",
            ariaAutocomplete: "list" as const,
            ariaExpanded: true,
            ariaControls: "composer-autocomplete-list",
            ...(acSel >= 0 && acOptions[acSel] ? { ariaActiveDescendant: acOptions[acSel].id } : {}),
          } : {})}
          onTextChange={onTextChange}
          onKeyIntercept={onKeyIntercept}
          onUnmovedArrow={onUnmovedArrow}
          onPaste={onPaste}
          onFocusChange={(focused) => {
            if (focused) setInputFocused(true);
            else persistComposerDraft(false); // save locally now; server sync follows idle time
          }}
        />
        {acView && (
          <div className="ac-popup" data-kind={acView.kind}>
            {/* With people listed the groups name themselves; a "Files" title
                above the People group would mislabel it. */}
            {!acGroups.some((group) => group.id === "people") && <div className="ac-header">
              <span className="ac-header-title">{acView.kind === "cmd" ? tr("composer.discovery.actions") : acView.kind === "snip" ? tr("composer.snippets") : tr("composer.files")}</span>
              {acView.kind === "cmd" && acView.resultCount !== undefined && (
                <span className="ac-count" aria-label={tr("composer.discovery.valueAvailable", { value: acView.resultCount })}>{acView.resultCount}</span>
              )}
            </div>}
            {acView.status && (
              <div className="ac-status" id={acOptions.length === 0 ? "composer-autocomplete-list" : undefined}>
                <span>{acView.status.text}</span>
                {acView.status.createSnippet && (
                  <Button
                    size="sm"
                    className="ac-create-snippet"
                    onClick={() => { setAcToken(null); openSettingsPage("commands"); }}
                  >
                    {tr("composer.createASnippet")}</Button>
                )}
              </div>
            )}
            {privateMentionHint && session && (
              <div className="ac-status ac-private-hint">
                <span>{tr("composer.people.privateHint")}</span>
                <Button
                  size="sm"
                  className="ac-create-snippet"
                  onClick={() => { setAcToken(null); openSessionSharing(session.id); }}
                >
                  {tr("sharing.share")}</Button>
              </div>
            )}
            {acOptions.length > 0 && (
              <div
                className="ac-list"
                id="composer-autocomplete-list"
                role="listbox"
                aria-label={acView.kind === "cmd" ? tr("composer.discovery.actions") : acView.kind === "snip" ? tr("composer.snippets") : tr("composer.files")}
              >
                {acGroups.length > 0
                  ? acGroups.map((group) => (
                    <div key={group.id} className="ac-group" role="group" aria-labelledby={`composer-ac-group-${group.id}`}>
                      <div className="ac-group-label" id={`composer-ac-group-${group.id}`}>{group.label}</div>
                      {group.options.map((item) => renderAutocompleteOption(item, acOptionIndex.get(item.id) ?? 0))}
                    </div>
                  ))
                  : acOptions.map((item, index) => renderAutocompleteOption(item, index))}
              </div>
            )}
            {acOptions.length > 0 && (
              <div className="ac-footer">
                <span><kbd>↑↓</kbd> {tr("composer.navigate")}</span>
                <span><kbd>↵</kbd> / <kbd>Tab</kbd> {acView.kind === "cmd" ? tr("settings.pages.use") : tr("composer.insert")}</span>
                <span><kbd>{tr("composer.esc")}</kbd> {tr("composer.dismiss")}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {/* P2-W3A rail: typing first, configuration second. One quiet row under
          the editor — Add (attachments/context/tools), then extensions and
          Send. The model/effort line already sits above the editor.
          Send/Stop is the only filled control; everything else stays quiet. */}
        <ComposerFileInput inputRef={fileInputRef} onFiles={attachFiles} />
        <ComposerFileInput inputRef={photoInputRef} onFiles={attachFiles} accept="image/*" />
        <ComposerFileInput inputRef={cameraInputRef} onFiles={attachFiles} accept="image/*" capture="environment" />
      {selectingConversation ? null : phoneLayout ? (
        <MobileComposerRail
          key={`${activeBrowserAccountId()}:${spaceId}:${activeProjectId ?? ""}`}
          storageKey={mobileRailKey(spaceId ?? "", activeProjectId)}
          context={slotContext}
          add={addControl}
          primary={primaryAction}
          resting={!presentedExpanded}
          editing={mobileRailEditing}
          onEditingChange={editMobileRail}
        />
      ) : (
        <div className="composer-rail">
          <span className="composer-leading-zone customize-zone">
            {addControl}
            {/* Extensions (icon actions) lead the rail. */}
            <span className="composer-extensions composer-mobile-extensions">
              <SlotHost slot="composer.leading" context={slotContext} customizable />
            </span>
            {/* Desktop retains its independent zone customization. */}
            {!phoneLayout && <CustomizeZoneButton slot="composer.leading" align="start" />}
          </span>
          <span className="composer-execution">
            <SlotHost slot="composer.execution" context={slotContext} />
          </span>
          <div className="composer-actions customize-zone">
            <span className="composer-extensions">
              <SlotHost slot="composer.trailing" context={slotContext} customizable />
            </span>
            {!phoneLayout && <CustomizeZoneButton slot="composer.trailing" />}
            <span className="composer-primary">
              {primaryAction}
            </span>
          </div>
        </div>
      )}
      {focusMode && (
        <ComposerFocusDialog
          initialText={inputRef.current?.getText() ?? text}
          onCommit={(t) => {
            setText(t);
            inputRef.current?.replaceText(t);
          }}
          onClose={() => setFocusMode(false)}
          onSend={(t) => send(t)}
        />
      )}
      {contributedDialogs.map((dialog) => (
        <Fragment key={dialog.key}>{dialog.render()}</Fragment>
      ))}
      </GlassDock>
    </div>
  );
}
