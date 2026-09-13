import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SessionEvent } from "@polyth/contracts";
import { renderMarkdown } from "../markdown.tsx";
import { fmtCost, fmtDuration, fmtTokens } from "../format.ts";
import { groupActivity, mergeThinking, promptIndex, copyText, loadDraft, type ActivityGroup, type ActivityItem } from "../utils.ts";
import { executionPresentation, reasoningHead, reasoningTail } from "../execution.ts";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { cancelResume, forkSession, loadOlderEvents, resumeNow } from "../init.ts";
import { markSessionPerformance } from "../sessionPerformance.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import {
  applyEvent, openWorkspacePane, setUiError, startNewSession, useStore,
} from "../store.ts";
import { api } from "@polyth/session/web-api";
import {
  COPY_REASONING_NAME,
  JUMP_TO_LATEST_NAME,
  PROMPT_NAV_NAME,
  actionsMenuName,
  assistantArticleName,
  assistantTime,
  completedName,
  copyActionName,
  copyAnnouncement,
  copyJson,
  copyMarkdown,
  draftStateOf,
  forkActionName,
  forkAvailability,
  guardsFromModel,
  mutationErrorMessage,
  promptJumpName,
  reasoningToggleName,
  normalizedDuration,
  revertActionName,
  revertAvailability,
  rewindSeedKey,
  sentName,
  timeIso,
  timeShort,
  turnDurationMs,
  userArticleName,
  type ActionAvailability,
  type MutationGuards,
} from "../messageActions.ts";
import { applyComposerSeed, discardComposerSeed, loadSeedRecord } from "../drafts.ts";
import {
  LOW_RESOURCE_TIMELINE_WINDOW,
  TIMELINE_CHUNK,
  grownLimit,
  initialTimelineWindow,
  limitToInclude,
  windowStart,
} from "../timelineWindow.ts";
import {
  RAIL_PANEL_ROWS,
  activePromptIndex,
  cursorTickIndex,
  railWindow,
  tickWidth,
} from "../promptRail.ts";
import { captureTimelineAnchor, loadTimelineAnchor, restoreScrollDelta, saveTimelineAnchor, type TimelineAnchor } from "../timelineAnchor.ts";
import { publishPromptVisibility } from "../promptVisibility.ts";
import {
  TIMELINE_TAIL_EPSILON,
  requiredTurnSheetPadding,
  timelineFollowState,
} from "../timelineFollow.ts";
import AttachmentPills from "./AttachmentPills.tsx";
import CopyButton from "./CopyButton.tsx";
import SelectionMenu from "./SelectionMenu.tsx";
import SlotHost, { useSlotVersion } from "./slots/SlotHost.ts";
import { listSlots } from "../slots.ts";
import { mergeTimelineEntries } from "../timelineEvents.ts";
import type {
  AssistantMsg,
  GithubConflictMsg,
  NoticeMsg,
  RenderMessage,
  RenderModel,
  SubagentState,
  TaskActivityMsg,
  ToolMsg,
  UserMsg,
} from "../reduce.ts";
import { Icon } from "../icons.tsx";
import "./messagePinAction.tsx";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import { seedMultiRunPrompt } from "@polyth/multirun/prompt-seed";
import WorkflowTimelineCard from "../../../../packages/workflow/widgets/WorkflowTimelineCard.tsx";
import { tr } from "../i18n/index.ts";
import ExecutionRow, { DiffStat, useCollapsePresence } from "./ExecutionRow.tsx";
import Picker from "./Picker.tsx";
import type { PickerItem } from "../picker.ts";
import { Button, InfoIcon, Menu, Notice, RunSummary, type RunSummaryState } from "./ui/index.ts";
import type { TurnLimitState } from "../reduce.ts";
import ChatResponseFooter from "./ChatResponseFooter.tsx";
import MessageQuickActions from "./MessageQuickActions.tsx";

const EMPTY_SESSION_EVENTS: SessionEvent[] = [];

type Announce = (text: string) => void;

function smoothTextOff(): boolean {
  if (typeof document !== "undefined" && document.body.dataset.desktopLowResource === "true") return true;
  if (typeof document !== "undefined" && document.documentElement.dataset.reduceAnimations === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useSmoothText(target: string, fromEmpty = false): string {
  const initial = fromEmpty && !smoothTextOff() ? "" : target;
  const [shown, setShown] = useState(initial);
  const shownRef = useRef(initial);
  const rateRef = useRef(0);
  const revealRef = useRef(fromEmpty);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (target.length < shownRef.current.length || smoothTextOff()) {
      shownRef.current = target;
      rateRef.current = 0;
      revealRef.current = false;
      setShown(target);
      return;
    }
    if (shownRef.current.length >= target.length) return;
    const frames = revealRef.current ? 90 : 18;
    rateRef.current = Math.max(4, Math.ceil((target.length - shownRef.current.length) / frames));
    const step = () => {
      if (smoothTextOff()) {
        shownRef.current = target;
        setShown(target);
        return;
      }
      const behind = target.length - shownRef.current.length;
      if (behind <= 0) return;
      const take = Math.min(behind, rateRef.current);
      shownRef.current = target.slice(0, target.length - behind + take);
      setShown(shownRef.current);
      if (shownRef.current.length < target.length) raf.current = requestAnimationFrame(step);
      else revealRef.current = false;
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);
  return target.length < shown.length ? target : shown;
}

const revealedReasoning = new Set<string>();
function reasoningSeen(text: string): boolean {
  for (const seen of revealedReasoning) {
    if (text === seen || text.startsWith(seen) || seen.startsWith(text)) return true;
  }
  return false;
}

function Thinking({ m, live, entering = false }: { m: AssistantMsg; live: boolean; entering?: boolean }) {
  const prefs = useUiSettings();
  const source = m.reasoning || m.text;
  const fresh = live && m.text === "" && !reasoningSeen(source);
  const reasoning = useSmoothText(source, fresh);
  const typing = reasoning.length < source.length;
  const active = typing || (!m.finalized && live && m.text === "");
  const [open, setOpen] = useState(active || prefs.thinkingDefaultExpanded);
  const userToggled = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const reasoningAtBottom = useRef(true);
  const bodyPresent = useCollapsePresence(open);
  const head = active ? reasoningTail(reasoning) : reasoningHead(reasoning);
  useEffect(() => {
    if (active) {
      userToggled.current = false;
      setOpen(true);
    } else if (!userToggled.current) {
      setOpen(prefs.thinkingDefaultExpanded);
    }
  }, [active, prefs.thinkingDefaultExpanded]);
  useEffect(() => {
    if (fresh && !typing) revealedReasoning.add(source);
  }, [fresh, typing, source]);
  useEffect(() => {
    if (!open || !active || !reasoningAtBottom.current) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, active, reasoning]);
  const mark = (
    <span className={active ? "reasoning-mark running" : "reasoning-mark"} aria-hidden="true">
      <Icon.brain />
    </span>
  );
  const body = (
    <div className="reasoning-content">
      <div
        className="reasoning-body"
        ref={bodyRef}
        dir="auto"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          reasoningAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
        }}
      >
        {renderMarkdown(reasoning, `${m.id}-reasoning`)}
      </div>
      <div className="reasoning-foot">
        <CopyButton text={source} label={COPY_REASONING_NAME} />
      </div>
    </div>
  );
  if (!prefs.collapsibleThinkingBlocks) {
    return (
      <div className={`reasoning reasoning-flat${entering ? " timeline-row-enter" : ""}`}>
        <div className="reasoning-heading">{mark}</div>
        {body}
      </div>
    );
  }
  return (
    <div className={`reasoning${entering ? " timeline-row-enter" : ""}${open ? " open" : ""}`}>
      <button
        type="button"
        className="reasoning-toggle"
        aria-label={reasoningToggleName(open)}
        aria-expanded={open}
        onClick={() => {
          userToggled.current = true;
          setOpen((value) => {
            if (!value) reasoningAtBottom.current = true;
            return !value;
          });
        }}
      >
        {mark}
        <span className="reasoning-main">
          <strong className="reasoning-preview">{head || (active ? tr("timeline.workingThroughTheRequest") : tr("timeline.activityDetail"))}</strong>
        </span>
        <span className="reasoning-chevron" aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronRight />}</span>
      </button>
      <div className="reasoning-expand-shell" aria-hidden={!open}>
        <div className="reasoning-collapse-content">
          {bodyPresent && body}
        </div>
      </div>
    </div>
  );
}

interface MessageActionEntry {
  key: string;
  label: string;
  name: string;
  run: () => void;
  disabledReason?: string;
  dataAttr?: Record<string, string | number>;
}

function messageActionEntries(
  m: UserMsg | AssistantMsg,
  opts: {
    announce: Announce;
    onRevert?: (message: UserMsg) => void;
    onFork?: (message: UserMsg) => void;
    revert?: ActionAvailability;
    fork?: ActionAvailability;
    copyFormat: "markdown" | "json";
    onGallery?: () => void;
    onRegenerate?: () => void;
    galleryAvailable?: boolean;
  },
): MessageActionEntry[] {
  const role = m.kind;
  const doCopy = () => {
    void copyText(opts.copyFormat === "markdown" ? copyMarkdown(m) : copyJson(m)).then((ok) => {
      opts.announce(copyAnnouncement(ok ? opts.copyFormat : "failed"));
    });
  };
  const entries: MessageActionEntry[] = [{
    key: "copy",
    label: tr("timeline.copyAsValue", { value: opts.copyFormat === "markdown" ? tr("common.markdown") : tr("common.json") }),
    name: copyActionName(role, opts.copyFormat),
    run: doCopy,
  }];
  if (m.kind === "assistant") {
    entries.push({
      key: "gallery",
      label: tr("timeline.gallery"),
      name: tr("timeline.openImagesFromThisAssistantAnswer"),
      run: opts.onGallery ?? (() => {}),
      ...(!opts.galleryAvailable ? { disabledReason: tr("timeline.noImagesInThisAnswer") } : {}),
    });
    if (opts.onRegenerate) entries.push({
      key: "regenerate",
      label: tr("timeline.regenerate"),
      name: tr("timeline.regenerateThisAssistantAnswer"),
      run: opts.onRegenerate,
    });
  }
  if (m.kind === "user" && opts.onRevert) entries.push({
    key: "revert",
    label: tr("timeline.revertEdit"),
    name: revertActionName(m.time),
    run: () => opts.onRevert?.(m),
    ...(opts.revert && !opts.revert.enabled ? { disabledReason: opts.revert.reason } : {}),
    dataAttr: { "data-revert-seq": m.eventSeq },
  });
  if (m.kind === "user" && opts.onFork) entries.push({
    key: "fork",
    label: tr("timeline.forkEdit"),
    name: forkActionName(m.time),
    run: () => opts.onFork?.(m),
    ...(opts.fork && !opts.fork.enabled ? { disabledReason: opts.fork.reason } : {}),
  });
  return entries;
}

