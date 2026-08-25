import { useState, useRef, useEffect, useCallback, useMemo, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  activateProject,
  getState,
  openSettingsPage,
  setUiError,
  startNewSession,
  useActiveModel,
  useStore,
} from "../store.ts";
import {
  sendMessage,
  abortSession,
  createSession,
  rememberProjectModelSelection,
} from "../init.ts";
import {
  api,
  type ComposerCatalogResult,
  type GitBranches,
  type SlashCommand,
  type SnippetDef,
  type Worktree,
} from "../api.ts";
import { loadDraft, saveDraft, type AutocompleteItem } from "../utils.ts";
import SlotHost from "./slots/SlotHost.ts";
import { dragKind, dropIntoSession } from "../dnd.ts";
import {
  addAttachment, attachGithubLink, attachUpload, parseGithubUrl, removeAttachment,
  takeAttachments, tryAttachGithubUrl, usePendingAttachments, type GithubAttachResult,
} from "../attachments.ts";
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
  withExplicitAgent, withExplicitModel, withExplicitThinking, withProfile, withProfileNone,
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
import ComposerFocusDialog from "./ComposerFocusDialog.tsx";
import QueuedMessageList from "./QueuedMessageList.tsx";
import { GoalAttachForm } from "./GoalStrip.tsx";
import { announce } from "./a11y/live.tsx";
import { noteModelUsed } from "../modelPrefs.ts";
import { getUiSettings, useUiSettings } from "../uiPrefs.ts";
import { migrateFavoritesOnce, profilesLoaded, useProfiles } from "../profiles.ts";
import AgentProfileForm from "./AgentProfileForm.tsx";
import type {
  AgentProfile,
  ModelDescriptor,
  ModelRef,
  QueueItemDto,
  SessionProjection,
} from "@polyth/contracts";
import { agentPickerDefaultLabel } from "../composerDefaults.ts";
import { friendlyError, modKeyLabel, parseModelRef } from "../settings.ts";
import { Icon } from "../icons.tsx";
import { useWorkspaceMode } from "../widgets/workspaceMode.ts";
import ModelPicker, { modelContextLabel, modelMetaLine, modelSupportsThinking } from "./ModelPicker.tsx";
import { resolveProjectModelDefault, useSessionDefaults } from "../sessionDefaults.ts";
import { roleKind, useRolePrefs } from "../rolePrefs.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useViewportMetrics } from "../mobileViewport.ts";
import { formatNumber, getLocale, tr } from "../i18n/index.ts";
import SessionContextBar, {
  type ContextChoice,
  type SessionContextBarProps,
} from "./mobile/SessionContextBar.tsx";

function modelRefFromValue(value: string): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { providerID?: unknown; modelID?: unknown };
    if (typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return { providerID: parsed.providerID, modelID: parsed.modelID };
    }
  } catch {
    // fall through
  }
  return undefined;
}

