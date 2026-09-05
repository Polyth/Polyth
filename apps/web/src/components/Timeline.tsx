import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SessionEvent } from "@polyth/contracts";
import { renderMarkdown } from "../markdown.tsx";
import { fmtCost, fmtDuration, fmtTokens } from "../format.ts";
import { groupActivity, mergeThinking, promptIndex, copyText, loadDraft, type ActivityGroup } from "../utils.ts";
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
import AttachmentPills from "./AttachmentPills.tsx";
import CopyButton from "./CopyButton.tsx";
import SelectionMenu from "./SelectionMenu.tsx";
import SlotHost from "./slots/SlotHost.ts";
import type {
  AssistantMsg,
  GithubConflictMsg,
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
import { Button, Menu, Notice, RunSummary, type RunSummaryState } from "./ui/index.ts";
import type { TurnLimitState } from "../reduce.ts";

/** One announcement per copy/mutation outcome; text is the accessible record,
 *  checkmarks only supplement it. Screen readers ignore repeats, so identical
 *  text gets an invisible nudge (same trick as a11y/live.tsx). */
type Announce = (text: string) => void;

/** True when streamed text must not be smoothed: accessibility settings and
 *  the desktop low-resource mode both get the raw target directly. */
function smoothTextOff(): boolean {
  if (typeof document !== "undefined" && document.body.dataset.desktopLowResource === "true") return true;
  if (typeof document !== "undefined" && document.documentElement.dataset.reduceAnimations === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Super-fast typewriter: the rendered text chases the streamed target at a
 *  rate set once per chunk arrival (backlog ÷ ~18 frames), so any backlog
 *  catches up in a fixed ~300ms and new arrivals re-rate — the visible text
 *  lags the stream by a bounded ~300ms and reads as one continuous fast
 *  type-out instead of blocks popping in. Shrinking targets (rewind) and
 *  motion-off snap immediately.
 *  `fromEmpty` mounts the chase at "" instead of the full target: a fresh
 *  live block types its FIRST backlog over a watchable ~90 frames (~1.5s at
 *  60fps) so a one-shot thought reads as typing, not a pop-in; after that
 *  first catch-up the rate returns to the bounded ~300ms chase.
 *  ponytail: re-parses one message's markdown per reveal frame; per-block
 *  memo caching in markdown/render.tsx is the upgrade if profiling complains. */
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
    // Fixed-time catch-up from THIS arrival's backlog; the floor keeps short
    // drips visibly typing instead of teleporting. The initial reveal spans
    // ~90 frames so the first full thought is readable while it types.
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
  // Render guard: never show more text than the target holds.
  return target.length < shown.length ? target : shown;
}

// Merged thinking block (P2-W2): progressive disclosure over the REAL
// reasoning stream. While the thought FORMS the block mounts expanded and its
// text types out (useSmoothText fromEmpty reveal); as soon as the thought is
// formed — the reasoning part finalized, the answer text started, or the
// stream went quiet — the block folds to a single line: the brain mark plus
// the first thought, faded out toward the line end. Expanded it renders the
// reasoning as secondary-styled markdown inside a height-capped,
// self-following scroll well, so long thinking never breaks the page.
// UX-MSG-ACTIONS: the disclosure is a native, keyboard-operable control with
// a purpose-and-target name and truthful expanded state; expanding/collapsing
// appends no event.

/** Reasoning reveals that already played in this app session. A remount of
 *  the same (or grown) reasoning — row-key change on the reasoning→answer
 *  merge, switching away and back mid-turn — must never re-type from empty.
 *  ponytail: unbounded module set, one string per revealed thought; cap or
 *  per-session reset if long-running tabs ever matter. */
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
  // Fresh live thought: its row is the turn's live latest, the answer has not
  // started, and this reasoning never revealed before → type out from empty.
  const fresh = live && m.text === "" && !reasoningSeen(source);
  const reasoning = useSmoothText(source, fresh);
  const typing = reasoning.length < source.length;
  // Block stays expanded while the thought is forming: either the reveal is
  // still typing, or the reasoning part has not finalized yet (turn working,
  // latest row). Pauses in the stream do NOT collapse — only a real
  // finalization (part-final / answer started / turn ended) folds it.
  const active = typing || (!m.finalized && live && m.text === "");
  const [open, setOpen] = useState(active || prefs.thinkingDefaultExpanded);
  const userToggled = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const reasoningAtBottom = useRef(true);
  const bodyPresent = useCollapsePresence(open);
  const head = active ? reasoningTail(reasoning) : reasoningHead(reasoning);
  // Expanded while forming; auto-folds when the thought is formed unless the
  // reader pinned it by hand.
  useEffect(() => {
    if (active) {
      userToggled.current = false;
      setOpen(true);
    } else if (!userToggled.current) {
      setOpen(prefs.thinkingDefaultExpanded);
    }
  }, [active, prefs.thinkingDefaultExpanded]);
  // A played reveal registers its reasoning so any remount shows it formed.
  useEffect(() => {
    if (fresh && !typing) revealedReasoning.add(source);
  }, [fresh, typing, source]);
  // Streaming follow mirrors the conversation reader contract: follow while
  // the well is at its tail, but preserve an intentional scroll-up position.
  // Deps track the SMOOTHED text so the well follows the per-frame reveal.
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
          reasoningAtBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 16;
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
          <strong>{head || (active ? tr("timeline.workingThroughTheRequest") : tr("timeline.activityDetail"))}</strong>
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
  name: string; // accessible purpose-and-target name
  run: () => void;
  disabledReason?: string;
  dataAttr?: Record<string, string | number>;
}

/** The action set for one user message or finalized assistant answer. Shared
 *  by the hover/focus desktop row and the persistent touch menu so pointer,
 *  Enter, and Space always produce the same operation. */
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
  const entries: MessageActionEntry[] = [
    {
      key: "copy",
      label: tr("timeline.copyAsValue", {
        value: opts.copyFormat === "markdown" ? tr("common.markdown") : tr("common.json"),
      }),
      name: copyActionName(role, opts.copyFormat),
      run: doCopy,
    },
  ];
  if (m.kind === "assistant") {
    entries.push({
      key: "gallery",
      label: tr("timeline.gallery"),
      name: tr("timeline.openImagesFromThisAssistantAnswer"),
      run: opts.onGallery ?? (() => {}),
      ...(!opts.galleryAvailable ? { disabledReason: tr("timeline.noImagesInThisAnswer") } : {}),
    });
    if (opts.onRegenerate) {
      entries.push({
        key: "regenerate",
        label: tr("timeline.regenerate"),
        name: tr("timeline.regenerateThisAssistantAnswer"),
        run: opts.onRegenerate,
      });
    }
  }
  if (m.kind === "user" && opts.onRevert) {
    entries.push({
      key: "revert",
      label: tr("timeline.revertEdit"),
      name: revertActionName(m.time),
      run: () => opts.onRevert?.(m),
      ...(opts.revert && !opts.revert.enabled ? { disabledReason: opts.revert.reason } : {}),
      dataAttr: { "data-revert-seq": m.eventSeq },
    });
  }
  if (m.kind === "user" && opts.onFork) {
    entries.push({
      key: "fork",
      label: tr("timeline.forkEdit"),
      name: forkActionName(m.time),
      run: () => opts.onFork?.(m),
      ...(opts.fork && !opts.fork.enabled ? { disabledReason: opts.fork.reason } : {}),
    });
  }
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

// Semantic time + actions row under a user message or finalized answer. The
// time stays visible; the desktop action buttons reveal on hover/focus-within
// (hidden ones have no pointer hit area); the touch entry is persistent.
//
// UX-TIMELINE-LAYOUT-01 §2.5: the narrow action menu is bounded NORMAL-FLOW
// content immediately after this footer — it pushes later content instead of
// covering its message body, its block size is capped to the visible
// scrollport (internally scrollable beyond that), and opening it reveals it
// through the existing timeline scroll root. Escape/outside press close it,
// action activation closes it, and focus returns to the opener (predecessor
// UX-MSG-ACTIONS contract, placement only).
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
    announce,
    onRevert,
    onFork,
    revert,
    fork,
    copyFormat: prefs.messageCopyFormat,
    onGallery,
    onRegenerate,
    galleryAvailable,
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
      // Outside press closes AND restores the opener, matching Escape and
      // action activation (UX-MSG-ACTIONS focus contract). One exception: a
      // press on another interactive control must keep that control's own
      // focus — restoring here would steal a deliberate target (and trap the
      // composer). The restore runs after the press's default focus handling,
      // which would otherwise land on the focusable timeline region.
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
    // Cap to the LIVE scrollport so the whole menu always sits inside it
    // (rows beyond the cap scroll internally per §2.5), then reveal it
    // through the existing timeline scroll root. The menu sits BELOW its
    // footer in normal flow, so it can never extend behind the fixed header —
    // even at scrollTop=0 — and never covers the body it belongs to. The
    // reveal region can mount mid-open and shrink the port, so the cap tracks
    // port resizes for as long as the menu stays open.
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
              {m.kind === "assistant" && (
                <SlotHost
                  slot="session.message.actions"
                  context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }}
                />
              )}
              {entries.filter((entry) => entry.key === "regenerate").map((entry) => (
                <ActionButton key={entry.key} entry={entry} className="msg-action-btn" />
              ))}
              {m.kind === "user" && (
                <SlotHost
                  slot="session.message.actions"
                  context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }}
                />
              )}
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
            >
              <Icon.more />
            </button>
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
                {entry.key === "copy"
                  ? <Icon.copy />
                  : entry.key === "gallery"
                    ? <Icon.image />
                    : entry.key === "regenerate"
                      ? <Icon.regenerate />
                  : entry.key === "fork"
                    ? <Icon.fork />
                    : <Icon.rewind />}
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
      } else {
        line = candidate;
      }
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

