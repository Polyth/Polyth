import {
  useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore,
  type ClipboardEvent, type KeyboardEvent,
} from "react";
import {
  activateProject,
  clearNewSessionDraft,
  getState,
  lastSeq,
  openSettingsPage,
  setUiError,
  saveNewSessionDraftText,
  startNewSession,
  useActiveModel,
  useStore,
} from "../store.ts";
import {
  sendMessage,
  abortSession,
  createSession,
  startIsolatedSession,
  rememberProjectModelSelection,
  reconnectSync,
  recheckRuntimeCatalog,
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
import { flushNewSessionHandoffImport } from "@polyth/handoff/web";
import { loadDraft, saveDraft, syncDraftToServer, flushDraftToServer } from "../utils.ts";
import {
  canApplyNextAction,
  canRevertPromptRewrite,
  nextActionInsertMode,
  promptRewriteSource,
  type NextActionRequest,
  type PromptRewrite,
} from "../nextAction.ts";
import { latestCompletedExchange } from "@polyth/session/next-action";
import SlotHost from "./slots/SlotHost.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import { dragKind, dropIntoSession } from "../dnd.ts";
import {
  addAttachment, attachText, attachUpload, clearAttachments, isLargeTextPaste, pendingAttachments, removeAttachment, seedAttachments, takeAttachments, usePendingAttachments,
} from "../attachments.ts";
import {
  attachGithubLink,
  parseGithubUrl,
  tryAttachGithubUrl,
  type GithubAttachResult,
} from "@polyth/github/attachments";
import AttachmentPills from "./AttachmentPills.tsx";
import {
  COMPOSER_INSERT,
  COMPOSER_REPLACE,
  drainComposerReplacement,
  drainInserts,
  requestComposerReplace,
} from "../composerInsert.ts";
import { activeToken, completeToken, shellCommand, type PromptToken } from "../composer/language.ts";
import {
  ATTACHMENT_COMPAT_NOTE,
  catalogFromResult,
  commandAutocomplete,
  mergeCommandCatalog,
  nativeCommandInput,
  fileAutocomplete,
  modelSupportsTextWorkflow,
  OPEN_PROJECT_FIRST,
  planCommandInsert,
  planShellEntry,
  planSigilInsert,
  snippetAutocomplete,
  type AutocompleteViewState,
  type AutocompleteOption,
  type CatalogState,
  type ComposerCommand,
  type InsertPlan,
} from "../composer/discovery.ts";
import {
  loadComposerConfig, saveComposerConfig, consumeComposerConfig, wireProfileId,
  withAutoThinking, withExplicitAgent, withExplicitThinking, withModelForNextTurn,
  withProfile, withProfileNone,
  type ComposerConfig,
} from "../composerConfig.ts";
import { shouldHandlePromptHistoryKey } from "../composer/history.ts";
import { usePromptHistory } from "../composer/usePromptHistory.ts";
import type { PickerItem } from "../picker.ts";
import Picker from "./Picker.tsx";
import AdaptiveTextInput, { type TextInputHandle } from "./input/AdaptiveTextInput.tsx";
import ComposerAddMenu from "./ComposerAddMenu.tsx";
import EffortMenu from "./EffortMenu.tsx";
import ComposerFocusDialog from "./ComposerFocusDialog.tsx";
import QueuedMessageList, { latestSteerableQueuedItem } from "./QueuedMessageList.tsx";
import { GoalAttachForm } from "../../../../packages/goals/widgets/GoalStrip.tsx";
import { announce } from "./a11y/live.tsx";
import { noteModelUsed } from "@polyth/models/web-prefs";
import { getUiSettings, setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { migrateFavoritesOnce, profilesLoaded, useProfiles } from "../profiles.ts";
import type {
  DraftExecutionConfig,
  ModelRef,
  QueueItemDto,
  RuntimeCapabilities,
  RuntimeCommandDescriptor,
  SessionProjection,
} from "@polyth/contracts";
import { agentPickerDefaultLabel } from "../composerDefaults.ts";
import { friendlyError, matchesSendShortcut, modKeyLabel, parseModelRef } from "../settings.ts";
import { Icon } from "../icons.tsx";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { modelSupportsThinking } from "@polyth/models/model-presentation";
import { resolveProjectModelDefault, useSessionDefaults } from "../sessionDefaults.ts";
import { contextTokensUsed } from "../reduce.ts";
import { effectiveAttachmentSupport, attachmentModality } from "@polyth/harness-runtime";
import { getModelThinking, setModelThinking } from "../thinkingPrefs.ts";
import { roleKind, useRolePrefs } from "../rolePrefs.ts";
import { useShellMode } from "../responsiveShell.ts";
import {
  clearDraftExecutionConfig,
  emptyDraftExecutionConfig,
  readDraftExecutionConfig,
  subscribeDraftExecutionConfig,
  updateDraftExecutionConfig,
} from "../executionDraft.ts";
import { dismissKeyboard, useViewportMetrics } from "../mobileViewport.ts";
import { tr } from "../i18n/index.ts";
import SessionContextBar, {
  type ContextChoice,
  type SessionContextBarProps,
} from "./mobile/SessionContextBar.tsx";
import { Button, CheckIcon, GlassDock, IconButton, Menu, MoreIcon, Notice, QueueIcon, SendIcon, StopIcon } from "./ui/index.ts";
import { getSendFailure, subscribeSendFailures } from "../sendFailure.ts";
import { isNativeMobile } from "@polyth/mobile/runtime";
import { pickNativeFiles } from "@polyth/mobile/native";

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

type NewSessionTarget =
  | { kind: "main" }
  | { kind: "worktree"; path: string }
  /** Check the branch out in a fresh linked worktree. `base` is set for a
   *  remote-only branch — the new local branch starts from that remote ref. */
  | { kind: "branch"; branch: string; base?: string }
  /** Fork a brand-new linked worktree from `base` (any branch, including the
   *  current one) — the "New worktree" checkbox inside the branch picker. */
  | { kind: "new-worktree"; base: string };

type LocationChoice = ContextChoice & {
  target: NewSessionTarget;
};

/** Project/worktree context is composer chrome, not fresh-session chrome.
 * Keeping it here makes every chat call site render the same complete entity. */
function useComposerLocation(session: SessionProjection | null): {
  contextBar: SessionContextBarProps;
  newSessionTarget: NewSessionTarget;
} {
  const projects = useStore((state) => state.projectRegistry.projects);
  const projectId = useStore((state) => state.activeProjectId);
  const newSessionIntent = useStore((state) => state.newSessionIntent);
  const branch = useStore((state) => state.gitBranch);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const intendedWorktree = session?.worktreePath
    ?? (newSessionIntent?.projectId === projectId ? newSessionIntent.worktreePath : undefined);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<GitBranches>({ current: "", branches: [] });
  const [branchLoading, setBranchLoading] = useState(false);
  const [selectedBranchId, setSelectedBranchId] = useState(
    intendedWorktree ? `worktree:${intendedWorktree}` : "main",
  );
  // "New worktree" mode: a checkbox in the branch picker that turns every
  // branch row into a fork point for a fresh linked worktree.
  const [newWorktreeMode, setNewWorktreeMode] = useState(false);
  // Opening the branch picker pulls the remote once per project so branches
  // that only exist on the server show up as fork points.
  const remoteFetchedRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    setSelectedBranchId(intendedWorktree ? `worktree:${intendedWorktree}` : "main");
    setNewWorktreeMode(false);
    const sessionId = session?.id;
    const sessionBranch = session?.branch;
    // The context bar is hidden while a session is open, so its data is unused.
    if (session || !projectId) {
      setWorktrees([]);
      setBranches({ current: "", branches: [] });
      return () => { active = false; };
    }
    setBranchLoading(true);
    void Promise.all([api.listWorktrees(projectId), api.gitBranches(projectId, sessionId)])
      .then(([nextWorktrees, nextBranches]) => {
        if (!active) return;
        setWorktrees(nextWorktrees);
        setBranches(nextBranches);
        const currentWorktree = intendedWorktree
          ? nextWorktrees.find((worktree) => worktree.path === intendedWorktree)
          : nextWorktrees.find((worktree) =>
              worktree.branch === (nextBranches.current || sessionBranch || branch));
        setSelectedBranchId(currentWorktree?.isMain
          ? "main"
          : currentWorktree
            ? `worktree:${currentWorktree.path}`
            : intendedWorktree
              ? `worktree:${intendedWorktree}`
              : "main");
      })
      .catch((error) => {
        if (active) setUiError(friendlyError(tr("composer.couldnTLoadWorktrees"), error));
      })
      .finally(() => {
        if (active) setBranchLoading(false);
      });
    return () => { active = false; };
  }, [projectId, session?.id, session?.worktreePath, session?.branch, newSessionIntent?.worktreePath, branch]);

  // Fired when the branch picker opens: fetch the remote (best effort) and
  // re-read the branch list so server-only branches become selectable. Runs
  // at most once per project so reopening the picker stays instant.
  const refreshBranchesFromRemote = useCallback(() => {
    if (session || !projectId || remoteFetchedRef.current === projectId) return;
    remoteFetchedRef.current = projectId;
    void (async () => {
      try {
        await api.gitFetch(projectId).catch(() => undefined);
        const [nextWorktrees, nextBranches] = await Promise.all([
          api.listWorktrees(projectId),
          api.gitBranches(projectId),
        ]);
        setWorktrees(nextWorktrees);
        setBranches(nextBranches);
      } catch {
        // A failed refresh leaves the already-loaded local branches in place.
        remoteFetchedRef.current = null;
      }
    })();
  }, [projectId, session]);

  const currentBranchName = worktrees.find((worktree) => worktree.isMain)?.branch
    || branches.current
    || branch
    || "";

  const branchChoices = useMemo<LocationChoice[]>(() => {
    const linkedBranches = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
    const localBranches = branches.branches.filter((candidate) => !candidate.remote);
    // Branches that only exist on a remote, keyed by the local name a checkout
    // would create. `ref` (e.g. `origin/foo`) is the start point.
    const localNames = new Set(localBranches.map((candidate) => candidate.name));
    const remoteOnly: Array<{ short: string; ref: string }> = [];
    const seenRemote = new Set<string>();
    for (const candidate of branches.branches) {
      if (!candidate.remote) continue;
      const short = candidate.name.slice(candidate.remote.length + 1);
      if (!short || short === "HEAD" || short.startsWith("HEAD ")) continue;
      if (localNames.has(short) || seenRemote.has(short)) continue;
      seenRemote.add(short);
      remoteOnly.push({ short, ref: candidate.name });
    }

    if (newWorktreeMode) {
      // Isolation starts from a live checkout so merge-back has a truthful cwd.
      const seen = new Set<string>();
      const choices: LocationChoice[] = [];
      if (currentBranchName) {
        seen.add(currentBranchName);
        choices.push({
          id: `branch:${currentBranchName}`,
          label: currentBranchName,
          detail: tr("gitview.current"),
          target: { kind: "new-worktree", base: currentBranchName },
        });
      }
      for (const worktree of worktrees) {
        const name = worktree.branch;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        choices.push({
          id: `branch:${name}`,
          label: name,
          target: { kind: "new-worktree", base: name },
        });
      }
      return choices;
    }

    const choices: LocationChoice[] = [{
      id: "main",
      label: currentBranchName || tr("composer.mainWorkspace"),
      detail: tr("composer.mainWorkspace"),
      target: { kind: "main" },
    }];
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
  }, [worktrees, branches, branch, newWorktreeMode, currentBranchName]);

  const selectedChoice = branchChoices.find((choice) => choice.id === selectedBranchId);
  const newSessionTarget: NewSessionTarget = selectedChoice?.target
    ?? (intendedWorktree
      ? { kind: "worktree", path: intendedWorktree }
      : { kind: "main" });
  const rawBranchLabel = selectedChoice?.label
    || session?.branch
    || branch
    || intendedWorktree?.split("/").pop()
    || tr("composer.mainWorkspace");
  const branchName = newSessionTarget.kind === "new-worktree"
    ? `${rawBranchLabel} · ${tr("worktreesessiondialog.newWorktree")}`
    : rawBranchLabel;
  const projectName = project?.name || project?.path || tr("composer.noProject");
  const projectChoices: ContextChoice[] = projects.map((candidate) => ({
    id: candidate.id,
    label: candidate.name || candidate.path,
    detail: candidate.name ? candidate.path : "",
  }));

  const pickBranch = (id: string) => {
    const choice = branchChoices.find((candidate) => candidate.id === id);
    if (!choice || id === selectedBranchId) return;
    setSelectedBranchId(id);
    if (!session || !projectId) return;

    if (choice.target.kind === "main") {
      startNewSession(projectId);
    } else if (choice.target.kind === "worktree") {
      startNewSession(projectId, { worktreePath: choice.target.path });
    } else if (choice.target.kind === "branch") {
      setBranchLoading(true);
      void api.createWorktree(projectId, choice.target.branch, undefined, choice.target.base)
        .then((worktree) => startNewSession(projectId, { worktreePath: worktree.path }))
        .catch((error) => setUiError(friendlyError(tr("composer.couldnTCreateTheWorktree"), error)))
        .finally(() => setBranchLoading(false));
    } else {
      // Isolation fork point is recorded on send; don't create a workspace yet.
    }
  };

  // Toggling the mode keeps the selection meaningful: the current branch and
  // the "main workspace" row are two views of the same checkout.
  const toggleNewWorktree = (on: boolean) => {
    setNewWorktreeMode(on);
    setSelectedBranchId((prev) => {
      if (on && prev === "main") {
        return currentBranchName ? `branch:${currentBranchName}` : prev;
      }
      if (!on && currentBranchName && prev === `branch:${currentBranchName}`) {
        return "main";
      }
      return prev;
    });
  };

  return {
    newSessionTarget,
    contextBar: {
      projectName,
      ...(projectId ? { projectId } : {}),
      projects: projectChoices,
      onPickProject: (id) => activateProject(id || null),
      branchName,
      branchId: selectedBranchId,
      branches: branchChoices,
      ...(branchLoading ? { branchLoading: true } : {}),
      onPickBranch: pickBranch,
      onBranchPickerOpen: refreshBranchesFromRemote,
      newWorktreeMode,
      onToggleNewWorktree: toggleNewWorktree,
    },
  };
}