function ContextWindowPicker({ limit, used }: { limit?: number; used?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const value = limit
    ? modelContextLabel(limit).replace(/\s+context$/, "").toUpperCase()
    : tr("composer.unknown");
  const usage = Math.max(0, used ?? 0);
  const percent = limit ? Math.min(100, Math.round((usage / limit) * 100)) : null;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return (
    <div className={`context-window-picker${open ? " open" : ""}`} ref={ref}>
      <button
        type="button"
        className="context-window-chip"
        title={limit ? tr("composer.modelContextWindowValueTokens", { value: limit.toLocaleString(getLocale()) }) : tr("composer.contextWindowUnavailable")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((valueOpen) => !valueOpen)}
      >
        <span>
          <small>{tr("composer.contextWindow")}</small>
          <strong>{value}</strong>
        </span>
        <Icon.chevronDown />
      </button>
      {open && <div className="context-window-pop" role="dialog" aria-label={tr("composer.contextWindowDetails")}>
        <div>
          <span>{tr("composer.modelLimit")}</span>
          <strong>{limit ? limit.toLocaleString(getLocale()) : tr("common.unavailable")}</strong>
        </div>
        <div>
          <span>{tr("composer.currentInput")}</span>
          <strong>{usage.toLocaleString(getLocale())} {tr("composer.tokens")}</strong>
        </div>
        {percent !== null && (
          <div className="context-window-meter" aria-label={tr("composer.valueOfContextWindowUsed", { percent: percent })}>
            <i style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>}
    </div>
  );
}

const PROFILE_MISSING_NOTE = tr("composer.profileUnavailableChooseAnother");

type NewSessionTarget =
  | { kind: "main" }
  | { kind: "worktree"; path: string }
  | { kind: "branch"; branch: string };

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

  useEffect(() => {
    let active = true;
    setSelectedBranchId(intendedWorktree ? `worktree:${intendedWorktree}` : "main");
    if (!projectId) {
      setWorktrees([]);
      setBranches({ current: "", branches: [] });
      return () => { active = false; };
    }
    setBranchLoading(true);
    void Promise.all([api.listWorktrees(projectId), api.gitBranches(projectId, session?.id)])
      .then(([nextWorktrees, nextBranches]) => {
        if (!active) return;
        setWorktrees(nextWorktrees);
        setBranches(nextBranches);
        const currentWorktree = intendedWorktree
          ? nextWorktrees.find((worktree) => worktree.path === intendedWorktree)
          : nextWorktrees.find((worktree) =>
              worktree.branch === (nextBranches.current || session?.branch || branch));
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

  const branchChoices = useMemo<LocationChoice[]>(() => {
    const linkedBranches = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
    const main = worktrees.find((worktree) => worktree.isMain);
    const choices: LocationChoice[] = [{
      id: "main",
      label: main?.branch || branches.current || branch || tr("composer.mainWorkspace"),
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
    for (const candidate of branches.branches) {
      if (candidate.remote || linkedBranches.has(candidate.name)) continue;
      choices.push({
        id: `branch:${candidate.name}`,
        label: candidate.name,
        detail: tr("composer.openInANewWorktree"),
        target: { kind: "branch", branch: candidate.name },
      });
    }
    return choices;
  }, [worktrees, branches, branch]);

  const selectedChoice = branchChoices.find((choice) => choice.id === selectedBranchId);
  const newSessionTarget = selectedChoice?.target
    ?? (intendedWorktree
      ? { kind: "worktree" as const, path: intendedWorktree }
      : { kind: "main" as const });
  const branchName = selectedChoice?.label
    || session?.branch
    || branch
    || intendedWorktree?.split("/").pop()
    || tr("composer.mainWorkspace");
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
    } else {
      setBranchLoading(true);
      void api.createWorktree(projectId, choice.target.branch)
        .then((worktree) => startNewSession(projectId, { worktreePath: worktree.path }))
        .catch((error) => setUiError(friendlyError(tr("composer.couldnTCreateTheWorktree"), error)))
        .finally(() => setBranchLoading(false));
    }
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
    },
  };
}

function compactContext(context?: number): string {
  if (!context) return tr("composer.unknown");
  if (context >= 1_000_000) {
    return `${formatNumber(context / 1_000_000, { maximumFractionDigits: 1 })}M`;
  }
  if (context >= 1_000) return `${formatNumber(Math.round(context / 1_000))}K`;
  return formatNumber(context);
}

/** Reasoning-effort variants are backend strings ("low", "xhigh", "thinking").
 *  Display only — the id sent to the backend is always the raw variant. */
const THINKING_LABELS: Record<string, string> = { xhigh: "X-High", none: tr("common.none") };

function thinkingLabel(variant: string): string {
  const known = THINKING_LABELS[variant.toLowerCase()];
  if (known) return known;
  const label = variant.replace(/[-_]+/g, " ").trim();
  return label ? label[0]!.toUpperCase() + label.slice(1) : variant;
}

/** A discrete effort control: every model-reported variant is a fixed stop,
 * with Auto retained as the first stop so an explicit override can be cleared. */
function ThinkingSlider({
  className,
  variants,
  value,
  onPick,
}: {
  className?: string;
  variants: readonly string[];
  value?: string;
  onPick: (thinking: string | undefined) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const options = ["", ...variants];
  const selected = Math.max(0, options.indexOf(value ?? ""));
  const selectedOption = options[selected] ?? "";
  const label = selectedOption ? thinkingLabel(selectedOption) : tr("composer.auto");
  return (
    <label className={`thinking-slider${className ? ` ${className}` : ""}`}>
      <span className="thinking-slider-label">
        <span className="thinking-glyph" aria-hidden="true">◌</span>
        <output>{label}</output>
      </span>
      <span className="thinking-slider-track">
        <input
          type="range"
          min={0}
          max={options.length - 1}
          step={1}
          value={selected}
          aria-label={tr("composer.thinkingEffortValue", { value: label })}
          onChange={(event) => onPick(options[Number(event.target.value)] || undefined)}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onBlur={() => setDragging(false)}
        />
        <span className="thinking-slider-stops" aria-hidden="true">
          {options.map((option, index) => (
            <i key={option || "auto"} className={index <= selected ? "active" : ""} />
          ))}
        </span>
        {dragging && <span className="thinking-slider-tooltip" role="tooltip">{tr("composer.thinkingValue", { value: label })}</span>}
      </span>
    </label>
  );
}

function agentBadgeLabel(agent?: string): string {
  const label = (agent || tr("composer.build")).replace(/[-_]+/g, " ").trim();
  return label ? label[0]!.toUpperCase() + label.slice(1) : tr("composer.build");
}

// UX-MOBILE-01 §13/§40/§41: one muted microtext line — `Text · Image · 500K`.
// No mixed glyph set, no "Context:" label competing for primary space.
function modelCapabilityMeta(model?: ModelDescriptor): string {
  const line = modelMetaLine(model);
  return line || tr("composer.contextValue", { value: compactContext(model?.context) });
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
  const [pinSeed, setPinSeed] = useState<{ providerID: string; modelID: string; name?: string } | null>(null);
  const [pinEdit, setPinEdit] = useState<AgentProfile | null>(null);
  const [createProfileOpen, setCreateProfileOpen] = useState(false);
  const [goalFormOpen, setGoalFormOpen] = useState(false);
  const [goalAttachBusy, setGoalAttachBusy] = useState(false);
  const [autoApproveBusy, setAutoApproveBusy] = useState(false);
  const [newSessionAutoApprove, setNewSessionAutoApprove] = useState(false);
  const [newSessionGoal, setNewSessionGoal] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [deliveryMenuOpen, setDeliveryMenuOpen] = useState(false);
  const deliveryMenuRef = useRef<HTMLDivElement>(null);
  const profiles = useProfiles();
  const models = useStore((s) => s.models);
  const chatModels = models.filter(modelSupportsTextWorkflow);
  const agents = useStore((s) => s.agents);
  const rolePrefs = useRolePrefs();
  const settings = useStore((s) => s.settings);
  const sessionDefaults = useSessionDefaults();
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const newSessionIntent = useStore((s) => s.newSessionIntent);
  const { contextBar, newSessionTarget } = useComposerLocation(session);
  const model = useActiveModel();
  const working = model.turn?.status === "working";
  const [techOpen, setTechOpen] = useState(false);
  const noModels = chatModels.length === 0;
  const widgetMode = variant === "widget";
  const simpleMode = useWorkspaceMode() === "chat" || widgetMode;
  const lightFocusComposer = simpleMode && !widgetMode;
  const shellLayout = useShellMode();
  const ui = useUiSettings();

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
  // mobileViewport.ts publishes --visual-vh / --keyboard-inset / --viewport-shift
  // and the phone CSS keeps the frame on the visible band. The composer reads
  // the metrics for auto-grow; it never re-derives its own transform.
  const isPhone = shellLayout === "phone";

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

  // Session switch: restore the draft through the command handle (never a
  // controlled replay), and never while the user is mid-composition. The
  // pending execution configuration is per-session and reloads with it.
  useEffect(() => {
    const outgoing = sessionIdRef.current;
    if (outgoing !== null && outgoing !== (session?.id ?? null)) {
      const editing = queueEditRef.current;
      saveDraft(outgoing, editing?.sessionId === outgoing
        ? editing.draftBefore
        : inputRef.current?.getText() ?? committedTextRef.current);
      if (editing?.sessionId === outgoing) void api.queueEditCancel(outgoing, editing.id).catch(() => {});
    }
    sessionIdRef.current = session?.id ?? null;
    const t = session?.id ? loadDraft(session.id) : newSessionIntent?.draft ?? "";
    setText(t);
    inputRef.current?.replaceText(t);
    historyCursor.current = emptyPromptHistoryCursor();
    setCfg(loadComposerConfig(session?.id ?? null));
    setAcToken(null);
    acTokenRef.current = null;
    fileSearchSeq.current++;
    setQueueEdit(null);
    setQueueEditStarting(false);
    setQueueEditSaving(false);
  }, [session?.id, newSessionIntent]);

  // Disengage on the first pointer press outside the composer (including its
  // sheets, which render inside this subtree).
  useEffect(() => {
    if (!inputFocused) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (rootRef.current?.contains(target)) return;
      // Sheets are portalled to <body>; a press inside one is still composer
      // interaction and must not collapse the surface behind it.
      if (target?.closest?.(".sheet-backdrop")) return;
      setInputFocused(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [inputFocused]);

  useEffect(() => {
    if (!deliveryMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!deliveryMenuRef.current?.contains(event.target as Node)) setDeliveryMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDeliveryMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [deliveryMenuOpen]);

  // Pane and session transitions must not depend on the debounce. Flush the
  // canonical draft synchronously on pagehide and unmount.
  useEffect(() => {
    const flush = () => {
      const id = sessionIdRef.current;
      const editing = queueEditRef.current;
      if (id !== null) saveDraft(id, editing?.sessionId === id
        ? editing.draftBefore
        : inputRef.current?.getText() ?? committedTextRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
      const editing = queueEditRef.current;
      if (editing) void api.queueEditCancel(editing.sessionId, editing.id).catch(() => {});
    };
  }, []);

  // Debounced draft persistence of committed text.
  useEffect(() => {
    const id = session?.id;
    if (!id || queueEdit?.sessionId === id) return;
    const t = setTimeout(() => saveDraft(id, text), 250);
    return () => clearTimeout(t);
  }, [session?.id, text, queueEdit]);

  // Drag-and-drop: tree paths and desktop files become attachment pills.
  const [dropHint, setDropHint] = useState<"path" | "files" | null>(null);

  // Pending attachment pills live in the per-session draft store (F2).
  const attachments = usePendingAttachments(session?.id ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Paste: image/file clipboards become pills; a lone GitHub PR/issue URL
  // becomes a pill when the project's remote matches, else stays plain text.
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
    if (!parseGithubUrl(pasted)) return;
    e.preventDefault();
    const target = sessionIdRef.current;
    void tryAttachGithubUrl(projectId, target, pasted).then((consumed) => {
      if (!consumed) inputRef.current?.insertText(pasted);
    });
  }, [attachFiles]);

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
    void api.composerCatalog(activeProjectId).then((r) => {
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
  useEffect(() => {
    const el = inputRef.current?.element();
    if (!el) return;
    const visible = bandHeight || window.innerHeight;
    // Phones collapse to zero first: `auto` resolves to the `rows` attribute,
    // which would keep an empty composer three lines tall (§7). Wider layouts
    // keep the roomier three-row resting size.
    const phone = isPhone;
    el.style.height = phone ? "0px" : "auto";
    // 42% of the visible band, but never so much that the composer's own
    // chrome (model header, actions, context bar) is pushed off a short
    // keyboard-squeezed viewport.
    const cap = phone
      ? Math.max(44, Math.min(visible * 0.42, visible - 240))
      : visible * 0.42;
    el.style.height = `${Math.min(el.scrollHeight + 2, cap)}px`;
  }, [text, inputFocused, isPhone, bandHeight]);

  // Composer inserts (Files @, drag-drop, starter chips). preventDefault marks
  // the event consumed; anything queued while unmounted drains now. Inserts go
  // through the command handle so an active composition is never interrupted.
  useEffect(() => {
    const replaceText = (detail: string) => {
      setText(detail);
      inputRef.current?.replaceText(detail);
    };
    const insert = (detail: string) => {
      const h = inputRef.current;
      if (!h) return;
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

  const send = useCallback((
    override?: string,
    deliveryOverride?: "steer" | "queue" | "interrupt",
  ) => {
    if (creatingSession) return;
    const t = (override ?? inputRef.current?.getText() ?? text).trim();
    const target = sessionIdRef.current;
    if (queueEdit) {
      if (!target || target !== queueEdit.sessionId || !t || queueEditSaving) return;
      const editing = queueEdit;
      setQueueEditSaving(true);
      void api.queueEdit(target, editing.id, t)
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
    if ((!t && !hasPills) || (command === null && noModels) || command === "") return;
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
    const requestedThinking = cfgSent.thinking ?? sessionDefaults.defaultThinking;
    const sentThinking = requestedThinking && selectedDescriptor?.variants?.includes(requestedThinking)
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
          if (!ok) return;
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
        }
        await createSession(activeProjectId, {
          ...(newSessionIntent?.title ? { title: newSessionIntent.title } : {}),
          ...(worktreePath ? { worktreePath } : {}),
        });
        const created = getState().activeSessionId;
        if (!created) throw new Error(tr("composer.theNewSessionDidNotBecomeActive"));
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
    if (target) saveDraft(target, "");
    setAcToken(null);
    acTokenRef.current = null;
  }, [
    text, attachments, cfg, profileMissing, noModels, working, activeProjectId, queueEdit, queueEditSaving,
    session?.model, preferredModel,
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
      if (settings.sendOnEnter && !e.shiftKey) {
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
      setText(val);
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
  const selectedProfileId = cfg.profile.kind === "id"
    ? cfg.profile.id
    : cfg.profile.kind === "none"
    ? ""
    : (session?.agentProfileId ?? "");

  const recommendedModel = session?.model && chatModels.some((candidate) =>
    candidate.providerID === session.model?.providerID && candidate.modelID === session.model?.modelID)
    ? session.model
    : preferredModel && chatModels.some((candidate) =>
        candidate.providerID === preferredModel.providerID && candidate.modelID === preferredModel.modelID)
      ? preferredModel
      : chatModels[0];
  const pickComposerModel = (ref?: ModelRef) => {
    if (!ref) return;
    updateCfg(withExplicitModel(cfg, ref));
    noteModelUsed(`${ref.providerID}/${ref.modelID}`);
    if (activeProjectId) {
      void rememberProjectModelSelection(activeProjectId, ref).catch((error) => {
        setUiError(friendlyError(tr("composer.couldnTRememberTheProjectModel"), error));
      });
    }
  };
  const chatAgents = agents.filter((agent) =>
    roleKind(agent, rolePrefs) === "main" && agent.name.toLowerCase() !== "compaction");
  const agentItems: PickerItem[] = [
    { id: "", label: agentPickerDefaultLabel(session?.agent, chatAgents).replace(/^Default:\s*/, ""), group: "" },
    ...chatAgents.map((a) => ({
      id: a.name,
      label: a.name,
      group: "",
    })),
  ];
  const pickAgent = (id: string) => updateCfg(withExplicitAgent(cfg, id || undefined));

  // Create/Edit profile from the model row: exactly one matching profile opens
  // Edit, otherwise the form is seeded with the immutable provider/model pair.
  const matchingProfiles = (ref: { providerID: string; modelID: string }) =>
    profiles.filter((p) => p.providerID === ref.providerID && p.modelID === ref.modelID);
  const pinModel = (value: string) => {
    const ref = modelRefFromValue(value);
    if (!ref) return;
    const matching = matchingProfiles(ref);
    if (matching.length === 1) setPinEdit(matching[0]!);
    else {
      const m = models.find((x) => x.providerID === ref.providerID && x.modelID === ref.modelID);
      setPinSeed({ ...ref, name: m?.name || ref.modelID });
    }
  };
  const modelRowAction = {
    labelFor: (id: string) => {
      const ref = modelRefFromValue(id);
      return ref && matchingProfiles(ref).length === 1 ? tr("composer.editProfile") : tr("composer.createProfile");
    },
    nameFor: (id: string) => {
      const ref = modelRefFromValue(id);
      if (!ref) return tr("composer.createProfile");
      const matching = matchingProfiles(ref);
      if (matching.length === 1) return tr("composer.editProfileValue", { name: matching[0]!.name });
      const m = models.find((x) => x.providerID === ref.providerID && x.modelID === ref.modelID);
      return tr("composer.createProfileFromValue", { value: m?.name || ref.modelID });
    },
    onAction: pinModel,
  };

  const noneLabel = tr("common.none");
  const profileItems: PickerItem[] = [
    { id: "", label: noneLabel, group: "" },
    ...profiles.map((p) => ({
      id: p.id,
      label: p.name,
      group: "",
      detail: `${p.providerID}/${p.modelID}${p.agent ? ` · ${p.agent}` : ""}`,
    })),
  ];
  const pickProfile = (id: string) => {
    updateCfg(id ? withProfile(cfg, id) : withProfileNone(cfg));
  };
  const currentProfileName = profileMissing
    ? tr("composer.profileUnavailable")
    : profiles.find((p) => p.id === selectedProfileId)?.name ?? noneLabel;
  // Creation needs a connectable model; the reason is visible text with an
  // operable settings route, never a silent hidden action.
  const profileFooter = (label: string) => ({
    label,
    run: () => setCreateProfileOpen(true),
    ...(noModels ? {
      disabledReason: tr("composer.connectAModelBeforeCreatingAProfile"),
      secondaryLabel: tr("composer.openModelSettings"),
      secondaryRun: () => openSettingsPage("models"),
    } : {}),
  });

  const currentAgentLabel = agentItems.find((i) => i.id === agentValue)?.label ?? agentItems[0]!.label;
  const selectedModel = cfg.model
    ? chatModels.find((candidate) =>
        candidate.providerID === cfg.model?.providerID && candidate.modelID === cfg.model?.modelID)
    : recommendedModel
      ? chatModels.find((candidate) =>
          candidate.providerID === recommendedModel.providerID && candidate.modelID === recommendedModel.modelID)
      : undefined;
  const activeAgent = cfg.agent ?? session?.agent ?? sessionDefaults.defaultAgent ?? chatAgents[0]?.name ?? "build";
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
    setGoalAttachBusy(true);
    void api.goalAttach(session.id, objective)
      .then(() => {
        setText("");
        inputRef.current?.replaceText("");
        saveDraft(session.id, "");
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
    if (target) saveDraft(target, "");
    // A workflow/run-started event can replace the empty-session hero composer
    // before the launch request resolves. This callback may therefore belong
    // to an unmounted instance; notify the currently mounted composer too, but
    // never clear a different session if navigation happened meanwhile.
    if (getState().activeSessionId === target) requestComposerReplace("");
  };
  // Bounded callbacks let the same configurable action widget live in either
  // composer slot without owning session-creation state.
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
  };
  const thinkingVariants = selectedModel?.variants ?? [];

  const followUp = getUiSettings().followUpBehavior;
  const sendDisabled = creatingSession
    || queueEditSaving
    || (queueEdit ? !text.trim() : (!text.trim() && attachments.length === 0))
    || (!queueEdit && !shellMode && (noModels || profileMissing));
  const phoneLayout = isPhone;
  const hasDraft = text.trim() !== "" || attachments.length > 0;
  const expanded = !phoneLayout || inputFocused || hasDraft || working || shellMode;
  const stateClass = phoneLayout
    ? ` composer-mobile ${expanded ? "composer-expanded" : "composer-collapsed"}${hasDraft ? " composer-has-draft" : ""}`
    : "";

  return (
    <div
      ref={rootRef}
      className={`composer ${widgetMode ? "composer-widget" : "composer-chat"}${simpleMode ? " composer-simple" : " composer-power"}${lightFocusComposer ? " composer-focus-light" : ""}${stateClass}`}
    >
      <SessionContextBar {...contextBar} />
      <div
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
      {noModels && (
        <div className="composer-note" role="status">
          {tr("composer.noModelsAvailableCheckThatTheBackend")}</div>
      )}
      {profileMissing && (
        <div className="composer-note composer-profile-missing" role="alert">
          {PROFILE_MISSING_NOTE}
        </div>
      )}
      {session?.id && (
        <QueuedMessageList
          sessionId={session.id}
          editingId={queueEdit?.sessionId === session.id ? queueEdit.id : null}
          onEdit={beginQueuedEdit}
        />
      )}
      {attachments.length > 0 && (
        <AttachmentPills
          attachments={attachments}
          onRemove={(id) => removeAttachment(session?.id ?? null, id)}
        />
      )}
      {attachments.length > 0 && !noModels && (
        <div className="composer-attach-note">{ATTACHMENT_COMPAT_NOTE}</div>
      )}
      {simpleMode && (
        <div className="composer-model-header">
          {!noModels && (
            <ModelPicker
              models={chatModels}
              value={cfg.model}
              recommended={recommendedModel}
              composerMeta={modelCapabilityMeta(selectedModel)}
              direction="up"
              onPick={pickComposerModel}
            />
          )}
          {/* Reasoning effort stays reachable on phones as a compact slider
              immediately right of the model name. It only exists for models
              that actually report variants. */}
          <span className="composer-mode-cluster">
            {modelSupportsThinking(selectedModel) && (
              <ThinkingSlider
                className="composer-thinking-badge"
                variants={thinkingVariants}
                value={cfg.thinking}
                onPick={(thinking) => updateCfg(withExplicitThinking(cfg, thinking || undefined))}
              />
            )}
            {chatAgents.length > 0 ? (
              <Picker
                className="composer-agent-badge"
                label={tr("composer.mode")}
                mobileSheet
                direction="up"
                items={agentItems}
                value={agentValue}
                onPick={pickAgent}
                placeholder={agentBadgeLabel(activeAgent)}
                ariaLabel={tr("composer.selectAgentModeCurrentValue", { value: agentBadgeLabel(activeAgent) })}
              />
            ) : (
              <span className="agent-type-badge">{agentBadgeLabel(activeAgent)}</span>
            )}
          </span>
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
            : simpleMode
              ? shellLayout === "phone"
                ? tr("composer.useForHelpers")
                : tr("composer.messageTheAgentTagFilesOrUse")
              : tr("composer.askAnything")}
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
          onFocusChange={(focused) => { if (focused) setInputFocused(true); }}
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
                  <button
                    type="button"
                    className="small-btn ac-create-snippet"
                    onClick={() => { setAcToken(null); openSettingsPage("commands"); }}
                  >
                    {tr("composer.createASnippet")}</button>
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
      {!simpleMode && techOpen && (
        <div className="composer-tech-help" role="note">
          {tr("composer.type")}{" "}<kbd>!</kbd> {tr("composer.forAShellCommand")}{" "}<kbd>/</kbd> {tr("composer.forCommands")}{" "}<kbd>#</kbd> {tr("composer.forSnippets")}{" "}<kbd>@</kbd> {tr("composer.toMentionFiles")}</div>
      )}
      <div className="composer-bar composer-row">
        <div className="composer-selectors">
          {!simpleMode && ui.showTechnicalButtons && <button
            className="composer-tech-toggle"
            aria-expanded={techOpen}
            title={techOpen
              ? tr("composer.hideModelAgentAndSyntaxOptions")
              : tr("composer.showModelAgentAndSyntaxOptions")}
            onClick={() => setTechOpen((open) => !open)}
          >
            {tr("composer.technicalOptions")}</button>}
          {!simpleMode && !noModels && (
            <>
              <ModelPicker
                models={chatModels}
                value={cfg.model}
                recommended={recommendedModel}
                onPick={pickComposerModel}
              />
              <ContextWindowPicker
                limit={selectedModel?.context}
                used={model.contextUsage?.inputTokens}
              />
            </>
          )}
          {!simpleMode && chatAgents.length > 0 && (
            <Picker
              className="picker-agent"
              label={tr("composer.agent")} direction="up" items={agentItems} value={agentValue} onPick={pickAgent}
              ariaLabel={tr("composer.selectWorkModeCurrentValue", { value: currentAgentLabel })}
              triggerIcon={<span className="agent-status-dot" />}
            />
          )}
          {!simpleMode && modelSupportsThinking(selectedModel) && (
            <ThinkingSlider
              className="picker-thinking"
              variants={thinkingVariants}
              value={cfg.thinking}
              onPick={(thinking) => updateCfg(withExplicitThinking(cfg, thinking || undefined))}
            />
          )}
          {!simpleMode && ui.showTechnicalButtons && techOpen && (
            <Picker
              className="picker-profile"
              label={tr("composer.profile")} direction="up" items={profileItems} value={selectedProfileId} onPick={pickProfile}
              placeholder={profileMissing ? tr("composer.profileUnavailable") : tr("common.none")}
              ariaLabel={tr("composer.selectProfileCurrentValue", { value: currentProfileName })}
              footerAction={profileFooter(tr("composer.createAProfile"))}
            />
          )}
        </div>
        {!simpleMode && (
          <div className="composer-extensions">
            <SlotHost slot="composer.leading" context={slotContext} />
            <SlotHost slot="composer.trailing" context={slotContext} />
          </div>
        )}
        <div className="composer-actions">
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
          {/* §17/§19: phones get ONE `+` (the Add menu, which owns Upload).
              Wider layouts keep the direct upload chip beside it. */}
          {!phoneLayout && (
            <button
              type="button"
              className="chip composer-add-files"
              aria-label={tr("composer.addFiles")}
              title={tr("composer.addFiles")}
              disabled={!activeProjectId}
              onClick={() => fileInputRef.current?.click()}
            ><Icon.plus /></button>
          )}
          <ComposerAddMenu
            hasProject={!!activeProjectId}
            hasSession={!!session?.id}
            goalsEnabled
            draftText={text}
            commands={commandCatalog}
            snippets={snippetCatalog}
            direction="up"
            trigger={phoneLayout ? "add" : "tools"}
            onUpload={() => fileInputRef.current?.click()}
            onInsertMention={menuMention}
            onInsertCommand={menuCommand}
            onInsertSnippet={menuSnippet}
            onEnterShell={menuShell}
            onAttachGoal={toggleGoal}
            attachGithub={attachGithub}
          />
          {simpleMode && (
            <span className="composer-extensions composer-mobile-extensions">
              <SlotHost slot="composer.leading" context={slotContext} />
              <SlotHost slot="composer.trailing" context={slotContext} />
            </span>
          )}
          <span className="composer-primary">
            {working ? (
              (queueEdit || (followUp === "queue" && !sendDisabled)) ? (
                <div className="composer-send-split" ref={deliveryMenuRef}>
                  <button
                    className="send composer-delivery composer-queue"
                    onClick={() => send()}
                    aria-label={queueEdit ? tr("composer.saveQueuedMessageInIts") : tr("composer.queueMessageUntilTheCurrentResponseFinishes")}
                    title={queueEdit ? tr("composer.saveQueuedMessageInIts") : tr("composer.queueMessageUntilTheCurrentResponseFinishes")}
                    disabled={queueEdit ? queueEditSaving || !text.trim() : false}
                  >
                    <Icon.sendClock /><span className="composer-action-label">{queueEdit ? tr("common.save") : tr("composer.queue")}</span>
                  </button>
                  <button
                    className="composer-send-options"
                    aria-label={tr("composer.moreActiveRunActions")}
                    aria-haspopup="menu"
                    aria-expanded={deliveryMenuOpen}
                    onClick={() => setDeliveryMenuOpen((open) => !open)}
                    disabled={queueEdit ? queueEditSaving || !text.trim() : false}
                  >
                    <Icon.chevronDown />
                  </button>
                  {deliveryMenuOpen && (
                    <div className="composer-send-menu" role="menu">
                      <button role="menuitem" onClick={() => { setDeliveryMenuOpen(false); send(undefined, queueEdit ? undefined : "interrupt"); }}>
                        <Icon.send /><span><strong>{queueEdit ? tr("composer.saveQueuedMessage") : tr("composer.sendNow")}</strong><small>{queueEdit ? tr("composer.keepItInItsCurrent") : tr("composer.stopTheCurrentResponseAndSend")}</small></span>
                      </button>
                      <button role="menuitem" onClick={() => { setDeliveryMenuOpen(false); void abortSession(); }}>
                        <Icon.stop /><span><strong>{tr("common.stop")}</strong><small>{tr("composer.stopWithoutSendingThisDraft")}</small></span>
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  className="stop composer-stop-primary"
                  title={tr("composer.stopTheCurrentResponse")}
                  aria-label={tr("composer.stopTheCurrentResponse")}
                  onClick={() => void abortSession()}
                >
                  <Icon.stop /><span className="composer-action-label">{tr("common.stop")}</span>
                </button>
              )
            ) : (
              <button className="send" onClick={() => send()}
                title={shellMode ? tr("composer.runShellCommand") : tr("composer.sendMessage")}
                aria-label={shellMode ? tr("composer.runShellCommand") : tr("composer.sendMessage")}
                disabled={sendDisabled}>
                {simpleMode
                  ? <span className="send-plane" aria-hidden="true"><Icon.send /></span>
                  : <>{shellMode ? tr("common.run") : tr("composer.sendNow")} <span className="send-key">{settings.sendOnEnter ? "↵" : `${modKeyLabel()}↵`}</span></>}
              </button>
            )}
          </span>
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
      {(pinSeed || pinEdit) && (
        <AgentProfileForm
          {...(pinEdit ? { existing: pinEdit } : {})}
          {...(pinSeed ? { seed: pinSeed } : {})}
          lockModel
          onClose={() => { setPinSeed(null); setPinEdit(null); }}
          onSaved={(profile, use) => { if (use) updateCfg(withProfile(cfg, profile.id)); }}
        />
      )}
      {createProfileOpen && (
        <AgentProfileForm
          onClose={() => setCreateProfileOpen(false)}
          onSaved={(profile, use) => { if (use) updateCfg(withProfile(cfg, profile.id)); }}
        />
      )}
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
      </div>
    </div>
  );
}