// Pin state per event array, computed once per applied batch and shared by
// every assistant header (previously each header re-scanned the WHOLE log on
// every store change). Selectors then return a primitive, so headers stop
// re-rendering on unrelated streamed events.
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
  m,
  announce,
  turn,
  segmentStartedAt,
  regeneratePrompt,
}: {
  m: AssistantMsg;
  announce?: Announce;
  /** Present only for the terminal assistant answer of the current turn. */
  turn?: RenderModel["turn"];
  /** Opening prompt time of the answer's turn — the fallback duration source
   *  for terminal answers whose turn state is no longer in the store. */
  segmentStartedAt?: number;
  regeneratePrompt?: string;
}) {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const projectId = useStore((state) => state.activeProjectId);
  const pinned = useStore((state) =>
    pinnedState(session ? state.events[session.id] : undefined, m.eventSeq));
  const models = useStore((state) => state.models);
  const prefs = useUiSettings();
  const [pinBusy, setPinBusy] = useState(false);
  const modelRef = turn?.model ?? m.model ?? session?.model;
  const descriptor = modelRef
    ? models.find((candidate) =>
        candidate.providerID === modelRef.providerID && candidate.modelID === modelRef.modelID)
    : undefined;
  const modelName = descriptor?.name
    ?? (modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : "Unknown model");
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
          className="response-footer-mark"
        />
        <span className="response-footer-model">{modelName}</span>
        {duration && <span className="response-footer-duration">{duration}</span>}
        <details className="response-footer-metadata">
          <summary aria-label={tr("timeline.showResponseMetadata")} title={tr("timeline.responseMetadata")}><Icon.chevronDown /></summary>
          <div className="response-footer-metadata-grid">
            <span>{tr("timeline.agent")}</span><strong>{agentName}</strong>
            <span>{tr("timeline.completed")}</span><time dateTime={timeIso(assistantTime(m))}>{timeShort(assistantTime(m))}</time>
            {hasUsage && <><span>{tr("timeline.input")}</span><strong>{fmtTokens(usage.input)}</strong><span>{tr("timeline.output")}</span><strong>{fmtTokens(usage.output)}</strong></>}
            {usage?.cacheRead ? <><span>{tr("timeline.cached")}</span><strong>{fmtTokens(usage.cacheRead)}</strong></> : null}
            {cost ? <><span>{tr("timeline.cost")}</span><strong>{fmtCost(cost)}</strong></> : null}
            {turn?.turnId ? <><span>Run</span><code>{turn.turnId}</code></> : null}
          </div>
        </details>
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

/** Text alternative for the task glyph so state never rides on shape alone. */
function VisuallyHiddenStatus({ status }: { status: "done" | "active" | "failed" }) {
  const label = status === "done" ? "completed" : status === "active" ? "in progress" : "failed";
  return <span className="sr-only">({label})</span>;
}

function AssistantView({
  m,
  announce,
  plan,
  regeneratePrompt,
  turn,
  terminal = false,
  segmentStartedAt,
  live = false,
  entering = false,
}: {
  m: AssistantMsg;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  regeneratePrompt?: string;
  turn?: RenderModel["turn"];
  /** Terminal answer of a completed turn: the only row that carries the
   *  identity panel (one per turn, rendered after the turn completes). */
  terminal?: boolean;
  segmentStartedAt?: number;
  /** True while this row is the latest assistant row of a working turn: its
   *  thinking block is the live thought and reveals with the typing effect. */
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
        <AssistantAgentHeader m={m} announce={announce} turn={turn} segmentStartedAt={segmentStartedAt} regeneratePrompt={regeneratePrompt} />
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

export function shellCardCopyText(
  input: ToolMsg["input"],
  output?: string,
  error?: string,
): string {
  const command = shellCommandText(input);
  return [command, output, error].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
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

// Technical work is projected into one run-level activity group. Settled runs
// collapse to a summary; the current run opens without promoting every tool to
// a separate card.
function childForTool(tool: ToolMsg, subagents: SubagentState | null): SubagentState["agents"][number] | undefined {
  if (!subagents || executionPresentation(tool).kind !== "subagent") return undefined;
  const metadataId = ["sessionId", "sessionID", "childSessionId", "child_session_id"]
    .map((key) => tool.metadata?.[key])
    .find((value): value is string => typeof value === "string");
  if (metadataId) return subagents.agents.find((agent) => agent.sessionId === metadataId);
  const description = typeof tool.input.description === "string" ? tool.input.description : undefined;
  return subagents.agents.find((agent) =>
    agent.label === description || agent.currentTask === tool.input.prompt);
}

function derivedActivityState(g: ActivityGroup): RunSummaryState {
  const latestTasks = new Map(g.tasks.map((task) => [task.taskId, task]));
  if (g.tools.some((tool) => tool.status === "error" && /cancel(?:led|ed)|aborted|stopped/i.test(tool.error ?? ""))) return "cancelled";
  if (g.tools.some((tool) => tool.status === "error") || [...latestTasks.values()].some((task) => task.action === "failed")) return "failed";
  if (g.tools.some((tool) => tool.status === "pending" || tool.status === "running") || [...latestTasks.values()].some((task) => task.action === "started")) return "active";
  return g.settled ? "completed" : "waiting";
}

export function ActivityGroupView({
  g,
  subagents,
  state: stateOverride,
  entering = false,
}: {
  g: ActivityGroup;
  subagents: SubagentState | null;
  state?: RunSummaryState;
  entering?: boolean;
}) {
  const state = stateOverride ?? derivedActivityState(g);
  const active = state === "active" || state === "waiting";
  const [open, setOpen] = useState(active);
  const userToggled = useRef(false);
  const itemsPresent = useCollapsePresence(open);
  useEffect(() => {
    if (userToggled.current) return;
    setOpen(active);
  }, [active]);
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
    <section className={`msg assistant activity-group${entering ? " timeline-row-enter" : ""}${open ? " open" : ""}${active ? " current" : ""}`} aria-label={tr("timeline.agentActivity")}>
      <RunSummary
        title={tr("timeline.activity")}
        meta={meta}
        state={state}
        expanded={open}
        additions={lineStats.add}
        deletions={lineStats.del}
        label={open
          ? tr("timeline.collapseActivityValue", { value: meta })
          : tr("timeline.expandActivityValue", { value: meta })}
        diffLabel={tr("timeline.valueAdditionsValueDeletions", { additions: lineStats.add, deletions: lineStats.del })}
        onToggle={() => {
          userToggled.current = true;
          setOpen((value) => !value);
        }}
      />
      <div className="activity-group-expand-shell" aria-hidden={!open}>
        <div className="activity-group-collapse-content">
          {itemsPresent && (
            <div className="activity-group-items">
              {g.items.map((item, index) => (
                 item.kind === "tool"
                  ? <ExecutionRow key={item.id} message={item} subagent={childForTool(item, subagents)} defaultOpen={active && (item.status === "pending" || item.status === "running")} entering={entering && active && index === g.items.length - 1} />
                  : item.kind === "assistant"
                    ? <Thinking key={item.id} m={item} live={active && index === g.items.length - 1} entering={entering && active && index === g.items.length - 1} />
                    : <TaskActivityRow key={item.id} activity={item} entering={entering && active && index === g.items.length - 1} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
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
          {renderMarkdown(m.text, m.id)}
          {m.attachments && m.attachments.length > 0 && (
            <AttachmentPills attachments={m.attachments} />
          )}
          {m.raw && m.raw !== m.text && (
            <div className="user-expanded-hint">
              {tr("timeline.expandedFrom")}{" "}<code>{m.raw.split("\n")[0] ?? m.raw}</code>
            </div>
          )}
          {m.uncertain && (
            <div className="runtime-recovery-caption">{tr("runtimeRecovery.uncertainTurn")}</div>
          )}
        </div>
        {announce && (
          <MessageMeta m={m} announce={announce} onRevert={onRevert} onFork={onFork} revert={revert} fork={fork} />
        )}
      </div>
    );
  }
  if (m.kind === "assistant") {
    return <AssistantView m={m} announce={announce} plan={plan} regeneratePrompt={regeneratePrompt} turn={turn} terminal={terminal} segmentStartedAt={segmentStartedAt} live={live} entering={entering} />;
  }
  if (m.kind === "github-conflict") return <GithubConflictCard message={m} entering={entering} />;
  if (m.kind === "task") return <TaskActivityRow activity={m} entering={entering} />;
  return <ExecutionRow message={m} entering={entering} />;
}

// ---- memoized rows -----------------------------------------------------------
// reduceEvent mutates message objects IN PLACE, so identity checks cannot see
// changes: each row captures a scalar `rev` prop at render time (bumped by
// every in-place mutation, accumulated by mergeThinking for merged rows) and
// falls back to snapshot-field comparison for rows that merge re-creates.
// Net effect: a streamed chunk re-renders ONE row instead of the whole log.

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
  if (a === b) return true; // same object → the rev prop covers mutations
  if (a.kind === "user" && b.kind === "user") {
    return a.text === b.text && a.raw === b.raw && a.attachments === b.attachments
      && a.uncertain === b.uncertain;
  }
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
  if (a.kind === "task" && b.kind === "task") {
    return a.action === b.action && a.text === b.text;
  }
  return true; // github-conflict: immutable after creation
}

const MessageRow = memo(function MessageRow(props: Parameters<typeof MessageView>[0] & { rev: number }) {
  const { rev: _rev, ...rest } = props;
  return <MessageView {...rest} />;
}, (prev, next) =>
  prev.rev === next.rev
  && sameMessage(prev.m, next.m)
  && prev.plan === next.plan
  // model.turn mutates in place: any row holding it must always re-render
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

/** Sum of item revs + count: strictly grows on any member mutation/addition. */
function activityRev(g: ActivityGroup): number {
  let rev = g.items.length;
  for (const item of g.items) rev += item.rev ?? 0;
  return rev;
}

function sameActivity(a: ActivityGroup, b: ActivityGroup): boolean {
  if (a.id !== b.id || a.ms !== b.ms || a.settled !== b.settled || a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i += 1) {
    if (!sameMessage(a.items[i]!, b.items[i]!)) return false;
  }
  return true;
}

const ActivityRow = memo(function ActivityRow({
  g,
  subagents,
  state,
  entering,
}: {
  rev: number;
  g: ActivityGroup;
  subagents: SubagentState | null;
  state?: RunSummaryState;
  entering?: boolean;
}) {
  return <ActivityGroupView g={g} subagents={subagents} state={state} entering={entering} />;
}, (prev, next) => prev.rev === next.rev && sameActivity(prev.g, next.g)
  && prev.subagents === next.subagents && prev.state === next.state && prev.entering === next.entering);

// Right-edge prompt rail (WP4, restyled after polyth PromptNavigatorRail):
// a thin vertical tape of ticks in a 28px gutter hugging the right edge of the
// chat viewport, vertically centered. It is a SIBLING of the .timeline scroller
// (absolute within .timeline-viewport), so it never scrolls away and never
// competes with right-aligned user bubbles. Each tick is one real user prompt
// from this session; the active turn is tracked against the timeline scroll
// position, ticks swell in a proximity wave under the cursor, and hover/focus
// reveals a recent-turns panel. Click jumps via the existing
// jump()/scrollIntoView path. Presentation-only — no SessionEvent.
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

  // Scroll-spy: the active turn is the last prompt at/above the viewport
  // midline; at the very bottom the newest rendered prompt always wins (its
  // top may never cross the midline). rAF-throttled; rows hidden by L13
  // windowing count as "above" (see activePromptIndex).
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
        for (let i = tops.length - 1; i >= 0; i--) {
          if (tops[i] !== null) { index = i; break; }
        }
      }
      setActive(index);
    };
    const onScroll = () => { if (raf === 0) raf = requestAnimationFrame(measure); };
    el.addEventListener("scroll", onScroll, { passive: true });
    measure();
    // Timeline restores the tail in its own effect. Measure once more after
    // that first layout so a long chat gets its initial tick window immediately
    // instead of waiting for the reader to scroll.
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
  // 160ms leave grace so the pointer can cross the gap into the panel.
  const scheduleClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); setHovered(-1); }, 160);
  };

  // Hovering a text row can target a prompt outside the current 30-tick
  // window; center the tape on that same prompt so the two representations
  // always have a visible counterpart.
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
  const showLater = () => {
    if (laterPrompt) jumpTo(laterPrompt.id);
  };

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
        <button
          type="button"
          className="prompt-nav-page prompt-nav-edge"
          aria-label={start > 0 ? tr("timeline.showEarlierMessages") : tr("timeline.loadEarlierHistory")}
          title={start > 0 ? tr("timeline.showEarlierMessages") : tr("timeline.loadEarlierHistory")}
          disabled={olderBusy}
          onClick={showEarlier}
        >↑</button>
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
              <span
                className="prompt-nav-tick-bar"
                aria-hidden="true"
                style={{ width: `${tickWidth(index, active, hovered)}px` }}
              />
            </button>
          );
        })}
      </div>
      {hasLater && (
        <button
          type="button"
          className="prompt-nav-page prompt-nav-edge"
          aria-label={tr("timeline.showLaterMessages")}
          title={tr("timeline.showLaterMessages")}
          onClick={showLater}
        >↓</button>
      )}
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
            <button
              type="button"
              className="prompt-nav-page"
              aria-label={tr("timeline.showLaterMessages")}
              title={tr("timeline.showLaterMessages")}
              onClick={() => setPanelStart((value) => Math.min(maxPanelStart, value + RAIL_PANEL_ROWS))}
            >↓</button>
          )}
        </div>
      )}
    </nav>
  );
}