function ActionButton({ entry, className }: { entry: MessageActionEntry; className: string }) {
  const glyph = entry.key === "copy"
    ? <Icon.copy />
    : entry.key === "gallery"
      ? <Icon.image />
      : entry.key === "regenerate"
        ? <Icon.regenerate />
        : entry.key === "fork"
          ? <Icon.fork />
          : <Icon.rewind />;
  return (
    <button
      className={className}
      aria-label={entry.name}
      title={entry.disabledReason ?? entry.name}
      data-tooltip={entry.disabledReason ?? entry.label}
      disabled={entry.disabledReason !== undefined}
      onClick={entry.run}
      {...(entry.dataAttr ?? {})}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

function MessageMeta({
  m,
  announce,
  onRevert,
  onFork,
  onGallery,
  onRegenerate,
  galleryAvailable,
  revert,
  fork,
}: {
  m: UserMsg | AssistantMsg;
  announce: Announce;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  onGallery?: () => void;
  onRegenerate?: () => void;
  galleryAvailable?: boolean;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  const prefs = useUiSettings();
  const sessionId = useStore((s) => s.activeSessionId);
  const t = m.kind === "user" ? m.time : assistantTime(m);
  const name = m.kind === "user" ? sentName(t) : completedName(t);
  const entries = messageActionEntries(m, {
    announce, onRevert, onFork, revert, fork, copyFormat: prefs.messageCopyFormat,
    onGallery, onRegenerate, galleryAvailable,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) openerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!prefs.showMessageActions && menuOpen) setMenuOpen(false);
  }, [prefs.showMessageActions, menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeMenu(true); }
    };
    const onPress = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || openerRef.current?.contains(target)) return;
      const interactive = target instanceof Element
        && target.closest("button, a[href], input, textarea, select, summary, [contenteditable]") !== null;
      closeMenu(false);
      if (!interactive) {
        const opener = openerRef.current;
        requestAnimationFrame(() => opener?.focus());
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, [menuOpen, closeMenu]);
  useEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    const port = menu.closest<HTMLElement>(".timeline");
    const fit = () => {
      if (port) menu.style.maxBlockSize = `${Math.max(44, port.clientHeight - 12)}px`;
      menu.scrollIntoView({ block: "nearest" });
    };
    fit();
    const ro = port && typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : undefined;
    if (ro && port) ro.observe(port);
    menu.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    return () => ro?.disconnect();
  }, [menuOpen]);
  return (
    <>
      <div className="msg-meta">
        <time className="msg-time" dateTime={timeIso(t)} aria-label={name}>{timeShort(t)}</time>
        {prefs.showMessageActions && (
          <>
            <div className="msg-actions">
              {entries.filter((entry) => entry.key !== "regenerate").map((entry) => (
                <ActionButton key={entry.key} entry={entry} className="msg-action-btn" />
              ))}
              {m.kind === "assistant" && <SlotHost slot="session.message.actions" context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }} />}
              {entries.filter((entry) => entry.key === "regenerate").map((entry) => (
                <ActionButton key={entry.key} entry={entry} className="msg-action-btn" />
              ))}
              {m.kind === "user" && <SlotHost slot="session.message.actions" context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }} />}
            </div>
            <button
              ref={openerRef}
              className="msg-actions-entry"
              aria-label={actionsMenuName(m)}
              title={actionsMenuName(m)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-actions-seq={m.eventSeq}
              onClick={() => setMenuOpen((v) => !v)}
            ><Icon.more /></button>
          </>
        )}
      </div>
      {prefs.showMessageActions && menuOpen && (
        <div ref={menuRef} className="msg-actions-popup" role="menu" aria-label={actionsMenuName(m)}>
          {entries.map((entry) => (
            <button
              key={entry.key}
              role="menuitem"
              className="msg-actions-item"
              aria-label={entry.name}
              title={entry.disabledReason ?? entry.name}
              disabled={entry.disabledReason !== undefined}
              onClick={() => { entry.run(); closeMenu(true); }}
            >
              <span aria-hidden="true">
                {entry.key === "copy" ? <Icon.copy />
                  : entry.key === "gallery" ? <Icon.image />
                    : entry.key === "regenerate" ? <Icon.regenerate />
                      : entry.key === "fork" ? <Icon.fork /> : <Icon.rewind />}
              </span>
              <span className="msg-actions-item-label">{entry.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const RESPONSE_ACTION_ICON = {
  copy: Icon.copy,
  image: Icon.image,
  plan: Icon.plan,
  pin: Icon.bookmark,
  session: Icon.newSession,
  multirun: Icon.multirun,
} as const;

const RESPONSE_ACTION_LABEL = {
  copy: tr("timeline.copyAnswer"),
  image: tr("timeline.saveAsImage"),
  plan: tr("timeline.saveAsPlan"),
  pin: tr("timeline.pinIntoContext"),
  session: tr("timeline.startNewSessionFromThisAnswer"),
  multirun: tr("timeline.startNewMultiRunFromThisAnswer"),
} as const;

function downloadAnswerImage(text: string, title: string): boolean {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;
  const width = 1200;
  const padding = 72;
  const lineHeight = 34;
  context.font = "24px system-ui, sans-serif";
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width > width - padding * 2 && line) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line);
  }
  canvas.width = width;
  canvas.height = Math.max(260, padding * 2 + 54 + Math.min(lines.length, 120) * lineHeight);
  context.fillStyle = "#111318";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f4f6fa";
  context.font = "700 30px system-ui, sans-serif";
  context.fillText(title, padding, padding);
  context.fillStyle = "#d7dce5";
  context.font = "24px system-ui, sans-serif";
  lines.slice(0, 120).forEach((line, index) => context.fillText(line, padding, padding + 54 + index * lineHeight));
  const link = document.createElement("a");
  link.download = `polyth-answer-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  return true;
}

const pinnedBySource = new WeakMap<readonly SessionEvent[], Map<number, boolean>>();
function pinnedState(events: readonly SessionEvent[] | undefined, seq: number): boolean {
  if (!events) return false;
  let map = pinnedBySource.get(events);
  if (!map) {
    map = new Map();
    for (const event of events) {
      if (event.type !== "context/pinned" && event.type !== "context/unpinned") continue;
      const src = Number((event.data as { sourceEventSeq?: unknown }).sourceEventSeq);
      if (!Number.isFinite(src)) continue;
      map.set(src, event.type === "context/pinned");
    }
    pinnedBySource.set(events, map);
  }
  return map.get(seq) === true;
}

function AssistantAgentHeader({
  m, announce, turn, segmentStartedAt, regeneratePrompt,
}: {
  m: AssistantMsg;
  announce?: Announce;
  turn?: RenderModel["turn"];
  segmentStartedAt?: number;
  regeneratePrompt?: string;
}) {
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const projectId = useStore((state) => state.activeProjectId);
  const pinned = useStore((state) => pinnedState(session ? state.events[session.id] : undefined, m.eventSeq));
  const models = useStore((state) => state.models);
  const prefs = useUiSettings();
  const [pinBusy, setPinBusy] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  useEffect(() => {
    if (!metadataOpen) return;
    const dismiss = () => queueMicrotask(() => setMetadataOpen(false));
    document.addEventListener("click", dismiss, true);
    return () => document.removeEventListener("click", dismiss, true);
  }, [metadataOpen]);
  const modelRef = turn?.model ?? m.model ?? session?.model;
  const descriptor = modelRef
    ? models.find((candidate) => candidate.providerID === modelRef.providerID && candidate.modelID === modelRef.modelID
        && (!candidate.harnessId || !m.harnessId || candidate.harnessId === m.harnessId))
    : undefined;
  const modelName = descriptor?.name ?? (modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : "Unknown model");
  const agent = (turn?.agent ?? m.agent ?? session?.agent ?? tr("composer.build")).replace(/[-_]+/g, " ");
  const agentName = agent ? agent[0]!.toUpperCase() + agent.slice(1) : tr("composer.build");
  const wholeTurnDuration = turnDurationMs(turn ?? null);
  const fallbackStart = segmentStartedAt && segmentStartedAt > 0 ? segmentStartedAt : m.time;
  const duration = wholeTurnDuration !== null
    ? normalizedDuration(wholeTurnDuration)
    : m.completedAt !== undefined
      ? normalizedDuration(Math.max(0, m.completedAt - fallbackStart))
      : null;
  const usage = turn?.usage?.tokens ?? m.tokens;
  const cost = turn?.usage?.cost ?? m.cost;
  const hasUsage = usage !== undefined && (usage.input > 0 || usage.output > 0);
  const runAction = (id: (typeof prefs.responseActions)[number]) => {
    if (id === "copy") {
      void copyText(m.text).then((ok) => announce?.(ok ? tr("timeline.answerCopied") : tr("timeline.couldnTCopyAnswer")));
      return;
    }
    if (id === "image") {
      announce?.(downloadAnswerImage(m.text, modelName) ? tr("timeline.answerImageSaved") : tr("timeline.couldnTSaveAnswerImage"));
      return;
    }
    if (id === "plan") {
      if (!projectId) return;
      void api.knowledgeCreate({
        projectId,
        kind: "plan",
        title: tr("timeline.valuePlanValue", { modelName: modelName, value: timeShort(assistantTime(m)) }),
        body: m.text,
        ...(session ? { sourceSessionId: session.id } : {}),
      }).then(() => announce?.(tr("timeline.answerSavedAsAPlan")))
        .catch((error) => setUiError(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (id === "pin") {
      if (!session || pinBusy) return;
      setPinBusy(true);
      void (pinned ? api.unpinContext(session.id, m.eventSeq) : api.pinContext(session.id, m.eventSeq))
        .then(applyEvent)
        .catch((error) => setUiError(error instanceof Error ? error.message : String(error)))
        .finally(() => setPinBusy(false));
      return;
    }
    if (id === "session") {
      if (projectId) startNewSession(projectId, { draft: m.text });
      return;
    }
    seedMultiRunPrompt(m.text);
    openWorkspacePane("multirun");
  };
  const directActions = prefs.responseActions.filter((id) => id === "copy" || id === "pin");
  const overflowActions = prefs.responseActions.filter((id) => id !== "copy" && id !== "pin");
  const actionLabel = (id: (typeof prefs.responseActions)[number]) =>
    id === "pin" && pinned ? tr("timeline.unpinFromContext") : RESPONSE_ACTION_LABEL[id];
  const actionDisabled = (id: (typeof prefs.responseActions)[number]) =>
    (id === "pin" && pinBusy) || ((id === "plan" || id === "session") && !projectId);
  return (
    <footer className="response-footer">
      <div className="response-footer-row">
        <ProviderLogo
          providerID={descriptor?.providerID ?? modelRef?.providerID}
          providerName={descriptor?.providerName}
          harnessId={descriptor?.harnessId ?? m.harnessId ?? turn?.harnessId}
          className="response-footer-mark"
        />
        <span className="response-footer-model">{modelName}</span>
        {duration && <span className="response-footer-duration">{duration}</span>}
        <div className="response-footer-metadata">
          <button
            type="button"
            className="response-footer-metadata-trigger"
            aria-label={tr("timeline.showResponseMetadata")}
            title={tr("timeline.responseMetadata")}
            aria-expanded={metadataOpen}
            onClick={() => setMetadataOpen((open) => !open)}
          ><InfoIcon /></button>
          {metadataOpen && <div className="response-footer-metadata-grid">
            {(m.harnessId ?? turn?.harnessId) && <><span>Harness</span><strong>{m.harnessId ?? turn?.harnessId}</strong></>}
            {(m.profileId ?? turn?.profileId) && <><span>Profile</span><code>{m.profileId ?? turn?.profileId}</code></>}
            {(m.runtimeLegId ?? turn?.runtimeLegId) && <><span>Runtime leg</span><code>{m.runtimeLegId ?? turn?.runtimeLegId}</code></>}
            <span>{tr("timeline.agent")}</span><strong>{agentName}</strong>
            <span>{tr("timeline.completed")}</span><time dateTime={timeIso(assistantTime(m))}>{timeShort(assistantTime(m))}</time>
            {hasUsage && <><span>{tr("timeline.input")}</span><strong>{fmtTokens(usage.input)}</strong><span>{tr("timeline.output")}</span><strong>{fmtTokens(usage.output)}</strong></>}
            {usage?.cacheRead ? <><span>{tr("timeline.cached")}</span><strong>{fmtTokens(usage.cacheRead)}</strong></> : null}
            {cost ? <><span>{tr("timeline.cost")}</span><strong>{fmtCost(cost)}</strong></> : null}
            {turn?.turnId ? <><span>Run</span><code>{turn.turnId}</code></> : null}
          </div>}
        </div>
        <span className="response-footer-actions" aria-label={tr("timeline.answerActions")}>
          {directActions.map((id) => {
            const Glyph = RESPONSE_ACTION_ICON[id];
            const label = actionLabel(id);
            return (
              <button
                key={id}
                className={id === "pin" && pinned ? "active" : ""}
                aria-label={label}
                title={label}
                aria-pressed={id === "pin" ? pinned : undefined}
                disabled={actionDisabled(id)}
                onClick={() => runAction(id)}
              ><Glyph /></button>
            );
          })}
          {regeneratePrompt && (
            <button
              aria-label={tr("timeline.regenerateThisAssistantAnswer")}
              title={tr("timeline.regenerateThisAssistantAnswer")}
              onClick={() => requestComposerReplace(regeneratePrompt)}
            ><Icon.regenerate /></button>
          )}
          {overflowActions.length > 0 && (
            <Menu
              label={tr("timeline.moreResponseActions")}
              align="end"
              entries={overflowActions.map((id) => ({
                id,
                label: actionLabel(id),
                disabled: actionDisabled(id),
                onSelect: () => runAction(id),
              }))}
            >
              {(trigger) => <button className="response-footer-more" aria-label={tr("timeline.moreResponseActions")} title={tr("timeline.moreResponseActions")} {...trigger}><Icon.more /></button>}
            </Menu>
          )}
        </span>
      </div>
    </footer>
  );
}

const TASK_MARK = { done: "✓", active: "●", failed: "×", pending: "○" } as const;

function TodoWriteList({ items }: { items: NonNullable<RenderModel["tasks"]>["items"] }) {
  return (
    <ul className="execution-todo-list" aria-label="Todo items">
      {items.map((item) => (
        <li key={item.id} className={item.status}>
          <span className="execution-todo-mark" aria-hidden="true">{TASK_MARK[item.status]}</span>
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

function TaskList({ plan }: { plan: NonNullable<RenderModel["tasks"]> }) {
  const completed = plan.items.filter((item) => item.status === "done").length;
  const failed = plan.items.filter((item) => item.status === "failed").length;
  const allDone = completed === plan.items.length;
  const settled = plan.items.every((item) => item.status === "done" || item.status === "failed");
  const active = plan.items.find((item) => item.status === "active");
  const [open, setOpen] = useState(false);
  const itemsPresent = useCollapsePresence(open);
  useEffect(() => {
    if (settled) setOpen(false);
  }, [settled]);
  const detail = [
    tr("timeline.valueCompleteOfValue", { completed, total: plan.items.length }),
    ...(failed > 0 ? [tr("timeline.valueFailedCount", { count: failed })] : []),
    ...(active && !settled ? [active.text] : []),
  ].join(" · ");
  const state: RunSummaryState = failed > 0 && settled ? "failed"
    : active ? "active"
      : allDone ? "completed"
        : "waiting";
  return (
    <section className={`task-list${open ? " open" : ""}`} aria-label={tr("timeline.currentTaskPlan")}>
      <RunSummary
        title={tr("timeline.tasks")}
        meta={detail}
        state={state}
        expanded={open}
        label={`${open ? tr("timeline.collapse") : tr("timeline.expand")} ${tr("timeline.tasks")}, ${detail}`}
        onToggle={() => setOpen((value) => !value)}
      />
      <div className="task-list-expand-shell" aria-hidden={!open}>
        <div className="task-list-collapse-content">
          {itemsPresent && (
            <ul>
              {plan.items.map((item) => (
                <li key={item.id} className={item.status}>
                  <span className="task-list-item-mark" aria-hidden="true">{TASK_MARK[item.status]}</span>
                  <span>{item.text}</span>
                  {item.status !== "pending" && <VisuallyHiddenStatus status={item.status} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function VisuallyHiddenStatus({ status }: { status: "done" | "active" | "failed" }) {
  const label = status === "done" ? "completed" : status === "active" ? "in progress" : "failed";
  return <span className="sr-only">({label})</span>;
}

function AssistantView({
  m, announce, plan, regeneratePrompt, turn, terminal = false, segmentStartedAt, live = false, entering = false,
}: {
  m: AssistantMsg;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  regeneratePrompt?: string;
  turn?: RenderModel["turn"];
  terminal?: boolean;
  segmentStartedAt?: number;
  live?: boolean;
  entering?: boolean;
}) {
  const hasAnswer = m.text.trim() !== "" || !m.finalized;
  const answer = m.text;
  const galleryAvailable = /!\[[^\]]*]\([^)]+\)/.test(m.text);
  const openGallery = () => {
    const message = Array.from(document.querySelectorAll<HTMLElement>(tr("timeline.msgAssistant")))
      .find((candidate) => candidate.dataset.messageSeq === String(m.eventSeq));
    message?.querySelector<HTMLButtonElement>(".md-img-btn")?.click();
  };
  const articleProps = hasAnswer
    ? ({ role: "article", "aria-label": assistantArticleName(m.finalized, assistantTime(m)) } as const)
    : undefined;
  return (
    <div className={`msg assistant${entering ? " timeline-row-enter" : ""}`} data-message-seq={m.eventSeq} {...(articleProps ?? {})}>
      {m.reasoning !== "" && <Thinking m={m} live={live} />}
      {hasAnswer && (
        <div className="bubble" dir="auto">
          {renderMarkdown(answer || "", m.id)}
          {!m.finalized && <span className="caret" />}
        </div>
      )}
      {m.finalized && hasAnswer && terminal && (
        <ChatResponseFooter m={m} announce={announce} turn={turn} segmentStartedAt={segmentStartedAt} regeneratePrompt={regeneratePrompt} />
      )}
      {m.finalized && m.text !== "" && announce && galleryAvailable && (
        <button className="assistant-gallery-shortcut" onClick={openGallery}><Icon.image /> {tr("timeline.openAnswerImages")}</button>
      )}
      {plan && plan.items.length > 0 && <TaskList plan={plan} />}
    </div>
  );
}

function shellCommandText(input: ToolMsg["input"]): string {
  return typeof input.command === "string" ? input.command : JSON.stringify(input, null, 2);
}

export function shellCardCopyText(input: ToolMsg["input"], output?: string, error?: string): string {
  const command = shellCommandText(input);
  return [command, output, error].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
}

function NoticeRow({ notice, entering = false }: { notice: NoticeMsg; entering?: boolean }) {
  const text = notice.topic === "isolation-merged"
    ? tr("timeline.mergedIntoValue", { branch: notice.branch ?? "", commit: notice.commit ?? "" })
    : tr("timeline.isolatedWorkspaceDiscarded");
  return (
    <div className={`task-activity completed${entering ? " timeline-row-enter" : ""}`}>
      <span className="task-activity-mark" aria-hidden="true">✓</span>
      <span>{text}</span>
    </div>
  );
}

function TaskActivityRow({ activity, entering = false }: { activity: TaskActivityMsg; entering?: boolean }) {
  const label = activity.action === "created"
    ? tr("timeline.taskCreated")
    : activity.action === "started"
      ? tr("timeline.taskStarted")
      : activity.action === "completed"
        ? tr("timeline.taskCompleted")
        : tr("timeline.taskFailed");
  return (
    <div className={`task-activity ${activity.action}${entering ? " timeline-row-enter" : ""}`} data-task-id={activity.taskId}>
      <span className="task-activity-mark" aria-hidden="true">
        {activity.action === "completed" ? "✓" : activity.action === "failed" ? "✕" : "•"}
      </span>
      <span>{label}: {activity.text}</span>
    </div>
  );
}

function GithubConflictCard({ message, entering = false }: { message: GithubConflictMsg; entering?: boolean }) {
  const label = tr("pullrequestview.fixingPullRequestConflictsValue", { number: message.prNumber });
  return (
    <article
      className={`msg github-conflict-card${entering ? " timeline-row-enter" : ""}`}
      data-msg-id={message.id}
      aria-label={label}
    >
      <span className="github-conflict-icon" aria-hidden="true"><Icon.pullRequest /></span>
      <div className="github-conflict-copy">
        <strong>{label}</strong>
        <span>{message.title}</span>
        <code>{message.baseRefName} ← {message.headRefName}</code>
      </div>
      <a className="ui-btn ui-btn--quiet ui-btn--sm" href={message.url} target="_blank" rel="noreferrer">
        {tr("githubview.openOnGithub")} <Icon.external />
      </a>
    </article>
  );
}

function childForTool(tool: ToolMsg, subagents: SubagentState | null): SubagentState["agents"][number] | undefined {
  if (!subagents || executionPresentation(tool).kind !== "subagent") return undefined;
  const metadataId = ["sessionId", "sessionID", "childSessionId", "child_session_id"]
    .map((key) => tool.metadata?.[key])
    .find((value): value is string => typeof value === "string");
  if (metadataId) return subagents.agents.find((agent) => agent.sessionId === metadataId);
  const description = typeof tool.input.description === "string" ? tool.input.description : undefined;
  return subagents.agents.find((agent) => agent.label === description || agent.currentTask === tool.input.prompt);
}

const ACTIVITY_LIVE_EXIT_MS = 280;
const ACTION_SHOW_MS = 1_500;
const ACTION_GAP_MS = ACTIVITY_LIVE_EXIT_MS;
const ACTION_BACKLOG_MS = 2 * (ACTION_SHOW_MS + ACTION_GAP_MS);

function inFlight(item: ActivityItem): boolean {
  if (item.kind === "tool") return item.status === "pending" || item.status === "running";
  if (item.kind === "assistant") return !item.finalized;
  return item.action === "started";
}

function useActionSchedule(items: ActivityItem[]): Set<string> {
  const turns = useRef(new Map<string, number>());
  const cursor = useRef(0);
  const mounted = useRef(false);
  const [, redraw] = useState(0);
  const at = Date.now();
  for (const item of items) {
    if (turns.current.has(item.id)) continue;
    const arrivedAt = mounted.current ? at : Math.min(at, item.time);
    const startAt = Math.max(arrivedAt, cursor.current);
    if (at - arrivedAt >= ACTION_SHOW_MS || startAt - at > ACTION_BACKLOG_MS) {
      turns.current.set(item.id, 0);
      continue;
    }
    turns.current.set(item.id, startAt);
    cursor.current = startAt + ACTION_SHOW_MS + ACTION_GAP_MS;
  }
  mounted.current = true;
  const showing = new Set<string>();
  let next = Infinity;
  for (const item of items) {
    const startAt = turns.current.get(item.id) ?? 0;
    if (startAt === 0) continue;
    if (at < startAt) next = Math.min(next, startAt);
    else if (at < startAt + ACTION_SHOW_MS) {
      showing.add(item.id);
      next = Math.min(next, startAt + ACTION_SHOW_MS);
    }
  }
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => redraw((value) => value + 1), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [next]);
  return showing;
}

function useLingering(ids: string[], ms: number): string[] {
  const [leaving, setLeaving] = useState<string[]>([]);
  const previous = useRef(ids);
  const timers = useRef<number[]>([]);
  const key = ids.join("\u0000");
  useEffect(() => {
    const gone = previous.current.filter((id) => !ids.includes(id));
    previous.current = ids;
    if (gone.length === 0) return;
    setLeaving((current) => [...current, ...gone]);
    timers.current.push(window.setTimeout(() => setLeaving((current) => current.filter((id) => !gone.includes(id))), ms));
  }, [key]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  return leaving;
}

function activityItemNode(item: ActivityItem, subagents: SubagentState | null, live: boolean, entering: boolean) {
  return item.kind === "tool"
    ? <ExecutionRow key={item.id} message={item} subagent={childForTool(item, subagents)} entering={entering} />
    : item.kind === "assistant"
      ? <Thinking key={item.id} m={item} live={live} entering={entering} />
      : <TaskActivityRow key={item.id} activity={item} entering={entering} />;
}

function derivedActivityState(g: ActivityGroup): RunSummaryState {
  const latestTasks = new Map(g.tasks.map((task) => [task.taskId, task]));
  if (g.tools.some((tool) => tool.status === "error" && /cancel(?:led|ed)|aborted|stopped|interrupted/i.test(tool.error ?? ""))) return "cancelled";
  if (g.tools.some((tool) => tool.status === "error") || [...latestTasks.values()].some((task) => task.action === "failed")) return "failed";
  if (g.tools.some((tool) => tool.status === "pending" || tool.status === "running") || [...latestTasks.values()].some((task) => task.action === "started")) return "active";
  return g.settled ? "completed" : "waiting";
}

export function ActivityGroupView({
  g, subagents, state: stateOverride, entering = false,
}: {
  g: ActivityGroup;
  subagents: SubagentState | null;
  state?: RunSummaryState;
  entering?: boolean;
}) {
  const state = stateOverride ?? derivedActivityState(g);
  const active = state === "active" || state === "waiting";
  const [open, setOpen] = useState(false);
  const itemsPresent = useCollapsePresence(open);
  const showing = useActionSchedule(g.items);
  const liveIds = g.items.filter((item) => showing.has(item.id) || (active && inFlight(item))).map((item) => item.id);
  const leavingIds = useLingering(liveIds, ACTIVITY_LIVE_EXIT_MS);
  const floatingIds = new Set([...liveIds, ...leavingIds]);
  const floating = g.items.filter((item) => floatingIds.has(item.id));
  const folded = g.items.filter((item) => !floatingIds.has(item.id));
  const showBlock = g.items.length > liveIds.length;
  const files = new Set(g.tools.flatMap((tool) => {
    const presentation = executionPresentation(tool);
    return [
      ...(tool.changedFiles ?? []),
      ...(presentation.files?.map((file) => file.path) ?? []),
      ...(presentation.path ? [presentation.path] : []),
    ];
  })).size;
  const lineStats = g.tools.reduce((acc, tool) => {
    const stats = executionPresentation(tool).stats;
    if (!stats) return acc;
    return { add: acc.add + stats.add, del: acc.del + stats.del };
  }, { add: 0, del: 0 });
  const stepCount = g.items.length;
  const meta = [
    stepCount === 1 ? tr("timeline.valueStepCount", { count: stepCount }) : tr("timeline.valueStepsCount", { count: stepCount }),
    ...(files > 0 ? [files === 1 ? tr("timeline.valueFileCount", { count: files }) : tr("timeline.valueFilesCount", { count: files })] : []),
    fmtDuration(g.ms),
  ].join(" · ");
  return (
    <>
      {showBlock && (
        <section className={`msg assistant activity-group${entering ? " timeline-row-enter" : ""}${open ? " open" : ""}${active ? " current" : ""}`} aria-label={tr("timeline.agentActivity")}>
          <RunSummary
            title={tr("timeline.activity")}
            meta={meta}
            state={state}
            expanded={open}
            additions={lineStats.add}
            deletions={lineStats.del}
            label={open ? tr("timeline.collapseActivityValue", { value: meta }) : tr("timeline.expandActivityValue", { value: meta })}
            diffLabel={tr("timeline.valueAdditionsValueDeletions", { additions: lineStats.add, deletions: lineStats.del })}
            onToggle={() => setOpen((value) => !value)}
          />
          <div className="activity-group-expand-shell" aria-hidden={!open}>
            <div className="activity-group-collapse-content">
              {itemsPresent && (
                <div className="activity-group-items">
                  {folded.map((item, index) => activityItemNode(item, subagents, false, entering && active && index === folded.length - 1))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}
      {floating.map((item) => (
        <div key={item.id} className={`activity-live${liveIds.includes(item.id) ? "" : " leaving"}`}>
          <div className="activity-live-content">{activityItemNode(item, subagents, liveIds.includes(item.id), false)}</div>
        </div>
      ))}
    </>
  );
}

function useClipped(ref: RefObject<HTMLElement | null>, clamped: boolean): boolean {
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !clamped) return;
    const measure = () => setClipped(element.scrollHeight - element.clientHeight > 1);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, clamped]);
  return clipped;
}

export function UserPrompt({ text, id }: { text: string; id: string }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const clipped = useClipped(bodyRef, !open);
  return (
    <>
      <div className={`user-prompt${open ? " open" : clipped ? " clipped" : ""}`} ref={bodyRef}>
        {renderMarkdown(text, id)}
      </div>
      {clipped && (
        <button type="button" className="user-prompt-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? tr("timeline.collapse") : tr("timeline.expand")}
          <span aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronDown />}</span>
        </button>
      )}
    </>
  );
}

function MessageView({ m, announce, plan, regeneratePrompt, turn, terminal, segmentStartedAt, live, entering, onRevert, onFork, revert, fork }: {
  m: RenderMessage;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  regeneratePrompt?: string;
  turn?: RenderModel["turn"];
  terminal?: boolean;
  segmentStartedAt?: number;
  live?: boolean;
  entering?: boolean;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  if (m.kind === "user") {
    return (
      <div className={`msg user${entering ? " timeline-row-enter" : ""}`} data-msg-id={m.id} role="article" aria-label={userArticleName(m.time)}>
        <div className="bubble" dir="auto">
          <UserPrompt text={m.text} id={m.id} />
          {m.raw && m.raw !== m.text && (
            <div className="user-expanded-hint">{tr("timeline.expandedFrom")}{" "}<code>{m.raw.split("\n")[0] ?? m.raw}</code></div>
          )}
          {m.uncertain && <div className="runtime-recovery-caption">{tr("runtimeRecovery.uncertainTurn")}</div>}
        </div>
        {m.attachments && m.attachments.length > 0 && <AttachmentPills attachments={m.attachments} />}
        {announce && (
          <MessageQuickActions message={m} announce={announce} onRevert={onRevert} onFork={onFork} revert={revert} fork={fork} />
        )}
      </div>
    );
  }
  if (m.kind === "assistant") {
    return <AssistantView m={m} announce={announce} plan={plan} regeneratePrompt={regeneratePrompt} turn={turn} terminal={terminal} segmentStartedAt={segmentStartedAt} live={live} entering={entering} />;
  }
  if (m.kind === "github-conflict") return <GithubConflictCard message={m} entering={entering} />;
  if (m.kind === "notice") return <NoticeRow notice={m} entering={entering} />;
  if (m.kind === "task") return <TaskActivityRow activity={m} entering={entering} />;
  return <ExecutionRow message={m} entering={entering} />;
}

function availabilityEqual(a?: ActionAvailability, b?: ActionAvailability): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.enabled && b.enabled) return true;
  if (!a.enabled && !b.enabled) return a.reason === b.reason;
  return false;
}

function sameMessage(a: RenderMessage, b: RenderMessage): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.eventSeq !== b.eventSeq || a.time !== b.time) return false;
  if (a.undone !== b.undone || a.rewindMarkerSeq !== b.rewindMarkerSeq) return false;
  if (a === b) return true;
  if (a.kind === "user" && b.kind === "user") return a.text === b.text && a.raw === b.raw && a.attachments === b.attachments && a.uncertain === b.uncertain;
  if (a.kind === "assistant" && b.kind === "assistant") {
    return a.text === b.text && a.reasoning === b.reasoning && a.finalized === b.finalized
      && a.completedAt === b.completedAt && a.tokens === b.tokens && a.cost === b.cost
      && a.model === b.model && a.agent === b.agent;
  }
  if (a.kind === "tool" && b.kind === "tool") {
    return a.status === b.status && a.output === b.output && a.error === b.error
      && a.title === b.title && a.metadata === b.metadata && a.input === b.input
      && a.finishTime === b.finishTime && a.changedFiles === b.changedFiles;
  }
  if (a.kind === "task" && b.kind === "task") return a.action === b.action && a.text === b.text;
  if (a.kind === "notice" && b.kind === "notice") return a.topic === b.topic && a.branch === b.branch && a.commit === b.commit;
  return true;
}

const MessageRow = memo(function MessageRow(props: Parameters<typeof MessageView>[0] & { rev: number }) {
  const { rev: _rev, ...rest } = props;
  return <MessageView {...rest} />;
}, (prev, next) =>
  prev.rev === next.rev
  && sameMessage(prev.m, next.m)
  && prev.plan === next.plan
  && prev.turn === undefined && next.turn === undefined
  && prev.terminal === next.terminal
  && prev.live === next.live
  && prev.entering === next.entering
  && prev.segmentStartedAt === next.segmentStartedAt
  && prev.regeneratePrompt === next.regeneratePrompt
  && prev.announce === next.announce
  && prev.onRevert === next.onRevert
  && prev.onFork === next.onFork
  && availabilityEqual(prev.revert, next.revert)
  && availabilityEqual(prev.fork, next.fork));

function activityRev(g: ActivityGroup): number {
  let rev = g.items.length;
  for (const item of g.items) rev += item.rev ?? 0;
  return rev;
}

function sameActivity(a: ActivityGroup, b: ActivityGroup): boolean {
  if (a.id !== b.id || a.ms !== b.ms || a.settled !== b.settled || a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i += 1) if (!sameMessage(a.items[i]!, b.items[i]!)) return false;
  return true;
}

const ActivityRow = memo(function ActivityRow({ g, subagents, state, entering }: {
  rev: number;
  g: ActivityGroup;
  subagents: SubagentState | null;
  state?: RunSummaryState;
  entering?: boolean;
}) {
  return <ActivityGroupView g={g} subagents={subagents} state={state} entering={entering} />;
}, (prev, next) => prev.rev === next.rev && sameActivity(prev.g, next.g)
  && prev.subagents === next.subagents && prev.state === next.state && prev.entering === next.entering);

function PromptNavigator({ prompts, onJump, containerRef, canLoadOlder, olderBusy, onLoadOlder }: {
  prompts: Array<{ id: string; preview: string; text: string }>;
  onJump: (id: string) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  canLoadOlder: boolean;
  olderBusy: boolean;
  onLoadOlder: () => void;
}) {
  const [active, setActive] = useState(-1);
  const [hovered, setHovered] = useState(-1);
  const [open, setOpen] = useState(false);
  const [panelStart, setPanelStart] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const box = el.getBoundingClientRect();
      const line = box.top + el.clientHeight * 0.5;
      const tops = prompts.map((p) => {
        const node = el.querySelector(`[data-msg-id="${p.id}"]`);
        return node === null ? null : node.getBoundingClientRect().top;
      });
      let index = activePromptIndex(tops, line);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) {
        for (let i = tops.length - 1; i >= 0; i--) if (tops[i] !== null) { index = i; break; }
      }
      setActive(index);
    };
    const onScroll = () => { if (raf === 0) raf = requestAnimationFrame(measure); };
    el.addEventListener("scroll", onScroll, { passive: true });
    measure();
    const initialMeasure = requestAnimationFrame(measure);
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
      cancelAnimationFrame(initialMeasure);
    };
  }, [prompts, containerRef]);
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }, []);

  const reveal = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setPanelStart(Math.max(0, prompts.length - RAIL_PANEL_ROWS));
    setOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); setHovered(-1); }, 160);
  };
  const { start, end } = railWindow(prompts.length, hovered >= 0 ? hovered : active);
  const visible = prompts.slice(start, end);
  const hasEarlier = canLoadOlder || start > 0;
  const hasLater = end < prompts.length;
  const earlierPrompt = start > 0 ? prompts[start - 1] : prompts[0];
  const laterPrompt = end < prompts.length ? prompts[end] : undefined;
  const maxPanelStart = Math.max(0, prompts.length - RAIL_PANEL_ROWS);
  const currentPanelStart = Math.min(panelStart, maxPanelStart);
  const panelPrompts = prompts.slice(currentPanelStart, currentPanelStart + RAIL_PANEL_ROWS);
  const jumpTo = (id: string) => { onJump(id); setOpen(false); setHovered(-1); };
  const showEarlier = () => {
    if (start > 0 && earlierPrompt) { jumpTo(earlierPrompt.id); return; }
    if (canLoadOlder) onLoadOlder();
  };
  const showLater = () => { if (laterPrompt) jumpTo(laterPrompt.id); };

  return (
    <nav
      className="prompt-nav"
      aria-label={PROMPT_NAV_NAME}
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
      onFocus={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) reveal(); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleClose(); }}
    >
      {hasEarlier && (
        <button type="button" className="prompt-nav-page prompt-nav-edge" aria-label={start > 0 ? tr("timeline.showEarlierMessages") : tr("timeline.loadEarlierHistory")} title={start > 0 ? tr("timeline.showEarlierMessages") : tr("timeline.loadEarlierHistory")} disabled={olderBusy} onClick={showEarlier}>↑</button>
      )}
      <div
        className="prompt-nav-tape"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const local = cursorTickIndex(e.clientY - box.top, visible.length);
          setHovered(local >= 0 ? start + local : -1);
        }}
        onMouseLeave={() => setHovered(-1)}
        data-clip-above={start > 0 || undefined}
        data-clip-below={end < prompts.length || undefined}
      >
        {visible.map((p, i) => {
          const index = start + i;
          return (
            <button
              key={p.id}
              type="button"
              className={index === hovered ? "prompt-nav-tick hovered" : "prompt-nav-tick"}
              aria-label={promptJumpName(index, prompts.length, p.text)}
              aria-current={index === active ? "true" : undefined}
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(-1)}
              onClick={() => jumpTo(p.id)}
            >
              <span className="prompt-nav-tick-bar" aria-hidden="true" style={{ width: `${tickWidth(index, active, hovered)}px` }} />
            </button>
          );
        })}
      </div>
      {hasLater && <button type="button" className="prompt-nav-page prompt-nav-edge" aria-label={tr("timeline.showLaterMessages")} title={tr("timeline.showLaterMessages")} onClick={showLater}>↓</button>}
      {open && panelPrompts.length > 0 && (
        <div className="prompt-nav-panel">
          {(currentPanelStart > 0 || canLoadOlder) && (
            <button
              type="button"
              className="prompt-nav-page"
              aria-label={currentPanelStart === 0 && canLoadOlder ? tr("timeline.loadEarlierHistory") : tr("timeline.showEarlierMessages")}
              title={currentPanelStart === 0 && canLoadOlder ? tr("timeline.loadEarlierHistory") : tr("timeline.showEarlierMessages")}
              disabled={olderBusy}
              onClick={() => {
                if (currentPanelStart === 0 && canLoadOlder) onLoadOlder();
                else setPanelStart((value) => Math.max(0, value - RAIL_PANEL_ROWS));
              }}
            >↑</button>
          )}
          {panelPrompts.map((p, i) => {
            const index = currentPanelStart + i;
            return (
              <button
                key={p.id}
                type="button"
                className={index === active
                  ? (index === hovered ? "prompt-nav-row current hovered" : "prompt-nav-row current")
                  : (index === hovered ? "prompt-nav-row hovered" : "prompt-nav-row")}
                aria-current={index === active ? "true" : undefined}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(-1)}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(-1)}
                onClick={() => jumpTo(p.id)}
              >
                <span className="prompt-nav-row-text">{p.preview || tr("messageActions.emptyPrompt")}</span>
              </button>
            );
          })}
          {currentPanelStart < maxPanelStart && (
            <button type="button" className="prompt-nav-page" aria-label={tr("timeline.showLaterMessages")} title={tr("timeline.showLaterMessages")} onClick={() => setPanelStart((value) => Math.min(maxPanelStart, value + RAIL_PANEL_ROWS))}>↓</button>
          )}
        </div>
      )}
    </nav>
  );
}

function useRemainingSeconds(target: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (target <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);
  return Math.max(0, Math.ceil((target - now) / 1000));
}

function formatWait(totalSeconds: number): string {
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function RateLimitNotice({ sessionId, limit }: { sessionId: string; limit: TurnLimitState }) {
  const models = useStore((s) => s.models);
  const remaining = useRemainingSeconds(limit.resumeAt);
  const [busy, setBusy] = useState<null | "resume" | "cancel" | "switch">(null);
  const providerLabel = limit.provider ? limit.provider.charAt(0).toUpperCase() + limit.provider.slice(1) : undefined;
  const scopeLabel = limit.scope === "quota"
    ? tr("timeline.rateLimit.scopeQuota")
    : limit.scope === "overloaded"
      ? tr("timeline.rateLimit.scopeOverloaded")
      : tr("timeline.rateLimit.scopeRate");
  const heading = providerLabel
    ? tr("timeline.rateLimit.headingProvider", { provider: providerLabel, scope: scopeLabel })
    : tr("timeline.rateLimit.heading", { scope: scopeLabel });
  const modelItems = useMemo<PickerItem[]>(() => models.map((m) => ({
    id: `${m.providerID}/${m.modelID}`,
    label: m.name,
    group: m.providerName ?? m.providerID,
  })), [models]);
  const run = (kind: "resume" | "cancel", op: Promise<unknown>) => {
    setBusy(kind);
    void op.finally(() => setBusy(null));
  };
  const pickModel = (id: string) => {
    const slash = id.indexOf("/");
    if (slash < 1) return;
    setBusy("switch");
    void resumeNow(sessionId, { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }).finally(() => setBusy(null));
  };
  return (
    <Notice
      tone="warning"
      className="turn-rate-limit"
      role="status"
      aria-live="polite"
      heading={heading}
      actions={
        <>
          <Button size="sm" variant="quiet" className="turn-rate-limit-action" busy={busy === "resume"} disabled={busy !== null} onClick={() => run("resume", resumeNow(sessionId))}>{tr("timeline.rateLimit.resumeNow")}</Button>
          <Picker label={tr("timeline.rateLimit.switchModel")} items={modelItems} onPick={pickModel} disabled={busy !== null || modelItems.length === 0} className="turn-rate-limit-model" />
          <Button size="sm" variant="quiet" className="turn-rate-limit-action" busy={busy === "cancel"} disabled={busy !== null} onClick={() => run("cancel", cancelResume(sessionId))}>{tr("timeline.rateLimit.cancelWait")}</Button>
        </>
      }
    >
      {remaining > 0 ? tr("timeline.rateLimit.resumesIn", { time: formatWait(remaining) }) : tr("timeline.rateLimit.resuming")}
      {limit.attempt > 1 ? ` · ${tr("timeline.rateLimit.attempt", { n: String(limit.attempt) })}` : ""}
    </Notice>
  );
}

function blankAssistant(m: RenderMessage): boolean {
  return m.kind === "assistant" && m.finalized && m.text.trim() === "" && m.reasoning.trim() === "";
}

export function timelineAfterSlotContext(input: {
  sessionId: string | null;
  messageCount: number;
  promptCount: number;
  turnStatus: string | null;
  permissions: ReadonlyArray<{ status: string }>;
  secrets: ReadonlyArray<{ status: string }>;
}): {
  sessionId: string | null;
  messageCount: number;
  promptCount: number;
  turnStatus: string | null;
  permissions: Array<{ status: string }>;
  secrets: Array<{ status: string }>;
} {
  return {
    sessionId: input.sessionId,
    messageCount: input.messageCount,
    promptCount: input.promptCount,
    turnStatus: input.turnStatus,
    permissions: input.permissions.filter((permission) => permission.status === "pending"),
    secrets: input.secrets.filter((secret) => secret.status === "pending"),
  };
}

export default function Timeline({ model, latestRevealTarget }: {
  model: RenderModel;
  latestRevealTarget?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prefs = useUiSettings();
  const sessionId = useStore((s) => s.activeSessionId);
  const sessionEvents = useStore((s) => s.activeSessionId ? s.events[s.activeSessionId] ?? EMPTY_SESSION_EVENTS : EMPTY_SESSION_EVENTS);
  const latestUserMessage = [...model.messages].reverse().find((message) => message.kind === "user" && !message.undone);
  useSlotVersion();
  const initialLimit = initialTimelineWindow(typeof document !== "undefined" && document.body.dataset.desktopLowResource === "true");
  const [limit, setLimit] = useState(initialLimit);
  useEffect(() => {
    const applyResourceMode = () => {
      if (document.body.dataset.desktopLowResource === "true") setLimit((current) => Math.min(current, LOW_RESOURCE_TIMELINE_WINDOW));
    };
    window.addEventListener("polyth:desktop-performance-changed", applyResourceMode);
    applyResourceMode();
    return () => window.removeEventListener("polyth:desktop-performance-changed", applyResourceMode);
  }, []);
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const pendingJump = useRef<string | null>(null);
  const pendingJumpFocus = useRef(false);
  const readerDetached = useRef(false);
  const lastScrollTop = useRef(0);
  const touchY = useRef<number | null>(null);
  const scrollbarPointer = useRef(false);
  const readerIntent = useRef<{ direction: "toward-history" | "toward-tail"; until: number } | null>(null);
  const expectedScrollTop = useRef<number | null>(null);
  const turnSheetPromptId = useRef<string | null>(null);
  const turnSheetPadding = useRef(0);
  const observedPrompt = useRef({ sessionId, seq: latestUserMessage?.eventSeq ?? 0 });
  const [showJump, setShowJump] = useState(false);
  useEffect(() => {
    const releaseScrollbar = () => { scrollbarPointer.current = false; };
    window.addEventListener("pointerup", releaseScrollbar);
    window.addEventListener("pointercancel", releaseScrollbar);
    return () => {
      window.removeEventListener("pointerup", releaseScrollbar);
      window.removeEventListener("pointercancel", releaseScrollbar);
    };
  }, []);
  const restoreRef = useRef<TimelineAnchor | null>(null);
  const [anchorSession, setAnchorSession] = useState<string | null | undefined>(undefined);
  if (anchorSession !== sessionId) {
    const el = ref.current;
    if (anchorSession !== undefined && anchorSession !== null && el !== null) saveTimelineAnchor(anchorSession, captureTimelineAnchor(el, atBottom.current));
    setAnchorSession(sessionId);
    setLimit(initialLimit);
    const stored = sessionId !== null ? loadTimelineAnchor(sessionId) : null;
    restoreRef.current = stored !== null && !stored.atBottom ? stored : null;
    atBottom.current = stored?.atBottom ?? true;
    readerDetached.current = stored !== null && !stored.atBottom;
    readerIntent.current = null;
    scrollbarPointer.current = false;
    expectedScrollTop.current = null;
    lastScrollTop.current = el?.scrollTop ?? 0;
    setShowJump(stored !== null && !stored.atBottom);
  }

  useLayoutEffect(() => {
    if (sessionId === null) return;
    markSessionPerformance("cached_tail_rendered", sessionId);
  }, [sessionId]);

  const hasMessages = model.messages.length > 0;
  useEffect(() => {
    if (sessionId === null || !hasMessages || typeof requestAnimationFrame !== "function") return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => markSessionPerformance("first_message_painted", sessionId)); });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [sessionId, hasMessages]);

  const scrollToTail = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - target) >= 0.5) {
      expectedScrollTop.current = target;
      el.scrollTop = target;
    } else expectedScrollTop.current = null;
    lastScrollTop.current = el.scrollTop;
  }, []);

  const setTurnSheetPadding = useCallback((value: number) => {
    const el = ref.current;
    if (!el || Math.abs(turnSheetPadding.current - value) < 0.5) return;
    turnSheetPadding.current = value;
    if (value > 0) el.style.setProperty("--timeline-turn-sheet-space", `${value}px`);
    else el.style.removeProperty("--timeline-turn-sheet-space");
  }, []);

  const syncTurnSheet = useCallback((alignPrompt = false) => {
    const el = ref.current;
    const promptId = turnSheetPromptId.current;
    if (!el || !promptId) return;
    const prompt = [...el.querySelectorAll<HTMLElement>(".msg.user")].find((row) => row.dataset.msgId === promptId);
    if (!prompt) {
      turnSheetPromptId.current = null;
      setTurnSheetPadding(0);
      return;
    }
    const port = el.getBoundingClientRect();
    const row = prompt.getBoundingClientRect();
    const paddingTop = Number.parseFloat(getComputedStyle(el).paddingTop) || 0;
    const promptContentTop = el.scrollTop + row.top - port.top;
    const desiredScrollTop = Math.max(0, promptContentTop - paddingTop);
    const padding = requiredTurnSheetPadding({
      scrollHeight: el.scrollHeight,
      currentPadding: turnSheetPadding.current,
      clientHeight: el.clientHeight,
      desiredScrollTop,
    });
    setTurnSheetPadding(padding);
    if (alignPrompt) {
      if (Math.abs(el.scrollTop - desiredScrollTop) >= 0.5) {
        expectedScrollTop.current = desiredScrollTop;
        el.scrollTop = desiredScrollTop;
      } else expectedScrollTop.current = null;
      lastScrollTop.current = el.scrollTop;
    }
  }, [setTurnSheetPadding]);

  useLayoutEffect(() => {
    const latestSeq = latestUserMessage?.eventSeq ?? 0;
    if (observedPrompt.current.sessionId !== sessionId) {
      observedPrompt.current = { sessionId, seq: latestSeq };
      turnSheetPromptId.current = null;
      setTurnSheetPadding(0);
      return;
    }
    if (!latestUserMessage || latestSeq <= observedPrompt.current.seq) return;
    observedPrompt.current = { sessionId, seq: latestSeq };
    turnSheetPromptId.current = latestUserMessage.id;
    readerIntent.current = null;
    scrollbarPointer.current = false;
    readerDetached.current = false;
    atBottom.current = true;
    setShowJump(false);
    syncTurnSheet(true);
  }, [sessionId, latestUserMessage?.id, latestUserMessage?.eventSeq, setTurnSheetPadding, syncTurnSheet]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    syncTurnSheet();
    if (atBottom.current) {
      setShowJump(false);
      scrollToTail();
    }
  }, [model.version, scrollToTail, syncTurnSheet]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const refresh = () => {
      syncTurnSheet();
      if (atBottom.current) scrollToTail();
    };
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
    const observed = new Set<Element>();
    const observeRows = () => {
      const current = new Set<Element>([el, ...el.children]);
      for (const node of observed) {
        if (current.has(node)) continue;
        resize?.unobserve(node);
        observed.delete(node);
      }
      for (const node of current) {
        if (observed.has(node)) continue;
        resize?.observe(node);
        observed.add(node);
      }
    };
    observeRows();
    const mutations = typeof MutationObserver === "function" ? new MutationObserver(() => { observeRows(); refresh(); }) : null;
    mutations?.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "open", "aria-expanded"] });
    return () => {
      resize?.disconnect();
      mutations?.disconnect();
    };
  }, [sessionId, scrollToTail, syncTurnSheet]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteReaderIntent = (direction: "toward-history" | "toward-tail") => {
    readerIntent.current = { direction, until: Date.now() + 700 };
  };
  const stopFollowing = () => {
    const el = ref.current;
    if (!el || el.scrollHeight - el.clientHeight <= TIMELINE_TAIL_EPSILON) return;
    noteReaderIntent("toward-history");
    expectedScrollTop.current = null;
    readerDetached.current = true;
    atBottom.current = false;
    setShowJump(true);
  };
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const delta = el.scrollTop - lastScrollTop.current;
    if (scrollbarPointer.current && delta < -0.25) stopFollowing();
    else if (scrollbarPointer.current && delta > 0.25) noteReaderIntent("toward-tail");
    const lease = readerIntent.current;
    const intent = lease !== null && lease.until >= Date.now() ? lease.direction : null;
    if (lease !== null && intent === null) readerIntent.current = null;
    const programmatic = intent === null && expectedScrollTop.current !== null && Math.abs(el.scrollTop - expectedScrollTop.current) < 1;
    expectedScrollTop.current = null;
    if (!programmatic) {
      const distanceFromEnd = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
      const next = timelineFollowState({
        scrollTop: el.scrollTop,
        previousScrollTop: lastScrollTop.current,
        distanceFromEnd,
        readerDetached: readerDetached.current,
        readerIntent: intent,
      });
      readerDetached.current = next.readerDetached;
      atBottom.current = next.following;
      setShowJump(next.showJump);
    }
    lastScrollTop.current = el.scrollTop;
    if (el.scrollTop < 160 && canLoadOlder && start === 0 && !olderBusy) void loadOlder();
    if (sessionId === null) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const now = ref.current;
      if (now) saveTimelineAnchor(sessionId, captureTimelineAnchor(now, atBottom.current));
    }, 200);
  };

  useEffect(() => {
    if (sessionId === null) return;
    const flush = () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const el = ref.current;
      if (el) saveTimelineAnchor(sessionId, captureTimelineAnchor(el, atBottom.current));
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [sessionId]);

  const [liveText, setLiveText] = useState("");
  const liveRef = useRef("");
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((text: string) => {
    liveRef.current = text === liveRef.current ? `${text}\u00a0` : text;
    setLiveText(liveRef.current);
    clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => setLiveText(""), 4000);
  }, []);
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  const archived = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status === "archived");
  const sessionStatus = useStore((s) => s.activeSessionId === null ? undefined : s.sessions.find((x) => x.id === s.activeSessionId)?.status);
  const isolated = useStore((s) => s.activeSessionId !== null && s.sessions.find((x) => x.id === s.activeSessionId)?.isolation?.kind === "git-worktree");
  const sessionActive = sessionStatus === "working" || sessionStatus === "waiting";
  const canLoadOlder = useStore((s) => {
    if (s.activeSessionId === null) return false;
    const list = s.events[s.activeSessionId];
    return list !== undefined && list.length > 0 && list[0]!.seq > 1;
  });
  const pendingQuestion = model.questions.some((question) => question.status === "pending");
  const pendingPermission = model.permissions.some((permission) => permission.status === "pending");
  const pendingSecret = model.secrets.some((secret) => secret.status === "pending");
  const emptyCopy = archived ? tr("timeline.archivedSessionNoMessages") : pendingQuestion ? tr("timeline.answerPendingQuestion") : tr("timeline.noMessagesYet");
  const [queuedCount, setQueuedCount] = useState(0);
  const revertPendingRef = useRef<string | null>(null);
  const [revertPendingSession, setRevertPendingSession] = useState<string | null>(null);
  useEffect(() => {
    if (revertPendingRef.current !== null && revertPendingRef.current !== sessionId) {
      revertPendingRef.current = null;
      setRevertPendingSession(null);
    }
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) { setQueuedCount(0); return; }
    let cancelled = false;
    void api.queueList(sessionId).then((items) => { if (!cancelled) setQueuedCount(items.length); });
    return () => { cancelled = true; };
  }, [sessionId, model.queueVersion]);
  const sessionBlocked = sessionStatus === "unknown" || sessionStatus === "reconciling" || sessionStatus === "epoch-pending";
  const guards: MutationGuards = guardsFromModel(model, { queuedCount, archived, sessionBlocked });
  const revertPending = sessionId !== null && revertPendingSession === sessionId;
  const revertOk = revertPending
    ? { enabled: false as const, reason: "Revert unavailable while another revert is being applied" }
    : revertAvailability(guards);
  const forkOk = isolated
    ? { enabled: false as const, reason: "Fork is unavailable while this session is isolated" }
    : forkAvailability(guards);

  const turn = model.turn;
  const turnWorking = turn?.status === "working";
  const visibleMessages = useMemo(() => model.messages.filter((message) => !message.undone && !blankAssistant(message)), [model]);
  const undoneMessages = useMemo(() => model.messages.filter((message) => message.undone && !blankAssistant(message)), [model]);
  const rows = useMemo(() => groupActivity(mergeThinking(visibleMessages)), [visibleMessages]);
  const undoneRows = useMemo(() => groupActivity(mergeThinking(undoneMessages)), [undoneMessages]);
  const rewoundLiveActivity = model.rewind && turnWorking
    ? undoneRows.findLast((row): row is ActivityGroup => row.kind === "activity" && row.items.some((item) => item.time >= (turn.startedAt ?? Number.POSITIVE_INFINITY)))
    : undefined;
  const terminalAnswers = useMemo(() => {
    const terminal = new Map<number, number>();
    let openAt = 0;
    let lastAssistant: AssistantMsg | null = null;
    for (const message of visibleMessages) {
      if (message.kind === "user" || message.kind === "github-conflict" || message.kind === "notice") {
        if (lastAssistant !== null) terminal.set(lastAssistant.eventSeq, openAt);
        lastAssistant = null;
        openAt = message.time;
      } else if (message.kind === "assistant") lastAssistant = message;
    }
    if (lastAssistant !== null) terminal.set(lastAssistant.eventSeq, openAt);
    return terminal;
  }, [visibleMessages]);
  const prompts = useMemo(() => promptIndex(visibleMessages), [visibleMessages]);
  const showNav = prefs.promptNavigator === "on" || (prefs.promptNavigator === "auto" && (prompts.length >= 3 || canLoadOlder));
  const regenerateSources = useMemo(() => {
    const bySeq = new Map<number, string>();
    let lastUserText: string | undefined;
    for (const message of visibleMessages) {
      if (message.kind === "user") lastUserText = message.text;
      else if (message.kind === "github-conflict") lastUserText = undefined;
      else if (message.kind === "assistant" && lastUserText !== undefined) bySeq.set(message.eventSeq, lastUserText);
    }
    return bySeq;
  }, [visibleMessages]);
  const turnBroken = turn && (turn.status === "failed" || turn.status === "aborted");
  const lastPromptBoundary = [...model.messages].reverse().find((message) => message.kind === "user" || message.kind === "github-conflict");
  const lastUser = lastPromptBoundary?.kind === "user" ? lastPromptBoundary : undefined;
  useEffect(() => {
    const el = ref.current;
    const update = () => {
      const prompt = el?.querySelector<HTMLElement>(`.msg.user[data-msg-id="${lastUser?.id ?? ""}"]`);
      if (!el || !prompt) return publishPromptVisibility(false);
      const viewport = el.getBoundingClientRect();
      const row = prompt.getBoundingClientRect();
      publishPromptVisibility(row.bottom > viewport.top && row.top < viewport.bottom);
    };
    update();
    el?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      publishPromptVisibility(false);
    };
  }, [sessionId, lastUser?.id, limit]);

  const start = windowStart(rows.length, limit);
  const shownRows = start > 0 ? rows.slice(start) : rows;
  const timelineEventTypes = new Set(listSlots("session.timeline.event").flatMap((item) => {
    const value = item.meta?.eventTypes;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  }));
  const firstShownSeq = shownRows[0]
    ? shownRows[0].kind === "activity"
      ? Math.min(...shownRows[0].items.map((item) => item.eventSeq))
      : shownRows[0].eventSeq
    : 0;
  const chronologicalRows = mergeTimelineEntries(
    shownRows.map((row) => ({
      id: row.id,
      seq: row.kind === "activity" ? Math.min(...row.items.map((item) => item.eventSeq)) : row.eventSeq,
      row,
    })),
    sessionEvents,
    timelineEventTypes,
    start === 0 ? 0 : firstShownSeq,
  );
  const latestRowId = shownRows[shownRows.length - 1]?.id;
  const latestAssistantId = [...shownRows].reverse().find((row) => row.kind === "assistant")?.id;
  const latestActivityId = [...shownRows].reverse().find((row) => row.kind === "activity")?.id;
  const currentActivityState: RunSummaryState | undefined = pendingQuestion || pendingPermission || pendingSecret
    ? "waiting"
    : turn?.status === "working" ? "active"
      : turn?.status === "failed" ? "failed"
        : turn?.status === "aborted" ? "cancelled"
          : turn?.status === "stopped" ? "completed"
            : undefined;
  const revealHadFocus = useRef(false);
  const reveal = (next: number) => {
    const el = ref.current;
    if (el) anchor.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    const active = document.activeElement;
    revealHadFocus.current = active instanceof Element && active.closest(".timeline-earlier") !== null;
    setLimit(next);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && a) el.scrollTop = a.scrollTop + (el.scrollHeight - a.scrollHeight);
    const target = pendingJump.current;
    pendingJump.current = null;
    if (target) {
      const node = el?.querySelector<HTMLElement>(`[data-msg-id="${target}"]`);
      node?.scrollIntoView({ block: "center" });
      if (pendingJumpFocus.current && node) {
        node.tabIndex = -1;
        node.focus({ preventScroll: true });
      }
    }
    pendingJumpFocus.current = false;
    if (revealHadFocus.current) {
      revealHadFocus.current = false;
      if (el && el.querySelector(".timeline-earlier") === null) el.focus({ preventScroll: true });
    }
  }, [limit]);

  const [olderBusy, setOlderBusy] = useState(false);
  const revealAfterLoad = useRef(false);
  useEffect(() => {
    if (!revealAfterLoad.current || start === 0) return;
    revealAfterLoad.current = false;
    reveal(rows.length);
  });
  const loadOlder = useCallback(async () => {
    if (sessionId === null) return;
    setOlderBusy(true);
    try {
      revealAfterLoad.current = true;
      const loaded = await loadOlderEvents(sessionId);
      if (!loaded) revealAfterLoad.current = false;
    } finally {
      setOlderBusy(false);
    }
  }, [sessionId]);

  useLayoutEffect(() => {
    const a = restoreRef.current;
    const el = ref.current;
    if (a === null || a.id === null || el === null) return;
    const node = el.querySelector(`[data-msg-id="${a.id}"]`);
    if (node === null) {
      const index = rows.findIndex((r) => r.kind !== "activity" && r.id === a.id);
      if (index >= 0) {
        const next = limitToInclude(rows.length, limit, index);
        if (next !== limit) {
          setLimit(next);
          return;
        }
      }
      if (rows.length > 0 && !canLoadOlder) restoreRef.current = null;
      return;
    }
    restoreRef.current = null;
    el.scrollTop += restoreScrollDelta(el, node, a);
  });
  const jump = (id: string, opts?: { focus?: boolean }) => {
    stopFollowing();
    const index = rows.findIndex((r) => r.kind !== "activity" && r.id === id);
    const next = limitToInclude(rows.length, limit, index);
    if (next !== limit) {
      pendingJump.current = id;
      pendingJumpFocus.current = opts?.focus === true;
      setLimit(next);
      return;
    }
    const node = ref.current?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    node?.scrollIntoView({ block: "center" });
    if (opts?.focus && node) {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
    }
  };
  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    readerIntent.current = null;
    scrollbarPointer.current = false;
    readerDetached.current = false;
    atBottom.current = true;
    syncTurnSheet();
    scrollToTail();
    setShowJump(false);
    const msgs = el.querySelectorAll<HTMLElement>(":scope > .msg");
    const target = msgs[msgs.length - 1] ?? el;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  };
  const latestReveal = showJump && !pendingQuestion && !pendingPermission && !pendingSecret ? (
    <div className="timeline-reveal">
      <button className={`jump-latest${model.turn?.status === "working" ? " agent-working" : ""}`} aria-label={JUMP_TO_LATEST_NAME} title={JUMP_TO_LATEST_NAME} onClick={jumpToLatest}>↓</button>
    </div>
  ) : null;
  const revert = useCallback((message: UserMsg) => {
    if (!sessionId) return;
    if (revertPendingRef.current === sessionId) return;
    revertPendingRef.current = sessionId;
    setRevertPendingSession(sessionId);
    void api.rewind(sessionId, message.eventSeq).then((marker) => {
      applyEvent(marker);
      const draft = {
        text: message.raw ?? message.text,
        ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      };
      applyComposerSeed(sessionId, rewindSeedKey(marker.seq), draft);
      requestComposerReplace(draft.text);
    }).catch((err) => {
      const text = mutationErrorMessage("revert", err);
      announce(text);
      setUiError(text);
    }).finally(() => {
      if (revertPendingRef.current === sessionId) {
        revertPendingRef.current = null;
        setRevertPendingSession(null);
      }
    });
  }, [sessionId, announce]);
  const fork = useCallback((message: UserMsg) => {
    if (!sessionId) return;
    void forkSession(sessionId, message.eventSeq).catch((err) => {
      const text = mutationErrorMessage("fork", err);
      announce(text);
      setUiError(text);
    });
  }, [sessionId, announce]);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const restore = (opts?: { confirmed?: boolean; invoker?: HTMLElement | null }) => {
    if (!sessionId || !model.rewind) return;
    const draftState = draftStateOf(loadSeedRecord(sessionId), loadDraft(sessionId));
    if (draftState === "edited" && !opts?.confirmed) {
      setConfirmRestore(true);
      return;
    }
    const atSeq = model.rewind.atSeq;
    const invoker = opts?.invoker ?? null;
    void api.clearRewind(sessionId).then((cleared) => {
      applyEvent(cleared);
      discardComposerSeed(sessionId);
      requestComposerReplace("");
      setConfirmRestore(false);
      announce(tr("timeline.originalTimelineRestored"));
      requestAnimationFrame(() => {
        if (invoker && document.contains(invoker)) { invoker.focus(); return; }
        const el = ref.current;
        const target = el?.querySelector<HTMLElement>(`[data-revert-seq="${atSeq}"]`) ?? el?.querySelector<HTMLElement>(`[data-actions-seq="${atSeq}"]`);
        if (target) { target.focus(); return; }
        if (el) el.focus();
      });
    }).catch((err) => {
      const text = mutationErrorMessage("restore", err);
      announce(text);
      setUiError(text);
    });
  };

  const slotSummary = timelineAfterSlotContext({
    sessionId,
    messageCount: model.messages.length,
    promptCount: prompts.length,
    turnStatus: turn?.status ?? null,
    permissions: model.permissions,
    secrets: model.secrets,
  });

  return (
    <div className="timeline-shell">
      <div className="timeline-viewport">
      <div
        className="timeline"
        role="region"
        aria-label={tr("timeline.conversationTimeline")}
        tabIndex={-1}
        ref={ref}
        onScroll={onScroll}
        onWheelCapture={(event) => {
          if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
          if (event.deltaY < 0) stopFollowing();
          else if (event.deltaY > 0) noteReaderIntent("toward-tail");
        }}
        onKeyDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.matches("input, textarea, select, [contenteditable=true]")) return;
          const towardHistory = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home"
            || ((event.key === " " || event.key === "Spacebar") && event.shiftKey)
            || (event.metaKey && event.key === "ArrowUp");
          const towardTail = event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End"
            || ((event.key === " " || event.key === "Spacebar") && !event.shiftKey)
            || (event.metaKey && event.key === "ArrowDown");
          if (towardHistory) stopFollowing();
          else if (towardTail) noteReaderIntent("toward-tail");
        }}
        onPointerDownCapture={(event) => {
          const el = event.currentTarget;
          const rect = el.getBoundingClientRect();
          const direction = getComputedStyle(el).direction;
          const gutter = Math.max(12, el.offsetWidth - el.clientWidth);
          const inScrollbar = direction === "rtl" ? event.clientX <= rect.left + gutter : event.clientX >= rect.right - gutter;
          scrollbarPointer.current = event.button === 1 || (event.button === 0 && inScrollbar && el.scrollHeight > el.clientHeight);
        }}
        onPointerUpCapture={() => { scrollbarPointer.current = false; }}
        onPointerCancelCapture={() => { scrollbarPointer.current = false; }}
        onTouchStartCapture={(event) => { touchY.current = event.touches[0]?.clientY ?? null; }}
        onTouchMoveCapture={(event) => {
          const y = event.touches[0]?.clientY;
          if (touchY.current !== null && y !== undefined) {
            const deltaY = y - touchY.current;
            if (deltaY > 2) {
              stopFollowing();
              touchY.current = y;
            } else if (deltaY < -2) {
              noteReaderIntent("toward-tail");
              touchY.current = y;
            }
          }
        }}
        onTouchEndCapture={() => { touchY.current = null; }}
        onTouchCancelCapture={() => { touchY.current = null; }}
      >
        <SlotHost slot="session.timeline.before" context={slotSummary} customizable />
        {model.messages.length === 0 && !model.workflowRun && <div className="empty"><div>{emptyCopy}</div></div>}
        {start > 0 && (
          <div className="timeline-earlier">
            <Button size="sm" onClick={() => reveal(grownLimit(rows.length, limit))}>{tr("timeline.show")} {Math.min(TIMELINE_CHUNK, start)} {tr("timeline.earlier")}</Button>
            <Button size="sm" onClick={() => reveal(rows.length)}>{tr("timeline.showAll2")}{start} {tr("timeline.hidden")}</Button>
          </div>
        )}
        {start === 0 && canLoadOlder && (
          <div className="timeline-earlier">
            <Button size="sm" busy={olderBusy} onClick={() => void loadOlder()}>{olderBusy ? tr("timeline.loadingEarlierHistory") : tr("timeline.loadEarlierHistory")}</Button>
          </div>
        )}
        {chronologicalRows.map((entry) => {
          if (entry.kind === "timeline-event") return <SlotHost key={entry.id} slot="session.timeline.event" context={{ ...slotSummary, event: entry.event }} />;
          const r = entry.row;
          return r.kind === "activity"
            ? <ActivityRow key={r.id} rev={activityRev(r)} g={r} subagents={model.subagents} state={r.id === latestActivityId ? currentActivityState : undefined} entering={r.id === latestRowId} />
            : <MessageRow
                key={r.id}
                rev={r.rev ?? 0}
                m={r}
                plan={r.kind === "assistant" && r.id === latestAssistantId && model.tasks ? model.tasks : undefined}
                regeneratePrompt={r.kind === "assistant" ? regenerateSources.get(r.eventSeq) : undefined}
                turn={r.kind === "assistant" && r.id === latestAssistantId && turn?.status !== "working" ? turn : undefined}
                live={r.kind === "assistant" && turnWorking && r.id === latestAssistantId}
                entering={r.id === latestRowId}
                terminal={r.kind === "assistant" && !sessionActive && terminalAnswers.has(r.eventSeq)}
                segmentStartedAt={r.kind === "assistant" ? terminalAnswers.get(r.eventSeq) : undefined}
                announce={announce}
                onRevert={revert}
                onFork={fork}
                revert={revertOk}
                fork={forkOk}
              />;
        })}
        {rewoundLiveActivity && <ActivityRow key={`rewound-live-${rewoundLiveActivity.id}`} rev={activityRev(rewoundLiveActivity)} g={rewoundLiveActivity} subagents={model.subagents} state={currentActivityState} />}
        {model.workflowRun && <WorkflowTimelineCard run={model.workflowRun} />}
        {confirmRestore && model.rewind && undoneRows.length > 0 && (
          <div className="rewound-confirm" role="group" aria-label={tr("timeline.confirmRestore")}>
            <span>{tr("timeline.youEditedTheDraftRestoringTheOriginal")}</span>
            <Button size="sm" onClick={(event) => restore({ confirmed: true, invoker: event.currentTarget })}>{tr("timeline.restoreAndDiscardTheEditedDraft")}</Button>
            <Button size="sm" onClick={() => setConfirmRestore(false)}>{tr("timeline.keepEditingTheDraft")}</Button>
          </div>
        )}
        {model.rewind && undoneRows.length > 0 && (
          <details className="rewound-tail">
            <summary>
              <span>{undoneMessages.length} {tr("timeline.revertedTimeline")} {undoneMessages.length === 1 ? tr("timeline.item") : tr("timeline.items")}</span>
              {model.rewind && !confirmRestore && (
                <Button size="sm" onClick={(event) => { event.preventDefault(); restore({ invoker: event.currentTarget }); }}>{tr("timeline.restoreOriginalTimeline")}</Button>
              )}
            </summary>
            <div className="rewound-tail-body">
              {undoneRows.map((row) => row.kind === "activity"
                ? <ActivityRow key={row.id} rev={activityRev(row)} g={row} subagents={model.subagents} />
                : <MessageRow key={row.id} rev={row.rev ?? 0} m={row} announce={announce} />)}
            </div>
          </details>
        )}
        {turnBroken && turn.status === "failed" && turn.limit && sessionId && <RateLimitNotice sessionId={sessionId} limit={turn.limit} />}
        {turnBroken && !(turn.status === "failed" && turn.limit) && (
          <Notice
            tone="error"
            className="turn-error"
            role="alert"
            actions={turn.status === "failed" && lastUser && sessionId ? (
              <Button
                size="sm"
                className="turn-error-retry"
                title={tr("timeline.retryTheLastMessage")}
                onClick={() => {
                  const draft = {
                    text: lastUser.raw ?? lastUser.text,
                    ...(lastUser.attachments?.length ? { attachments: lastUser.attachments } : {}),
                  };
                  applyComposerSeed(sessionId, `turn-failed:${turn.turnId}`, draft);
                  requestComposerReplace(draft.text);
                }}
              >{tr("common.retry")}</Button>
            ) : undefined}
          >
            {turn.status === "aborted" ? tr("timeline.turnAborted") : tr("timeline.lastTurnFailed")}
          </Notice>
        )}
        <div className="msg-live" role="status" aria-live="polite">{liveText}</div>
        <SlotHost slot="session.timeline.after" context={slotSummary} customizable />
      </div>
      {showNav && <PromptNavigator prompts={prompts} onJump={jump} containerRef={ref} canLoadOlder={canLoadOlder} olderBusy={olderBusy} onLoadOlder={() => void loadOlder()} />}
      {latestReveal && (latestRevealTarget ? createPortal(latestReveal, latestRevealTarget) : latestReveal)}
      </div>
      <SelectionMenu container={ref} />
    </div>
  );
}
