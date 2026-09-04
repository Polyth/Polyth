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
  createDefaultWorktree,
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
import { loadDraft, saveDraft, syncDraftToServer, flushDraftToServer, type AutocompleteItem } from "../utils.ts";
import { canApplyNextAction, nextActionInsertMode, type NextActionRequest } from "../nextAction.ts";
import { latestCompletedExchange } from "@polyth/session/next-action";
import SlotHost from "./slots/SlotHost.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import { dragKind, dropIntoSession } from "../dnd.ts";
import {
  addAttachment, attachUpload, removeAttachment, takeAttachments, usePendingAttachments,
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
  requestComposerInsert,
  requestComposerReplace,
} from "../composerInsert.ts";
import { activeToken, completeToken, shellCommand, type PromptToken } from "../composer/language.ts";
import {
  ATTACHMENT_COMPAT_NOTE,
  attachmentCompatibility,
  catalogFromResult,
  commandAutocomplete,
  fileAutocomplete,
  modelSupportsTextWorkflow,
  OPEN_PROJECT_FIRST,
  planCommandInsert,
  planShellEntry,
  planSigilInsert,
  snippetAutocomplete,
  type AutocompleteViewState,
  type CatalogState,
  type InsertPlan,
} from "../composer/discovery.ts";
import {
  loadComposerConfig, saveComposerConfig, consumeComposerConfig, wireProfileId,
  withAutoThinking, withExplicitAgent, withExplicitThinking, withModelForNextTurn,
  type ComposerConfig,
} from "../composerConfig.ts";
import {
  emptyPromptHistoryCursor,
  promptHistory,
  restorePromptHistoryDraft,
  stepPromptHistory,
} from "../composer/history.ts";
import type { PickerItem } from "../picker.ts";
import Picker from "./Picker.tsx";
import AdaptiveTextInput, { type TextInputHandle } from "./input/AdaptiveTextInput.tsx";
import ComposerAddMenu from "./ComposerAddMenu.tsx";
import EffortMenu from "./EffortMenu.tsx";
import ComposerFocusDialog from "./ComposerFocusDialog.tsx";
import QueuedMessageList from "./QueuedMessageList.tsx";
import { GoalAttachForm } from "../../../../packages/goals/widgets/GoalStrip.tsx";
import { announce } from "./a11y/live.tsx";
import { noteModelUsed } from "@polyth/models/web-prefs";
import { getUiSettings, setUiSettings } from "../uiPrefs.ts";
import {
  formatPasteSize,
  isLargeTextPaste,
  mimeForPasteFilename,
  pasteByteLength,
  suggestPasteFilename,
} from "../pasteAttach.ts";
import { migrateFavoritesOnce, profilesLoaded, useProfiles } from "../profiles.ts";
import type {
  ModelRef,
  QueueItemDto,
  SessionProjection,
} from "@polyth/contracts";
import { agentPickerDefaultLabel } from "../composerDefaults.ts";
import { friendlyError, matchesSendShortcut, modKeyLabel, parseModelRef } from "../settings.ts";
import { Icon } from "../icons.tsx";
import ModelPicker from "@polyth/models/model-picker";
import { modelSupportsThinking } from "@polyth/models/model-presentation";
import { resolveProjectModelDefault, useSessionDefaults } from "../sessionDefaults.ts";
import { getModelThinking, setModelThinking } from "../thinkingPrefs.ts";
import { roleKind, useRolePrefs } from "../rolePrefs.ts";
import { useShellMode } from "../responsiveShell.ts";
import { dismissKeyboard, useViewportMetrics } from "../mobileViewport.ts";
import { tr } from "../i18n/index.ts";
import SessionContextBar, {
  type ContextChoice,
  type SessionContextBarProps,
} from "./mobile/SessionContextBar.tsx";
import { Button, GlassDock, IconButton, Menu, Notice, SendIcon, StopIcon } from "./ui/index.ts";
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
  | { kind: "branch"; branch: string }
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

  const currentBranchName = worktrees.find((worktree) => worktree.isMain)?.branch
    || branches.current
    || branch
    || "";

  const branchChoices = useMemo<LocationChoice[]>(() => {
    const linkedBranches = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
    const localBranches = branches.branches.filter((candidate) => !candidate.remote);

    if (newWorktreeMode) {
      // Every local branch — including the current one and ones already checked
      // out elsewhere — is a valid fork point, because a fresh branch is cut
      // from it rather than moved into the new worktree.
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
      for (const candidate of localBranches) {
        if (seen.has(candidate.name)) continue;
        seen.add(candidate.name);
        choices.push({
          id: `branch:${candidate.name}`,
          label: candidate.name,
          target: { kind: "new-worktree", base: candidate.name },
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
      void api.createWorktree(projectId, choice.target.branch)
        .then((worktree) => startNewSession(projectId, { worktreePath: worktree.path }))
        .catch((error) => setUiError(friendlyError(tr("composer.couldnTCreateTheWorktree"), error)))
        .finally(() => setBranchLoading(false));
    } else {
      const base = choice.target.base;
      setBranchLoading(true);
      void createDefaultWorktree(projectId, newSessionIntent?.title, base)
        .then((path) => startNewSession(projectId, { worktreePath: path }))
        .catch((error) => setUiError(friendlyError(tr("composer.couldnTCreateTheWorktree"), error)))
        .finally(() => setBranchLoading(false));
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
  const profiles = useProfiles();
  const models = useStore((s) => s.models);
  const chatModels = models.filter(modelSupportsTextWorkflow);
  const agents = useStore((s) => s.agents);
  const rolePrefs = useRolePrefs();
  const settings = useStore((s) => s.settings);
  const sessionDefaults = useSessionDefaults();
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
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
  const noModels = chatModels.length === 0;
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
  const queueEditRef = useRef<QueueEdit | null>(null);
  queueEditRef.current = queueEdit;
  const committedTextRef = useRef(text);
  committedTextRef.current = text;
  const draftRevisionRef = useRef(0);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
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

  const historyCursor = useRef(emptyPromptHistoryCursor());
  const applyingHistory = useRef(false);
  const historyItems = promptHistory(model.messages);
  const shell = shellCommand(text);
  const shellMode = shell !== null;

  // UX-COMPOSER-DISC: one pending execution configuration (profile / model /
  // agent) per canonical session, persisted with the draft. Selections flow
  // through composerConfig transitions so profile and explicit overrides
  // clear each other.
  const [cfg, setCfg] = useState<ComposerConfig>(() => loadComposerConfig(session?.id ?? null));
  const updateCfg = useCallback((next: ComposerConfig) => {
    setCfg(next);
    saveComposerConfig(sessionIdRef.current, next);
  }, []);

  // Save the live composer text to the local draft store and the server, on
  // focus loss / session switch / unmount — never while typing (a server
  // broadcast echoing the debounced autosave would reset the live input to
  // the older value). While editing a queued message the unrelated draft is
  // preserved untouched.
  const flushComposerDraft = useCallback(() => {
    const id = sessionIdRef.current;
    if (id === null) return;
    const editing = queueEditRef.current;
    saveDraft(id, editing?.sessionId === id
      ? editing.draftBefore
      : inputRef.current?.getText() ?? committedTextRef.current);
    flushDraftToServer(id);
  }, []);

  // Session switch: restore the draft through the command handle (never a
  // controlled replay), and never while the user is mid-composition. The
  // pending execution configuration is per-session and reloads with it.
  // Deliberately NOT reactive to session.draft: live cross-client draft
  // updates apply below, only when the composer is empty.
  useEffect(() => {
    const outgoing = sessionIdRef.current;
    if (outgoing !== null && outgoing !== (session?.id ?? null)) {
      flushComposerDraft();
      const editing = queueEditRef.current;
      if (editing?.sessionId === outgoing) void api.queueEditCancel(outgoing, editing.id).catch(() => {});
    }
    sessionIdRef.current = session?.id ?? null;
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
    historyCursor.current = emptyPromptHistoryCursor();
    setCfg(loadComposerConfig(session?.id ?? null));
    setAcToken(null);
    acTokenRef.current = null;
    fileSearchSeq.current++;
    setQueueEdit(null);
    setQueueEditStarting(false);
    setQueueEditSaving(false);
  }, [session?.id, newSessionIntent, flushComposerDraft]);

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
  const attachments = usePendingAttachments(session?.id ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteIndexRef = useRef(0);
  const [pendingLargePaste, setPendingLargePaste] = useState<{
    text: string;
    sizeLabel: string;
    projectId: string;
    sessionId: string | null;
  } | null>(null);
  const pendingLargePasteRef = useRef(pendingLargePaste);
  pendingLargePasteRef.current = pendingLargePaste;
  const attachFiles = useCallback((files: File[]) => {
    const projectId = getState().activeProjectId;
    if (!projectId || files.length === 0) return;
    const target = sessionIdRef.current;
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
    const index = ++pasteIndexRef.current;
    const name = suggestPasteFilename(pasted, index);
    const file = new File([pasted], name, { type: mimeForPasteFilename(name) });
    void attachUpload(projectId, sessionId, file).then((r) => {
      if (!r.ok) {
        setUiError(tr("composer.couldNotAttachValue", {
          name: file.name,
          reason: r.reason,
        }));
      }
    });
  }, []);
  const resolveLargePaste = useCallback((action: "attach" | "inline" | "always-attach") => {
    const pending = pendingLargePasteRef.current;
    if (!pending) return;
    setPendingLargePaste(null);
    if (action === "inline") {
      inputRef.current?.insertText(pending.text);
      return;
    }
    if (action === "always-attach") {
      setUiSettings({ largeTextPasteBehavior: "attach" });
    }
    attachPastedText(pending.text, pending.projectId, pending.sessionId);
  }, [attachPastedText]);
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

  // Paste: image/file clipboards become pills; large text may attach or ask;
  // a lone GitHub PR/issue URL becomes a pill when the project's remote matches.
  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const projectId = getState().activeProjectId;
    if (!projectId) return;
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
        sizeLabel: formatPasteSize(pasteByteLength(pasted)),
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
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProject = useStore((s) =>
    s.projectRegistry.projects.find((candidate) => candidate.id === s.activeProjectId));
  const globalDefaultModel = sessionDefaults.defaultModel ?? parseModelRef(settings.defaultModel);
  const preferredModel = resolveProjectModelDefault(
    activeProject?.defaults,
    globalDefaultModel,
    chatModels[0],
  );
  const [catalog, setCatalog] = useState<ComposerCatalogResult | null>(null);
  const catalogSeq = useRef(0);

  useEffect(() => {
    const seq = ++catalogSeq.current;
    setCatalog(null);
    if (!activeProjectId) return;
    void loadComposerCatalog(activeProjectId).then((r) => {
      if (seq === catalogSeq.current) setCatalog(r);
    });
  }, [activeProjectId]);

  const commandCatalog: CatalogState<SlashCommand> = !activeProjectId
    ? { state: "unavailable", reason: OPEN_PROJECT_FIRST }
    : catalogFromResult(catalog?.commands ?? null);
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
          historyCursor.current = emptyPromptHistoryCursor();
          announce(tr("composer.queuedMessageValueUpdatedInPlace", { id: editing.id }));
        })
        .catch((error) => setUiError(friendlyError("Couldn’t update queued message", error)))
        .finally(() => setQueueEditSaving(false));
      return;
    }
    const command = shellCommand(t);
    const hasPills = command === null && attachments.length > 0;
    if ((!t && !hasPills) || command === "") return;
    if (command === null && noModels) {
      // Never a silent no-op: pressing Enter while the model catalog is empty
      // (backend still starting / restarting) surfaces the same guidance as
      // the composer banner instead of appearing to swallow the message.
      setUiError(tr("composer.noModelsAvailableCheckThatTheBackend"));
      return;
    }
    if (command === null && profileMissing) return;
    // Capture the target session at send time — project/session switches must
    // never reroute a send (delivery admission handles active turns server-side).
    // Pills leave the draft the moment the message leaves the composer.
    const atts = command === null ? takeAttachments(target) : [];
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
    const sentModel = selected
      ? {
          providerID: selected.providerID,
          modelID: selected.modelID,
          ...(sentThinking ? { variant: sentThinking } : {}),
        }
      : undefined;
    const deliver = (targetSessionId: string) => command !== null
      ? api.runShell(targetSessionId, command).catch(
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
        let worktreePath = newSessionTarget.kind === "main"
          ? undefined
          : newSessionIntent?.worktreePath;
        if (newSessionTarget.kind === "worktree") {
          worktreePath = newSessionTarget.path;
        } else if (newSessionTarget.kind === "branch") {
          worktreePath = (await api.createWorktree(activeProjectId, newSessionTarget.branch)).path;
        } else if (newSessionTarget.kind === "new-worktree") {
          worktreePath = await createDefaultWorktree(
            activeProjectId,
            newSessionIntent?.title,
            newSessionTarget.base,
          );
        }
        const created = await createSession(activeProjectId, {
          ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
          ...(worktreePath ? { worktreePath } : {}),
          precache: true,
        });
        clearNewSessionDraft(activeProjectId);
        if (newSessionAutoApprove) await api.autoAcceptSet(created, "on");
        if (newSessionGoal) await api.goalAttach(created, t);
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
    historyCursor.current = emptyPromptHistoryCursor();
    if (target) {
      saveDraft(target, "");
      syncDraftToServer(target, ""); // clear server draft on send
    }
    setAcToken(null);
    acTokenRef.current = null;
  }, [
    text, attachments, cfg, profileMissing, noModels, working, activeProjectId, queueEdit, queueEditSaving,
    session?.model, session?.status, session?.runtimeControl, preferredModel,
    sessionDefaults.defaultThinking, chatModels, creatingSession, newSessionTarget,
    newSessionAutoApprove, newSessionGoal, newSessionIntent,
  ]);

  const applyCompletion = useCallback((item: AutocompleteItem) => {
    const token = acTokenRef.current;
    const h = inputRef.current;
    if (!token || !h) return false;
    const cur = h.getText();
    const r = completeToken(cur, token, item.value);
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
      if (e.key === "ArrowDown" && acOptions.length > 0) {
        setAcIndex((i) => (i + 1) % acOptions.length);
        return true;
      }
      if (e.key === "ArrowUp" && acOptions.length > 0) {
        setAcIndex((i) => (i - 1 + acOptions.length) % acOptions.length);
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
    const h = inputRef.current;
    const current = h?.getText() ?? text;
    const selection = h?.getSelection() ?? { start: 0, end: 0 };
    if (e.key === "ArrowUp" && (historyCursor.current.index !== null || (selection.start === 0 && selection.end === 0))) {
      const next = stepPromptHistory(historyItems, current, historyCursor.current, "up");
      historyCursor.current = next.cursor;
      applyingHistory.current = true;
      setText(next.text);
      h?.replaceText(next.text);
      return historyItems.length > 0;
    }
    if (e.key === "ArrowDown" && (historyCursor.current.index !== null || (selection.start === current.length && selection.end === current.length))) {
      const next = stepPromptHistory(historyItems, current, historyCursor.current, "down");
      historyCursor.current = next.cursor;
      applyingHistory.current = true;
      setText(next.text);
      h?.replaceText(next.text);
      return historyCursor.current.index !== null || next.text !== current;
    }
    if (e.key === "Escape" && historyCursor.current.index !== null) {
      const next = restorePromptHistoryDraft(current, historyCursor.current);
      historyCursor.current = next.cursor;
      applyingHistory.current = true;
      setText(next.text);
      h?.replaceText(next.text);
      return true;
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

  // Token-based autocomplete on committed text changes. File searches keep the
  // sequence guard: a project, session, token, or query change invalidates the
  // in-flight request, so a stale response never reopens or replaces results.
  const onTextChange = useCallback(
    (val: string) => {
      draftRevisionRef.current += 1;
      setText(val);
      if (sessionIdRef.current === null && activeProjectId) saveNewSessionDraftText(activeProjectId, val);
      if (!applyingHistory.current) historyCursor.current = emptyPromptHistoryCursor();
      applyingHistory.current = false;
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
    noteModelUsed(`${ref.providerID}/${ref.modelID}`);
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
  const pickAgent = (id: string) => updateCfg(withExplicitAgent(cfg, id || undefined));
  const activeAgent = cfg.agent
    ?? session?.agent
    ?? sessionDefaults.defaultAgent
    ?? chatAgents[0]?.name
    ?? "build";
  const activeAgentLabel = agentItems.find((item) => item.id === agentValue)?.label
    ?? agentBadgeLabel(activeAgent);

  const selectedModel = cfg.model
    ? chatModels.find((candidate) =>
        candidate.providerID === cfg.model?.providerID && candidate.modelID === cfg.model?.modelID)
    : recommendedModel
      ? chatModels.find((candidate) =>
          candidate.providerID === recommendedModel.providerID && candidate.modelID === recommendedModel.modelID)
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
    if (attachments.length === 0 || !selectedModel) return null;
    const compatibility = attachmentCompatibility(selectedModel);
    if (compatibility === "supported") return null;
    if (compatibility === "unsupported"
      && attachments.some((attachment) =>
        attachment.kind === "image" || attachment.mime.startsWith("image/"))) {
      return tr("composer.discovery.attachmentImagesNotSupported");
    }
    return ATTACHMENT_COMPAT_NOTE;
  })();
  const pickThinking = (thinking: string | undefined) => {
    if (selectedModel) setModelThinking(selectedModel, thinking);
    updateCfg(thinking === undefined ? withAutoThinking(cfg) : withExplicitThinking(cfg, thinking));
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
    historyCursor.current = emptyPromptHistoryCursor();
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
  // UX-MOBILE: phones render model + reasoning effort in a header row above
  // the editor (where the effort track has room to drag); the desktop rail
  // keeps the same controls under the text. One element, one owner — only
  // the placement differs.
  const modelControl = !noModels && (
      <ModelPicker
        models={chatModels}
        value={cfg.model}
        recommended={recommendedModel}
        direction="up"
        usage={model.contextUsage?.inputTokens}
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
  const canGenerateNextAction = !!session?.id && !working && hasCompletedExchange && !suggestionBusy;
  const generateNextAction = useCallback(() => {
    const target = sessionIdRef.current;
    if (!target || !canGenerateNextAction) return;
    const draft = inputRef.current?.getText() ?? text;
    const request: NextActionRequest = {
      sessionId: target,
      atSeq: activeSessionSeq,
      draftRevision: draftRevisionRef.current,
      draft,
    };
    setSuggestionBusy(true);
    void api.assistSuggestion(target)
      .then((result) => {
        const mode = nextActionInsertMode(request, result.suggestion);
        if (!mode || !canApplyNextAction(request, {
          activeSessionId: getState().activeSessionId,
          latestSeq: lastSeq(target),
          draftRevision: draftRevisionRef.current,
        }, result)) return;
        if (mode === "replace") requestComposerReplace(result.suggestion);
        else requestComposerInsert(result.suggestion);
      })
      .catch((error) => {
        const code = errorCodeOf(error);
        if (code === "stale" || code === "no-completed-exchange" || code === "in-flight") return;
        setUiError(friendlyError(tr("composer.couldNotGenerateNextAction"), error));
      })
      .finally(() => setSuggestionBusy(false));
  }, [activeSessionSeq, canGenerateNextAction, text]);
  // Composer controls are ordinary mini-widgets: one placement/visibility
  // system owns next action, Workflow, effort, and agent.
  const slotContext = {
    sessionId: session?.id,
    projectId: activeProjectId ?? undefined,
    variant,
    working,
    autoApproveOn,
    autoApproveBusy,
    toggleAutoApprove,
    goalOn: newSessionGoal,
    goalBusy: goalAttachBusy,
    toggleGoal,
    workflowDraftText: text,
    workflowAttachmentCount: attachments.length,
    consumeWorkflowDraft,
    composerEffortControl: effortControl,
    composerAgentControl: agentControl,
    canGenerateNextAction,
    suggestionBusy,
    generateNextAction,
  };

  const followUp = getUiSettings().followUpBehavior;
  const borrowedEpochPending = session?.status === "epoch-pending"
    && session.runtimeControl === "borrowed";
  const sendDisabled = creatingSession
    || queueEditSaving
    || borrowedEpochPending
    || (queueEdit ? !text.trim() : (!text.trim() && attachments.length === 0))
    || (!queueEdit && !shellMode && (noModels || profileMissing));
  const phoneLayout = isPhone;
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
          onSteer={async (item) => {
            const target = sessionIdRef.current;
            if (!target) return;
            const ok = await sendMessage(item.text, undefined, undefined, {
              targetSessionId: target,
              delivery: "steer",
              ...(item.attachments?.length ? { attachments: item.attachments } : {}),
              dismissPending: true,
            });
            if (!ok) return;
            await api.queueRemove(target, item.id);
          }}
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
        <div className="composer-note composer-large-paste" role="status">
          <span>{tr("composer.largePasteBanner", { size: pendingLargePaste.sizeLabel })}</span>
          <span className="composer-large-paste-actions">
            <button type="button" className="composer-large-paste-action" onClick={() => resolveLargePaste("attach")}>
              {tr("composer.largePasteAttach")}
            </button>
            <button type="button" className="composer-large-paste-action" onClick={() => resolveLargePaste("inline")}>
              {tr("composer.largePasteInline")}
            </button>
            <button type="button" className="composer-large-paste-action" onClick={() => resolveLargePaste("always-attach")}>
              {tr("composer.largePasteAlwaysAttach")}
            </button>
          </span>
        </div>
      )}
      {showModelWarning && (
        <div className="composer-note composer-runtime-unavailable" role="status">
          <span>{tr("composer.noModelsAvailableCheckThatTheBackend")}</span>
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
          onRemove={(id) => removeAttachment(session?.id ?? null, id)}
        />
      )}
      {attachments.length > 0 && !noModels && attachNote && (
        <div className="composer-attach-note">{attachNote}</div>
      )}
      {phoneLayout && modelControl && (
        <div className="composer-config-top">
          {modelControl}
        </div>
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
        <div className="composer-actions customize-zone">
          <span className="composer-extensions">
            <SlotHost slot="composer.trailing" context={slotContext} customizable />
          </span>
          <div className="composer-config">
            {!phoneLayout && modelControl}
          </div>
          <span className="composer-primary">
            {canStop ? (
              (working && (queueEdit || (followUp === "queue" && !sendDisabled))) ? (
                <div className="composer-send-split">
                    <button
                      className="send composer-delivery composer-queue"
                      onClick={() => send()}
                      aria-label={queueEdit ? tr("composer.saveQueuedMessageInIts") : tr("composer.queueMessageUntilTheCurrentResponseFinishes")}
                      title={queueEdit ? tr("composer.saveQueuedMessageInIts") : tr("composer.queueMessageUntilTheCurrentResponseFinishes")}
                      disabled={queueEdit ? queueEditSaving || !text.trim() : false}
                    >
                      <Icon.sendClock /><span className="composer-action-label">{queueEdit ? tr("common.save") : tr("composer.queue")}</span>
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
                        disabled={queueEdit ? queueEditSaving || !text.trim() : false}
                        {...trigger}
                      >
                        <Icon.chevronDown />
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