/** Live seconds remaining until `target` (ms epoch); ticks once a second and
 *  stops at zero. */
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

/** Provider capacity stop: countdown to the server's auto-resume, with
 *  cancel-wait and continue-on-another-model actions. Replaces the generic
 *  "Last turn failed" line while `turn.limit` is set. */
function RateLimitNotice({ sessionId, limit }: { sessionId: string; limit: TurnLimitState }) {
  const models = useStore((s) => s.models);
  const remaining = useRemainingSeconds(limit.resumeAt);
  const [busy, setBusy] = useState<null | "resume" | "cancel" | "switch">(null);

  const providerLabel = limit.provider
    ? limit.provider.charAt(0).toUpperCase() + limit.provider.slice(1)
    : undefined;
  const scopeLabel =
    limit.scope === "quota"
      ? tr("timeline.rateLimit.scopeQuota")
      : limit.scope === "overloaded"
        ? tr("timeline.rateLimit.scopeOverloaded")
        : tr("timeline.rateLimit.scopeRate");
  const heading = providerLabel
    ? tr("timeline.rateLimit.headingProvider", { provider: providerLabel, scope: scopeLabel })
    : tr("timeline.rateLimit.heading", { scope: scopeLabel });

  const modelItems = useMemo<PickerItem[]>(
    () =>
      models.map((m) => ({
        id: `${m.providerID}/${m.modelID}`,
        label: m.name,
        group: m.providerName ?? m.providerID,
      })),
    [models],
  );

  const run = (kind: "resume" | "cancel", op: Promise<unknown>) => {
    setBusy(kind);
    void op.finally(() => setBusy(null));
  };
  const pickModel = (id: string) => {
    // Item id is `${providerID}/${modelID}`; providerID never contains a slash,
    // but some model ids do — split on the first separator only.
    const slash = id.indexOf("/");
    if (slash < 1) return;
    setBusy("switch");
    void resumeNow(sessionId, { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) })
      .finally(() => setBusy(null));
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
          <Button
            size="sm"
            busy={busy === "resume"}
            disabled={busy !== null}
            onClick={() => run("resume", resumeNow(sessionId))}
          >{tr("timeline.rateLimit.resumeNow")}</Button>
          <Picker
            label={tr("timeline.rateLimit.switchModel")}
            items={modelItems}
            onPick={pickModel}
            disabled={busy !== null || modelItems.length === 0}
          />
          <Button
            size="sm"
            variant="ghost"
            busy={busy === "cancel"}
            disabled={busy !== null}
            onClick={() => run("cancel", cancelResume(sessionId))}
          >{tr("timeline.rateLimit.cancelWait")}</Button>
        </>
      }
    >
      {remaining > 0
        ? tr("timeline.rateLimit.resumesIn", { time: formatWait(remaining) })
        : tr("timeline.rateLimit.resuming")}
      {limit.attempt > 1 ? ` · ${tr("timeline.rateLimit.attempt", { n: String(limit.attempt) })}` : ""}
    </Notice>
  );
}