function agentBadgeLabel(agent?: string): string {
  const label = (agent || tr("composer.build")).replace(/[-_]+/g, " ").trim();
  return label ? label[0]!.toUpperCase() + label.slice(1) : tr("composer.build");
}

type QueueEdit = {
  id: string;
  sessionId: string;
  /** Preserve an unrelated composer draft while the queued item is edited. */
  draftBefore: string;
};

export default function Composer({
  variant = "docked",
}: {
  variant?: "docked" | "widget";
}) {
  const [goalFormOpen, setGoalFormOpen] = useState(false);
  const [goalAttachBusy, setGoalAttachBusy] = useState(false);
  const [autoApproveBusy, setAutoApproveBusy] = useState(false);
  const [newSessionAutoApprove, setNewSessionAutoApprove] = useState(false);
  const [newSessionGoal, setNewSessionGoal] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [draftExecution, setDraftExecution] = useState<DraftExecutionConfig>(() =>
    activeProjectId ? readDraftExecutionConfig(activeProjectId) : emptyDraftExecutionConfig());
  useEffect(() => {
    const refresh = () => setDraftExecution(activeProjectId
      ? readDraftExecutionConfig(activeProjectId)
      : emptyDraftExecutionConfig());
    refresh();
    return subscribeDraftExecutionConfig(refresh);
  }, [activeProjectId]);
  const profiles = useProfiles();
  const globalModels = useStore((s) => s.models);
  const globalAgents = useStore((s) => s.agents);
  const activeProject = useStore((s) =>
    s.projectRegistry.projects.find((candidate) => candidate.id === s.activeProjectId));
  const rolePrefs = useRolePrefs();
  const settings = useStore((s) => s.settings);
  const sessionDefaults = useSessionDefaults();
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const selectedDraftHarness = !session
    ? draftExecution.harnessSelection.mode === "pinned"
      ? draftExecution.harnessSelection.harnessId
      : !draftExecution.harnessSelectionExplicit && activeProject?.defaults?.harness?.mode === "pinned"
        ? activeProject.defaults.harness.harnessId
        : undefined
    : undefined;
  const routeCatalog = useRuntimeCatalog(session, globalModels, globalAgents, {
    projectId: activeProjectId ?? undefined,
    harnessId: selectedDraftHarness,
  });
  const catalogHarnessId = session?.resolvedHarnessId ?? routeCatalog.harnessId ?? selectedDraftHarness;
  const effectiveDraftHarness = session ? undefined : catalogHarnessId;
  const models = catalogHarnessId
    ? routeCatalog.models.filter((item) => !item.harnessId || item.harnessId === catalogHarnessId)
    : routeCatalog.models;
  const agents = catalogHarnessId
    ? routeCatalog.agents.filter((item) => !item.harnessId || item.harnessId === catalogHarnessId)
    : routeCatalog.agents;
  const chatModels = models.filter(modelSupportsTextWorkflow);
  const activeSessionSeq = useStore((s) => {
    const events = s.activeSessionId ? s.events[s.activeSessionId] : undefined;
    return events?.at(-1)?.seq ?? 0;
  });
  const hasCompletedExchange = useStore((s) => {
    const events = s.activeSessionId ? s.events[s.activeSessionId] : undefined;
    return !!events && latestCompletedExchange(events) !== null;
  });
  const failedSend = useSyncExternalStore(
    subscribeSendFailures,
    () => getSendFailure(session?.id ?? null),
    () => null,
  );
  const newSessionIntent = useStore((s) => s.newSessionIntent);
  const { contextBar, newSessionTarget } = useComposerLocation(session);
  const model = useActiveModel();
  const working = model.turn?.status === "working";
  // The session projection can lag the event log (e.g. a re-attach marks the
  // session `unknown` after the turn already stopped). A terminal turn status
  // is authoritative: never offer Stop for a turn the log has already closed.
  const turn = model.turn;
  const canStop = working;
  const abortPendingRef = useRef(false);
  const [abortPending, setAbortPending] = useState(false);
  useEffect(() => {
    if (!canStop) {
      abortPendingRef.current = false;
      setAbortPending(false);
    }
  }, [canStop]);
  const stopActiveTurn = useCallback(async () => {
    // One stop intent per active turn. If the stream settles while the request
    // is in flight, the idle Send state wins and the late response is ignored.
    if (!canStop || abortPendingRef.current) return;
    abortPendingRef.current = true;
    setAbortPending(true);
    try {
      await abortSession();
    } finally {
      abortPendingRef.current = false;
      setAbortPending(false);
    }
  }, [canStop]);
  const noModels = chatModels.length === 0 && !routeCatalog.nativeDefault;
  // The server-known cause, when there is one. "Check that the backend is
  // running" is a guess; this is what actually went wrong.
  const runtimeUnavailable = useStore((s) => s.runtimeUnavailable);
  const [showModelWarning, setShowModelWarning] = useState(false);
  useEffect(() => {
    if (!noModels) {
      setShowModelWarning(false);
      return;
    }
    const timer = setTimeout(() => setShowModelWarning(true), MODEL_WARNING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [noModels]);
  const widgetMode = variant === "widget";
  const shellLayout = useShellMode();

  // IME-safe input: the DOM owns live text; `text` tracks committed edits only.
  const inputRef = useRef<TextInputHandle>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const [text, setText] = useState(() => (
    session?.id ? loadDraft(session.id) : newSessionIntent?.draft ?? ""
  ));
  const [queueEdit, setQueueEdit] = useState<QueueEdit | null>(null);
  const [queueEditStarting, setQueueEditStarting] = useState(false);
  const [queueEditSaving, setQueueEditSaving] = useState(false);
  const [queuedItems, setQueuedItems] = useState<QueueItemDto[]>([]);
  const [steeringQueuedId, setSteeringQueuedId] = useState<string | null>(null);
  const steeringQueuedBySessionRef = useRef(new Map<string, string>());
  const queueEditRef = useRef<QueueEdit | null>(null);
  queueEditRef.current = queueEdit;
  const committedTextRef = useRef(text);
  committedTextRef.current = text;
  const draftRevisionRef = useRef(0);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const [promptRewrite, setPromptRewrite] = useState<PromptRewrite | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  // UX-MOBILE-01 §9/§10/§11/§42: on phones the composer is a compact resting
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

  // UX-MOBILE-01 §31/§45: keyboard geometry is one source of truth —
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
  const shell = shellCommand(text);
  const shellMode = shell !== null;

  // UX-COMPOSER-DISC: one pending execution configuration (profile / model /
  // agent) per canonical session, persisted with the draft. Selections flow
  // through composerConfig transitions so profile and explicit overrides
  // clear each other.
  const [cfg, setCfg] = useState<ComposerConfig>(() => loadComposerConfig(session?.id ?? null));
  const priorRoute = useRef({ sessionId: session?.id, harnessId: session?.resolvedHarnessId });
  useEffect(() => {
    if (!routeCatalog.ready) return;
    if (priorRoute.current.sessionId === session?.id && priorRoute.current.harnessId !== session?.resolvedHarnessId) {
      const harnessId = session?.resolvedHarnessId;
      const compatibleModel = cfg.model && routeCatalog.models.some((model) =>
        model.providerID === cfg.model?.providerID
        && model.modelID === cfg.model?.modelID
        && (!harnessId || model.harnessId === harnessId));
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
  const updateCfg = useCallback((next: ComposerConfig) => {
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
    const compatibleModel = cfg.model && routeCatalog.models.some((model) =>
      (!model.harnessId || model.harnessId === effectiveDraftHarness)
      && model.providerID === cfg.model?.providerID
      && model.modelID === cfg.model?.modelID);
    const compatibleAgent = cfg.agent && routeCatalog.agents.some((agent) =>
      (!agent.harnessId || agent.harnessId === effectiveDraftHarness) && agent.name === cfg.agent);
    const draftProfileId = cfg.profile.kind === "id" ? cfg.profile.id : undefined;
    const compatibleProfile = !draftProfileId || profiles.some((profile) =>
      profile.id === draftProfileId && (profile.harnessId ?? "opencode") === effectiveDraftHarness);
    const next: ComposerConfig = {
      profile: compatibleProfile ? cfg.profile : { kind: "inherit" },
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

  // Save the live composer text to the local draft store and the server, on
  // focus loss / session switch / unmount — never while typing (a server
  // broadcast echoing the debounced autosave would reset the live input to
  // the older value). While editing a queued message the unrelated draft is
  // preserved untouched.
  const flushComposerDraft = useCallback(() => {
    const id = sessionIdRef.current;
    if (id === null) return;
    const editing = queueEditRef.current;
    const nav = promptHistoryNavRef.current;
    const live = nav.isBrowsing()
      ? (nav.snapshot()?.text ?? inputRef.current?.getText() ?? committedTextRef.current)
      : inputRef.current?.getText() ?? committedTextRef.current;
    saveDraft(id, editing?.sessionId === id ? editing.draftBefore : live);
    flushDraftToServer(id);
  }, []);

  // Session switch: restore the draft through the command handle (never a
  // controlled replay), and never while the user is mid-composition. The
  // pending execution configuration is per-session and reloads with it.
  // Deliberately NOT reactive to session.draft: live cross-client draft
  // updates apply below, only when the composer is empty.
  //
  // This effect is registered after usePromptHistory(). The hook must not
  // destroy the browse snapshot on sessionId change, or this flush would
  // persist the recalled textarea instead of the canonical draft.
  useEffect(() => {
    const outgoing = sessionIdRef.current;
    if (outgoing !== null && outgoing !== (session?.id ?? null)) {
      flushComposerDraft();
      const editing = queueEditRef.current;
      if (editing?.sessionId === outgoing) void api.queueEditCancel(outgoing, editing.id).catch(() => {});
    }
    sessionIdRef.current = session?.id ?? null;
    setPendingLargePaste(null);
    // Prefer server-synced draft from the projection (cross-client sync);
    // fall back to localStorage for offline / fast local edits.
    const serverDraft = session?.draft;
    const localDraft = session?.id ? loadDraft(session.id) : "";
    const t = session?.id
      ? (serverDraft !== undefined && serverDraft !== localDraft ? serverDraft : localDraft || serverDraft || "")
      : newSessionIntent?.draft ?? "";
    setText(t);
    inputRef.current?.replaceText(t);
    // If server draft differs from local, update localStorage to match.
    if (session?.id && serverDraft !== undefined && serverDraft !== localDraft) {
      saveDraft(session.id, serverDraft);
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
    setPromptRewrite(null);
  }, [session?.id, newSessionIntent, flushComposerDraft]);

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
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (rootRef.current?.contains(target)) return;
      // Sheets are portalled to <body>; an action inside one is still composer
      // interaction and must not collapse the surface behind it.
      if (target?.closest?.(".sheet-backdrop")) return;
      setInputFocused(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [inputFocused]);

  // Pane and session transitions must not depend on the debounce. Flush the
  // canonical draft synchronously on pagehide and unmount.
  useEffect(() => {
    window.addEventListener("pagehide", flushComposerDraft);
    return () => {
      window.removeEventListener("pagehide", flushComposerDraft);
      flushComposerDraft();
      const editing = queueEditRef.current;
      if (editing) void api.queueEditCancel(editing.sessionId, editing.id).catch(() => {});
    };
  }, [flushComposerDraft]);

  // Debounced LOCAL persistence while typing (refresh-safe). Server sync is
  // deferred to focus loss / send / session switch: a broadcast arriving
  // mid-typing would reset the live input to the older server value.
  useEffect(() => {
    const id = session?.id;
    if (!id || queueEdit?.sessionId === id) return;
    if (promptHistoryNavRef.current.isBrowsing()) return;
    const t = setTimeout(() => saveDraft(id, text), 250);
    return () => clearTimeout(t);
  }, [session?.id, text, queueEdit]);

  // Apply server-side draft updates from other clients when the composer is
  // empty (user hasn't started typing). Active local edits always win — the
  // focus-loss flush ensures the server catches up.
  const lastServerDraftRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const serverDraft = session?.draft;
    if (serverDraft === undefined) return;
    if (serverDraft === lastServerDraftRef.current) return;
    lastServerDraftRef.current = serverDraft;
    // Only apply if the composer is empty (no local work in progress).
    if (!text && serverDraft) {
      setText(serverDraft);
      inputRef.current?.replaceText(serverDraft);
      if (session?.id) saveDraft(session.id, serverDraft);
    }
  }, [session?.draft, session?.id, text]);

  // Drag-and-drop: tree paths and desktop files become attachment pills.
  const [dropHint, setDropHint] = useState<"path" | "files" | null>(null);

  // Pending attachment pills live in the per-session draft store (F2).
  // History browsing overlays recalled refs locally; the canonical store is
  // untouched until a genuine edit or send.
  const pending = usePendingAttachments(session?.id ?? null);
  const attachments = promptHistoryNav.displayedAttachments ?? pending;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingLargePaste, setPendingLargePaste] = useState<{
    text: string;
    projectId: string;
    sessionId: string | null;
  } | null>(null);
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
          name: "pasted-context.txt",
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
  const openAttachmentPicker = useCallback(() => {
    if (!isNativeMobile()) {
      fileInputRef.current?.click();
      return;
    }
    void pickNativeFiles().then((result) => {
      if (result.status === "picked") attachFiles(result.files);
      else if (result.status === "denied" || result.status === "failed") setUiError(result.message);
      // Native cancellation is a normal no-op and keeps the draft untouched.
    });
  }, [attachFiles]);

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
    if (!parseGithubUrl(pasted)) return;
    e.preventDefault();
    const target = sessionIdRef.current;
    void tryAttachGithubUrl(projectId, target, pasted).then((consumed) => {
      if (!consumed) inputRef.current?.insertText(pasted);
    });
  }, [attachFiles, attachPastedText]);

  // ---- capability catalogs (UX-COMPOSER-DISC) --------------------------------
  // Strict independent command/snippet outcomes; an HTTP failure is
  // `unavailable`, never a successful empty list.
  const globalDefaultModel = sessionDefaults.defaultModel ?? parseModelRef(settings.defaultModel);
  const preferredModel = resolveProjectModelDefault(
    activeProject?.defaults,
    globalDefaultModel,
    chatModels[0],
  );
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

  // Auto-grow (§20). The ceiling follows the VISUAL viewport, so an open
  // keyboard shrinks the input instead of pushing the send button offscreen;
  // past the ceiling the textarea scrolls internally.
  // Re-grow when the visible band changes (keyboard, toolbar, rotation):
  // the cap depends on it, so a text-only trigger is not enough. Reactive —
  // reading getViewportMetrics() during render never re-fires on change.
  const bandHeight = useViewportMetrics().height;
  const keyboardOpen = useViewportMetrics().covering;
  useEffect(() => {
    const el = inputRef.current?.element();
    if (!el) return;
    const visible = bandHeight || window.innerHeight;
    // Phones collapse to zero first: `auto` resolves to the `rows` attribute,
    // which would keep an empty composer three lines tall (§7). Wider layouts
    // keep the roomier three-row resting size.
    const phone = isPhone;
    el.style.height = phone ? "0px" : "auto";
    // The visible viewport supplies the emergency cap; the shared
    // --composer-max-input-height token supplies the normal five-line cap.
    // On phones the input never grows past the room its own chrome (model
    // header, actions, context bar) needs on a keyboard-squeezed viewport.
    const cap = phone
      ? Math.max(44, Math.min(visible * 0.42, visible - 240))
      : Math.max(44, visible * 0.42);
    el.style.height = `${Math.min(el.scrollHeight + 2, cap)}px`;
  }, [text, inputFocused, isPhone, bandHeight]);

  // Composer inserts (Files @, drag-drop, starter chips). preventDefault marks
  // the event consumed; anything queued while unmounted drains now. Inserts go
  // through the command handle so an active composition is never interrupted.
  useEffect(() => {
    const replaceText = (detail: string) => {
      draftRevisionRef.current += 1;
      setText(detail);
      inputRef.current?.replaceText(detail);
    };
    const insert = (detail: string) => {
      const h = inputRef.current;
      if (!h) return;
      draftRevisionRef.current += 1;
      const cur = h.getText();
      h.replaceText(cur ? `${cur} ${detail}` : detail);
    };
    const queuedReplacement = drainComposerReplacement();
    if (queuedReplacement !== undefined) replaceText(queuedReplacement);
    for (const queued of drainInserts()) insert(queued);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      e.preventDefault();
      insert(detail);
      inputRef.current?.focus();
    };
    const replace = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      e.preventDefault();
      replaceText(detail);
      inputRef.current?.focus();
    };
    window.addEventListener(COMPOSER_INSERT, handler);
    window.addEventListener(COMPOSER_REPLACE, replace);
    return () => {
      window.removeEventListener(COMPOSER_INSERT, handler);
      window.removeEventListener(COMPOSER_REPLACE, replace);
    };
  }, []);

  // A selected profile that was deleted after selection blocks Send with a
  // visible state; it is never silently substituted.
  const profileMissing = profilesLoaded()
    && cfg.profile.kind === "id"
    && !profiles.some((p) => cfg.profile.kind === "id" && p.id === cfg.profile.id);

  const beginQueuedEdit = useCallback((item: QueueItemDto) => {
    if (queueEditRef.current || queueEditStarting) {
      announce(tr("composer.finishEditingCurrentQueuedMessageFirst"));
      return;
    }
    const target = sessionIdRef.current;
    if (!target || target !== item.sessionId) return;
    setQueueEditStarting(true);
    void api.queueEditStart(target, item.id)
      .then((reserved) => {
        if (sessionIdRef.current !== target) {
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
    let reserved = false;
    try {
      // Reserve before steering so turn completion cannot dispatch the same
      // queue row while this request is promoting it.
      const current = await api.queueEditStart(target, item.id);
      reserved = true;
      const cfgSent = cfg;
      const selected = cfgSent.model ?? session?.model ?? preferredModel;
      const descriptor = selected && chatModels.find((candidate) =>
        candidate.providerID === selected.providerID && candidate.modelID === selected.modelID);
      const requestedThinking = cfgSent.thinking !== undefined
        ? cfgSent.thinking
        : getModelThinking(selected) ?? sessionDefaults.defaultThinking;
      const thinking = typeof requestedThinking === "string" && descriptor?.variants?.includes(requestedThinking)
        ? requestedThinking
        : undefined;
      const selectedModel = selected && descriptor
        ? { providerID: selected.providerID, modelID: selected.modelID, ...(thinking ? { variant: thinking } : {}) }
        : undefined;
      const profile = wireProfileId(cfgSent);
      const ok = await sendMessage(current.text, selectedModel, cfgSent.agent, {
        targetSessionId: target,
        delivery: "steer",
        ...(current.attachments?.length ? { attachments: current.attachments } : {}),
        dismissPending: true,
        ...(profile !== undefined ? { agentProfileId: profile } : {}),
      });
      if (!ok) return;
      consumeComposerConfig(target, cfgSent);
      if (sessionIdRef.current === target) setCfg(loadComposerConfig(target));
      await api.queueRemove(target, current.id);
      setQueuedItems((items) => items.filter((candidate) => candidate.id !== current.id));
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "not-found" || (reserved && code === "conflict")) {
        setQueuedItems((items) => items.filter((candidate) => candidate.id !== item.id));
      } else if (code !== "conflict") {
        setUiError(friendlyError(tr("common.error"), error));
      }
    } finally {
      // Also restarts queue dispatch if the turn ended while the row was held.
      if (reserved) await api.queueEditCancel(target, item.id).catch(() => {});
      if (steeringQueuedBySessionRef.current.get(target) === item.id) {
        steeringQueuedBySessionRef.current.delete(target);
      }
      setSteeringQueuedId((current) => current === item.id ? null : current);
    }
  }, [cfg, session?.model, preferredModel, chatModels, sessionDefaults.defaultThinking]);

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
    reconnectSync();
  }, []);

  const send = useCallback((
    override?: string,
    deliveryOverride?: "steer" | "queue" | "interrupt",
  ) => {
    if (creatingSession) return;
    if (session?.status === "epoch-pending" && session.runtimeControl === "borrowed") return;
    const t = (override ?? inputRef.current?.getText() ?? text).trim();
    const target = sessionIdRef.current;
    if (queueEdit) {
      if (!target || target !== queueEdit.sessionId || !t || queueEditSaving) return;
      const editing = queueEdit;
      setQueueEditSaving(true);
      const save = deliveryOverride === "interrupt"
        ? api.queueSendNow(target, editing.id, t)
        : api.queueEdit(target, editing.id, t);
      void save
        .then(() => {
          // The server updates the existing queue row, so it retains its
          // position and delivery metadata instead of becoming a new message.
          if (queueEditRef.current?.id === editing.id) setQueueEdit(null);
          if (sessionIdRef.current !== target) return;
          setText(editing.draftBefore);
          inputRef.current?.replaceText(editing.draftBefore);
          saveDraft(target, editing.draftBefore);
          promptHistoryNav.reset();
          announce(tr("composer.queuedMessageValueUpdatedInPlace", { id: editing.id }));
        })
        .catch((error) => setUiError(friendlyError("Couldn’t update queued message", error)))
        .finally(() => setQueueEditSaving(false));
      return;
    }
    const command = shellCommand(t);
    const hasPills = command === null && attachments.length > 0;
    if (!t && !hasPills) {
      if (emptySteerItem) void steerQueuedItem(emptySteerItem);
      return;
    }
    if (command === "") return;
    if (command === null && noModels) {
      // Never a silent no-op: pressing Enter while the model catalog is empty
      // (backend still starting / restarting) surfaces the same guidance as
      // the composer banner instead of appearing to swallow the message.
      setUiError(
        runtimeUnavailable?.message
          ?? tr("composer.noModelsAvailableCheckThatTheBackend"),
      );
      return;
    }
    if (command === null && profileMissing) return;
    // Capture the target session at send time — project/session switches must
    // never reroute a send (delivery admission handles active turns server-side).
    // Pills leave the draft the moment the message leaves the composer.
    const recalled = promptHistoryNav.takeDisplayedForSend();
    const atts = command === null ? (recalled ?? takeAttachments(target)) : [];
    if (command === null && recalled) clearAttachments(target);
    const delivery = working ? deliveryOverride ?? getUiSettings().followUpBehavior : undefined;
    const cfgSent = cfg;
    const wire = wireProfileId(cfgSent);
    const selected = cfgSent.model ?? session?.model ?? preferredModel;
    const selectedDescriptor = selected
      ? chatModels.find((candidate) =>
          candidate.providerID === selected.providerID && candidate.modelID === selected.modelID)
      : undefined;
    const requestedThinking = cfgSent.thinking !== undefined
      ? cfgSent.thinking
      : getModelThinking(selected) ?? sessionDefaults.defaultThinking;
    const sentThinking = typeof requestedThinking === "string"
      && selectedDescriptor?.variants?.includes(requestedThinking)
      ? requestedThinking
      : undefined;
    const sentModel = selected && selectedDescriptor
      ? {
          providerID: selected.providerID,
          modelID: selected.modelID,
          ...(sentThinking ? { variant: sentThinking } : {}),
        }
      : undefined;
    const selectedNativeCommand = command === null && commandCatalog.state === "available"
      ? nativeCommandInput(t, commandCatalog.items, selectedCommandRef.current)
      : undefined;
    const selectedProfileId = cfgSent.profile.kind === "id" ? cfgSent.profile.id : undefined;
    const selectedProfile = selectedProfileId
      ? profiles.find((profile) => profile.id === selectedProfileId)
      : undefined;
    const modelHarnessId = selectedDescriptor?.harnessId ?? draftExecution.model?.harnessId;
    const creationHarness = selectedProfile
      ? { mode: "pinned" as const, harnessId: selectedProfile.harnessId ?? "opencode" }
      : modelHarnessId
        ? { mode: "pinned" as const, harnessId: modelHarnessId }
        : draftExecution.harnessSelectionExplicit
          ? draftExecution.harnessSelection
          : activeProject?.defaults?.harness ?? undefined;
    const deliver = (targetSessionId: string) => command !== null
      ? api.runShell(targetSessionId, command).then(() => {
          promptHistoryNav.reload();
        }).catch(
          (err) => setUiError(tr("composer.couldNotRunShellCommand", {
            reason: err instanceof Error ? err.message : String(err),
          })),
        )
      : sendMessage(
          t,
          sentModel,
          cfgSent.agent,
          {
            targetSessionId,
            ...(selectedNativeCommand ? { command: selectedNativeCommand } : {}),
            ...(atts.length > 0 ? { attachments: atts } : {}),
            ...(delivery ? { delivery } : {}),
            dismissPending: true,
            ...(wire !== undefined ? { agentProfileId: wire } : {}),
          },
        ).then((ok) => {
          if (!ok) {
            // Admission failures remove attachment pills optimistically below;
            // put them back, and restore the exact draft only when the user
            // has not already started a replacement while the request ran.
            for (const attachment of atts) addAttachment(targetSessionId, attachment);
            if (sessionIdRef.current === targetSessionId
              && !(inputRef.current?.getText() ?? "").trim()) {
              setText(t);
              inputRef.current?.replaceText(t);
              saveDraft(targetSessionId, t);
            }
            return;
          }
          promptHistoryNav.reload();
          // The server recorded the sent configuration in the projection and
          // durable log; drop the local pending record only when it still
          // equals what was sent, then reflect the authoritative state.
          consumeComposerConfig(target, cfgSent);
          if (sessionIdRef.current === target) setCfg(loadComposerConfig(target));
        });
    if (target) {
      void deliver(target);
    } else if (activeProjectId) {
      setCreatingSession(true);
      void (async () => {
        let created: string;
        if (newSessionTarget.kind === "new-worktree") {
          created = await startIsolatedSession(activeProjectId, {
            harness: creationHarness,
            ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
            ...(sentModel ? { model: sentModel } : {}),
            ...(cfgSent.agent ? { agent: cfgSent.agent } : {}),
            ...(newSessionTarget.base ? { targetBranch: newSessionTarget.base } : {}),
            precache: true,
          });
        } else {
          let worktreePath = newSessionTarget.kind === "main"
            ? undefined
            : newSessionIntent?.worktreePath;
          if (newSessionTarget.kind === "worktree") {
            worktreePath = newSessionTarget.path;
          } else if (newSessionTarget.kind === "branch") {
            worktreePath = (await api.createWorktree(
              activeProjectId,
              newSessionTarget.branch,
              undefined,
              newSessionTarget.base,
            )).path;
          }
          created = await createSession(activeProjectId, {
            harness: creationHarness,
            ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
            ...(sentModel ? { model: sentModel } : {}),
            ...(cfgSent.agent ? { agent: cfgSent.agent } : {}),
            ...(worktreePath ? { worktreePath } : {}),
            precache: true,
          });
        }
        clearNewSessionDraft(activeProjectId);
        clearDraftExecutionConfig(activeProjectId);
        if (newSessionAutoApprove) await api.autoAcceptSet(created, "on");
        if (newSessionGoal) await api.goalAttach(created, t);
        await flushNewSessionHandoffImport(activeProjectId, created, t);
        await deliver(created);
        setNewSessionAutoApprove(false);
        setNewSessionGoal(false);
      })()
        .catch((error) => {
          setUiError(friendlyError(tr("common.error"), error));
          // The draft was cleared optimistically below; a failed worktree or
          // session creation must never lose the typed prompt or its pills.
          // Restore only while still on the fresh-session surface — never into
          // another session's draft.
          if (sessionIdRef.current === null) {
            if (!(inputRef.current?.getText() ?? "").trim()) {
              setText(t);
              inputRef.current?.replaceText(t);
            }
            for (const attachment of atts) addAttachment(null, attachment);
          }
        })
        .finally(() => setCreatingSession(false));
    }
    setText("");
    inputRef.current?.replaceText("");
    promptHistoryNav.reset();
    if (target) {
      saveDraft(target, "");
      syncDraftToServer(target, ""); // clear server draft on send
    }
    setAcToken(null);
    acTokenRef.current = null;
    selectedCommandRef.current = undefined;
  }, [
    text, attachments, cfg, profileMissing, noModels, runtimeUnavailable, working, activeProjectId, queueEdit, queueEditSaving,
    emptySteerItem, steerQueuedItem, promptHistoryNav,
    session?.model, session?.status, session?.runtimeControl, preferredModel,
    sessionDefaults.defaultThinking, chatModels, creatingSession, newSessionTarget,
    newSessionAutoApprove, newSessionGoal, newSessionIntent, commandCatalog,
    draftExecution, profiles, activeProject?.defaults?.harness,
  ]);

  const applyCompletion = useCallback((item: AutocompleteOption) => {
    const token = acTokenRef.current;
    const h = inputRef.current;
    if (!token || !h) return false;
    const cur = h.getText();
    const r = completeToken(cur, token, item.value);
    selectedCommandRef.current = token.kind === "command" ? item.command : undefined;
    // replaceText fires onTextChange, which re-derives the token/popup state.
    h.replaceText(r.text, { anchor: r.caret });
    h.focus();
    return true;
  }, []);

  // ---- derived popup view (honest four-state projection) ----------------------
  const acView: AutocompleteViewState | null = (() => {
    if (!acToken) return null;
    if (acToken.kind === "command") return commandAutocomplete(commandCatalog, acToken.value);
    if (acToken.kind === "snippet") return snippetAutocomplete(snippetCatalog, acToken.value);
    if (!activeProjectId) return null;
    const fresh = fileSearch.query === acToken.path;
    return fileAutocomplete(
      acToken.path,
      fresh ? fileSearch.phase : "pending",
      fresh && fileSearch.phase === "done" ? fileSearch.hits : [],
    );
  })();
  const acOptions = acView?.options ?? [];
  const acSel = acOptions.length > 0 ? Math.min(acIndex, acOptions.length - 1) : -1;

  // One polite announcement per status transition — never per render and never
  // duplicating the active option name (aria-activedescendant covers that).
  const lastAnnounced = useRef<string | null>(null);
  const statusText = acView?.status?.text ?? null;
  useEffect(() => {
    if (statusText && statusText !== lastAnnounced.current) announce(statusText);
    lastAnnounced.current = statusText;
  }, [statusText]);

  const completeAutocomplete = (): boolean => {
    if (!acView || acOptions.length === 0) return false;
    const item = acOptions[acSel];
    if (!item) return false;
    return applyCompletion(item);
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
      draftRevisionRef.current += 1;
      promoteHistoryDraft();
      setText(val);
      setPromptRewrite((current) => current?.generated === val ? current : null);
      if (sessionIdRef.current === null && activeProjectId) saveNewSessionDraftText(activeProjectId, val);
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
  const attachGithub = (url: string): Promise<GithubAttachResult> => {
    const projectId = getState().activeProjectId;
    if (!projectId) {
      return Promise.resolve({ ok: false, code: "no-repo", reason: OPEN_PROJECT_FIRST });
    }
    return attachGithubLink(projectId, sessionIdRef.current, url);
  };

  // ---- execution configuration projections ------------------------------------
  const agentValue = cfg.agent ?? "";
  const recommendedModel = session?.model && chatModels.some((candidate) =>
    candidate.providerID === session.model?.providerID && candidate.modelID === session.model?.modelID)
    ? session.model
    : preferredModel && chatModels.some((candidate) =>
        candidate.providerID === preferredModel.providerID && candidate.modelID === preferredModel.modelID)
      ? preferredModel
      : chatModels[0];
  const pickComposerModel = (ref?: ModelRef) => {
    if (!ref) return;
    // A pending effort belongs to the old model. The selected model's saved
    // value is derived at send/render time, so never carry this one across.
    updateCfg(withModelForNextTurn(cfg, ref));
    const descriptor = routeCatalog.models.find((candidate) =>
      candidate.providerID === ref.providerID && candidate.modelID === ref.modelID
      && (!effectiveDraftHarness || !candidate.harnessId || candidate.harnessId === effectiveDraftHarness));
    noteModelUsed(`${descriptor?.harnessId ? `${descriptor.harnessId}::` : ""}${ref.providerID}/${ref.modelID}`);
    if (!session && activeProjectId && descriptor?.harnessId) {
      updateDraftExecutionConfig(activeProjectId, {
        harnessSelection: { mode: "pinned", harnessId: descriptor.harnessId },
        harnessSelectionExplicit: true,
        model: { ...ref, harnessId: descriptor.harnessId },
      });
    }
    if (activeProjectId) {
      void rememberProjectModelSelection(activeProjectId, ref).catch((error) => {
        setUiError(friendlyError(tr("composer.couldnTRememberTheProjectModel"), error));
      });
    }
  };
  const chatAgents = agents.filter((agent) =>
    roleKind(agent, rolePrefs) === "main" && agent.name.toLowerCase() !== "compaction");
  const defaultAgentLabel = agentBadgeLabel(
    agentPickerDefaultLabel(session?.agent, chatAgents).replace(/^Default:\s*/, ""),
  );
  const agentChangeEffect = "Applies to the next message in this session. No new session is created; current work and history stay here.";
  // Agent rows carry the backend-reported purpose so choosing between modes
  // is informed, not a guess from a one-word name.
  const agentItems: PickerItem[] = [
    {
      id: "",
      label: defaultAgentLabel,
      detail: `${tr("composer.letPolythUseYourCurrentWorkspaceDefault")}. ${agentChangeEffect}`,
      group: "",
    },
    ...chatAgents
      // The default row already resolves to this agent; showing it twice is a dupe.
      .filter((a) => agentBadgeLabel(a.name) !== defaultAgentLabel)
      .map((a) => ({
      id: a.name,
      label: agentBadgeLabel(a.name),
      detail: a.description ? `${a.description} — ${agentChangeEffect}` : agentChangeEffect,
      group: "",
    })),
  ];
  const pickAgent = (id: string) => {
    updateCfg(withExplicitAgent(cfg, id || undefined));
    if (!session && activeProjectId && !id) {
      updateDraftExecutionConfig(activeProjectId, { agent: undefined });
    } else if (!session && activeProjectId) {
      const descriptor = routeCatalog.agents.find((candidate) => candidate.name === id
        && (!effectiveDraftHarness || !candidate.harnessId || candidate.harnessId === effectiveDraftHarness));
      if (descriptor?.harnessId) updateDraftExecutionConfig(activeProjectId, {
        harnessSelection: { mode: "pinned", harnessId: descriptor.harnessId },
        harnessSelectionExplicit: true,
        agent: { harnessId: descriptor.harnessId, agent: id },
      });
    }
  };
  const activeAgent = cfg.agent
    ?? session?.agent
    ?? sessionDefaults.defaultAgent
    ?? chatAgents[0]?.name
    ?? "build";
  const activeAgentLabel = agentItems.find((item) => item.id === agentValue)?.label
    ?? agentBadgeLabel(activeAgent);

  const selectedModel = (() => {
    const nextTurn = cfg.model ?? session?.model ?? preferredModel;
    return nextTurn
      ? chatModels.find((candidate) =>
          candidate.providerID === nextTurn.providerID && candidate.modelID === nextTurn.modelID)
      : undefined;
  })();
  const composerAttachmentSupport = runtimeFeatures
    ? effectiveAttachmentSupport(
        {
          ...runtimeFeatures.capabilities,
          attachments: { modalities: runtimeFeatures.attachmentSupport },
        },
        selectedModel?.capabilities,
        false,
        false,
      )
    : undefined;
  const requestedSelectedThinking = cfg.thinking !== undefined
    ? cfg.thinking
    : getModelThinking(selectedModel) ?? sessionDefaults.defaultThinking;
  const selectedThinking = typeof requestedSelectedThinking === "string"
    && selectedModel?.variants?.includes(requestedSelectedThinking)
    ? requestedSelectedThinking
    : undefined;
  // Honest attachment note from the next-turn model's normalized capabilities:
  // `input:image`/`attachment` = supported (no note); an input report without
  // image support names the block when an image pill is pending; no report
  // keeps the legacy "not reported" line.
  const attachNote = (() => {
    if (attachments.length === 0) return null;
    if (!composerAttachmentSupport) return ATTACHMENT_COMPAT_NOTE;
    for (const attachment of attachments) {
      const modality = attachmentModality(attachment);
      if (!modality) continue;
      const level = composerAttachmentSupport[modality];
      if (level === "native" || level === "emulated") continue;
      if (modality === "image") return tr("composer.discovery.attachmentImagesNotSupported");
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
  const pickThinking = (thinking: string | undefined) => {
    if (selectedModel) setModelThinking(selectedModel, thinking);
    updateCfg(thinking === undefined ? withAutoThinking(cfg) : withExplicitThinking(cfg, thinking));
    if (!session && activeProjectId) updateDraftExecutionConfig(activeProjectId, {
      ...(thinking ? { thinking } : { thinking: undefined }),
    });
  };
  const preserveKeyboard = isPhone && keyboardOpen
    ? () => inputRef.current?.focus()
    : undefined;
  const autoApproveOn = session ? session.autoAccept === true : newSessionAutoApprove;
  const toggleAutoApprove = () => {
    if (autoApproveBusy) return;
    if (!session) {
      setNewSessionAutoApprove((current) => !current);
      return;
    }
    setAutoApproveBusy(true);
    void api.autoAcceptSet(session.id, autoApproveOn ? "off" : "on")
      .catch((error) => setUiError(friendlyError(tr("common.error"), error)))
      .finally(() => setAutoApproveBusy(false));
  };
  const toggleGoal = () => {
    const objective = (inputRef.current?.getText() ?? text).trim();
    if (!objective) {
      if (session) setGoalFormOpen(true);
      else setNewSessionGoal((current) => !current);
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
    setGoalAttachBusy(true);
    void api.goalAttach(target, objective)
      .then(() => {
        // A session switch mid-attach must not clear a different composer.
        if (sessionIdRef.current !== target) return;
        setText("");
        inputRef.current?.replaceText("");
        saveDraft(target, "");
        syncDraftToServer(target, "");
        announce(tr("composer.goalAttached"));
      })
      .catch((error) => setUiError(friendlyError(tr("composer.couldnTAttachTheGoal"), error)))
      .finally(() => setGoalAttachBusy(false));
  };
  const consumeWorkflowDraft = () => {
    setText("");
    inputRef.current?.replaceText("");
    promptHistoryNav.reset();
    const target = sessionIdRef.current;
    if (target) {
      saveDraft(target, "");
      syncDraftToServer(target, "");
    }
    // A workflow/run-started event can replace the empty-session hero composer
    // before the launch request resolves. This callback may therefore belong
    // to an unmounted instance; notify the currently mounted composer too, but
    // never clear a different session if navigation happened meanwhile.
    if (getState().activeSessionId === target) requestComposerReplace("");
  };
  const thinkingVariants = selectedModel?.variants ?? [];
  // Desktop renders these controls in the rail. On phones the harness package
  // composes them into one execution sheet, so each control has one owner.
  const modelControl = chatModels.length > 0 && (
      <ModelPicker
        models={chatModels}
        value={cfg.model}
        recommended={recommendedModel}
        direction="up"
        usage={model.contextUsage ? contextTokensUsed(model) : undefined}
        onPick={pickComposerModel}
      />
  );
  const effortControl = !noModels && modelSupportsThinking(selectedModel) ? (
    <EffortMenu
      variants={thinkingVariants}
      value={selectedThinking}
      onPick={(thinking) => pickThinking(thinking || undefined)}
      onCommit={preserveKeyboard}
    />
  ) : null;
  const agentControl = chatAgents.length > 0 ? (
    <Picker
      className="composer-agent-chip"
      label={tr("composer.agent")}
      mobileSheet
      direction="up"
      items={agentItems}
      value={agentValue}
      searchable={false}
      onPick={pickAgent}
      placeholder={activeAgentLabel}
      ariaLabel={tr("composer.selectAgentModeCurrentValue", { value: activeAgentLabel })}
    />
  ) : <span className="agent-type-badge">{activeAgentLabel}</span>;
  const profileHarnessId = session?.resolvedHarnessId ?? effectiveDraftHarness;
  const compatibleProfiles = profiles.filter((profile) => !profileHarnessId
    || (profile.harnessId ?? "opencode") === profileHarnessId);
  const inheritedProfile = activeProject?.defaults?.agentProfileId
    ? profiles.find((profile) => profile.id === activeProject.defaults?.agentProfileId)
    : undefined;
  const profileItems: PickerItem[] = [
    { id: "", label: inheritedProfile ? `Default: ${inheritedProfile.name}` : "Default", group: "" },
    { id: "__none", label: "None", group: "" },
    ...compatibleProfiles.map((profile) => ({
      id: profile.id,
      label: profile.name,
      detail: `${profile.harnessId ?? "OpenCode (legacy)"} · ${profile.providerID}/${profile.modelID}`,
      group: "",
    })),
  ];
  const profileValue = cfg.profile.kind === "id"
    ? cfg.profile.id
    : cfg.profile.kind === "none" ? "__none" : "";
  const pickProfile = (id: string) => {
    if (!id) {
      updateCfg({ ...cfg, profile: { kind: "inherit" } });
      if (!session && activeProjectId) updateDraftExecutionConfig(activeProjectId, { profileId: undefined });
      return;
    }
    if (id === "__none") {
      updateCfg(withProfileNone(cfg));
      if (!session && activeProjectId) updateDraftExecutionConfig(activeProjectId, { profileId: undefined });
      return;
    }
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!profile) return;
    const harnessId = profile.harnessId ?? "opencode";
    updateCfg(withProfile(cfg, id));
    if (!session && activeProjectId) updateDraftExecutionConfig(activeProjectId, {
      harnessSelection: { mode: "pinned", harnessId },
      harnessSelectionExplicit: true,
      profileId: id,
      model: { harnessId, providerID: profile.providerID, modelID: profile.modelID },
      ...(profile.agent ? { agent: { harnessId, agent: profile.agent } } : { agent: undefined }),
      ...(profile.thinking ? { thinking: profile.thinking } : { thinking: undefined }),
    });
  };
  const profileControl = <Picker
    className="composer-profile-chip"
    label="Profile"
    mobileSheet
    direction="up"
    items={profileItems}
    value={profileValue}
    searchable={compatibleProfiles.length > 8}
    onPick={pickProfile}
    placeholder={profileItems.find((item) => item.id === profileValue)?.label ?? "Profile"}
    ariaLabel={`Select profile, current: ${profileItems.find((item) => item.id === profileValue)?.label ?? "Default"}`}
  />;
  const suggestionScopeId = session?.id ?? activeProjectId ?? "";
  const canGenerateNextAction = !!suggestionScopeId
    && !working
    && (!!text.trim() || (!!session?.id && hasCompletedExchange))
    && !suggestionBusy;
  const canRevertSuggestion = !!suggestionScopeId
    && canRevertPromptRewrite(suggestionScopeId, text, promptRewrite)
    && !suggestionBusy;
  const generateNextAction = useCallback(() => {
    const target = sessionIdRef.current;
    const projectId = getState().activeProjectId;
    if (!canGenerateNextAction || (!target && !projectId)) return;
    const draft = inputRef.current?.getText() ?? text;
    const scopeId = target ?? projectId!;
    const source = promptRewriteSource(scopeId, draft, promptRewrite);
    const request: NextActionRequest = {
      sessionId: target,
      projectId,
      atSeq: target ? activeSessionSeq : 0,
      draftRevision: draftRevisionRef.current,
      draft,
    };
    setSuggestionBusy(true);
    const completion = target
      ? api.assistSuggestion(target, source)
      : api.assistPrompt(projectId!, source);
    void completion
      .then((result) => {
        const mode = nextActionInsertMode(result.suggestion);
        if (!mode || !canApplyNextAction(request, {
          activeSessionId: getState().activeSessionId,
          activeProjectId: getState().activeProjectId,
          latestSeq: target ? lastSeq(target) : 0,
          draftRevision: draftRevisionRef.current,
        }, result)) return;
        requestComposerReplace(result.suggestion);
        setPromptRewrite({ scopeId, original: source, generated: result.suggestion });
      })
      .catch((error) => {
        const code = errorCodeOf(error);
        if (code === "stale" || code === "no-completed-exchange" || code === "in-flight") return;
        setUiError(friendlyError(tr("composer.couldNotGenerateNextAction"), error));
      })
      .finally(() => setSuggestionBusy(false));
  }, [activeSessionSeq, canGenerateNextAction, promptRewrite, text]);
  const revertSuggestion = useCallback(() => {
    const target = sessionIdRef.current;
    const projectId = getState().activeProjectId;
    const scopeId = target ?? projectId;
    const draft = inputRef.current?.getText() ?? text;
    const rewrite = promptRewrite;
    if (!scopeId || !rewrite || !canRevertPromptRewrite(scopeId, draft, rewrite)) return;
    setPromptRewrite(null);
    requestComposerReplace(rewrite.original);
  }, [promptRewrite, text]);
  const phoneLayout = isPhone;
  // Composer controls are ordinary mini-widgets: one placement/visibility
  // system owns next action, Workflow, effort, and agent.
  const slotContext = {
    sessionId: session?.id,
    projectId: activeProjectId ?? undefined,
    variant,
    working,
    sessionStatus: session?.status,
    harnessSelection: session?.harness,
    resolvedHarnessId: session?.resolvedHarnessId,
    harnessTransition: session?.harnessTransition,
    projectHarnessDefault: activeProject?.defaults?.harness,
    autoApproveOn,
    autoApproveBusy,
    toggleAutoApprove,
    goalOn: newSessionGoal,
    goalBusy: goalAttachBusy,
    toggleGoal,
    workflowDraftText: text,
    workflowAttachmentCount: attachments.length,
    consumeWorkflowDraft,
    // The phone execution sheet owns effort and agent. Keep the ordinary
    // composer widget contexts empty so neither control renders twice.
    composerEffortControl: phoneLayout ? null : effortControl,
    composerAgentControl: phoneLayout ? null : agentControl,
    executionModelControl: modelControl,
    executionAgentControl: agentControl,
    executionEffortControl: effortControl,
    executionProfileControl: profileControl,
    executionModelLabel: selectedModel?.name ?? selectedModel?.modelID,
    phoneLayout,
    canGenerateNextAction,
    canRevertSuggestion,
    suggestionBusy,
    suggestionActionLabel: canRevertSuggestion
      ? tr("timeline.regenerate")
      : text.trim()
        ? tr("composer.improvePrompt")
        : tr("composer.generateNextAction"),
    generateNextAction,
    revertSuggestion,
  };

  const borrowedEpochPending = session?.status === "epoch-pending"
    && session.runtimeControl === "borrowed";
  const sendDisabled = creatingSession
    || queueEditSaving
    || borrowedEpochPending
    || (queueEdit ? !text.trim() : (!text.trim() && attachments.length === 0))
    || (!queueEdit && !shellMode && (noModels || profileMissing));
  const hasDraft = text.trim() !== "" || attachments.length > 0;
  // On phones the composer only unfolds when it is actually being used: focus,
  // a shell command, or a draft in progress. A working turn alone keeps it in
  // its minified resting state (same as the fresh-session composer) so a busy
  // agent never inflates the interaction dock — Stop stays reachable in the
  // collapsed row.
  const expanded = !phoneLayout || inputFocused || shellMode;
  const stateClass = phoneLayout
    ? ` composer-mobile ${expanded ? "composer-expanded" : "composer-collapsed"}${inputFocused ? " composer-input-active" : ""}${hasDraft ? " composer-has-draft" : ""}`
    : "";

  // Creating a canonical session can cold-start OpenCode. Replace the empty
  // new-chat composer immediately, rather than leaving a sent prompt looking
  // like it disappeared until the server responds.
  if (creatingSession) {
    return (
      <div
        ref={rootRef}
        className={`composer ${widgetMode ? "composer-widget" : "composer-chat"} composer-simple${widgetMode ? "" : " composer-focus-light"}${stateClass}`}
        aria-busy="true"
      >
        <GlassDock className="composer-card">
          <div className="session-loading" role="status">
            <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
            <span>{tr("workspace.builtinsurfaces.loadingSession")}</span>
          </div>
        </GlassDock>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`composer ${widgetMode ? "composer-widget" : "composer-chat"} composer-simple${widgetMode ? "" : " composer-focus-light"}${stateClass}`}
    >
      {/* The project/worktree pickers only make sense before a session exists:
          in an open session the location is fixed, and picking here silently
          switched project or spawned a new session instead of retargeting. */}
      {!session && <SessionContextBar {...contextBar} />}
      {/* Widget-areas (WA4): the project/branch meta row is a widget area. */}
      <SlotHost slot="composer.meta" context={slotContext} customizable />
      {failedSend && (
        <Notice
          tone="warning"
          className="composer-send-failure"
          role="alert"
          actions={<Button size="sm" onClick={() => send()}>{tr("common.retry")}</Button>}
        >{tr("composer.sendUnavailableDraftPreserved")}</Notice>
      )}
      {/* Widget-areas (WA4): the uncommitted-changes bar area, above the box. */}
      <SlotHost slot="composer.pending" context={slotContext} customizable />
      {session?.id && (
        <QueuedMessageList
          sessionId={session.id}
          editingId={queueEdit?.sessionId === session.id ? queueEdit.id : null}
          onEdit={beginQueuedEdit}
          onSteer={steerQueuedItem}
          onItemsChange={updateQueuedItems}
        />
      )}
      <GlassDock
        className="composer-card"
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
      {showModelWarning && (
        <div className="composer-note composer-runtime-unavailable" role="status">
          <span>
            {runtimeUnavailable?.message
              ?? tr("composer.noModelsAvailableCheckThatTheBackend")}
          </span>
          <Button size="sm" onClick={retryModelConnection}>{tr("sidebar.reconnect")}</Button>
        </div>
      )}
      {profileMissing && (
        <div className="composer-note composer-profile-missing" role="alert">
          {PROFILE_MISSING_NOTE}
        </div>
      )}
      {attachments.length > 0 && (
        <AttachmentPills
          attachments={attachments}
          onRemove={(id) => {
            const sid = session?.id ?? null;
            if (promptHistoryNavRef.current.isBrowsing()) promoteHistoryDraft();
            removeAttachment(sid, id);
          }}
        />
      )}
      {attachments.length > 0 && !noModels && attachNote && (
        <div className="composer-attach-note">{attachNote}</div>
      )}
      <div className="composer-input">
        {shellMode && <div className="composer-mode-label">{tr("composer.shellCommandPermissionCheckedOutputAddedTo")}</div>}
        <AdaptiveTextInput
          ref={inputRef}
          data-composer-input=""
          initialText={text}
          rows={3}
          className="composer-editor"
          ariaLabel={tr("composer.message")}
          placeholder={shellMode
            ? tr("composer.enterAWorkspaceShellCommand")
            : shellLayout === "phone"
              ? `${tr("composer.message")} Polyth…`
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
            else flushComposerDraft(); // save on focus loss, never mid-typing
          }}
        />
        {acView && (
          <div className="ac-popup">
            <div className="ac-header">{acView.kind === "cmd" ? tr("composer.commands") : acView.kind === "snip" ? tr("composer.snippets") : tr("composer.files")}</div>
            {acOptions.length > 0 ? (
              <div
                className="ac-list"
                id="composer-autocomplete-list"
                role="listbox"
                aria-label={acView.kind === "cmd" ? tr("composer.commands") : acView.kind === "snip" ? tr("composer.snippets") : tr("composer.files")}
              >
                {acOptions.map((item, i) => (
                  <div
                    key={item.id}
                    id={item.id}
                    role="option"
                    aria-selected={i === acSel}
                    ref={i === acSel ? (el) => el?.scrollIntoView({ block: "nearest" }) : null}
                    className={`ac-item ${i === acSel ? "ac-active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setAcIndex(i);
                      applyCompletion(item);
                    }}
                    onMouseEnter={() => setAcIndex(i)}
                  >
                    <span className="ac-label">{item.label}</span>
                    <span className="ac-detail">{item.detail}</span>
                  </div>
                ))}
              </div>
            ) : (
              // Instructional / loading / empty / error body: the popup stays
              // open so the state is visible; Tab passes through normally.
              <div className="ac-status" id="composer-autocomplete-list">
                <span>{acView.status?.text}</span>
                {acView.status?.createSnippet && (
                  <Button
                    size="sm"
                    className="ac-create-snippet"
                    onClick={() => { setAcToken(null); openSettingsPage("commands"); }}
                  >
                    {tr("composer.createASnippet")}</Button>
                )}
              </div>
            )}
            {acOptions.length > 0 && (
              <div className="ac-footer">
                <span><kbd>↑↓</kbd> {tr("composer.navigate")}</span>
                <span><kbd>↵</kbd> / <kbd>Tab</kbd> {tr("composer.insert")}</span>
                <span><kbd>{tr("composer.esc")}</kbd> {tr("composer.dismiss")}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {/* P2-W3A rail: typing first, configuration second. One quiet row under
          the editor — Add (attachments/context/tools), then the execution
          config chips (model, agent, effort), then extensions and Send.
          Send/Stop is the only filled control; everything else stays quiet. */}
      <div className="composer-rail">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            attachFiles(files);
          }}
        />
        <span className="composer-leading-zone customize-zone">
          <ComposerAddMenu
            hasProject={!!activeProjectId}
            hasSession={!!session?.id}
            goalsEnabled
            draftText={text}
            commands={commandCatalog}
            snippets={snippetCatalog}
            {...(uploadDisabledReason ? { uploadDisabledReason } : {})}
            direction="up"
            onUpload={openAttachmentPicker}
            onInsertMention={menuMention}
            onInsertCommand={menuCommand}
            onInsertSnippet={menuSnippet}
            onEnterShell={menuShell}
            onAttachGoal={toggleGoal}
            attachGithub={attachGithub}
          />
          {/* Extensions (icon actions) lead the rail; the config cluster
              (model · effort · agent) is right-anchored beside Send. */}
          <span className="composer-extensions composer-mobile-extensions">
            <SlotHost slot="composer.leading" context={slotContext} customizable />
          </span>
          {/* Phones cannot hover to arm a zone; inline edit pencils are just
              clutter there, so composer customization stays in Settings. */}
          {!phoneLayout && <CustomizeZoneButton slot="composer.leading" align="start" />}
        </span>
        <span className="composer-execution">
          <SlotHost slot="composer.execution" context={slotContext} />
        </span>
        <div className="composer-actions customize-zone">
          <span className="composer-extensions">
            <SlotHost slot="composer.trailing" context={slotContext} customizable />
          </span>
          <div className="composer-config">
            {!phoneLayout && modelControl}
          </div>
          <span className="composer-primary">
            {canStop ? (
              (working && (queueEdit || (followUp === "queue" && (!sendDisabled || emptySteerItem)))) ? (
                <div className="composer-send-split">
                    <button
                      className="send composer-delivery composer-queue"
                      onClick={() => send()}
                      aria-label={queueEdit
                        ? tr("composer.saveQueuedMessageInIts")
                        : emptySteerItem
                          ? tr("queuedmessagelist.steer")
                          : tr("composer.queueMessageUntilTheCurrentResponseFinishes")}
                      title={queueEdit
                        ? tr("composer.saveQueuedMessageInIts")
                        : emptySteerItem
                          ? tr("queuedmessagelist.steer")
                          : tr("composer.queueMessageUntilTheCurrentResponseFinishes")}
                      aria-busy={!!emptySteerItem && steeringQueuedId === emptySteerItem.id}
                      disabled={queueEdit
                        ? queueEditSaving || !text.trim()
                        : !!emptySteerItem && steeringQueuedId !== null}
                    >
                      {emptySteerItem ? <SendIcon /> : queueEdit ? <CheckIcon /> : <QueueIcon />}
                      <span className="composer-action-label">{queueEdit
                        ? tr("common.save")
                        : emptySteerItem
                          ? tr("settings.pages.steer")
                          : tr("composer.queue")}</span>
                  </button>
                  <Menu
                    label={tr("composer.moreActiveRunActions")}
                    align="end"
                    entries={[
                      {
                        id: "send-now",
                        label: tr("composer.sendNow"),
                        icon: SendIcon,
                        detail: tr("composer.stopTheCurrentResponseAndSend"),
                        onSelect: () => send(undefined, "interrupt"),
                      },
                      {
                        id: "stop",
                        label: tr("common.stop"),
                        icon: StopIcon,
                        detail: tr("composer.stopWithoutSendingThisDraft"),
                        disabled: abortPending,
                        onSelect: () => void stopActiveTurn(),
                      },
                    ]}
                  >
                    {(trigger) => (
                      <button
                        className="composer-send-options"
                        aria-label={tr("composer.moreActiveRunActions")}
                        disabled={queueEdit
                          ? queueEditSaving || !text.trim()
                          : !!emptySteerItem && steeringQueuedId !== null}
                        {...trigger}
                      >
                        <MoreIcon />
                      </button>
                    )}
                  </Menu>
                </div>
              ) : (
                <button
                  className="stop composer-stop-primary"
                  title={tr("composer.stopTheCurrentResponse")}
                  aria-label={tr("composer.stopTheCurrentResponse")}
                  aria-busy={abortPending}
                  disabled={abortPending}
                  onClick={() => void stopActiveTurn()}
                >
                  <Icon.stop /><span className="composer-action-label">{tr("common.stop")}</span>
                </button>
              )
            ) : (
              <button className="send" onClick={() => send()}
                title={`${shellMode ? tr("composer.runShellCommand") : tr("composer.sendMessage")} (${sendKey})`}
                aria-label={shellMode ? tr("composer.runShellCommand") : tr("composer.sendMessage")}
                disabled={sendDisabled}>
                <span className="send-plane" aria-hidden="true"><Icon.send /></span>
              </button>
            )}
          </span>
          {!phoneLayout && <CustomizeZoneButton slot="composer.trailing" />}
        </div>
      </div>
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
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
      </GlassDock>
    </div>
  );
}