// Footer under the last message once the turn ended: exactly one terminal
// turn's own start/stop and usage (UX-MSG-ACTIONS) — see turnFooterLine().

/** A finalized assistant row with only whitespace (no text, no reasoning) is
 *  an invisible no-op — the model emitted blank lines between blocks. It stays
 *  in the log but is dropped from the timeline so it can't open a second gap
 *  between real rows (the 1px ghost bubble sandwiching two timeline gaps). */
function blankAssistant(m: RenderMessage): boolean {
  return m.kind === "assistant" && m.finalized && m.text.trim() === "" && m.reasoning.trim() === "";
}

export default function Timeline({
  model,
  latestRevealTarget,
}: {
  model: RenderModel;
  /** An optional dock anchor places the latest-reveal control above the composer. */
  latestRevealTarget?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prefs = useUiSettings();
  const sessionId = useStore((s) => s.activeSessionId);
  // L13 windowing: only the last `limit` rows render (see timelineWindow.ts).
  const initialLimit = initialTimelineWindow(
    typeof document !== "undefined" && document.body.dataset.desktopLowResource === "true",
  );
  const [limit, setLimit] = useState(initialLimit);
  useEffect(() => {
    // Desktop settings arrive over IPC and can race the first React render.
    // Re-read the DOM marker after subscribing so low-resource startup always
    // releases the extra Markdown/tool subtrees even when IPC resolves late.
    const applyResourceMode = () => {
      if (document.body.dataset.desktopLowResource === "true") {
        setLimit((current) => Math.min(current, LOW_RESOURCE_TIMELINE_WINDOW));
      }
    };
    window.addEventListener("polyth:desktop-performance-changed", applyResourceMode);
    applyResourceMode();
    return () => window.removeEventListener("polyth:desktop-performance-changed", applyResourceMode);
  }, []);
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const pendingJump = useRef<string | null>(null);
  const pendingJumpFocus = useRef(false);
  // Smooth tail-follow state (refs, not state: rAF bookkeeping must never
  // re-render). instantFollow marks the first follow after open/switch so it
  // lands in one step instead of gliding through the restored history.
  const chaseRaf = useRef(0);
  const chasing = useRef(false);
  const touchY = useRef<number | null>(null);
  const expectedScrollTop = useRef<number | null>(null);
  const instantFollow = useRef(true);
  // Latest-reveal state (§2.4): true while the reader holds a position away
  // from the tail, mounting the reserved Jump to latest region.
  const [showJump, setShowJump] = useState(false);
  // UX-PANE-MODEL stable anchor: session switches adjust during render so the
  // outgoing anchor is captured from the STILL-CURRENT DOM (before commit) and
  // the incoming one is ready before the first paint of the new session.
  // Pane dock/expand/full-screen transitions never remount this tree, so the
  // live scroll position carries itself; this record covers reload + switch.
  const restoreRef = useRef<TimelineAnchor | null>(null);
  const [anchorSession, setAnchorSession] = useState<string | null | undefined>(undefined);
  if (anchorSession !== sessionId) {
    const el = ref.current;
    if (anchorSession !== undefined && anchorSession !== null && el !== null) {
      saveTimelineAnchor(anchorSession, captureTimelineAnchor(el, atBottom.current));
    }
    setAnchorSession(sessionId);
    setLimit(initialLimit);
    instantFollow.current = true; // next tail follow lands instantly, no glide
    const stored = sessionId !== null ? loadTimelineAnchor(sessionId) : null;
    restoreRef.current = stored !== null && !stored.atBottom ? stored : null;
    atBottom.current = stored?.atBottom ?? true;
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
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => markSessionPerformance("first_message_painted", sessionId));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [sessionId, hasMessages]);

  // Tail follow (§2.4): at/near the tail the timeline follows growth; a reader
  // who scrolled up keeps the chosen position and sees the reveal control.
  // The follow EASES instead of teleporting (exponential rAF chase, re-targeted
  // per commit), so appended rows visibly push older messages up. Any reader
  // scroll hands control back immediately.
  const chaseTail = useCallback(() => {
    cancelAnimationFrame(chaseRaf.current);
    chasing.current = true;
    const step = () => {
      const el = ref.current;
      if (!el || !atBottom.current) { chasing.current = false; return; }
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (Math.abs(gap) < 1) {
        expectedScrollTop.current = el.scrollHeight - el.clientHeight;
        el.scrollTop = expectedScrollTop.current;
        chasing.current = false;
        return;
      }
      expectedScrollTop.current = el.scrollTop + gap * 0.3;
      el.scrollTop = expectedScrollTop.current;
      chaseRaf.current = requestAnimationFrame(step);
    };
    chaseRaf.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(chaseRaf.current), []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = instantFollow.current;
    instantFollow.current = false;
    if (atBottom.current) {
      setShowJump(false);
      if (first) {
        // Session open/switch: land at the tail in one step, never glide.
        cancelAnimationFrame(chaseRaf.current);
        chasing.current = false;
        expectedScrollTop.current = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = expectedScrollTop.current;
      } else {
        chaseTail();
      }
    } else {
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
    }
  }, [model.version, chaseTail]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    if (expectedScrollTop.current !== null && Math.abs(el.scrollTop - expectedScrollTop.current) < 1) {
      expectedScrollTop.current = null;
    } else {
      expectedScrollTop.current = null;
      chasing.current = false;
      cancelAnimationFrame(chaseRaf.current);
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      atBottom.current = near;
      setShowJump(!near);
    }
    // Scroll-up lazy loading: nearing the top with every cached row already
    // rendered pulls the next page of older history from the server.
    if (el.scrollTop < 160 && canLoadOlder && start === 0 && !olderBusy) void loadOlder();
    if (sessionId === null) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const now = ref.current;
      if (now) saveTimelineAnchor(sessionId, captureTimelineAnchor(now, atBottom.current));
    }, 200);
  };

  const stopFollowing = () => {
    chasing.current = false;
    cancelAnimationFrame(chaseRaf.current);
    expectedScrollTop.current = null;
    atBottom.current = false;
    setShowJump(true);
  };

  // Debounce safety: reload and unmount flush the stable anchor immediately.
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

  // One timeline live region: copy results and mutation outcomes are announced
  // as text (visual checkmarks only supplement). Identical repeats get an
  // invisible nudge so assistive tech re-announces them.
  const [liveText, setLiveText] = useState("");
  const liveRef = useRef("");
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((text: string) => {
    liveRef.current = text === liveRef.current ? `${text}\u00a0` : text;
    setLiveText(liveRef.current);
    clearTimeout(liveTimer.current);
    // The visible chip fades after the announcement has been delivered; the
    // region itself stays mounted so the next announcement still fires.
    liveTimer.current = setTimeout(() => setLiveText(""), 4000);
  }, []);
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  // Truthful eligibility (UX-MSG-ACTIONS): guards derive from the live render
  // model plus the authoritative queue; the server re-validates inside the
  // per-session lock, so a raced action returns a typed conflict, not a lie.
  const archived = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status === "archived");
  // The assistant identity panel is a completed-turn artifact: while the
  // runtime is actively generating (or paused mid-turn on a request) no
  // answer shows any metadata row, and the panel appears once the turn
  // completes. A turn stranded by an unclear session state (unknown /
  // reconciling / idle without a stop) still counts as completed and shows
  // the panel.
  const sessionStatus = useStore((s) =>
    s.activeSessionId === null ? undefined : s.sessions.find((x) => x.id === s.activeSessionId)?.status);
  const sessionActive = sessionStatus === "working" || sessionStatus === "waiting";
  // Paginated hydration caches only the newest window; true while the server
  // still holds events OLDER than the cached window (primitive selector, so
  // streamed appends don't re-render the shell through this subscription).
  const canLoadOlder = useStore((s) => {
    if (s.activeSessionId === null) return false;
    const list = s.events[s.activeSessionId];
    return list !== undefined && list.length > 0 && list[0]!.seq > 1;
  });
  const pendingQuestion = model.questions.some((question) => question.status === "pending");
  const pendingPermission = model.permissions.some((permission) => permission.status === "pending");
  const pendingSecret = model.secrets.some((secret) => secret.status === "pending");
  const emptyCopy = archived
    ? tr("timeline.archivedSessionNoMessages")
    : pendingQuestion
      ? tr("timeline.answerPendingQuestion")
      : tr("timeline.noMessagesYet");
  const [queuedCount, setQueuedCount] = useState(0);
  // model.queueVersion bumps only on queue-affecting events, so this REST
  // read runs per session switch / queue change — not per streamed chunk.
  useEffect(() => {
    if (!sessionId) { setQueuedCount(0); return; }
    let cancelled = false;
    void api.queueList(sessionId).then((items) => { if (!cancelled) setQueuedCount(items.length); });
    return () => { cancelled = true; };
  }, [sessionId, model.queueVersion]);
  const guards: MutationGuards = guardsFromModel(model, { queuedCount, archived });
  const revertOk = revertAvailability(guards);
  const forkOk = forkAvailability(guards);

  const visibleMessages = useMemo(() => model.messages.filter((message) => !message.undone && !blankAssistant(message)), [model]);
  const undoneMessages = useMemo(() => model.messages.filter((message) => message.undone && !blankAssistant(message)), [model]);
  const rows = useMemo(() => groupActivity(mergeThinking(visibleMessages)), [visibleMessages]);
  const undoneRows = useMemo(() => groupActivity(mergeThinking(undoneMessages)), [undoneMessages]);
  // One identity panel per completed turn, on the turn's terminal answer only.
  // The terminal answer is the last assistant message before the next prompt
  // (or the log tail); the map also records the opening prompt time so the
  // panel's duration stays truthful when the turn state is no longer in the
  // store. While the session is actively working no answer shows any metadata
  // row; panels appear once the turn completes.
  const terminalAnswers = useMemo(() => {
    const terminal = new Map<number, number>();
    let openAt = 0;
    let lastAssistant: AssistantMsg | null = null;
    for (const message of visibleMessages) {
      if (message.kind === "user" || message.kind === "github-conflict") {
        if (lastAssistant !== null) terminal.set(lastAssistant.eventSeq, openAt);
        lastAssistant = null;
        openAt = message.time;
      } else if (message.kind === "assistant") {
        lastAssistant = message;
      }
    }
    if (lastAssistant !== null) terminal.set(lastAssistant.eventSeq, openAt);
    return terminal;
  }, [visibleMessages]);
  const prompts = useMemo(() => promptIndex(visibleMessages), [visibleMessages]);
  // An unloaded older tail is enough reason to mount the navigator: the rail's
  // load arrow is the only discoverable way to reach prompts outside the
  // initial event page when fewer than three prompts are cached.
  const showNav = prefs.promptNavigator === "on"
    || (prefs.promptNavigator === "auto" && (prompts.length >= 3 || canLoadOlder));
  // Regenerate resends the user prompt that produced each answer. One forward
  // pass — never a reverse scan per assistant row per streaming render.
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
  const turn = model.turn;
  const turnWorking = turn?.status === "working";
  const turnBroken = turn && (turn.status === "failed" || turn.status === "aborted");
  const lastPromptBoundary = [...model.messages].reverse()
    .find((message) => message.kind === "user" || message.kind === "github-conflict");
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

  // L13 windowing: rows render as a suffix; revealing earlier rows keeps the
  // viewport anchored (scrollTop compensates for the height that appeared
  // above), and a jump to a hidden prompt grows the window first.
  const start = windowStart(rows.length, limit);
  const shownRows = start > 0 ? rows.slice(start) : rows;
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
  // A reveal activated from the keyboard can unmount its own control (the
  // final Show earlier chunk, or Show all): focus must then hand off to the
  // named timeline region — never fall to BODY (a11y criteria 6–7).
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
      // The bar survives a partial reveal and keeps focus itself; only its
      // unmount hands focus to the region (preserving the anchored position).
      if (el && el.querySelector(".timeline-earlier") === null) {
        el.focus({ preventScroll: true });
      }
    }
  }, [limit]);

  // Scroll-up lazy loading: once every cached row is rendered (start === 0)
  // but older history remains on the server, fetch the next page backward.
  // The prepended events first land WITHOUT changing the visible suffix
  // (windowStart absorbs them); the effect below then grows the window over
  // the new rows via reveal(), whose anchor keeps the viewport pinned to the
  // previously-visible content.
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

  // Reapply the stored stable anchor once its row exists: grow the window to
  // include it if needed, then align the row to the remembered usable-edge
  // offset (timelineAnchor.ts owns the inset invariant). Runs every commit
  // but is a no-op unless a restore is pending.
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
          return; // retry after the window grows
        }
      }
      if (rows.length > 0) restoreRef.current = null; // anchor row is gone
      return;
    }
    restoreRef.current = null;
    el.scrollTop += restoreScrollDelta(el, node, a);
  });
  const jump = (id: string, opts?: { focus?: boolean }) => {
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
  // Jump to latest (§2.4): scroll to the true final surface (error/retry and
  // turn footer included — they precede the tail clearance), mark follow mode
  // active, and hand focus to the latest message container since this control
  // unmounts. Appends no event.
  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
    const msgs = el.querySelectorAll<HTMLElement>(":scope > .msg");
    const target = msgs[msgs.length - 1] ?? el;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  };
  const latestReveal = showJump && !pendingQuestion && !pendingPermission && !pendingSecret ? (
    <div className="timeline-reveal">
      <button className={`jump-latest${model.turn?.status === "working" ? " agent-working" : ""}`} aria-label={JUMP_TO_LATEST_NAME} title={JUMP_TO_LATEST_NAME} onClick={jumpToLatest}>
        ↓
      </button>
    </div>
  ) : null;
  // Revert and edit: append the marker, then seed the composer with the exact
  // raw prompt + attachments (marker-owned; replay derives the same draft).
  // Stable identity (useCallback) so memoized rows don't re-render per commit.
  const revert = useCallback((message: UserMsg) => {
    if (!sessionId) return;
    void api.rewind(sessionId, message.eventSeq).then((marker) => {
      applyEvent(marker); // WS re-delivery dedupes by seq
      const draft = {
        text: message.raw ?? message.text,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      };
      applyComposerSeed(sessionId, rewindSeedKey(marker.seq), draft);
      requestComposerReplace(draft.text);
    }).catch((err) => {
      const text = mutationErrorMessage("revert", err);
      announce(text);
      setUiError(text);
    });
  }, [sessionId, announce]);
  // Fork and edit: navigation happens only after the child is published; a
  // failure keeps the source selected with a bounded explanation (spec).
  const fork = useCallback((message: UserMsg) => {
    if (!sessionId) return;
    void forkSession(sessionId, message.eventSeq).catch((err) => {
      const text = mutationErrorMessage("fork", err);
      announce(text);
      setUiError(text);
    });
  }, [sessionId, announce]);
  // Restore original timeline. An untouched seed is cleared silently; an
  // edited draft asks first (both outcomes named in the dock confirmation).
  // Focus lands on the invoking control when it survives, otherwise on the
  // restored target's Revert action — never on BODY.
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
        const target = el?.querySelector<HTMLElement>(`[data-revert-seq="${atSeq}"]`)
          ?? el?.querySelector<HTMLElement>(`[data-actions-seq="${atSeq}"]`);
        if (target) { target.focus(); return; }
        if (el) { el.focus(); }
      });
    }).catch((err) => {
      const text = mutationErrorMessage("restore", err);
      announce(text);
      setUiError(text);
    });
  };

  // Bounded, already-reduced summary for the timeline before/after hosts —
  // contributions never receive live events or a mutable model reference.
  const slotSummary = {
    sessionId,
    messageCount: model.messages.length,
    promptCount: prompts.length,
    turnStatus: turn?.status ?? null,
  };

  // One timeline, one scroll root (§2.1): the shell stacks the reserved
  // utility region, the single `.timeline` scrollport, and the reserved
  // latest-reveal region as normal-flow siblings. The only exception is the
  // prompt rail: `.timeline-viewport` is a non-scrolling positioning context
  // wrapping the scrollport, and the rail is an absolute SIBLING of the
  // scroller pinned to the right gutter (never over the reading column).
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
          if (event.deltaY < 0) stopFollowing();
        }}
        onTouchStartCapture={(event) => { touchY.current = event.touches[0]?.clientY ?? null; }}
        onTouchMoveCapture={(event) => {
          const y = event.touches[0]?.clientY;
          if (touchY.current !== null && y !== undefined && y > touchY.current) stopFollowing();
          touchY.current = y ?? null;
        }}
        onTouchEndCapture={() => { touchY.current = null; }}
      >
        <SlotHost slot="session.timeline.before" context={slotSummary} customizable />
        {model.messages.length === 0 && !model.workflowRun && (
          <div className="empty">
            <div>{emptyCopy}</div>
          </div>
        )}
        {start > 0 && (
          <div className="timeline-earlier">
            <Button size="sm" onClick={() => reveal(grownLimit(rows.length, limit))}>
              {tr("timeline.show")}{" "}{Math.min(TIMELINE_CHUNK, start)} {tr("timeline.earlier")}</Button>
            <Button size="sm" onClick={() => reveal(rows.length)}>
              {tr("timeline.showAll2")}{start} {tr("timeline.hidden")}</Button>
          </div>
        )}
        {start === 0 && canLoadOlder && (
          <div className="timeline-earlier">
            <Button size="sm" busy={olderBusy} onClick={() => void loadOlder()}>
              {olderBusy ? tr("timeline.loadingEarlierHistory") : tr("timeline.loadEarlierHistory")}</Button>
          </div>
        )}
        {shownRows.map((r) => (
          r.kind === "activity"
            ? <ActivityRow
                key={r.id}
                rev={activityRev(r)}
                g={r}
                subagents={model.subagents}
                state={r.id === latestActivityId ? currentActivityState : undefined}
                entering={r.id === latestRowId}
              />
            : (
              <MessageRow
                key={r.id}
                rev={r.rev ?? 0}
                m={r}
                plan={r.kind === "assistant" && r.id === latestAssistantId && model.tasks ? model.tasks : undefined}
                regeneratePrompt={r.kind === "assistant" ? regenerateSources.get(r.eventSeq) : undefined}
                turn={r.kind === "assistant" && r.id === latestAssistantId && turn?.status !== "working" ? turn : undefined}
                // The latest assistant row of a working turn owns the live
                // thinking reveal; every other row shows its thought formed.
                live={r.kind === "assistant" && turnWorking && r.id === latestAssistantId}
                entering={r.id === latestRowId}
                terminal={r.kind === "assistant" && !sessionActive && terminalAnswers.has(r.eventSeq)}
                segmentStartedAt={r.kind === "assistant" ? terminalAnswers.get(r.eventSeq) : undefined}
                announce={announce}
                onRevert={revert}
                onFork={fork}
                revert={revertOk}
                fork={forkOk}
              />
            )
        ))}
        {model.workflowRun && <WorkflowTimelineCard run={model.workflowRun} />}
        {/* The dock confirmation sits OUTSIDE the collapsible tail: it must be
            visible even while the reverted items stay folded away. */}
        {confirmRestore && model.rewind && undoneRows.length > 0 && (
          <div className="rewound-confirm" role="group" aria-label={tr("timeline.confirmRestore")}>
            <span>{tr("timeline.youEditedTheDraftRestoringTheOriginal")}</span>
            <Button
              size="sm"
              onClick={(event) => restore({ confirmed: true, invoker: event.currentTarget })}
            >{tr("timeline.restoreAndDiscardTheEditedDraft")}</Button>
            <Button size="sm" onClick={() => setConfirmRestore(false)}>
              {tr("timeline.keepEditingTheDraft")}</Button>
          </div>
        )}
        {/* The collapsed tail exists only while the revert is ACTIVE. After a
            replacement the originals stay on disk (and out of model history)
            but no longer occupy the visible timeline. */}
        {model.rewind && undoneRows.length > 0 && (
          <details className="rewound-tail">
            <summary>
              <span>{undoneMessages.length} {tr("timeline.revertedTimeline")}{" "}{undoneMessages.length === 1 ? tr("timeline.item") : tr("timeline.items")}</span>
              {model.rewind && !confirmRestore && (
                <Button
                  size="sm"
                  onClick={(event) => {
                    event.preventDefault();
                    restore({ invoker: event.currentTarget });
                  }}
                >{tr("timeline.restoreOriginalTimeline")}</Button>
              )}
            </summary>
            <div className="rewound-tail-body">
              {undoneRows.map((row) => (
                row.kind === "activity"
                  ? <ActivityRow key={row.id} rev={activityRev(row)} g={row} subagents={model.subagents} />
                  : <MessageRow key={row.id} rev={row.rev ?? 0} m={row} announce={announce} />
              ))}
            </div>
          </details>
        )}
        {turnBroken && turn.status === "failed" && turn.limit && sessionId && (
          <RateLimitNotice sessionId={sessionId} limit={turn.limit} />
        )}
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
      {showNav && (
        <PromptNavigator
          prompts={prompts}
          onJump={jump}
          containerRef={ref}
          canLoadOlder={canLoadOlder}
          olderBusy={olderBusy}
          onLoadOlder={() => void loadOlder()}
        />
      )}
      {latestReveal && (latestRevealTarget ? createPortal(latestReveal, latestRevealTarget) : latestReveal)}
      </div>
      <SelectionMenu container={ref} />
    </div>
  );
}
