import { Fragment, createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { createTimelineDerivation } from "../timelineDerivation.ts";
import type { HarnessSelection, SessionEvent, SessionPerson } from "@polyth/contracts";
import { renderMarkdown } from "../markdown.tsx";
import { ConversationRepliesContext, createConversationReplies, followingReplies } from "../markdown/conversationReplies.ts";
import { chatDividerParts, emojiOnlyCount, fmtDuration } from "../format.ts";
import { groupActivity, mergeThinking, promptIndex, loadDraft, activityGroup, type ActivityGroup, type ActivityItem } from "../utils.ts";
import { executionPresentation, reasoningContinuation, reasoningPreview } from "../execution.ts";
import { activityTitle } from "../activityTitle.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { cancelResume, continuePausedSession, forkSession, loadOlderEvents, openSession, resumeNow, sendMessage, setResumeCompact } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { resumeOptionsForModel } from "../rateLimitRecovery.ts";
import { useSpaces } from "../spaces.ts";
import { markSessionPerformance } from "../sessionPerformance.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import {
  applyEvent, dismissUiError, focusComposer, getState, oldestSeq, reduceSessionModel, setUiError, usePendingSends, useStore, type PendingSend,
} from "../store.ts";
import { api } from "@polyth/session/web-api";
import {
  JUMP_TO_LATEST_NAME,
  PROMPT_NAV_NAME,
  assistantArticleName,
  assistantTime,
  draftStateOf,
  forkAvailability,
  guardsFromModel,
  mutationErrorMessage,
  promptJumpName,
  reasoningToggleName,
  revertAvailability,
  rewindSeedKey,
  userArticleName,
  userArticleNameFrom,
  type ActionAnnounceAnchor,
  type ActionAvailability,
  type MutationGuards,
} from "../messageActions.ts";
import { applyComposerSeed, discardComposerSeed, loadSeedRecord } from "../drafts.ts";
import { activeBrowserAccountId } from "../accountStorage.ts";
import { mentionTokensOf, personInitials, useSessionPeople } from "../sessionPeople.ts";
import { assignPersonTones, personToneOf } from "../personIdentity.ts";
import { canCollaborateSession } from "../sessionSharing.ts";
import {
  beginConversationSelection, closeConversationStart, conversationSelection, endConversationSelection,
  toggleConversationMessage, useConversationSelection,
} from "../conversationSelection.ts";
import ConversationStartDialog from "./ConversationStartDialog.tsx";
import "./ConversationStart.css";
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
  promptRowTops,
  cursorTickIndex,
  promptRailInset,
  promptRowLabel,
  railWindow,
  tickWidth,
  type PromptRailSide,
} from "../promptRail.ts";
import { captureTimelineAnchor, loadTimelineAnchor, restoreScrollDelta, saveTimelineAnchor, type TimelineAnchor } from "../timelineAnchor.ts";
import { useTimelineCompanion, useTimelineSessionId } from "../timelineSession.ts";
import { publishPromptVisibility } from "../promptVisibility.ts";
import { registerConversationReveal, type ConversationRevealRequest } from "../conversationReveal.ts";
import {
  fillDownScrollTop,
  focusLineScrollTop,
  ratchetTimelineExtent,
  TIMELINE_TAIL_EPSILON,
  timelineTurnReserve,
  timelineFollowState,
} from "../timelineFollow.ts";
import {
  cancelTimelineLift,
  captureTimelineLiftRows,
  playTimelineLift,
  TIMELINE_SETTLE_EASE,
  TIMELINE_LIFT_ROW_SELECTOR,
  timelineLiftDistance,
  timelineLiftMotionDisabled,
  timelineLiftRunning,
  type TimelineLiftRow,
} from "../timelineLift.ts";
import { timelineVisibleArea } from "../timelineVisibleArea.ts";
import { useTimelineStripLane } from "../timelineStripLane.ts";
import { claimTimelineMotion, sendFlightsInAir, TIMELINE_SEND_FLIGHT_ANIMATION_ID } from "../timelineMotionClaims.ts";
import {
  beginRestoreMotion,
  cancelRewindMotion,
  pendingRewindMotion,
  settleRewindMotion,
} from "../rewindMotion.ts";
import AttachmentPills from "./AttachmentPills.tsx";
import RewindMarker from "./RewindMarker.tsx";
import IsolationNotice from "./IsolationNotice.tsx";
import SelectionMenu from "./SelectionMenu.tsx";
import SlotHost, { useSlotVersion } from "./slots/SlotHost.ts";
import { listSlots } from "../slots.ts";
import { mergeTimelineEntries, splitRowsAtEvents, type SpanningRow } from "../timelineEvents.ts";
import type {
  AssistantMsg,
  ConversationStartedMsg,
  PersonMessageMsg,
  QuestionMsg,
  RenderMessage,
  RenderModel,
  SubagentState,
  TaskActivityMsg,
  ToolMsg,
  UserMsg,
} from "../reduce.ts";
import { Icon } from "../icons.tsx";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { rememberHarnessModel, useLastHarnessModels, useModelPrefs } from "@polyth/models/web-prefs";
import { hiddenModelMatcher } from "@polyth/models";
import { lastChosenHarnessModel } from "../composer/discovery.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { normalizeQuestions, questionAnswerDraft, type AnswerMap } from "../questionSerializers.ts";
import ExecutionRow, { ComposerShellRow, ExecutionIcon, useCollapsePresence, useExecutionStop, useExecutionSummary, type ExecutionSummary } from "./ExecutionRow.tsx";
import ActivityTicker, { useTickerKey } from "./ActivityTicker.tsx";
import { useSettledFlag } from "../activityTicker.ts";
import { BotIcon, Button, CheckIcon, ChevronRightIcon, Icon as UiIcon, IconButton, Notice, RunSummary, StopIcon, Tooltip, type RunSummaryState } from "./ui/index.ts";
import { PlayIcon } from "./ui/icons.ts";
import PausedMark from "./PausedMark.tsx";
import type { TurnLimitState } from "../reduce.ts";
import { transientTurnNoticeKey } from "../turnNotice.ts";
import { shortMessage } from "../errorPresentation.ts";
import ChatResponseFooter from "./ChatResponseFooter.tsx";
import MessageQuickActions from "./MessageQuickActions.tsx";
import QuestionPrompt from "./QuestionCards.tsx";
import QuestionRecord from "./QuestionRecord.tsx";
import PromptBookmark, { type PromptBookmarkTarget } from "./PromptBookmark.tsx";

const EMPTY_SESSION_EVENTS: SessionEvent[] = [];

/** Person-message selection for "Start session". A context keeps the state
 *  out of the memoized row contract: consumers update when selection changes,
 *  while every other transcript row keeps its identity. */
const PersonSelection = createContext<{
  active: boolean;
  selectable: boolean;
  selected: ReadonlySet<number>;
  toggle: (seq: number) => void;
  enter: (seq: number) => void;
}>({ active: false, selectable: false, selected: new Set(), toggle: () => {}, enter: () => {} });
/** Whether person messages name their authors. Only a one-to-one
 *  conversation (one other person can open it and only they have written)
 *  leaves names out: the header already says who it is. */
const PersonNames = createContext(true);
/** Each person's colour in this chat (personIdentity.ts). */
const PersonTones = createContext<ReadonlyMap<string, number> | null>(null);
const TASK_MARK = { done: "✓", active: "●", failed: "×", pending: "○" } as const;

const BOOKMARK_PREVIEW_LIMIT = 120;

function promptBookmarkPreview(text: string): string {
  const normalized = text.trim();
  return normalized.length > BOOKMARK_PREVIEW_LIMIT
    ? `${normalized.slice(0, BOOKMARK_PREVIEW_LIMIT - 1)}…`
    : normalized;
}

function promptRowNode(timeline: HTMLElement | null, id: string): HTMLElement | null {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/(["\\])/g, "\\$1");
  return timeline?.querySelector<HTMLElement>(`[data-msg-id="${escaped}"], [data-pending-send="${escaped}"]`) ?? null;
}

function timelineTailRow(timeline: HTMLElement): HTMLElement | null {
  for (const child of Array.from(timeline.children).reverse()) {
    if (child instanceof HTMLElement && child.matches(TIMELINE_LIFT_ROW_SELECTOR)) return child;
  }
  return null;
}

/** Bottom of the in-flow transcript. The extent-floor spacer is always the
 *  last in-flow child and starts exactly there. */
function timelineContentBottom(timeline: HTMLElement): number {
  const floor = timeline.querySelector<HTMLElement>(":scope > .timeline-extent-floor");
  return floor ? floor.getBoundingClientRect().top : timeline.getBoundingClientRect().bottom;
}

/** The clearance kept below the last row, which the conversation surface
 *  publishes as its bottom scroll padding (the tail runway without reserve). */
function timelineTailClearance(timeline: HTMLElement): number {
  const clearance = Number.parseFloat(getComputedStyle(timeline).scrollPaddingBottom);
  return Number.isFinite(clearance) ? Math.max(0, clearance) : 0;
}

/** Transcript height without the live sheet or extent floor. The floor's
 *  leading edge is in normal flow and is never transformed by row motion. */
function timelineNaturalHeight(timeline: HTMLElement): number {
  return timelineContentBottom(timeline) - timeline.getBoundingClientRect().top
    + timeline.scrollTop + timelineTailClearance(timeline);
}

/** In-flow content below the last transcript row: package cards in
 *  `session.timeline.after` (an approval, a secret request) and notices. Layout
 *  offsets, so a running lift's transform never counts. An empty row (a hidden
 *  one reporting offset 0) never stands for the tail alone. */
function timelineTrailingHeight(timeline: HTMLElement): number {
  const floor = timeline.querySelector<HTMLElement>(":scope > .timeline-extent-floor");
  if (!floor) return 0;
  let tailBottom: number | null = null;
  for (const child of Array.from(timeline.children).reverse()) {
    if (!(child instanceof HTMLElement) || !child.matches(TIMELINE_LIFT_ROW_SELECTOR)) continue;
    tailBottom = Math.max(tailBottom ?? 0, child.offsetTop + child.offsetHeight);
    if (child.offsetHeight > 0) break;
  }
  return tailBottom === null ? 0 : Math.max(0, floor.offsetTop - tailBottom);
}

/** The row at the top of the reading area: the first one whose layout box
 *  reaches below the visible top. Rows stack in layout order, so the scan
 *  runs from the tail and stops at the first row wholly above that edge — a
 *  followed tail reads only the rows in view. An empty row (a hidden row
 *  reporting offset 0) never stands for a position. */
function timelineReadingTopRow(timeline: HTMLElement): HTMLElement | null {
  const top = timeline.scrollTop + timelineVisibleArea(timeline).inset;
  let found: HTMLElement | null = null;
  for (let child = timeline.lastElementChild; child; child = child.previousElementSibling) {
    if (!(child instanceof HTMLElement) || !child.matches(TIMELINE_LIFT_ROW_SELECTOR)) continue;
    const height = child.offsetHeight;
    if (height <= 0) continue;
    if (child.offsetTop + height <= top) break;
    found = child;
  }
  return found;
}

/** Where the tail rests: the visible bottom less the tail clearance. */
function timelineRestLine(timeline: HTMLElement): number {
  return timelineVisibleArea(timeline).bottom - timelineTailClearance(timeline);
}

/** The whole transcript is visible down to its rest line. During a live turn
 *  this is the visual bottom, even with blank runway still below it. */
function timelineTailRevealed(timeline: HTMLElement): boolean {
  return timelineContentBottom(timeline) <= timelineRestLine(timeline) + TIMELINE_TAIL_EPSILON;
}

/** One announcement per copy/mutation outcome; text is the accessible record,
 *  while the invoking icon carries the visual confirmation. Screen readers
 *  ignore repeats, so identical text gets an invisible nudge (same trick as
 *  a11y/live.tsx). The single hidden timeline region owns every announcement. */
type Announce = (text: string, anchor?: ActionAnnounceAnchor) => void;

// A thought is a quiet separator, not an activity item. Folded, it shows two
// clamped lines; opened, the whole thought takes the preview's place from its
// first word, so the clamp seems to lift and the text simply continues —
// nothing the clamp hid is skipped and nothing is repeated.
// The disclosure is a native, keyboard-operable control with
// a purpose-and-target name and truthful expanded state; expanding/collapsing
// appends no event.

// Reader-opened thoughts. A thought remounts without the reader closing it —
// its live row folds away, the render window moves, a live tail joins the
// settled prefix — and must come back as it was left. A Thinking mode change
// folds them all.
const openThoughts = new Set<string>();

type TimelineResourceContext = { projectId: string; sessionId: string | null; repositoryId?: string };

function AssistantProse({ m, entering = false, resourceContext }: { m: AssistantMsg; entering?: boolean; resourceContext?: TimelineResourceContext }) {
  return (
    <div className={`msg assistant${entering ? " timeline-row-enter" : ""}`} data-message-seq={m.eventSeq}>
      <div className="bubble" dir="auto">
        {renderMarkdown(m.text, m.id, { conversation: true, ...(resourceContext ? { resourceContext } : {}) })}
        {!m.finalized && <span className="caret" />}
      </div>
    </div>
  );
}

function Thinking({ m, live, entering = false, resourceContext, inActivity = false }: {
  m: AssistantMsg;
  live: boolean;
  entering?: boolean;
  resourceContext?: TimelineResourceContext;
  inActivity?: boolean;
}) {
  const prefs = useUiSettings();
  const displayMode = inActivity && prefs.thinkingDisplayMode === "activity"
    ? "collapsed"
    : prefs.thinkingDisplayMode;
  // Render provider chunks immediately; the stream owns the pacing.
  const reasoning = m.reasoning;
  const active = !m.finalized && live && m.text.trim() === "";
  // The reader owns the disclosure, including while reasoning streams.
  const openKey = `${resourceContext?.sessionId ?? ""}:${m.id}`;
  const [open, setOpenState] = useState(() => openThoughts.has(openKey));
  const setOpen = (next: boolean) => {
    if (next) openThoughts.add(openKey);
    else openThoughts.delete(openKey);
    setOpenState(next);
  };
  // Preferences change the thought's presentation, not the identity of the
  // entire timeline row. Only the disclosures reset when the mode changes.
  const shownMode = useRef(displayMode);
  useEffect(() => {
    if (shownMode.current === displayMode) return;
    shownMode.current = displayMode;
    openThoughts.clear();
    setOpenState(false);
  }, [displayMode]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const reasoningAtBottom = useRef(true);
  const bodyPresent = useCollapsePresence(open);
  // A single long paragraph can be one source line but many visual lines.
  // Keep the static fast path only for genuinely short thoughts.
  // ponytail: 240 chars approximates two compact lines; measure width only if
  // the typography or chat column becomes dynamic enough to justify it.
  const fullPreview = reasoningPreview(reasoning, false, 0);
  const expandable = reasoningContinuation(reasoning) !== "" || fullPreview.length > 240;
  // A live folded row shows its tail. Static short thoughts keep their full
  // text so a two-line thought never gains an ellipsis.
  const preview = reasoningPreview(reasoning, active, expandable ? 180 : 0);
  // Follow incoming chunks only while the reader is at the reasoning tail.
  useEffect(() => {
    if (!open || !active || !reasoningAtBottom.current) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, active, reasoning]);
  if (displayMode === "activity" && !inActivity) return null;
  const mark = (
    <span className={active ? "reasoning-mark running" : "reasoning-mark"} aria-hidden="true" />
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
        {renderMarkdown(reasoning, `${m.id}-reasoning`, {
          ...(active ? { streaming: true } : {}),
          ...(resourceContext ? { resourceContext } : {}),
        })}
      </div>
    </div>
  );
  if (displayMode === "expanded") {
    return (
      <div className={`reasoning reasoning-flat${entering ? " timeline-row-enter" : ""}`}>
        {mark}
        {body}
      </div>
    );
  }
  if (!expandable) {
    return (
      <div className={`reasoning reasoning-static${entering ? " timeline-row-enter" : ""}`}>
        <div className="reasoning-heading reasoning-static-header">
          {mark}
          <span className="reasoning-main">
            <span className="reasoning-preview">
              {preview || (active ? tr("timeline.workingThroughTheRequest") : tr("timeline.activityDetail"))}
            </span>
          </span>
        </div>
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
          if (!open) reasoningAtBottom.current = true;
          setOpen(!open);
        }}
      >
        {mark}
        {/* Opened, the control keeps only its chevron in the same corner; the
            body below starts where the preview stood. */}
        {!open && (
          <span className="reasoning-main">
            <span className="reasoning-preview">
              {preview || (active ? tr("timeline.workingThroughTheRequest") : tr("timeline.activityDetail"))}
            </span>
          </span>
        )}
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
  settled = false,
  segmentStartedAt,
  live = false,
  entering = false,
  leaving = false,
  dormant = false,
  progress = false,
  resourceContext,
}: {
  m: AssistantMsg;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  regeneratePrompt?: { eventSeq: number; text: string; attachments?: UserMsg["attachments"] };
  turn?: RenderModel["turn"];
  /** Terminal answer of a completed turn: the only row that carries the
   *  identity panel (one per turn, rendered after the turn completes). */
  terminal?: boolean;
  /** The answer's turn is closed or idle: an interim answer may show its
   *  quick actions without moving rows of a live turn. */
  settled?: boolean;
  segmentStartedAt?: number;
  /** True while this row is the latest assistant row of a working turn: its
   *  thinking block reflects incoming reasoning chunks immediately. */
  live?: boolean;
  entering?: boolean;
  leaving?: boolean;
  /** A turn is working: a completed footer keeps its box but shows nothing. */
  dormant?: boolean;
  /** An activity block follows this answer: it is a progress update, read in
   *  a quieter ink (a class, not a sibling :has(), which re-matched on every
   *  row insertion and reflowed stale on older touch WebKit). */
  progress?: boolean;
  resourceContext?: TimelineResourceContext;
}) {
  const reasoningOnly = m.text.trim() === "" && m.reasoning.trim() !== "";
  const hasAnswer = m.text.trim() !== "" || (!m.finalized && !reasoningOnly);
  const answer = m.text;
  const articleProps = hasAnswer
    ? ({ role: "article", "aria-label": assistantArticleName(m.finalized, assistantTime(m)) } as const)
    : undefined;
  return (
    <div className={`msg assistant${reasoningOnly ? " reasoning-row" : ""}${progress && hasAnswer ? " progress-update" : ""}${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`} data-message-seq={m.eventSeq} {...(articleProps ?? {})}>
      {m.reasoning.trim() !== "" && <Thinking m={m} live={live} resourceContext={resourceContext} />}
      {hasAnswer && (
        <div className="bubble" dir="auto">
          {renderMarkdown(answer || "", m.id, {
            conversation: true,
            showGalleryShortcut: Boolean(m.finalized && announce),
            // Only the live row of a working turn: a chunk-only answer of a
            // stopped turn never finalizes and must show its whole text.
            ...(live && !m.finalized ? { streaming: true } : {}),
            ...(resourceContext ? { resourceContext } : {}),
          })}
          {!m.finalized && <span className="caret" />}
        </div>
      )}
      {/* Every finished answer of a settled turn keeps its quick actions, also
          when tools, a question or more text of the same turn follow it; only
          the terminal answer carries the identity panel. */}
      {m.finalized && hasAnswer && (terminal || settled) && (
        <ChatResponseFooter
          m={m}
          announce={announce}
          turn={turn}
          segmentStartedAt={segmentStartedAt}
          regeneratePrompt={regeneratePrompt}
          dormant={dormant}
          identity={terminal}
        />
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

function TaskActivityRow({ activity, entering = false, leaving = false }: { activity: TaskActivityMsg; entering?: boolean; leaving?: boolean }) {
  const label = activity.action === "created"
    ? tr("timeline.taskCreated")
    : activity.action === "started"
      ? tr("timeline.taskStarted")
      : activity.action === "completed"
        ? tr("timeline.taskCompleted")
        : tr("timeline.taskFailed");
  return (
    <div className={`task-activity ${activity.action}${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`} data-task-id={activity.taskId}>
      <span className="task-activity-mark" aria-hidden="true">
        {activity.action === "completed" ? "✓" : activity.action === "failed" ? "✕" : "•"}
      </span>
      {/* Read like a step: what, then a quiet kind. */}
      <span className="task-activity-copy">
        <span className="task-activity-text">{activity.text}</span>
        <span className="task-activity-kind">{label}</span>
      </span>
    </div>
  );
}

// Contiguous technical work is projected into an activity group. Settled runs
// collapse to a summary; the current run shows one live row without promoting
// every tool to a separate card. A turn may contain several such groups when
// the agent resumes work after a visible assistant message.
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

/** Bound the touch send flight plus a geometry-settle buffer. */
const FRESH_TURN_DISTORTION_MS = 480;
/** Confirmed rewind rows remain in flow for one compact exit before removal
 *  (matches `rewind-row-exit` in styles.css). */
const REWIND_EXIT_MS = 220;
/** The survivors' glide to the composer edge once the cut rows are removed. */
const REWIND_GLIDE_MS = 280;
/** Revealed earlier history that lands in view fades in, opacity only. */
const PREPEND_FADE_MS = 180;
/** A finger's scroll has come to rest once no scroll event (momentum
 *  included) arrived for this long after it lifted. */
const TOUCH_SCROLL_REST_MS = 150;
/** Content below the tail shorter than this is layout rounding, not a card. */
const TRAILING_CARD_MIN_PX = 2;
/** A short beat after a turn ends before its reserve is handed over. */
const TURN_END_SETTLE_WAIT_MS = 150;

/** The composer draft a confirmed revert restores, bound to its session. */
type RewindDraft = {
  sessionId: string;
  markerSeq: number;
  atSeq: number;
  text: string;
  attachments?: UserMsg["attachments"];
};
/** A local Revert & edit: `confirming` until the marker for `atSeq` is in the
 *  model, then the in-place exit of the cut rows, then the survivors' glide. */
type RevertExit = {
  sessionId: string;
  atSeq: number;
  markerSeq: number | null;
  phase: "confirming" | "leaving" | "gliding";
};

function activityItemNode(
  item: ActivityItem,
  subagents: SubagentState | null,
  live: boolean,
  entering: boolean,
  sessionId: string | null,
  resourceContext?: TimelineResourceContext,
): ReactNode {
  // A step shows what it is, not its whole output. Assistant text is the same
  // reading surface as the timeline answer — never secondary thinking type.
  if (item.kind === "tool") {
    return <ExecutionRow key={item.id} message={item} subagent={childForTool(item, subagents)} entering={entering} sessionId={sessionId} />;
  }
  if (item.kind === "assistant") {
    const thought = item.reasoning.trim() !== ""
      ? <Thinking key={`${item.id}-reasoning`} m={{ ...item, text: "" }} live={live} entering={entering} resourceContext={resourceContext} inActivity />
      : null;
    const prose = item.text.trim() !== ""
      ? <AssistantProse key={`${item.id}-text`} m={item} entering={entering} resourceContext={resourceContext} />
      : null;
    return thought && prose ? <Fragment key={item.id}>{thought}{prose}</Fragment> : thought ?? prose;
  }
  return <TaskActivityRow key={item.id} activity={item} entering={entering} />;
}

function derivedActivityState(g: ActivityGroup, live: boolean): RunSummaryState {
  const latestTasks = new Map(g.tasks.map((task) => [task.taskId, task]));
  if (g.tools.some((tool) => tool.status === "error" && /cancel(?:led|ed)|aborted|stopped|interrupted/i.test(tool.error ?? ""))) return "cancelled";
  if (g.tools.some((tool) => tool.status === "error") || [...latestTasks.values()].some((task) => task.action === "failed")) return "failed";
  // Task starts and completions can live in separate blocks. Historical
  // headers must not animate from an unmatched start, but retain failures.
  if (!live) return "completed";
  if (g.tools.some((tool) => tool.status === "pending" || tool.status === "running") || [...latestTasks.values()].some((task) => task.action === "started")) return "active";
  return g.settled ? "completed" : "waiting";
}

/** The step a live block's line names: its newest action or thought. Task
 *  lifecycle rows never take the line — the session title and overview own
 *  their live presentation. */
function tickerStep(items: readonly ActivityItem[], thinkingInActivity: boolean): ActivityItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "tool") return item;
    if (item.kind === "assistant" && (item.text.trim() !== "" || (thinkingInActivity && item.reasoning.trim() !== ""))) return item;
  }
  return undefined;
}

/** The words of a step's live line, exactly as the folded step reads them,
 *  and the same words as plain text for the block's accessible name (the
 *  visible line is always part of the name). */
function stepLine(item: ActivityItem, summary: ExecutionSummary | null): { glyph?: ExecutionSummary; label?: string; preview: string; command: boolean } {
  if (item.kind === "tool" && summary) {
    return { glyph: summary, label: summary.title, preview: summary.preview, command: summary.kind === "shell" || summary.kind === "test" };
  }
  if (item.kind === "assistant") {
    return item.text.trim() !== ""
      ? { preview: reasoningPreview(item.text, true, 160), command: false }
      : { label: tr("timeline.thinking"), preview: reasoningPreview(item.reasoning, true, 160), command: false };
  }
  return { preview: item.kind === "task" ? item.text : "", command: false };
}

function StepLineView({ line }: { line: ReturnType<typeof stepLine> }) {
  return <span className="activity-ticker-step live">
    {line.glyph && <span className="activity-ticker-glyph" aria-hidden="true"><ExecutionIcon kind={line.glyph.kind} image={line.glyph.image} mcp={line.glyph.mcp} /></span>}
    {line.label && <strong>{line.label}</strong>}
    {line.preview && <span className={`activity-ticker-preview${line.command ? " command" : ""}`}>{line.preview}</span>}
  </span>;
}

/** The leaving line keeps its own words while it fades. */
function ToolStepLine({ tool, sessionId }: { tool: ToolMsg; sessionId: string | null }) {
  const summary = useExecutionSummary(tool, sessionId);
  return <StepLineView line={stepLine(tool, summary)} />;
}

/** A running command's Stop shows only once it has run this long: steps that
 *  finish within a beat never flash a control in and out beside the line. */
const LIVE_STOP_DELAY_MS = 700;

export function ActivityGroupView({
  g,
  subagents,
  state: stateOverride,
  entering = false,
  leaving = false,
  livePresentation = true,
  ticking = false,
  sessionId = null,
  resourceContext,
}: {
  g: ActivityGroup;
  subagents: SubagentState | null;
  state?: RunSummaryState;
  entering?: boolean;
  leaving?: boolean;
  /** False for idle/historical groups: their header never animates. */
  livePresentation?: boolean;
  /** The block is the live tail of a working turn: its line names the step
   *  in progress. Once anything follows it, the line settles on the summary. */
  ticking?: boolean;
  sessionId?: string | null;
  resourceContext?: TimelineResourceContext;
}) {
  const state = stateOverride ?? derivedActivityState(g, livePresentation);
  const active = state === "active" || state === "waiting";
  const prefs = useUiSettings();
  const thinkingInActivity = prefs.thinkingDisplayMode === "activity";
  // The block never opens itself. Running work is named by its own line;
  // opening the block is a reader decision only.
  const [open, setOpen] = useState(false);
  const itemsPresent = useCollapsePresence(open);
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
  const stepCount = g.items.filter((item) => !thinkingInActivity || item.kind !== "assistant" || item.text.trim() !== "").length;
  const counts = [
    stepCount === 1 ? tr("timeline.valueStepCount", { count: stepCount }) : tr("timeline.valueStepsCount", { count: stepCount }),
    ...(files > 0 ? [files === 1 ? tr("timeline.valueFileCount", { count: files }) : tr("timeline.valueFilesCount", { count: files })] : []),
  ].join(" · ");
  const duration = fmtDuration(g.ms);
  const meta = `${counts} · ${duration}`;
  // The header names what happened inside instead of a generic "Activity".
  // The title already carries the counts, so narrow screens drop them from
  // the meta and keep the room for the title.
  const title = activityTitle(g);
  const metaNode = <><span className="activity-summary-counts">{counts} · </span>{duration}</>;
  // The live line: the newest step while the block is the working tail, the
  // summary otherwise. It swaps in place, so the block stays one row; what
  // describes the line (its name, the Stop) follows the words on screen.
  const target = ticking ? tickerStep(g.items, thinkingInActivity) : undefined;
  const ticker = useTickerKey(target?.id ?? "summary");
  const shownStep = ticker.shown === "summary" ? undefined : g.items.find((item) => item.id === ticker.shown);
  const shownTool = shownStep?.kind === "tool" ? shownStep : undefined;
  const shownSummary = useExecutionSummary(shownTool, sessionId);
  const shownLine = shownStep ? stepLine(shownStep, shownSummary) : null;
  const renderLine = (key: string): ReactNode => {
    if (key === ticker.shown && shownLine) return <StepLineView line={shownLine} />;
    const item = key === "summary" ? undefined : g.items.find((candidate) => candidate.id === key);
    if (!item) return <><strong>{title}</strong><small>{metaNode}</small></>;
    if (item.kind === "tool") return <ToolStepLine tool={item} sessionId={sessionId} />;
    return <StepLineView line={stepLine(item, null)} />;
  };
  // A command the line names while it runs gets a Stop beside the line, once
  // it has run for a beat. An open block shows the step's own Stop instead,
  // and a delegated agent is stopped from its own session.
  const stopCandidate = shownTool && shownTool.status === "running" && !open
    && shownSummary !== null && shownSummary.kind !== "subagent" ? shownTool : undefined;
  const stopper = useExecutionStop(stopCandidate, sessionId, stopCandidate !== undefined);
  const showStop = useSettledFlag(stopper.canStop, LIVE_STOP_DELAY_MS);
  const sectionRef = useRef<HTMLElement>(null);
  const stopFocused = useRef(false);
  // A Stop that leaves while it holds focus hands it to the block's line,
  // never to the page.
  useLayoutEffect(() => {
    if (showStop || !stopFocused.current) return;
    stopFocused.current = false;
    sectionRef.current?.querySelector<HTMLElement>(":scope > .ui-run-summary")?.focus();
  }, [showStop]);
  const lineText = shownLine ? [shownLine.label, shownLine.preview].filter(Boolean).join(" ") : "";
  const labelValue = lineText ? `${lineText} · ${title} · ${meta}` : `${title} · ${meta}`;
  return (
    <section ref={sectionRef} className={`msg assistant activity-group${entering ? " timeline-row-enter" : ""}${open ? " open" : ""}${active ? " current" : ""}${leaving ? " rewind-leaving" : ""}${showStop ? " has-live-stop" : ""}`} aria-label={tr("timeline.agentActivity")}>
      <RunSummary
        title={title}
        meta={metaNode}
        copy={<ActivityTicker ticker={ticker} render={renderLine} />}
        state={state}
        expanded={open}
        additions={lineStats.add}
        deletions={lineStats.del}
        label={open
          ? tr("timeline.collapseActivityValue", { value: labelValue })
          : tr("timeline.expandActivityValue", { value: labelValue })}
        diffLabel={tr("timeline.valueAdditionsValueDeletions", { additions: lineStats.add, deletions: lineStats.del })}
        onToggle={() => setOpen((value) => !value)}
      />
      {showStop && (
        <span
          className="activity-live-stop"
          onFocus={() => { stopFocused.current = true; }}
          onBlur={() => { stopFocused.current = false; }}
        >
          <Button
            className="execution-stop"
            variant="danger"
            size="sm"
            iconStart={StopIcon}
            busy={stopper.stopping}
            onPointerDown={stopper.armPointer}
            onClick={(event) => stopper.stop(event)}
          >
            {tr("common.stop")}
          </Button>
        </span>
      )}
      <div className="activity-group-expand-shell" aria-hidden={!open}>
        <div className="activity-group-collapse-content">
          {itemsPresent && (
            <div className="activity-group-items">
              {g.items.map((item, index) =>
                activityItemNode(item, subagents, ticking && index === g.items.length - 1, entering && active && index === g.items.length - 1, sessionId, resourceContext))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** True while the element is taller than its clamp. Measured only while the
 *  clamp is on, so expanding never erases the control that collapses it. */
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

/** A sent prompt is a record, not a wall of text: the log keeps four lines and
 *  the rest stays one tap away. */
export function UserPrompt({ text, id, resourceContext }: { text: string; id: string; resourceContext?: TimelineResourceContext }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const clipped = useClipped(bodyRef, !open);
  return (
    <>
      <div className={`user-prompt${open ? " open" : clipped ? " clipped" : ""}`} ref={bodyRef}>
        {renderMarkdown(text, id, resourceContext ? { resourceContext } : {})}
      </div>
      {clipped && (
        <button
          type="button"
          className="user-prompt-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? tr("timeline.collapse") : tr("timeline.expand")}
          <span aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronDown />}</span>
        </button>
      )}
    </>
  );
}

/** The prompt the reader just submitted, shown at the tail while admission is
 *  still in flight. Deliberately the same row shape as a canonical user turn —
 *  the canonical event replaces it in one commit with no reflow — but it owns
 *  no message actions, because there is no canonical message to act on yet,
 *  and no `article` role, because it would have to claim a send time nothing
 *  has confirmed. The composer's activity dock carries the live status; the
 *  canonical row arrives seconds later with its real timestamped label. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One person message as a chat bubble: the reader's own at the inline end on
 *  the accent, everyone else's at the start. A run from one author shares one
 *  name (opening its first bubble) and one mark and tail (beside its last),
 *  both in that person's colour; a
 *  centered time divider opens each new stretch of time; the exact time shows
 *  on hover. A quiet note says when the agent gets it too. Never a prompt. */
function PersonMessageView({ m, entering = false }: { m: PersonMessageMsg; entering?: boolean }) {
  const selection = useContext(PersonSelection);
  const named = useContext(PersonNames);
  const tones = useContext(PersonTones);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  useEffect(() => clearLongPress, []);
  const selectable = selection.selectable;
  const selected = selection.active && selection.selected.has(m.eventSeq);
  const self = activeBrowserAccountId();
  const authorName = m.author?.name?.trim() || tr("timeline.anotherPerson");
  const own = m.author?.userId === self;
  const time = new Date(m.time);
  const locale = getLocale();
  const timeLabel = time.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const divider = m.timeBreak ? chatDividerParts(m.time, Date.now(), locale) : null;
  const emoji = useMemo(() => emojiOnlyCount(m.text), [m.text]);
  const identity = named && !own;
  const tone = identity ? personToneOf(tones, m.author?.userId) : null;
  const parts = useMemo(() => {
    type Part = { text: string; mention?: SessionPerson; own?: boolean };
    const byToken = new Map<string, SessionPerson>();
    for (const mention of m.mentions) {
      for (const token of mentionTokensOf(mention.name ?? mention.userId)) {
        if (token.length > 1 && !byToken.has(token)) byToken.set(token, mention);
      }
    }
    if (byToken.size === 0) return [{ text: m.text }] as Part[];
    const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
    // A token ends at a word boundary, so "@Ann" never claims "@Anna".
    const pattern = new RegExp(`(${tokens.map((token) => escapeRegExp(token)).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
    return m.text.split(pattern).map((part): Part => {
      const mention = byToken.get(part);
      if (!mention) return { text: part };
      return { text: part.replace(/_/g, " "), mention, own: mention.userId === self };
    });
  }, [m.text, m.mentions, self]);
  return (
    <>
    {divider && (
      <div className="person-message-divider">
        <time dateTime={time.toISOString()}><b>{divider.day}</b> {divider.time}</time>
      </div>
    )}
    <div
      className={`msg person-message${own ? " is-own" : ""}${m.continuation ? " is-continuation" : ""}${m.continued ? " is-continued" : ""}${identity ? " is-named" : ""}${entering ? " is-entering" : ""}${selectable ? " is-selectable" : ""}${selection.active ? " is-selecting" : ""}${selected ? " is-selected" : ""}`}
      data-msg-id={m.id}
      data-message-seq={m.eventSeq}
      role={selection.active ? "checkbox" : "article"}
      {...(selection.active ? { "aria-checked": selected, tabIndex: 0 } : {})}
      aria-label={selection.active
        ? tr("conversation.selectMessage", { name: authorName })
        : tr("timeline.personMessageFrom", { name: authorName })}
      onClick={selection.active ? () => {
        if (longPressed.current) { longPressed.current = false; return; }
        selection.toggle(m.eventSeq);
      } : undefined}
      onKeyDown={selection.active ? (event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        selection.toggle(m.eventSeq);
      } : undefined}
      onPointerDown={selectable && !selection.active ? (event) => {
        if (event.pointerType !== "touch") return;
        longPressed.current = false;
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          longPressTimer.current = null;
          longPressed.current = true;
          selection.enter(m.eventSeq);
        }, 500);
      } : undefined}
      onPointerUp={clearLongPress}
      onPointerLeave={clearLongPress}
      onPointerCancel={clearLongPress}
    >
      {selection.active && (
        <span className="ui-checkbox-box person-message-check" aria-hidden="true">
          {selected && <UiIcon icon={CheckIcon} size="sm" />}
        </span>
      )}
      {identity && !m.continued && (
        <span className="person-mark person-message-mark" data-person-tone={tone ?? undefined} aria-hidden="true">{personInitials(authorName)}</span>
      )}
      <div className="person-message-line">
        <div className={`person-message-text${emoji ? " is-emoji" : ""}`} {...(emoji ? { "data-emoji": emoji } : {})}>
          {/* In a group the run's first bubble opens with its author's name,
              in their colour, so each voice reads at a glance. */}
          {identity && !m.continuation && (
            <span className="person-message-author" data-person-tone={tone ?? undefined} aria-hidden="true"><bdi>{authorName}</bdi></span>
          )}
          {parts.map((part, index) => part.mention
            ? (
              <span
                key={index}
                className={`person-mention${part.own ? " is-self" : ""}`}
                data-person-tone={part.own ? undefined : personToneOf(tones, part.mention.userId) ?? undefined}
                title={part.mention.name}
              >{part.text}</span>
            )
            : <Fragment key={index}>{part.text}</Fragment>)}
        </div>
        <time className="person-message-time" dateTime={time.toISOString()}>{timeLabel}</time>
      </div>
      {m.carryToAgent && (
        <div className="person-message-carry" {...(m.delivered ? { "data-delivered": "" } : {})}>
          <UiIcon icon={m.delivered ? CheckIcon : BotIcon} size="sm" />
          <span>{m.delivered ? tr("timeline.carryDelivered") : tr("timeline.carryPending")}</span>
        </div>
      )}
    </div>
    </>
  );
}

/** `conversation/session-started`: the conversation handed messages to a new
 *  agent session. One quiet link row; it opens that chat. */
function ConversationStartedView({ m }: { m: ConversationStartedMsg }) {
  const authorName = m.startedBy?.name?.trim() || tr("timeline.anotherPerson");
  const title = m.title.trim() || tr("timeline.untitledSession");
  return (
    <div className="msg conversation-started" data-msg-id={m.id} data-message-seq={m.eventSeq} role="article"
      aria-label={tr("timeline.sessionStartedBy", { name: authorName, title })}>
      <button
        type="button"
        className="conversation-started-card"
        onClick={() => { void openSession(m.sessionId).catch(() => { /* the row stays a readable card */ }); }}
      >
        <span className="conversation-started-icon" aria-hidden="true"><UiIcon icon={BotIcon} size="sm" /></span>
        <span className="conversation-started-copy">
          <span className="conversation-started-title" dir="auto">{title}</span>
          <span className="conversation-started-sub">{tr("timeline.startedSession", { name: authorName })}</span>
        </span>
        <span className="conversation-started-open" aria-hidden="true"><UiIcon icon={ChevronRightIcon} size="sm" /></span>
      </button>
    </div>
  );
}

function PendingPrompt({ send }: { send: PendingSend }) {
  return (
    <div className="msg user msg-pending" data-pending-send={send.id} aria-busy="true">
      <div className="bubble" dir="auto">
        <UserPrompt text={send.text} id={send.id} />
      </div>
      {send.attachments.length > 0 && <AttachmentPills attachments={send.attachments} />}
      {/* The canonical metadata line has the same intrinsic height as this
          empty one, so echo handover adds no geometry under the bubble. */}
      <div className="msg-meta msg-meta-pending" aria-hidden="true" />
    </div>
  );
}

function MessageView({ m, announce, plan, regeneratePrompt, turn, terminal, settled, dormant, progress, segmentStartedAt, live, entering, leaving = false, answerLeaving = false, onRevert, onFork, revert, fork, sessionId, resourceContext }: {
  m: RenderMessage;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  regeneratePrompt?: { eventSeq: number; text: string; attachments?: UserMsg["attachments"] };
  turn?: RenderModel["turn"];
  terminal?: boolean;
  settled?: boolean;
  dormant?: boolean;
  progress?: boolean;
  segmentStartedAt?: number;
  live?: boolean;
  entering?: boolean;
  leaving?: boolean;
  /** A confirmed revert of this question's answer: only the answer exits. */
  answerLeaving?: boolean;
  onRevert?: (message: UserMsg | QuestionMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
  sessionId: string | null;
  resourceContext?: TimelineResourceContext;
}) {
  if (m.kind === "person-message") return <PersonMessageView m={m} entering={entering} />;
  if (m.kind === "conversation-started") return <ConversationStartedView m={m} />;
  if (m.kind === "question") {
    if (m.status === "pending" && sessionId) {
      return <QuestionPrompt m={m} sessionId={sessionId} entering={entering} leaving={leaving} />;
    }
    return <QuestionRecord m={m} entering={entering} leaving={leaving} answerLeaving={answerLeaving} announce={announce} onRevert={onRevert} revert={revert} />;
  }
  if (m.kind === "user") {
    // In a shared session, name whoever else wrote a prompt; one's own stay unlabeled.
    // A judge's fixed message is always labeled: nobody typed it.
    const otherAuthor = m.author && m.author.userId !== activeBrowserAccountId() ? m.author : undefined;
    const otherName = otherAuthor ? otherAuthor.name ?? tr("timeline.anotherPerson") : undefined;
    const byJudge = m.author?.via === "judge" ? tr("timeline.sentByJudge") : undefined;
    const personLabel = byJudge ? (otherName ? `${otherName} · ${byJudge}` : byJudge) : otherName;
    return (
      <div className={`msg user${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`} data-msg-id={m.id} data-message-seq={m.eventSeq} data-via={m.author?.via} role="article" aria-label={`${otherName ? userArticleNameFrom(otherName, m.time) : userArticleName(m.time)}${byJudge ? `. ${byJudge}` : ""}`}>
        {personLabel && <div className="msg-person" dir="auto" aria-hidden="true">{personLabel}</div>}
        <div className="bubble" dir="auto">
          <UserPrompt text={m.text} id={m.id} resourceContext={resourceContext} />
          {m.raw && m.raw !== m.text && (
            <div className="user-expanded-hint">
              {tr("timeline.expandedFrom")}{" "}<code>{m.raw.split("\n")[0] ?? m.raw}</code>
            </div>
          )}
          {m.uncertain && (
            <div className="runtime-recovery-caption">{tr("runtimeRecovery.uncertainTurn")}</div>
          )}
        </div>
        {m.attachments && m.attachments.length > 0 && (
          <AttachmentPills attachments={m.attachments} />
        )}
        {announce && (
           <MessageQuickActions
             message={m}
             announce={announce}
             onRevert={onRevert}

            onFork={onFork}
            revert={revert}
            fork={fork}
          />
        )}
      </div>
    );
  }
  if (m.kind === "assistant") {
    return (
       <AssistantView
         m={m}
         announce={announce}
         plan={plan}

        regeneratePrompt={regeneratePrompt}
        turn={turn}
        terminal={terminal}
        settled={settled}
        dormant={dormant}
        progress={progress}
        segmentStartedAt={segmentStartedAt}
         live={live}
         entering={entering}
         leaving={leaving}
         resourceContext={resourceContext}
      />
    );
  }
  // The conflict card itself is a package contribution to
  // `session.timeline.event`. The model keeps this row as a hidden prompt
  // boundary (grouping, regenerate, search and export), so render nothing.
  if (m.kind === "github-conflict") return null;
  if (m.kind === "notice") return <IsolationNotice notice={m} entering={entering} leaving={leaving} />;
  if (m.kind === "task") return <TaskActivityRow activity={m} entering={entering} leaving={leaving} />;
  if (m.composerShell) return <ComposerShellRow message={m} entering={entering} leaving={leaving} />;
  return <ExecutionRow message={m} entering={entering} leaving={leaving} sessionId={sessionId} />;
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
      && a.uncertain === b.uncertain
      && a.author?.userId === b.author?.userId && a.author?.name === b.author?.name;
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
  if (a.kind === "question" && b.kind === "question") {
    return a.status === b.status && a.answers === b.answers && a.answeredSeq === b.answeredSeq
      && a.answerRewindMarkerSeq === b.answerRewindMarkerSeq && a.answerReplaced === b.answerReplaced;
  }
  if (a.kind === "notice" && b.kind === "notice") {
    return a.topic === b.topic && a.branch === b.branch && a.commit === b.commit;
  }
  if (a.kind === "person-message" && b.kind === "person-message") {
    return a.text === b.text && a.carryToAgent === b.carryToAgent && a.replyToSeq === b.replyToSeq
      && a.delivered === b.delivered && a.continuation === b.continuation
      && a.continued === b.continued && a.timeBreak === b.timeBreak
      && a.author?.userId === b.author?.userId && a.author?.name === b.author?.name
      && a.mentions.length === b.mentions.length
      && a.mentions.every((mention, index) => mention.userId === b.mentions[index]?.userId
        && mention.name === b.mentions[index]?.name);
  }
  if (a.kind === "conversation-started" && b.kind === "conversation-started") {
    return a.sessionId === b.sessionId && a.title === b.title
      && a.startedBy?.userId === b.startedBy?.userId && a.startedBy?.name === b.startedBy?.name;
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
  && prev.settled === next.settled
  && prev.dormant === next.dormant
  && prev.progress === next.progress
  && prev.live === next.live
  && prev.entering === next.entering
  && prev.leaving === next.leaving
  && prev.answerLeaving === next.answerLeaving
  && prev.segmentStartedAt === next.segmentStartedAt
  && prev.regeneratePrompt === next.regeneratePrompt
  && prev.announce === next.announce
  && prev.onRevert === next.onRevert
  && prev.onFork === next.onFork
  && prev.sessionId === next.sessionId
  && prev.resourceContext?.projectId === next.resourceContext?.projectId
  && prev.resourceContext?.sessionId === next.resourceContext?.sessionId
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
  leaving,
  livePresentation,
  ticking,
  sessionId,
  resourceContext,
}: {
  rev: number;
  g: ActivityGroup;
  subagents: SubagentState | null;
  state?: RunSummaryState;
  entering?: boolean;
  leaving?: boolean;
  livePresentation?: boolean;
  ticking?: boolean;
  sessionId: string | null;
  resourceContext?: TimelineResourceContext;
}) {
  return <ActivityGroupView g={g} subagents={subagents} state={state} entering={entering} leaving={leaving} livePresentation={livePresentation} ticking={ticking} sessionId={sessionId} resourceContext={resourceContext} />;
}, (prev, next) => prev.rev === next.rev && sameActivity(prev.g, next.g)
  && prev.subagents === next.subagents && prev.state === next.state
  && prev.entering === next.entering && prev.livePresentation === next.livePresentation
  && prev.ticking === next.ticking
  && prev.leaving === next.leaving
  && prev.sessionId === next.sessionId
  && prev.resourceContext?.projectId === next.resourceContext?.projectId
  && prev.resourceContext?.sessionId === next.resourceContext?.sessionId);

// Edge prompt rail:
// a thin vertical tape of ticks in a 32.2px gutter hugging the chosen (right by
// default, or left) edge of the chat viewport, vertically centered. Shell
// chrome drawn over that edge pushes it inward (see promptRailInset). It is a SIBLING of the .timeline scroller
// (absolute within .timeline-viewport), so it never scrolls away and never
// competes with right-aligned user bubbles. Each tick is one real user prompt
// from this session; the active turn is tracked against the timeline scroll
// position, ticks swell in a proximity wave under the cursor, and hover/focus
// reveals a recent-turns panel. Click jumps via the existing
// jump()/scrollIntoView path. Presentation-only — no SessionEvent.
function PromptNavigator({ prompts, side, onJump, containerRef, canLoadOlder, olderBusy, onLoadOlder }: {
  prompts: Array<{ id: string; preview: string; text: string }>;
  side: PromptRailSide;
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
  const [inset, setInset] = useState<number | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hug the visible edge of the chat. The launcher strip, a slide-over pane or
  // a collapsed navigator may be drawn over the viewport at different widths
  // (full-height strip, floating cluster, pinned pane beside the chat), and
  // the navigator collapses/expands, so the inset is measured, never a
  // constant. Every one of those changes resizes the viewport or the chrome.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const viewport = nav?.parentElement;
    if (!nav || !viewport) return;
    const shell = nav.closest(".app-shell") ?? nav.ownerDocument;
    const obstacles = Array.from(shell.querySelectorAll<HTMLElement>(".railbar, .sidebar"))
      .filter((element) => !element.contains(nav));
    const measure = () => {
      setInset(promptRailInset(viewport.getBoundingClientRect(), obstacles.map((element) => element.getBoundingClientRect()), side));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    for (const element of obstacles) observer?.observe(element);
    const view = nav.ownerDocument.defaultView;
    view?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      view?.removeEventListener("resize", measure);
    };
  }, [side]);

  // Scroll-spy: the active turn is the last prompt at/above the viewport
  // midline; at the very bottom the newest rendered prompt always wins (its
  // top may never cross the midline). rAF-throttled; rows hidden by timeline windowing
  // windowing count as "above" (see activePromptIndex).
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let raf = 0;
    const promptIds = prompts.map((p) => p.id);
    const measure = () => {
      raf = 0;
      const box = el.getBoundingClientRect();
      const line = box.top + el.clientHeight * 0.5;
      const tops = promptRowTops(el, promptIds);
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
      ref={navRef}
      className="prompt-nav"
      data-side={side}
      style={inset === null ? undefined : { "--prompt-nav-inset": `${inset}px` } as CSSProperties}
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
                <span className="prompt-nav-row-text" dir="auto">{promptRowLabel(p.preview) || tr("messageActions.emptyPrompt")}</span>
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
 *  cancel-wait and a full harness-qualified model recovery picker. Replaces
 *  the generic "Last turn failed" line while `turn.limit` is set.
 *  A refused model has no wait to run out: the same surface keeps the picker
 *  and drops the countdown, so recovery is one explicit user choice. */
/** A person paused this chat mid-turn (projection.paused): one quiet status
 *  line at the end of the conversation, the paused mark, then Continue (the
 *  work picks up on the same history) and Stop (it ends). Writing to the chat
 *  continues it too. */
function PausedNotice({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState<null | "continue" | "stop">(null);
  const run = (kind: "continue" | "stop", op: () => Promise<unknown>) => {
    setBusy(kind);
    void op().finally(() => setBusy(null));
  };
  return (
    <div className="turn-paused" role="status">
      <span className="turn-paused-mark"><PausedMark /></span>
      <span className="turn-paused-title">{tr("timeline.paused.heading")}</span>
      <span className="turn-paused-actions">
        <Button
          size="sm"
          variant="quiet"
          iconStart={PlayIcon}
          className="turn-paused-continue"
          busy={busy === "continue"}
          disabled={busy !== null}
          onClick={() => run("continue", () => continuePausedSession(sessionId, "timeline"))}
        >{tr("subagentdock.continue")}</Button>
        <IconButton
          icon={StopIcon}
          size="md"
          className="turn-paused-stop"
          label={tr("common.stop")}
          busy={busy === "stop"}
          disabled={busy !== null}
          onClick={() => run("stop", () => api.abort(sessionId, "timeline").catch((error: unknown) =>
            setUiError(friendlyError(tr("common.stop"), error))))}
        />
      </span>
    </div>
  );
}

function RateLimitNotice({ sessionId, limit, turnError }: { sessionId: string; limit: TurnLimitState; turnError?: string }) {
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const spaceId = useSpaces().activeSpaceId ?? undefined;
  const storedHarness = session?.harness;
  const storedHarnessKey = storedHarness?.mode === "pinned"
    ? `pinned:${storedHarness.harnessId}`
    : "auto";
  const [harnessSelection, setHarnessSelection] = useState<HarnessSelection>(
    () => storedHarness ?? { mode: "auto" },
  );
  // A newly selected session gets its canonical route, while a local tab
  // choice remains stable through countdown/projection refreshes.
  useEffect(() => {
    setHarnessSelection(storedHarness ?? { mode: "auto" });
  }, [sessionId, storedHarnessKey]);
  const currentHarnessId = session?.resolvedHarnessId;
  const selectedHarnessId = session?.harnessTransition?.targetHarnessId
    ?? (harnessSelection.mode === "pinned" ? harnessSelection.harnessId : currentHarnessId);
  const routeCatalog = useRuntimeCatalog(session, models, agents, {
    spaceId,
    projectId: session?.projectId,
    harnessId: selectedHarnessId,
  });
  const catalogHarnessId = routeCatalog.harnessId ?? selectedHarnessId;
  const selectedModel = selectedHarnessId === currentHarnessId && session?.model
    ? { ...session.model, ...(currentHarnessId ? { harnessId: currentHarnessId } : {}) }
    : undefined;
  // Another harness's tab opens on the model last chosen there, as in the
  // composer. Only a highlight: nothing resumes until a row is picked.
  const { hiddenProviders, hiddenModels, shownModels } = useModelPrefs();
  const lastHarnessModels = useLastHarnessModels();
  const otherHarness = selectedHarnessId !== currentHarnessId;
  const rememberedModel = otherHarness && catalogHarnessId ? lastHarnessModels[catalogHarnessId] : undefined;
  const lastChosenModel = useMemo(() => lastChosenHarnessModel(
    routeCatalog.models,
    hiddenModelMatcher({ hiddenProviders, hiddenModels, shownModels }),
    catalogHarnessId,
    rememberedModel,
  ), [routeCatalog.models, hiddenProviders, hiddenModels, shownModels, catalogHarnessId, rememberedModel]);
  const recommendedModel = lastChosenModel && catalogHarnessId
    ? { providerID: lastChosenModel.providerID, modelID: lastChosenModel.modelID, harnessId: catalogHarnessId }
    : undefined;
  const unavailable = limit.code === "model-unavailable";
  const quotaExhausted = limit.code === "quota-exhausted";
  const hasAutoResume = !unavailable && !quotaExhausted && (limit.resumeAt ?? 0) > 0;
  // A refused request is auto-retried by the server a bounded number of times:
  // the surface names the retry and shows how much of that budget is spent,
  // instead of a provider limit the person would have to wait out.
  const refusedRequest = limit.scope === "request" && !unavailable;
  const progress = refusedRequest && limit.maxAttempts
    ? Math.min(100, Math.round((limit.attempt / limit.maxAttempts) * 100))
    : 0;
  const remaining = useRemainingSeconds(limit.resumeAt ?? 0);
  const [busy, setBusy] = useState<null | "resume" | "cancel" | "switch">(null);
  // "Compact before proceeding" lives on the server's resume plan, so the
  // auto-resume honours it even with no client open. The local value only
  // bridges the round trip until the projection echoes it back.
  // Every runtime can compact: natively, or through Polyth's own compaction.
  const canCompact = useStore((s) => s.runtimeFeatures[sessionId] !== undefined);
  const storedCompactFirst = session?.resume?.compactFirst === true;
  const [compactFirst, setCompactFirst] = useState(storedCompactFirst);
  const compactHintId = useId();
  useEffect(() => setCompactFirst(storedCompactFirst), [sessionId, storedCompactFirst]);
  const toggleCompactFirst = (next: boolean) => {
    setCompactFirst(next);
    void setResumeCompact(sessionId, next);
  };

  const providerLabel = limit.provider
    ? limit.provider.charAt(0).toUpperCase() + limit.provider.slice(1)
    : undefined;
  const scopeLabel =
    limit.scope === "quota"
      ? tr("timeline.rateLimit.scopeQuota")
      : limit.scope === "overloaded"
        ? tr("timeline.rateLimit.scopeOverloaded")
        : tr("timeline.rateLimit.scopeRate");
  // A refused request names what the provider said in place of "retrying" —
  // the countdown below already says a retry is coming. The error takes its
  // own line under the title, so the template splits around it and the
  // title drops the separator that would otherwise dangle at its end.
  const refusalDetail = refusedRequest && turnError ? shortMessage(turnError) : "";
  const refusalHeading = (): ReactNode => {
    const slot = "\u0000";
    const [before = "", after = ""] = tr(
      providerLabel ? "timeline.rateLimit.headingRequestErrorProvider" : "timeline.rateLimit.headingRequestError",
      { provider: providerLabel, error: slot },
    ).split(slot);
    return <>{before.replace(/[\s:：—–-]+$/u, "")}{" "}<span className="turn-rate-limit-error">{refusalDetail}{after}</span></>;
  };
  const heading: ReactNode = unavailable
    ? tr("timeline.modelUnavailable.heading", {
        model: session?.model?.modelID ?? tr("timeline.modelUnavailable.thisModel"),
      })
    : refusedRequest
      ? refusalDetail
        ? refusalHeading()
        : providerLabel
          ? tr("timeline.rateLimit.headingRequestProvider", { provider: providerLabel })
          : tr("timeline.rateLimit.headingRequest")
      : providerLabel
        ? tr("timeline.rateLimit.headingProvider", { provider: providerLabel, scope: scopeLabel })
        : tr("timeline.rateLimit.heading", { scope: scopeLabel });

  const run = (kind: "resume" | "cancel", op: Promise<unknown>) => {
    setBusy(kind);
    void op.finally(() => setBusy(null));
  };
  const pickModel = (model?: { providerID: string; modelID: string; variant?: string; harnessId?: string }) => {
    if (!model || busy) return;
    const options = resumeOptionsForModel({
      currentHarnessId,
      selectedHarnessId: catalogHarnessId,
      model,
    });
    // ModelPicker closes/fences on a harness change; this final guard keeps a
    // late selection from its previously visible catalog out of the new route.
    if (!options) return;
    if (catalogHarnessId) {
      const descriptor = routeCatalog.models.find((candidate) => candidate.providerID === model.providerID
        && candidate.modelID === model.modelID);
      rememberHarnessModel(catalogHarnessId, {
        providerID: model.providerID,
        modelID: model.modelID,
        ...(descriptor?.name ? { name: descriptor.name } : {}),
      });
    }
    setBusy("switch");
    void resumeNow(sessionId, options)
      .finally(() => setBusy(null));
  };

  return (
    <Notice
      tone="warning"
      className={refusedRequest ? "turn-rate-limit turn-rate-limit--retry" : "turn-rate-limit"}
      role="status"
      aria-live="polite"
      heading={heading}
      actions={
        <>
          {hasAutoResume && canCompact && (
            // A mode for the coming resume, not a command: it sits above the
            // recovery buttons in the notice's top corner, and the whole pill
            // is the switch target. The hint stays reachable as its description.
            <Tooltip content={tr("timeline.rateLimit.compactFirstHint")} side="up">
              <button
                type="button"
                className="turn-rate-limit-compact"
                role="switch"
                aria-checked={compactFirst}
                aria-describedby={compactHintId}
                disabled={busy !== null}
                onClick={() => toggleCompactFirst(!compactFirst)}
              >
                <span className="turn-rate-limit-compact-label">{tr("timeline.rateLimit.compactFirst")}</span>
                <span className="switch" data-checked={compactFirst} aria-hidden="true">
                  <span className="switch-track"><i /></span>
                </span>
                <span id={compactHintId} className="sr-only">{tr("timeline.rateLimit.compactFirstHint")}</span>
              </button>
            </Tooltip>
          )}
          <span className="turn-rate-limit-buttons">
            {hasAutoResume && (
              <Button
                size="sm"
                variant="quiet"
                className="turn-rate-limit-action"
                busy={busy === "resume"}
                disabled={busy !== null}
                onClick={() => run("resume", resumeNow(sessionId))}
              >{tr("timeline.rateLimit.resumeNow")}</Button>
            )}
            <span className="turn-rate-limit-model">
              <ModelPicker
                models={routeCatalog.models}
                harnessId={catalogHarnessId}
                value={selectedModel}
                recommended={recommendedModel}
                header={
                  <SlotHost
                    slot="modelPicker.header"
                    context={{
                      spaceId,
                      sessionId,
                      projectId: session?.projectId,
                      sessionStatus: session?.status,
                      harnessSelection,
                      resolvedHarnessId: selectedHarnessId,
                      pendingHarnessSelection: harnessSelection,
                      onSelectHarness: setHarnessSelection,
                    }}
                  />
                }
                direction="up"
                onPick={pickModel}
                className="picker-chip"
              />
            </span>
            {hasAutoResume && (
              <Button
                size="sm"
                variant="quiet"
                className="turn-rate-limit-action"
                busy={busy === "cancel"}
                disabled={busy !== null}
                onClick={() => run("cancel", cancelResume(sessionId))}
              >{tr("timeline.rateLimit.cancelWait")}</Button>
            )}
          </span>
        </>
      }
    >
      {unavailable
        ? tr("timeline.modelUnavailable.body")
        : quotaExhausted
          ? (turnError ? shortMessage(turnError) : tr("timeline.rateLimit.scopeQuota"))
          : remaining > 0
            ? tr("timeline.rateLimit.resumesIn", { time: formatWait(remaining) })
            : tr("timeline.rateLimit.resuming")}
      {hasAutoResume && limit.maxAttempts !== undefined
        ? ` · ${tr("timeline.rateLimit.attemptOf", { n: String(limit.attempt), m: String(limit.maxAttempts) })}`
        : hasAutoResume && limit.attempt > 1
          ? ` · ${tr("timeline.rateLimit.attempt", { n: String(limit.attempt) })}`
          : ""}
      {progress > 0 && (
        <span className="turn-rate-limit-progress" aria-hidden="true">
          <span className="turn-rate-limit-progress-fill" style={{ inlineSize: `${progress}%` }} />
        </span>
      )}
    </Notice>
  );
}

// Footer under the last message once the turn ended: exactly one terminal
// turn's own start/stop and usage — see turnFooterLine().

/** A finalized assistant row with only whitespace (no text, no reasoning) is
 *  an invisible no-op — the model emitted blank lines between blocks. It stays
 *  in the log but is dropped from the timeline so it can't open a second gap
 *  between real rows (the 1px ghost bubble sandwiching two timeline gaps). */
/** The sheet's prompt row: an optimistic echo anchors the sheet exactly like
 *  the canonical prompt it stands in for. */
function sheetPromptRow(timeline: HTMLElement, promptId: string): HTMLElement | undefined {
  return [...timeline.querySelectorAll<HTMLElement>(".msg.user")]
    .find((row) => (row.dataset.msgId ?? row.dataset.pendingSend) === promptId);
}

/** The prompt's own composer-to-timeline entrance, if it is still running. A tail
 *  lift or an entrance on the same row is not a flight: waiting on those
 *  would suspend follow while content above the tail still grows. */
function runningMotion(element: Element): Animation[] {
  // Read from the flight registry: Element.getAnimations() flushes style on
  // every call, and this runs on every model update of a live turn.
  if (sendFlightsInAir.size === 0) return [];
  return [...sendFlightsInAir].filter((animation) =>
    animation.id === TIMELINE_SEND_FLIGHT_ANIMATION_ID
    && animation.playState === "running"
    && (animation.effect as KeyframeEffect | null)?.target === element
    && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
}

/** Upper bound for waiting on a flight: a stalled animation must never leave
 *  the fresh-turn sheet suspended. */
const FLIGHT_WAIT_LIMIT_MS = 1_600;

/** The next transcript row after `index` is an activity block (timeline
 *  event slots render no row of their own). */
function nextRowIsActivity(entries: ReadonlyArray<{ kind: string; row?: { kind: string } }>, index: number): boolean {
  for (let next = index + 1; next < entries.length; next += 1) {
    const entry = entries[next]!;
    if (entry.kind === "timeline-event") continue;
    return entry.row?.kind === "activity";
  }
  return false;
}

/** Also covers a provider limit line: the rate-limit notice replaces it. */
function blankAssistant(m: RenderMessage): boolean {
  return m.kind === "assistant" && m.finalized
    && (m.providerNotice === true || (m.text.trim() === "" && m.reasoning.trim() === ""));
}

/** An open question is answered in place; a rewound branch never offers one. */
function openQuestion(m: RenderMessage): boolean {
  return m.kind === "question" && m.status === "pending";
}

/** `[first hidden row, marker)` for every tail a rewind hid (the active one
 *  and the ones a replacement discarded). Package timeline facts inside a
 *  range belong to that hidden branch, not to the visible conversation. */
function rewoundRanges(messages: readonly RenderMessage[]): Array<[number, number]> {
  const ranges = new Map<number, [number, number]>();
  for (const message of messages) {
    if (!message.undone || message.rewindMarkerSeq === undefined) continue;
    const range = ranges.get(message.rewindMarkerSeq);
    if (!range) ranges.set(message.rewindMarkerSeq, [message.eventSeq, message.rewindMarkerSeq]);
    else if (message.eventSeq < range[0]) range[0] = message.eventSeq;
  }
  return [...ranges.values()];
}

export function timelineAfterSlotContext(input: {
  sessionId: string | null;
  projectId: string | null;
  messageCount: number;
  promptCount: number;
  turnStatus: string | null;
  permissions: ReadonlyArray<{ status: string }>;
  secrets: ReadonlyArray<{ status: string }>;
}): {
  sessionId: string | null;
  projectId: string | null;
  messageCount: number;
  promptCount: number;
  turnStatus: string | null;
  permissions: Array<{ status: string }>;
  secrets: Array<{ status: string }>;
} {
  return {
    sessionId: input.sessionId,
    projectId: input.projectId,
    messageCount: input.messageCount,
    promptCount: input.promptCount,
    turnStatus: input.turnStatus,
    permissions: input.permissions.filter((permission) => permission.status === "pending"),
    secrets: input.secrets.filter((secret) => secret.status === "pending"),
  };
}

export default function Timeline({
  model,
  latestRevealTarget,
}: {
  model: RenderModel;
  /** An optional dock anchor places the latest-reveal control above the composer. */
  latestRevealTarget?: HTMLElement | null;
}) {
  const spaceId = useSpaces().activeSpaceId ?? undefined;
  const ref = useRef<HTMLDivElement>(null);
  useTimelineStripLane(ref);
  const atBottom = useRef(true);
  const prefs = useUiSettings();
  const sessionId = useTimelineSessionId();
  // A split view's companion pane: a view of a background chat whose controls
  // wait for the pane to be focused, so it publishes nothing shell-wide.
  const companion = useTimelineCompanion();
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const conversation = session?.purpose === "conversation";
  const canStartConversationSession = !companion && conversation && !!session && canCollaborateSession(session);
  const selectionState = useConversationSelection(canStartConversationSession ? sessionId : null);
  const selectionMode = selectionState.sessionId !== null;
  const selectedSeqs = selectionState.seqs;
  // Leaving the conversation (or losing the right to start) ends the choice.
  useEffect(() => {
    if (companion) return;
    return () => endConversationSelection();
  }, [companion, sessionId, canStartConversationSession]);
  useEffect(() => {
    if (!selectionMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || conversationSelection().dialogOpen) return;
      event.preventDefault();
      endConversationSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectionMode]);
  const personSelection = useMemo(() => ({
    active: selectionMode,
    selectable: canStartConversationSession,
    selected: new Set(selectedSeqs),
    toggle: toggleConversationMessage,
    enter: (seq: number) => { if (sessionId) beginConversationSelection(sessionId, seq); },
  }), [selectionMode, canStartConversationSession, selectedSeqs, sessionId]);
  // Rows grow in place, so the length stands in for the log's identity.
  const messageCount = model.messages.length;
  const hasPersonMessages = useMemo(
    () => model.messages.some((message) => message.kind === "person-message"),
    [model.messages, messageCount],
  );
  // Everyone who can open the chat, so colours are the same for every reader
  // and do not shift as older messages load.
  const chatPeople = useSessionPeople(hasPersonMessages && sessionId ? sessionId : null);
  const personTones = useMemo(() => {
    if (!hasPersonMessages) return null;
    const ids: string[] = [activeBrowserAccountId(), ...chatPeople.map((person) => person.userId)];
    for (const message of model.messages) {
      if (message.kind !== "person-message") continue;
      if (message.author?.userId) ids.push(message.author.userId);
      for (const mention of message.mentions) ids.push(mention.userId);
    }
    return assignPersonTones(ids);
  }, [hasPersonMessages, chatPeople, model.messages, messageCount]);
  const personNames = useMemo(() => {
    if (!conversation) return true;
    // A group names its voices from the first message on.
    if (chatPeople.length >= 2) return true;
    const self = activeBrowserAccountId();
    let other: string | null = null;
    for (const message of model.messages) {
      if (message.kind !== "person-message") continue;
      const author = message.author?.userId ?? "";
      if (author === self) continue;
      if (other === null) other = author;
      else if (other !== author) return true;
    }
    return false;
  }, [conversation, chatPeople, model.messages, messageCount]);
  const projectId = session?.projectId ?? null;
  const resourceContext = projectId ? { projectId, sessionId } : undefined;
  const sessionEvents = useStore((s) => sessionId
    ? s.events[sessionId] ?? EMPTY_SESSION_EVENTS
    : EMPTY_SESSION_EVENTS);
  const latestUserMessage = [...model.messages].reverse()
    .find((message) => message.kind === "user" && !message.undone);
  const pendingSends = usePendingSends(sessionId);
  const observedPendingSend = useRef<string | null>(null);
  const newestPendingSendId = pendingSends[pendingSends.length - 1]?.id ?? null;
  const newestPendingDelivery = pendingSends[pendingSends.length - 1]?.delivery;
  useSlotVersion();
  // Timeline windowing: only the last `limit` rows render (see timelineWindow.ts).
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
  const pendingJumpSmooth = useRef(false);
  // Reader intent is separate from proximity. In particular, one slow wheel
  // tick upward must stay detached even while it is only a pixel from the end.
  const readerDetached = useRef(false);
  // Following, but from the reader's own position above live runway: rows
  // fill down into the blank below it (see timelineFollowState). Scrolling on
  // into the true tail releases it.
  const readerSoftLock = useRef(false);
  const lastScrollTop = useRef(0);
  const touchY = useRef<number | null>(null);
  // While a finger owns the native overflow gesture — from touchstart until
  // its momentum has come to rest — React must not write scrollTop or resize
  // the fresh-turn spacer. iOS WebKit can otherwise cancel the overflow
  // gesture, stop its glide dead, or leave the transcript layer unresponsive.
  const touchActive = useRef(false);
  const scrollbarPointer = useRef(false);
  const readerIntent = useRef<{
    direction: "toward-history" | "toward-tail";
    until: number;
  } | null>(null);
  const expectedScrollTop = useRef<number | null>(null);
  // True while a tail lift FLIPs the already-visible rows; rect-based sheet
  // geometry is skipped for its duration because those rects carry a transform.
  const liftBusy = useRef(false);
  // True from a revert/restore click until its choreography settles: rows are
  // FLIPped by transform (rewindMotion.ts), so the tail lift stays off and the
  // fresh-turn sheet is measured again only once they are released.
  const rewindMotionActive = useRef(false);
  // While following, this high-water mark keeps the scroller's extent from
  // shrinking under a folding action. The marker is an in-flow, aria-hidden
  // spacer so its old height survives the React commit before release FLIP.
  const timelineExtentHighWater = useRef(0);
  const timelineExtentSpace = useRef(0);
  // Height below the tail row at the last measure (timelineTrailingHeight).
  const timelineTrailing = useRef(0);
  // The followed scroll and the content below the tail from just before a
  // card (an approval) appeared there: when the card leaves, the rows it
  // pushed up come back to that scroll.
  const trailingBase = useRef<{ scroll: number; height: number } | null>(null);
  // A completed short chat keeps the scroll offset its live sheet created.
  // The existing floor retains only enough space to prevent browser clamping.
  const heldTailScroll = useRef<number | null>(null);
  // Whether a turn currently owns the tail: a prompt submitted locally but not
  // yet admitted, or a working turn. Read from callbacks whose identity must
  // not churn with every pending-send update.
  const turnLiveRef = useRef(false);
  turnLiveRef.current = pendingSends.length > 0 || model.turn?.status === "working";
  // A newly appended user prompt owns a contextual fresh-turn tail.
  // Presentation-only padding leaves the end of the previous answer above that
  // prompt and keeps the newest surface at that reading level for the whole
  // turn: every added row lifts the transcript instead of growing down into it.
  const turnSheetPromptId = useRef<string | null>(null);
  const turnSheetPadding = useRef(0);
  // The live reserve before a card below the tail takes its share of it.
  const turnSheetBase = useRef(0);
  const turnSheetStarted = useRef(false);
  // The turn-end beat, then the release it owes: a detached reader, a finger
  // on the transcript or a running lift defer the release, never cancel it.
  const turnEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchRestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The finger's gesture moved the scroll (momentum then keeps owning it).
  const touchScrolled = useRef(false);
  const touchEndCleanup = useRef<(() => void) | null>(null);
  const turnSettleDue = useRef(false);
  // The last tail seen by scrollToTail: a changed tail is an arrival, the same
  // tail growing is streamed prose.
  // The row a detached reader is reading, and its layout offset (see
  // captureReaderAnchor / holdReaderAnchor).
  const readerAnchor = useRef<{ row: HTMLElement; offset: number } | null>(null);
  // Layout of the latest follow write, and whether this session has painted a
  // frame yet (see notePaintedLayout).
  // `shift` is layout above the rows in view folded in since (foldLayoutShift):
  // a recorded offset stands at `offset + shift` in the current layout.
  const paintedLayout = useRef<{
    scroll: number;
    offsets: WeakMap<Element, number>;
    shift: number;
    tail: Element | null;
  } | null>(null);
  const firstPaint = useRef(false);
  const firstPaintPending = useRef(false);
  const paintEpoch = useRef(0);
  // True while the sheet belongs to an optimistic echo. Its canonical prompt
  // inherits the sheet in place instead of re-aligning (see below).
  const turnSheetOwnerEcho = useRef(false);
  // When a fresh-turn alignment scrolls the viewport, chatMotion's FLIP
  // transforms (fill: "both") are already painted via its earlier
  // MutationObserver. Any subsequent refresh() that re-measures
  // getBoundingClientRect() picks up the TRANSFORMED positions, producing
  // wrong padding and scroll targets. Suppress refresh() scrolling until
  // the first model.version bump confirms the agent has started, or until
  // FRESH_TURN_DISTORTION_MS elapses, whichever comes first — the
  // useLayoutEffect scroll is authoritative until then.
  const freshTurnPending = useRef(false);
  // Bounds the suppression above to the FLIP animation's real duration; see
  // FRESH_TURN_DISTORTION_MS.
  const freshTurnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while settling waits for a still-running prompt flight to land.
  const flightWait = useRef(false);
  // A follow-up sent into a live/aborted turn must stay pinned to the tail.
  // The fresh-turn sheet would scroll the current work off-screen and look
  // like the transcript was cleared until admission returns.
  const followUpSendRef = useRef(false);
  const observedPrompt = useRef({
    sessionId,
    seq: latestUserMessage?.eventSeq ?? 0,
  });
  // Hidden replays (regenerate/retry/auto-resume) intentionally append no
  // visible user row. Track the false -> true edge so a live hidden replay
  // can release geometry owned by the preceding visible prompt without
  // treating a hydrated/session-switched hidden turn as a new interaction.
  const observedHiddenPrompt = useRef({
    sessionId,
    hidden: model.lastUserMessageHidden,
  });
  // Latest-reveal state (§2.4): true while the reader holds a position away
  // from the tail, mounting the reserved Jump to latest region.
  const [showJump, setShowJump] = useState(false);
  // Revert & edit choreography (see the revert layout effects). The ref mirrors
  // the state for timers and the request callback; both change together.
  const [revertExit, setRevertExit] = useState<RevertExit | null>(null);
  const revertExitRef = useRef<RevertExit | null>(null);
  const setRevertChoreography = (next: RevertExit | null) => {
    revertExitRef.current = next;
    setRevertExit(next);
  };
  // The phase derived from state + model during render, for callbacks.
  const revertPhaseRef = useRef<"leaving" | "gliding" | null>(null);
  const revertExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revertGlideRows = useRef<TimelineLiftRow[] | null>(null);
  // The request's restored draft waits for the glide; the marker owns it.
  const revertDraft = useRef<RewindDraft | null>(null);
  const applyRewindDraftRef = useRef<(draft: RewindDraft) => void>(() => {});
  const bookmarkJumpGeneration = useRef(0);
  const [bookmarkJumpId, setBookmarkJumpId] = useState<string | null>(null);
  const [externalReveal, setExternalReveal] = useState<ConversationRevealRequest | null>(null);
  const externalRevealRef = useRef<ConversationRevealRequest | null>(null);
  const revealLoadInFlight = useRef<ConversationRevealRequest | null>(null);
  const [revealLoadEpoch, setRevealLoadEpoch] = useState(0);
  useEffect(() => {
    setExternalReveal(null);
    if (!sessionId) return;
    const unregister = registerConversationReveal(sessionId, (request) => {
      if (!ref.current) return false;
      if (externalRevealRef.current !== request) externalRevealRef.current?.finish(false);
      externalRevealRef.current = request;
      setExternalReveal(request);
      return true;
    });
    return () => {
      unregister();
      externalRevealRef.current?.finish(false);
      externalRevealRef.current = null;
    };
  }, [sessionId]);
  const bookmarkRequest = useRef<{ generation: number; resolve: () => void; reject: (error: Error) => void } | null>(null);
  const jumpRef = useRef<((id: string, opts?: { focus?: boolean; smooth?: boolean }) => void) | null>(null);
  useEffect(() => {
    bookmarkJumpGeneration.current += 1;
    return () => {
      bookmarkJumpGeneration.current += 1;
      bookmarkRequest.current?.reject(new Error("Prompt navigation cancelled"));
      bookmarkRequest.current = null;
    };
  }, [sessionId]);
  useEffect(() => {
    const releaseScrollbar = () => { scrollbarPointer.current = false; };
    window.addEventListener("pointerup", releaseScrollbar);
    window.addEventListener("pointercancel", releaseScrollbar);
    return () => {
      window.removeEventListener("pointerup", releaseScrollbar);
      window.removeEventListener("pointercancel", releaseScrollbar);
    };
  }, []);
  // Stable anchor: session switches adjust during render so the
  // outgoing anchor is captured from the STILL-CURRENT DOM (before commit) and
  // the incoming one is ready before the first paint of the new session.
  // Pane dock/expand/full-screen transitions never remount this tree, so the
  // live scroll position carries itself; this record covers reload + switch.
  const restoreRef = useRef<TimelineAnchor | null>(null);
  const [anchorSession, setAnchorSession] = useState<string | null | undefined>(undefined);
  if (anchorSession !== sessionId) {
    const el = ref.current;
    timelineExtentHighWater.current = 0;
    timelineExtentSpace.current = 0;
    timelineTrailing.current = 0;
    trailingBase.current = null;
    heldTailScroll.current = null;
    el?.style.removeProperty("--timeline-extent-floor");
    turnSheetStarted.current = false;
    turnSettleDue.current = false;
    readerAnchor.current = null;
    paintedLayout.current = null;
    firstPaint.current = false;
    firstPaintPending.current = false;
    paintEpoch.current += 1;
    if (turnEndTimer.current !== null) {
      clearTimeout(turnEndTimer.current);
      turnEndTimer.current = null;
    }
    if (anchorSession !== undefined && anchorSession !== null && el !== null) {
      saveTimelineAnchor(anchorSession, captureTimelineAnchor(el, atBottom.current));
    }
    setAnchorSession(sessionId);
    setLimit(initialLimit);
    const stored = sessionId !== null ? loadTimelineAnchor(sessionId) : null;
    restoreRef.current = stored !== null && !stored.atBottom ? stored : null;
    atBottom.current = stored?.atBottom ?? true;
    readerDetached.current = stored !== null && !stored.atBottom;
    readerSoftLock.current = false;
    readerIntent.current = null;
    scrollbarPointer.current = false;
    touchActive.current = false;
    if (touchRestTimer.current !== null) {
      clearTimeout(touchRestTimer.current);
      touchRestTimer.current = null;
    }
    touchY.current = null;
    expectedScrollTop.current = null;
    lastScrollTop.current = el?.scrollTop ?? 0;
    followUpSendRef.current = false;
    liftBusy.current = false;
    rewindMotionActive.current = false;
    revertDraft.current = null;
    revertGlideRows.current = null;
    if (revertExitTimer.current !== null) {
      clearTimeout(revertExitTimer.current);
      revertExitTimer.current = null;
    }
    if (revertExitRef.current !== null) setRevertChoreography(null);
    flightWait.current = false;
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

  // The rows the reader sees stay put through layout above them — Markdown,
  // code, images and fonts settling, prepended history, the earlier history
  // host coming or going, and a long session's window unmounting its oldest
  // rows while a turn adds new ones. The anchor is the first row at the top
  // of the reading area, tracked by layout offset (scroll and transforms never
  // change offsetTop) and re-baselined by every deliberate position. A
  // detached reader's scroll follows it (holdReaderAnchor); a followed tail
  // moves its held geometry with it (scrollToTail).
  const captureReaderAnchor = useCallback((el: HTMLElement) => {
    const found = timelineReadingTopRow(el);
    readerAnchor.current = found ? { row: found, offset: found.offsetTop } : null;
  }, []);
  const holdReaderAnchor = useCallback((el: HTMLElement) => {
    const anchor = readerAnchor.current;
    if (atBottom.current || touchActive.current || anchor === null) return;
    if (!anchor.row.isConnected || anchor.row.parentElement !== el) {
      captureReaderAnchor(el);
      return;
    }
    const delta = anchor.row.offsetTop - anchor.offset;
    if (Math.abs(delta) < 0.5) return;
    anchor.offset = anchor.row.offsetTop;
    expectedScrollTop.current = el.scrollTop + delta;
    el.scrollTop += delta;
    lastScrollTop.current = el.scrollTop;
  }, [captureReaderAnchor]);

  // Where the reader last saw the rows: their layout offsets and the scroll
  // they were painted at, recorded after every follow write. A lift that
  // starts after a DOM change (prepended history, late layout above the tail,
  // a browser clamp) travels from there, never from positions nobody saw.
  const notePaintedLayout = useCallback((el: HTMLElement) => {
    const offsets = new WeakMap<Element, number>();
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement && child.matches(TIMELINE_LIFT_ROW_SELECTOR)) offsets.set(child, child.offsetTop);
    }
    // Always the layout of the latest write: a running lift's transform is
    // relative to it, so origins stay consistent across unpainted writes.
    paintedLayout.current = { scroll: el.scrollTop, offsets, shift: 0, tail: timelineTailRow(el) };
    captureReaderAnchor(el);
    if (firstPaint.current || firstPaintPending.current) return;
    firstPaintPending.current = true;
    const epoch = paintEpoch.current;
    const shown = () => {
      if (paintEpoch.current !== epoch) return;
      firstPaintPending.current = false;
      firstPaint.current = true;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(shown, 0));
    else shown();
  }, [captureReaderAnchor]);
  const paintedOrigins = useCallback((el: HTMLElement, rows: readonly TimelineLiftRow[]): TimelineLiftRow[] => {
    const painted = paintedLayout.current;
    // Nothing painted yet (a mount, a session switch): the first position is
    // simply the resting place, never a glide from positions nobody saw.
    if (!painted || !firstPaint.current) return [];
    const scrollShift = el.scrollTop - painted.scroll;
    const origins: TimelineLiftRow[] = [];
    const starts = new Map<Element, number>();
    for (const row of rows) {
      const then = painted.offsets.get(row.element);
      if (then !== undefined) {
        // Current visual top (running transforms included), corrected by the
        // content and scroll change since it was painted. Layout that moved
        // the whole transcript from above is already folded into the record.
        const top = row.top + (then + painted.shift - row.element.offsetTop) + scrollShift;
        origins.push({ element: row.element, top });
        starts.set(row.element, top);
        continue;
      }
      // A row that arrived after a row the reader saw rises from where it was
      // inserted; one inserted before all of them (prepended history) was
      // never seen. Not the painted tail itself: a row that leaves in the same
      // commit its successors arrive must not strand them at their final place
      // while the rows above them still travel.
      let seen = row.element.previousElementSibling;
      while (seen && !painted.offsets.has(seen)) seen = seen.previousElementSibling;
      if (!(seen instanceof HTMLElement)) continue;
      // Inserted under that row, at their layout distance: when it is still
      // travelling from an earlier lift, the new row must not start ahead of it.
      const above = starts.get(seen);
      origins.push({
        element: row.element,
        top: above === undefined ? row.top + scrollShift : above + row.element.offsetTop - seen.offsetTop,
      });
    }
    return origins;
  }, []);

  // Layout above the rows in view moved the whole transcript since the reader
  // anchor was taken: a long session's window unmounting its oldest rows as a
  // turn or a send adds new ones, history arriving above, late layout far up.
  // That is neither a fold nor an arrival, so every held content coordinate
  // moves with it — the extent high water, a held short-transcript position,
  // the painted layout. Otherwise the floor kept the removed history as blank
  // under the tail, which lifted the live tail out of the reading area until
  // enough new rows filled it. Returns the shift; the caller owns the scroll.
  const foldLayoutShift = useCallback((el: HTMLElement): number => {
    const anchor = readerAnchor.current;
    if (anchor === null || anchor.row.parentElement !== el || anchor.row.offsetHeight <= 0) return 0;
    const shift = anchor.row.offsetTop - anchor.offset;
    if (Math.abs(shift) < 0.5) return 0;
    anchor.offset = anchor.row.offsetTop;
    timelineExtentHighWater.current = Math.max(0, timelineExtentHighWater.current + shift);
    if (heldTailScroll.current !== null) {
      heldTailScroll.current = Math.max(0, heldTailScroll.current + shift);
    }
    const painted = paintedLayout.current;
    if (painted) {
      painted.scroll += shift;
      painted.shift += shift;
    }
    return shift;
  }, []);

  const setTurnSheetPadding = useCallback((value: number) => {
    const el = ref.current;
    if (!el) return;
    if (Math.abs(turnSheetPadding.current - value) < 0.5) return;
    turnSheetPadding.current = value;
    if (value > 0) el.style.setProperty("--timeline-turn-sheet-space", `${value}px`);
    else el.style.removeProperty("--timeline-turn-sheet-space");
  }, []);

  // The floor is an explicit extent ratchet, not an activity-specific tail
  // patch. It survives a React removal commit and is released only through the
  // same canonical-scroll-then-FLIP path as every other intentional reflow.
  const resetTimelineExtent = useCallback((element: HTMLElement | null = ref.current) => {
    timelineExtentHighWater.current = 0;
    timelineExtentSpace.current = 0;
    heldTailScroll.current = null;
    trailingBase.current = null;
    element?.style.removeProperty("--timeline-extent-floor");
  }, []);
  const writeTimelineExtentSpace = useCallback((element: HTMLElement, space: number) => {
    const next = Math.max(0, Math.ceil(space));
    timelineExtentSpace.current = next;
    if (next > 0) element.style.setProperty("--timeline-extent-floor", `${next}px`);
    else element.style.removeProperty("--timeline-extent-floor");
  }, []);
  const updateTimelineExtent = useCallback((element: HTMLElement, live: boolean): {
    target: number;
    rows: ReturnType<typeof captureTimelineLiftRows> | null;
    allowShrink: boolean;
    /** A card below the tail left: the scroll it was pushed up from. */
    trailingBase?: number;
  } | null => {
    // A card below the tail that leaves (an answered approval) is not a fold:
    // holding its height left the transcript above an empty viewport until the
    // next row arrived. Its share of the high water is released and glides
    // back down, mirroring the lift that made room for it.
    const previousTrailing = timelineTrailing.current;
    const trailing = timelineTrailingHeight(element);
    const trailingShrink = previousTrailing - trailing;
    // Layout offsets are whole pixels while the tail ends on a fraction: a
    // pixel of rounding is not a card.
    if (trailing - previousTrailing >= TRAILING_CARD_MIN_PX && trailingBase.current === null) {
      trailingBase.current = { scroll: lastScrollTop.current, height: previousTrailing };
    }
    timelineTrailing.current = trailing;
    const trailingReleased = trailingShrink >= 0.5;
    // The card left (what stays below the tail is what was there before it):
    // the rows come back at most its own height.
    const base = trailingBase.current;
    const trailingBaseScroll = base !== null && trailingShrink >= TRAILING_CARD_MIN_PX
      && trailing <= base.height + TRAILING_CARD_MIN_PX
      ? Math.max(base.scroll, lastScrollTop.current - trailingShrink)
      : undefined;
    if (trailingBaseScroll !== undefined) trailingBase.current = null;
    if (trailingReleased) {
      timelineExtentHighWater.current = Math.max(0, timelineExtentHighWater.current - trailingShrink);
    }
    // The card's share of the live reserve changes with it in this same
    // measure, even mid-lift: a later sheet sync would move the rows again.
    if (Math.abs(trailingShrink) >= 0.5 && turnSheetPromptId.current !== null && turnLiveRef.current) {
      setTurnSheetPadding(Math.max(0, turnSheetBase.current - trailing));
    }
    if (!atBottom.current || rewindMotionActive.current) return null;
    // Measure the in-flow tail without removing its extent-floor marker.
    // Transforms can extend scrollHeight beyond that tail. Counting
    // that temporary overflow feeds each lift back into the next scroll.
    // Keep fractional layout here: rounding before the ratchet loses small
    // folds and makes the browser clamp the reader by a pixel at a time.
    const naturalExtent = Math.max(0, timelineNaturalHeight(element)
      + turnSheetPadding.current - element.clientHeight);
    // A finished turn keeps its reader's position, including on observer
    // refresh and viewport resize: blank the turn left under the tail stays
    // until nobody can see it — content grows over it, the reader scrolls
    // away from it, or a send, jump or session switch resets the hold.
    if (!live) {
      const heldScroll = heldTailScroll.current;
      if (heldScroll !== null) {
        const needed = element.clientHeight + heldScroll - timelineNaturalHeight(element);
        if (needed > 0.5) {
          writeTimelineExtentSpace(element, needed);
          return null;
        }
        heldTailScroll.current = null;
      }
      const held = timelineExtentSpace.current;
      timelineExtentHighWater.current = naturalExtent;
      if (held <= 0) return null;
      const rows = !timelineLiftMotionDisabled()
        ? captureTimelineLiftRows(element)
        : null;
      writeTimelineExtentSpace(element, 0);
      return { target: naturalExtent, rows, allowShrink: true };
    }
    // A turn that started without a visible prompt (a hidden resend, a
    // resume, a server wake) inherits the blank the previous turn left held
    // below its tail: rows fill down into it instead of the floor vanishing
    // under the reader.
    if (heldTailScroll.current !== null) {
      timelineExtentHighWater.current = Math.max(timelineExtentHighWater.current, naturalExtent + timelineExtentSpace.current);
      heldTailScroll.current = null;
    }
    const visible = timelineVisibleArea(element);
    // A card below the tail that does not fit under the focus line (a
    // keyboard-shortened viewport) rests on the composer edge: blank held for
    // a fold above would keep its actions above that edge, so it glides out.
    const cardOverflows = trailing > 0
      && trailing >= timelineTurnReserve(visible) - timelineTailClearance(element);
    const floor = ratchetTimelineExtent({
      highWater: timelineExtentHighWater.current,
      naturalExtent,
      visibleHeight: visible.height,
      tailReserve: turnSheetPadding.current + timelineTailClearance(element),
      following: !cardOverflows,
    });
    const releasing = (floor.released && floor.extent < timelineExtentHighWater.current) || trailingReleased;
    // Rows are captured at their visual position even mid-lift: a new lift
    // supersedes the running one row by row (timelineLift.ts).
    const rows = releasing && !timelineLiftMotionDisabled()
      ? captureTimelineLiftRows(element)
      : null;
    timelineExtentHighWater.current = floor.extent;
    writeTimelineExtentSpace(element, floor.space);
    // The spacer rounds up to cover the held extent; its spare fraction is
    // not a new follow target. Follow the held position, not the spacer's end.
    return floor.space > 0 || releasing
      ? { target: floor.extent, rows, allowShrink: releasing, ...(trailingBaseScroll !== undefined ? { trailingBase: trailingBaseScroll } : {}) }
      : null;
  }, [setTurnSheetPadding, writeTimelineExtentSpace]);
  const scrollToTail = useCallback(() => {
    const el = ref.current;
    if (!el || touchActive.current || readerDetached.current) return;
    // Layout that moved the whole transcript from above is not a fold: the
    // held geometry moves with it, and so does the last canonical position
    // that fill-down never settles below.
    const shift = foldLayoutShift(el);
    if (shift !== 0) lastScrollTop.current = Math.max(0, lastScrollTop.current + shift);
    const live = turnLiveRef.current;
    // Every arrival fills DOWN: rows the reader sees stay still while new
    // ones land under the tail, in the blank a live turn reserves below its
    // prompt; once the tail reaches the composer edge the view follows that
    // edge. Nothing is lifted onto a line mid-screen, so the tail never
    // waits there above blank for the turn to end and drop back down.
    // Hold through the completion commit too: the composer can resize before
    // the turn's reserve is handed over, so that early layout cannot clamp
    // the reading position.
    const release = updateTimelineExtent(el, live || turnSheetPadding.current > 0
      || turnEndTimer.current !== null || turnSettleDue.current);
    const maxScrollTop = Math.max(0, Math.ceil(timelineNaturalHeight(el)
      + turnSheetPadding.current + timelineExtentSpace.current - el.clientHeight));
    // Without reserve or floor below the tail the extent end is its rest.
    const blankBelow = turnSheetPadding.current > 0 || timelineExtentSpace.current > 0;
    // A held floor only keeps the extent from clamping; rows still fill down
    // into it. Following the held extent instead lifted a growing answer away
    // from its rows the moment any floor was left over. A real release (the
    // floor shrinking past its hold) still glides to its target.
    const fillsDown = blankBelow;
    // The reader saw the rows where the last follow write left them (moved
    // with any layout above them since). Measure the lift from that painted
    // scroll and start every captured row from its painted pixels: content
    // that changed above it since (prepended history, late layout, a clamp)
    // moves nothing by itself.
    const paintedScroll = paintedLayout.current?.scroll ?? el.scrollTop;
    // Fill down from there too after such a shift: the browser may already
    // have clamped a scrollTop whose content moved up.
    const fillFrom = shift !== 0 ? paintedScroll : el.scrollTop;
    // Fill down from where the reader is; a release (the extent shrinking past
    // what the floor holds) only ever lowers that to the new end.
    let target = fillsDown
      ? Math.max(
        fillDownScrollTop({
          scrollTop: fillFrom,
          maxScrollTop,
          tailBottom: timelineContentBottom(el) + el.scrollTop - fillFrom,
          restLine: timelineRestLine(el),
        }),
        // A row collapsing above the tail can make the browser clamp before
        // the floor restores the extent: filling down never settles below the
        // last canonical position, so the rows above do not move.
        Math.min(maxScrollTop, lastScrollTop.current),
      )
      : maxScrollTop;
    // A card below the tail left (an answered approval): the rows it pushed
    // up glide back to where they were before it, never further down than
    // the tail resting on the composer edge, and a card that fit moved
    // nothing to undo.
    if (release?.trailingBase !== undefined) {
      const restScroll = el.scrollTop + timelineContentBottom(el) - timelineRestLine(el);
      target = Math.max(0, Math.min(maxScrollTop, target, Math.max(release.trailingBase, restScroll)));
    }
    const distance = timelineLiftDistance(target - paintedScroll, { allowShrink: release?.allowShrink === true });
    const captured = release?.rows ?? (distance > 0 && !rewindMotionActive.current
      && !timelineLiftMotionDisabled()
      ? captureTimelineLiftRows(el)
      : null);
    const liftRows = captured === null ? null : paintedOrigins(el, captured);
    if (Math.abs(el.scrollTop - target) >= 0.5) {
      expectedScrollTop.current = target;
      el.scrollTop = target;
    } else {
      // A no-op assignment emits no scroll event; never leave a stale
      // programmatic target that could swallow the reader's next End/drag.
      expectedScrollTop.current = null;
    }
    // A no-op assignment emits no scroll event, so keep the direction sample
    // current here as well as in onScroll.
    lastScrollTop.current = el.scrollTop;
    if (heldTailScroll.current !== null) heldTailScroll.current = el.scrollTop;
    notePaintedLayout(el);
    if (liftRows !== null && liftRows.length > 0
      && playTimelineLift(liftRows, () => { liftBusy.current = timelineLiftRunning(el); })) {
      liftBusy.current = true;
    }
  }, [foldLayoutShift, notePaintedLayout, paintedOrigins, updateTimelineExtent]);

  // A new turn (send, queue, steer, auto-resume) takes the tail back: drop
  // the pending beat and any owed release. A glide already under way is left
  // to the next lift, which supersedes it from the rows' visual positions.
  const cancelTurnEndMotion = useCallback(() => {
    if (turnEndTimer.current !== null) {
      clearTimeout(turnEndTimer.current);
      turnEndTimer.current = null;
    }
    turnSettleDue.current = false;
  }, []);

  // A reader who scrolled up from a finished turn's held blank no longer sees
  // all of it: the floor shrinks to what is still in view (below the visible
  // bottom, so nothing moves) and is gone once none of it is.
  const trimHeldTail = useCallback((el: HTMLElement) => {
    const held = heldTailScroll.current;
    if (held === null || touchActive.current || el.scrollTop >= held - 0.5) return;
    const needed = el.clientHeight + el.scrollTop - timelineNaturalHeight(el);
    if (needed > 0.5) {
      heldTailScroll.current = el.scrollTop;
      writeTimelineExtentSpace(el, needed);
      return;
    }
    heldTailScroll.current = null;
    writeTimelineExtentSpace(el, 0);
  }, [writeTimelineExtentSpace]);

  // The live turn is over: its reserve is handed over without moving a row.
  // Whatever blank the turn left under the tail becomes a held floor at the
  // reader's position, released only once nobody can see it; a tail already
  // on the composer edge has nothing below it to keep. A finger or a running
  // rewind owns the rows right now and defers the handover to the next safe
  // refresh, touch end or resting scroll.
  const handOverTurnTail = useCallback(() => {
    turnEndTimer.current = null;
    const el = ref.current;
    // A revert's glide releases reserve and floor itself.
    if (!el || revertPhaseRef.current !== null) return;
    if (touchActive.current || freshTurnPending.current || rewindMotionActive.current) {
      turnSettleDue.current = true;
      return;
    }
    turnSettleDue.current = false;
    readerSoftLock.current = false;
    const needed = el.clientHeight + el.scrollTop - timelineNaturalHeight(el);
    turnSheetPromptId.current = null;
    turnSheetStarted.current = false;
    resetTimelineExtent(el);
    // The floor replaces the reserve before layout is read again, so the
    // browser never clamps the reader's scroll in between.
    if (needed > 0.5) {
      heldTailScroll.current = el.scrollTop;
      writeTimelineExtentSpace(el, needed);
    }
    setTurnSheetPadding(0);
    expectedScrollTop.current = null;
    lastScrollTop.current = el.scrollTop;
    notePaintedLayout(el);
  }, [notePaintedLayout, resetTimelineExtent, setTurnSheetPadding, writeTimelineExtentSpace]);

  const syncTurnSheet = useCallback((alignPrompt = false) => {
    const el = ref.current;
    const promptId = turnSheetPromptId.current;
    if (!el || touchActive.current || !promptId) return;
    // The reserve is scoped to a live turn. Idle: the turn-end handover owns
    // the tail, so a resize must never re-seat an already finished turn on
    // the focus line. (A ref: this callback must not churn — and re-subscribe
    // the observers — on every status change.)
    const turnLive = turnLiveRef.current;
    if (!turnLive) return;
    // An optimistic echo anchors the sheet exactly like the canonical prompt
    // it stands in for, so the handover moves nothing.
    const prompt = sheetPromptRow(el, promptId);
    if (!prompt) {
      turnSheetPromptId.current = null;
      setTurnSheetPadding(0);
      return;
    }
    const visible = timelineVisibleArea(el);
    // Every fresh turn, including the first, reserves the distance from the
    // focus line to the visible bottom (the tail clearance already sits below
    // the last row), so the prompt can rest on the focus line. The reserve is
    // held for the live turn: new rows fill down into the view below the
    // prompt, and only once the tail reaches the composer edge does the view
    // follow it. A card below the tail (a pending approval) takes its height
    // out of that reserve: it hangs from the tail toward the composer, and
    // once it no longer fits (a keyboard-shortened viewport) it rests on the
    // composer edge.
    turnSheetBase.current = Math.max(0, timelineTurnReserve(visible) - timelineTailClearance(el));
    setTurnSheetPadding(Math.max(0, turnSheetBase.current - timelineTrailingHeight(el)));
    if (alignPrompt) {
      const port = el.getBoundingClientRect();
      const row = prompt.getBoundingClientRect();
      const desiredScrollTop = focusLineScrollTop({
        contentBottom: el.scrollTop + row.bottom - port.top,
        viewportTop: port.top,
        visibleTop: visible.top,
        visibleHeight: visible.height,
      });
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const target = Math.min(desiredScrollTop, maxScroll);
      if (Math.abs(el.scrollTop - target) >= 0.5) {
        expectedScrollTop.current = target;
        el.scrollTop = target;
      } else {
        expectedScrollTop.current = null;
      }
      lastScrollTop.current = el.scrollTop;
      notePaintedLayout(el);
    }
  }, [notePaintedLayout, setTurnSheetPadding]);

  // Ends the fresh-turn distortion window: cancels any pending safety timer,
  // then re-measures for real. Shared by the model.version handoff and by
  // the timer itself, so a slow-to-respond turn cannot leave stale geometry
  // (a keyboard that already opened or closed) applied indefinitely.
  const settleFreshTurn = useCallback(() => {
    if (freshTurnTimer.current !== null) {
      clearTimeout(freshTurnTimer.current);
      freshTurnTimer.current = null;
    }
    // A late or slow send entrance (a busy device starts it late)
    // is still transforming the prompt: its rect is not its layout. Measure
    // only once it has landed, however long that takes on this device.
    const el = ref.current;
    const ownerSession = sessionId;
    const promptId = turnSheetPromptId.current;
    const promptRow = el && promptId ? sheetPromptRow(el, promptId) : undefined;
    const flight = promptRow ? runningMotion(promptRow) : [];
    if (el && flight.length > 0) {
      freshTurnPending.current = true;
      if (!flightWait.current) {
        flightWait.current = true;
        void Promise.race([
          Promise.allSettled(flight.map((animation) => animation.finished)),
          new Promise((resolve) => setTimeout(resolve, FLIGHT_WAIT_LIMIT_MS)),
        ]).then(() => {
          flightWait.current = false;
          if (ref.current === el && observedPrompt.current.sessionId === ownerSession) settleRef.current();
        });
      }
      return;
    }
    freshTurnPending.current = false;
    if (touchActive.current) return;
    // A lift animates rows by transform; measuring the sheet against those
    // rects would reserve the wrong tail.
    if (!liftBusy.current && !rewindMotionActive.current) syncTurnSheet();
    if (atBottom.current) {
      setShowJump(false);
      scrollToTail();
    }
  }, [sessionId, syncTurnSheet, scrollToTail]);

  const settleRef = useRef(settleFreshTurn);
  settleRef.current = settleFreshTurn;

  const armFreshTurnTimer = useCallback(() => {
    if (freshTurnTimer.current !== null) clearTimeout(freshTurnTimer.current);
    freshTurnTimer.current = setTimeout(settleFreshTurn, FRESH_TURN_DISTORTION_MS);
  }, [settleFreshTurn]);

  // Session changes restore their saved anchor. A later, monotonically newer
  // user event in the SAME session starts a fresh sheet and deliberately takes
  // focus away from whatever older reading position was held.
  useLayoutEffect(() => {
    const latestSeq = latestUserMessage?.eventSeq ?? 0;
    if (observedPrompt.current.sessionId !== sessionId) {
      observedPrompt.current = { sessionId, seq: latestSeq };
      resetTimelineExtent();
      turnSheetPromptId.current = null;
      turnSheetOwnerEcho.current = false;
      setTurnSheetPadding(0);
      freshTurnPending.current = false;
      followUpSendRef.current = false;
      return;
    }
    if (!latestUserMessage || latestSeq <= observedPrompt.current.seq) return;
    observedPrompt.current = { sessionId, seq: latestSeq };
    // The DOM identity changes at admission, but the first streamed row
    // must still lift from the echo's last painted position.
    const painted = paintedLayout.current;
    const echo = painted?.tail;
    const canonical = ref.current ? sheetPromptRow(ref.current, latestUserMessage.id) : null;
    if (painted && echo?.hasAttribute("data-pending-send") && !echo.isConnected && canonical) {
      const offset = painted.offsets.get(echo);
      if (offset !== undefined) painted.offsets.set(canonical, offset);
      painted.tail = canonical;
    }
    // The optimistic echo and canonical prompt are one visual row: hand the
    // sheet over in place. Re-aligning would re-center a row whose meta line
    // just appeared under it, nudging the very prompt the reader is watching.
    // While the send entrance is still active, never measure at all.
    if (turnSheetPromptId.current !== null && turnSheetOwnerEcho.current) {
      turnSheetPromptId.current = latestUserMessage.id;
      turnSheetOwnerEcho.current = false;
      if (!readerDetached.current && !freshTurnPending.current && !liftBusy.current && !rewindMotionActive.current && !touchActive.current) {
        syncTurnSheet();
      }
      return;
    }
    if (followUpSendRef.current) {
      followUpSendRef.current = false;
      turnSheetPromptId.current = null;
      setTurnSheetPadding(0);
      scrollToTail();
      return;
    }
    cancelTurnEndMotion();
    turnSheetStarted.current = false;
    resetTimelineExtent();
    readerIntent.current = null;
    scrollbarPointer.current = false;
    readerDetached.current = false;
    readerSoftLock.current = false;
    atBottom.current = true;
    setShowJump(false);
    turnSheetOwnerEcho.current = false;
    turnSheetPromptId.current = latestUserMessage.id;
    syncTurnSheet(true);
  }, [sessionId, latestUserMessage?.id, latestUserMessage?.eventSeq, cancelTurnEndMotion, resetTimelineExtent, setTurnSheetPadding, syncTurnSheet, scrollToTail]);

  // A session that opens mid-turn lands in the live layout in its first frame:
  // its prompt owns the reserve, so a fold at the tail never clamps the view,
  // and its tail rests on the composer edge, from where the turn keeps
  // filling down. Idle sessions and saved reading positions land as before.
  useLayoutEffect(() => {
    const el = ref.current;
    const prompt = latestUserMessage;
    if (!el || !prompt || !atBottom.current || model.turn?.status !== "working") return;
    turnSheetPromptId.current = prompt.id;
    turnSheetStarted.current = true;
    syncTurnSheet();
    const reserve = turnSheetPadding.current;
    if (turnSheetPromptId.current === null || reserve <= 0) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const target = Math.max(0, maxScrollTop - reserve);
    if (Math.abs(el.scrollTop - target) >= 0.5) {
      expectedScrollTop.current = target;
      el.scrollTop = target;
    }
    lastScrollTop.current = el.scrollTop;
    notePaintedLayout(el);
    // The prompt and turn status are read for the landing commit only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // A hidden resend has no DOM prompt to own a fresh-turn sheet. Leaving the
  // previous visible prompt as the owner makes each streamed resize mutate an
  // unrelated spacer; on touch WebKit this can wedge the overflow scroller.
  // Release only on a live false -> true edge so reload/session restoration
  // keeps its saved reader anchor intact.
  useLayoutEffect(() => {
    const previous = observedHiddenPrompt.current;
    if (previous.sessionId !== sessionId) {
      observedHiddenPrompt.current = { sessionId, hidden: model.lastUserMessageHidden };
      return;
    }
    const becameHidden = !previous.hidden && model.lastUserMessageHidden;
    observedHiddenPrompt.current = { sessionId, hidden: model.lastUserMessageHidden };
    if (!becameHidden) return;
    cancelTurnEndMotion();
    turnSheetStarted.current = false;
    // A held tail from the previous turn is adopted by the live ratchet
    // (updateTimelineExtent); dropping it here would lower every row at once.
    if (heldTailScroll.current === null) resetTimelineExtent();
    turnSheetPromptId.current = null;
    freshTurnPending.current = false;
    followUpSendRef.current = false;
    expectedScrollTop.current = null;
    if (!touchActive.current) setTurnSheetPadding(0);
  }, [sessionId, model.lastUserMessageHidden, cancelTurnEndMotion, resetTimelineExtent, setTurnSheetPadding]);

  // A submitted prompt opens its fresh-turn sheet the moment it is submitted,
  // not when admission returns. The canonical row inherits the same sheet with
  // identical geometry moments later, so the reader sees one settle, not two.
  // Follow-ups into a live turn stay at the tail: the echo (and then the
  // activity dock) appear in place instead of jumping the transcript away.
  useLayoutEffect(() => {
    if (observedPendingSend.current === newestPendingSendId) return;
    observedPendingSend.current = newestPendingSendId;
    if (!newestPendingSendId) return;
    cancelTurnEndMotion();
    // chatMotion's send FLIP measures the rows right after this commit: a
    // settle or lift still translating them would skew that measurement, so
    // they land now — the send captured their visual pixels at submit.
    cancelTimelineLift();
    liftBusy.current = false;
    turnSheetStarted.current = false;
    resetTimelineExtent();
    const liveFollowUp = newestPendingDelivery === "steer" || newestPendingDelivery === "interrupt"
      || model.turn?.status === "working"
      || model.turn?.status === "aborted";
    readerIntent.current = null;
    scrollbarPointer.current = false;
    readerDetached.current = false;
    readerSoftLock.current = false;
    atBottom.current = true;
    setShowJump(false);
    if (liveFollowUp) {
      followUpSendRef.current = true;
      turnSheetPromptId.current = null;
      turnSheetOwnerEcho.current = false;
      setTurnSheetPadding(0);
      scrollToTail();
      freshTurnPending.current = true;
      armFreshTurnTimer();
      return;
    }
    followUpSendRef.current = false;
    turnSheetPromptId.current = newestPendingSendId;
    turnSheetOwnerEcho.current = true;
    syncTurnSheet(true);
    // The scroll is now correct. Suppress refresh() until the first
    // model.version bump so chatMotion's FLIP transforms cannot override it
    // — but only for up to FRESH_TURN_DISTORTION_MS; see armFreshTurnTimer.
    freshTurnPending.current = turnSheetPromptId.current !== null;
    if (freshTurnPending.current) armFreshTurnTimer();
  }, [newestPendingSendId, newestPendingDelivery, model.turn?.status, cancelTurnEndMotion, resetTimelineExtent, syncTurnSheet, scrollToTail, setTurnSheetPadding, armFreshTurnTimer]);

  // Model commits cover durable/streamed rows. Resize observation additionally
  // covers local disclosure animation and streamed text renders, so an open
  // live action cannot grow underneath the composer/status dock.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A model.version bump after a fresh turn ends the FLIP distortion window,
    // but never before that flight could finish: a rewind replacement streams
    // its own bookkeeping events while the prompt is still rising, and
    // measuring it mid-flight raised the sheet and threw the prompt to the
    // top. The pending timer settles exactly at the end of the window.
    if (freshTurnPending.current && (freshTurnTimer.current !== null || flightWait.current)) return;
    settleFreshTurn();
  }, [model.version, settleFreshTurn]);

  // A completed turn no longer owns its reserve. After a short beat (late
  // footers and the final status land first) it is handed over in place:
  // the reader's rows never move at the end of a turn.
  useLayoutEffect(() => {
    if (model.turn?.status === "working") {
      turnSheetStarted.current = true;
      cancelTurnEndMotion();
      return;
    }
    if (pendingSends.length > 0) return;
    // Hand over whenever this session still owns any live-turn tail state,
    // even when the turn never reported "working" (a fast reply) or its prompt
    // row already left.
    const ownsTail = turnSheetPromptId.current !== null
      || turnSheetStarted.current
      || turnSheetPadding.current > 0
      || timelineExtentSpace.current > 0;
    if (!ownsTail || turnEndTimer.current !== null || turnSettleDue.current) return;
    // Motion off: the handover is one instant, coherent commit, no timer.
    if (timelineLiftMotionDisabled()) {
      handOverTurnTail();
      return;
    }
    turnEndTimer.current = setTimeout(() => {
      turnEndTimer.current = null;
      if (!turnLiveRef.current) handOverTurnTail();
    }, TURN_END_SETTLE_WAIT_MS);
  }, [model.turn?.status, model.turn?.turnId, pendingSends.length, cancelTurnEndMotion, handOverTurnTail]);

  // Revert & edit is model-driven. The click only marks the intent: no row
  // moves or fades before the server confirms. The commit that applies the
  // confirmed marker (WS or request, whichever lands first) keeps the cut rows
  // in their slots — same keys, no remount — and lets them fade out together;
  // one commit then removes them while the survivors glide to the composer
  // edge; only then do the marker and the restored draft appear. Motion off:
  // no intent is recorded and the confirming commit is the whole change.
  const revertPhase: "leaving" | "gliding" | null = (() => {
    const exit = revertExit;
    const rewind = model.rewind;
    if (!exit || exit.sessionId !== sessionId || !rewind || rewind.atSeq !== exit.atSeq) return null;
    if (exit.markerSeq !== null && exit.markerSeq !== rewind.markerSeq) return null;
    return exit.phase === "confirming" ? "leaving" : exit.phase;
  })();
  revertPhaseRef.current = revertPhase;
  useLayoutEffect(() => {
    // A rewind resolved elsewhere (restore, replacement, another client) ends
    // a started choreography; its rows are already gone from the model.
    const exit = revertExitRef.current;
    if (revertPhase !== null || exit === null || exit.phase === "confirming") return;
    if (revertExitTimer.current !== null) {
      clearTimeout(revertExitTimer.current);
      revertExitTimer.current = null;
    }
    revertGlideRows.current = null;
    revertDraft.current = null;
    setRevertChoreography(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revertPhase]);
  useLayoutEffect(() => {
    const exit = revertExitRef.current;
    const markerSeq = model.rewind?.markerSeq;
    if (revertPhase !== "leaving" || exit?.phase !== "confirming" || markerSeq === undefined) return;
    const leaving: RevertExit = { ...exit, markerSeq, phase: "leaving" };
    setRevertChoreography(leaving);
    revertExitTimer.current = setTimeout(() => {
      revertExitTimer.current = null;
      if (revertExitRef.current !== leaving) return;
      // Capture where the survivors are painted before the removal commit.
      const el = ref.current;
      revertGlideRows.current = el && !timelineLiftMotionDisabled() ? captureTimelineLiftRows(el) : null;
      flushSync(() => setRevertChoreography({ ...leaving, phase: "gliding" }));
    }, REWIND_EXIT_MS);
    // setRevertChoreography only touches a ref and a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revertPhase, model.rewind?.markerSeq]);
  useLayoutEffect(() => {
    const el = ref.current;
    const exit = revertExitRef.current;
    if (revertPhase !== "gliding" || !el || !exit) return;
    const rows = revertGlideRows.current;
    revertGlideRows.current = null;
    // The cut is the reader's new tail and nothing live owns it any more:
    // follow it, drop reserve, floor and any owed settle, and write the
    // canonical scroll before the FLIP (downward travel is allowed here).
    cancelTurnEndMotion();
    readerIntent.current = null;
    readerDetached.current = false;
    readerSoftLock.current = false;
    atBottom.current = true;
    setShowJump(false);
    turnSheetPromptId.current = null;
    turnSheetOwnerEcho.current = false;
    turnSheetStarted.current = false;
    setTurnSheetPadding(0);
    resetTimelineExtent(el);
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - target) >= 0.5) {
      expectedScrollTop.current = target;
      el.scrollTop = target;
    } else {
      expectedScrollTop.current = null;
    }
    lastScrollTop.current = el.scrollTop;
    notePaintedLayout(el);
    const finish = () => {
      liftBusy.current = timelineLiftRunning(el);
      if (revertExitRef.current !== exit) return;
      setRevertChoreography(null);
      const draft = revertDraft.current;
      revertDraft.current = null;
      if (draft) applyRewindDraftRef.current(draft);
    };
    if (rows !== null && rows.length > 0
      && playTimelineLift(rows, finish, { durationMs: REWIND_GLIDE_MS, easing: TIMELINE_SETTLE_EASE })) {
      liftBusy.current = true;
      return;
    }
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revertPhase]);
  useEffect(() => () => {
    if (revertExitTimer.current !== null) clearTimeout(revertExitTimer.current);
    if (turnEndTimer.current !== null) clearTimeout(turnEndTimer.current);
  }, [sessionId]);
  // Restore and regenerate (rewindMotion.ts): settle in the very commit that
  // renders the new canonical state — after the canonical scroll and before
  // paint — so surviving rows glide from their previous pixels.
  const pendingRewind = pendingRewindMotion();
  const echoIds = pendingSends.map((send) => send.id);
  const echoKey = echoIds.join(" ");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pending = pendingRewindMotion();
    if (pending?.kind === "restore" && pending.sessionId === sessionId && model.rewind === null && atBottom.current) {
      // The restored tail rests on the composer edge: canonical scroll first,
      // then the FLIP below measures from it (no scroll snap).
      resetTimelineExtent(el);
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - target) >= 0.5) {
        expectedScrollTop.current = target;
        el.scrollTop = target;
      }
      lastScrollTop.current = el.scrollTop;
    }
    const settled = settleRewindMotion(el, {
      sessionId,
      rewindAtSeq: model.rewind?.atSeq ?? null,
      echoIds,
    });
    if (!settled) {
      if (!pendingRewindMotion()) rewindMotionActive.current = false;
      return;
    }
    rewindMotionActive.current = true;
    void settled.then(() => {
      if (ref.current !== el) return;
      rewindMotionActive.current = false;
      if (touchActive.current) return;
      // The reflow already started from the canonical scroll position. Only
      // remeasure the sheet here; a second tail scroll would visibly snap the
      // transcript at the end of the animation.
      syncTurnSheet();
    });
    // echoIds is represented by echoKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, model.rewind?.markerSeq, model.rewind?.atSeq, echoKey, syncTurnSheet, resetTimelineExtent]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const refresh = () => {
      // While fresh-turn FLIP transforms distort getBoundingClientRect(),
      // or while a finger owns native scrolling, skip geometry writes. The
      // touch-end settle below catches up after WebKit releases the gesture.
      if (freshTurnPending.current || touchActive.current) return;
      // A lift animates rows by transform; measuring the sheet against those
      // rects would reserve the wrong tail. The numeric tail follow below is
      // transform-independent, so growth still tracks while the lift plays.
      if (!liftBusy.current && !rewindMotionActive.current) syncTurnSheet();
      if (!atBottom.current) {
        // A detached reader's row stays where they are reading it. Jump to
        // latest tracks whether anything is hidden below: layout can clamp
        // them to the end (no scroll event left to fire) or grow rows past
        // the composer edge without them moving.
        holdReaderAnchor(el);
        setShowJump(!timelineTailRevealed(el));
        return;
      }
      // A turn-end release owed while the reader was away is paid on return.
      if (turnSettleDue.current) handOverTurnTail();
      else scrollToTail();
    };
    let frame = 0;
    // Streaming tokens mutate text nodes and nested markdown many times a
    // second: those coalesce into one refresh per frame, still before paint.
    const schedule = () => {
      if (frame || document.visibilityState === "hidden") return;
      frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    };
    // Layout changes are compensated in the frame that produced them. A
    // ResizeObserver callback runs after layout and before paint, so deferring
    // its refresh would move a reader's row for one frame.
    const refreshNow = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      refresh();
    };
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(refreshNow) : null;
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
    const mutations = typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
        // Character changes and nested markdown mutations do not change the
        // set of timeline rows. Avoid walking every row on every token.
        const rowsChanged = records.some((record) => record.type === "childList" && record.target === el);
        if (rowsChanged) observeRows();
        // Row insertion/removal and class/open/aria-expanded changes can move
        // layout; only token-level churn is deferred to the frame.
        if (rowsChanged || records.some((record) => record.type === "attributes")) refreshNow();
        else schedule();
      })
      : null;
    mutations?.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "open", "aria-expanded"],
    });
    // Composer/status geometry changes outside the scrollport can clamp native
    // scrollTop before its ResizeObserver runs. Refresh in the mutation microtask
    // so the sheet and follow position settle together before the next paint.
    const dock = el.closest(".focus-conversation")?.querySelector(".conversation-composer-dock");
    if (dock) mutations?.observe(dock, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    document.addEventListener("visibilitychange", schedule);
    return () => {
      document.removeEventListener("visibilitychange", schedule);
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations?.disconnect();
      // A session switch must not let a previous turn's safety timer fire
      // into the newly mounted session's (already-reset) refs.
      if (freshTurnTimer.current !== null) {
        clearTimeout(freshTurnTimer.current);
        freshTurnTimer.current = null;
      }
    };
    // Stable callbacks: turn status reaches them through refs, so a status
    // change never re-subscribes these observers.
  }, [sessionId, scrollToTail, syncTurnSheet, handOverTurnTail, holdReaderAnchor]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteReaderIntent = (direction: "toward-history" | "toward-tail") => {
    // One physical gesture can deliver several scroll events (wheel momentum,
    // touch inertia, scrollbar drag). Keep its direction briefly, but never
    // infer intent from geometry alone: reflow emits the same scroll event.
    readerIntent.current = { direction, until: Date.now() + 700 };
  };

  // The tail is fully visible above blank runway that a live (or not yet
  // settled) turn owns. A completed short chat's held floor is not runway:
  // its reader detaches as before.
  const liveTailRevealed = (el: HTMLElement) =>
    (turnLiveRef.current || turnSettleDue.current || turnEndTimer.current !== null || turnSheetPadding.current > 0)
    && timelineTailRevealed(el);

  const stopFollowing = () => {
    const el = ref.current;
    if (!el || el.scrollHeight - el.clientHeight <= TIMELINE_TAIL_EPSILON) return;
    noteReaderIntent("toward-history");
    expectedScrollTop.current = null;
    readerDetached.current = true;
    atBottom.current = false;
    // With the tail in view the gesture may only soft-lock, or reveal
    // nothing hidden (input arrives before the browser scrolls); its scroll
    // event decides, so the control does not flash in between.
    if (timelineTailRevealed(el)) return;
    setShowJump(true);
  };

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    // Momentum after the finger lifted: the gesture still owns the scroll.
    if (touchActive.current) {
      touchScrolled.current = true;
      if (touchRestTimer.current !== null) armTouchRest();
    }
    const delta = el.scrollTop - lastScrollTop.current;
    if (scrollbarPointer.current && delta < -0.25) stopFollowing();
    else if (scrollbarPointer.current && delta > 0.25) noteReaderIntent("toward-tail");
    const lease = readerIntent.current;
    const intent = lease !== null && lease.until >= Date.now() ? lease.direction : null;
    if (lease !== null && intent === null) readerIntent.current = null;
    // Momentum after the finger or wheel stops is still the same gesture:
    // scrolling on in its direction keeps the lease, so inertia that carries
    // a reader into the tail reconnects instead of stranding the control.
    if (intent === "toward-tail" && delta > 0.25) noteReaderIntent("toward-tail");
    else if (intent === "toward-history" && delta < -0.25) noteReaderIntent("toward-history");
    const programmatic = intent === null && expectedScrollTop.current !== null
      && Math.abs(el.scrollTop - expectedScrollTop.current) < 1;
    expectedScrollTop.current = null;
    // A followed transcript whose extent shrank under the view is clamped by
    // the browser to the new end, not moved by the reader. Re-assert the
    // canonical position (the floor holds it during a live turn) in this same
    // scroll step, before the clamp can be painted.
    const clamped = !programmatic && intent === null && atBottom.current && !touchActive.current
      && el.scrollTop < lastScrollTop.current - 0.5
      && Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 1;
    if (clamped) {
      scrollToTail();
      return;
    }
    if (!programmatic) {
      const distanceFromEnd = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
      const next = timelineFollowState({
        scrollTop: el.scrollTop,
        previousScrollTop: lastScrollTop.current,
        distanceFromEnd,
        readerDetached: readerDetached.current,
        readerIntent: intent,
        tailRevealed: liveTailRevealed(el),
        softLocked: readerSoftLock.current,
      });
      const reattached = next.following && !atBottom.current;
      readerDetached.current = next.readerDetached;
      readerSoftLock.current = next.softLocked;
      atBottom.current = next.following;
      // Detached with the whole tail visible: nothing to jump to.
      setShowJump(next.showJump && !timelineTailRevealed(el));
      // The reader moved: the row they now read is the new anchor, and what
      // they see now is the layout a later lift starts from. Layout that moved
      // the transcript from above meanwhile (nothing anchored it under a
      // finger) is what they saw, so the held geometry moves with it first.
      foldLayoutShift(el);
      captureReaderAnchor(el);
      if (reattached || !paintedLayout.current) notePaintedLayout(el);
      else paintedLayout.current.scroll = el.scrollTop;
    }
    lastScrollTop.current = el.scrollTop;
    // Scroll-up lazy loading: nearing the top with every cached row already
    // rendered pulls the next page of older history from the server.
    if (el.scrollTop < 160 && canLoadOlder && start === 0 && !olderBusy) void loadOlder();
    if (sessionId === null) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const now = ref.current;
      if (now) saveTimelineAnchor(sessionId, captureTimelineAnchor(now, atBottom.current));
      // A handover a finger deferred is paid once the scroll has come to rest.
      if (turnSettleDue.current) handOverTurnTail();
      else if (now) trimHeldTail(now);
    }, 200);
  };

  // A finger owns the scroll until it has come to rest, not until it lifts:
  // touch WebKit keeps gliding on its own (momentum), and a scroll write in
  // that glide stops it dead or jumps it. Each momentum scroll re-arms the
  // rest timer; only then does follow catch up.
  const releaseTouch = useCallback(() => {
    touchRestTimer.current = null;
    touchActive.current = false;
    if (turnSheetPromptId.current === null && turnSheetPadding.current > 0) setTurnSheetPadding(0);
    else syncTurnSheet();
    if (turnSettleDue.current) handOverTurnTail();
    else if (atBottom.current) scrollToTail();
    if (atBottom.current) setShowJump(false);
  }, [handOverTurnTail, scrollToTail, setTurnSheetPadding, syncTurnSheet]);
  const armTouchRest = useCallback(() => {
    if (touchRestTimer.current !== null) clearTimeout(touchRestTimer.current);
    touchRestTimer.current = setTimeout(releaseTouch, TOUCH_SCROLL_REST_MS);
  }, [releaseTouch]);
  const finishTouchScroll = useCallback(() => {
    touchY.current = null;
    touchEndCleanup.current?.();
    touchEndCleanup.current = null;
    if (!touchActive.current || touchRestTimer.current !== null) return;
    // A tap moved nothing: its own layout change (a card answered under the
    // finger) must go through the ordinary refresh at once.
    if (!touchScrolled.current) {
      touchActive.current = false;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (!touchActive.current) releaseTouch(); });
      else releaseTouch();
      return;
    }
    armTouchRest();
  }, [armTouchRest, releaseTouch]);
  useEffect(() => () => {
    if (touchRestTimer.current !== null) clearTimeout(touchRestTimer.current);
    touchRestTimer.current = null;
    touchEndCleanup.current?.();
    touchEndCleanup.current = null;
  }, [sessionId]);

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
  // as text while the invoking icon supplies the visual confirmation. Identical
  // repeats get an invisible nudge so assistive tech re-announces them.
  const [liveText, setLiveText] = useState("");
  const liveRef = useRef("");
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((text: string, _anchor?: ActionAnnounceAnchor) => {
    liveRef.current = text === liveRef.current ? `${text}\u00a0` : text;
    setLiveText(liveRef.current);
    clearTimeout(liveTimer.current);
    // The live text is cleared after the announcement has been delivered; the
    // region itself stays mounted so the next announcement still fires.
    liveTimer.current = setTimeout(() => setLiveText(""), 4000);
  }, []);
  useEffect(() => () => clearTimeout(liveTimer.current), []);
  applyRewindDraftRef.current = (draft) => {
    const seed = {
      text: draft.text,
      ...(draft.attachments && draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
    };
    applyComposerSeed(draft.sessionId, rewindSeedKey(draft.markerSeq), seed);
    // The live composer, announcement and focus belong to the open session.
    if (draft.sessionId !== sessionId) return;
    requestComposerReplace(draft.text);
    announce(tr("timeline.rewindReady"));
    requestAnimationFrame(() => {
      if (typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) {
        focusComposer();
        return;
      }
      const control = ref.current?.querySelector<HTMLElement>(".rewind-marker-peek")
        ?? ref.current?.querySelector<HTMLElement>(".rewind-marker-restore");
      control?.focus({ preventScroll: true });
    });
  };

  // Truthful eligibility: guards derive from the live render
  // model plus the authoritative queue; the server re-validates inside the
  // per-session lock, so a raced action returns a typed conflict, not a lie.
  const archived = session?.status === "archived";
  // The assistant identity panel is a completed-turn artifact: while the
  // runtime is actively generating (or paused mid-turn on a request) no
  // answer shows any metadata row, and the panel appears once the turn
  // completes. A turn stranded by an unclear session state (unknown /
  // reconciling / idle without a stop) still counts as completed and shows
  // the panel.
  const sessionStatus = session?.status;
  const isolated = session?.isolation?.kind === "git-worktree";
  // A prompt in flight already ends the previous turn's "completed" state: its
  // answer loses the identity panel at send (inside the send motion) instead
  // of flashing it between an interrupt's abort and the replacement's start.
  const sessionActive = sessionStatus === "working" || sessionStatus === "waiting" || pendingSends.length > 0;
  // Paginated hydration caches only the newest window; true while the server
  // still holds events OLDER than the cached window (primitive selector, so
  // streamed appends don't re-render the shell through this subscription).
  const canLoadOlder = useStore((s) => {
    if (sessionId === null) return false;
    const list = s.events[sessionId];
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
  const revertPendingRef = useRef<string | null>(null);
  const [revertPendingSession, setRevertPendingSession] = useState<string | null>(null);
  useEffect(() => {
    if (revertPendingRef.current !== null && revertPendingRef.current !== sessionId) {
      revertPendingRef.current = null;
      setRevertPendingSession(null);
    }
  }, [sessionId]);
  // model.queueVersion bumps only on queue-affecting events, so this REST
  // read runs per session switch / queue change — not per streamed chunk.
  useEffect(() => {
    if (!sessionId) { setQueuedCount(0); return; }
    let cancelled = false;
    void api.queueList(sessionId).then((items) => { if (!cancelled) setQueuedCount(items.length); });
    return () => { cancelled = true; };
  }, [sessionId, model.queueVersion]);
  const sessionBlocked = sessionStatus === "unknown"
    || sessionStatus === "reconciling"
    || sessionStatus === "epoch-pending";
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
  const deriveRows = useRef(createTimelineDerivation());
  const derived = useMemo(() => deriveRows.current(model, prefs.thinkingDisplayMode, prefs.actionGrouping,
    (message) => !message.undone && !blankAssistant(message)), [model, prefs.thinkingDisplayMode, prefs.actionGrouping]);
  const visibleMessages = derived.messages;
  // Between admission and `turn/started` the newest prompt already owns a
  // turn in progress, so no completed-turn panel may flash on the answer
  // above it while the session status catches up.
  const newestVisible = visibleMessages.at(-1);
  const promptAwaitingTurn = newestVisible?.kind === "user"
    && (turn?.startedAt === undefined || turn.startedAt < newestVisible.time);
  const turnInProgress = sessionActive || promptAwaitingTurn;
  // Only what the ACTIVE marker hid is reversible. Tails of earlier,
  // already-replaced rewinds stay on disk but are never offered again.
  const rewoundMessages = useMemo(() => {
    const markerSeq = model.rewind?.markerSeq;
    if (markerSeq === undefined) return [];
    return model.messages.filter((message) =>
      message.undone && message.rewindMarkerSeq === markerSeq && !blankAssistant(message) && !openQuestion(message));
  }, [derived.epoch]);
  const visibleRows = derived.rows;
  const rewoundRows = useMemo(
    () => groupActivity(mergeThinking(rewoundMessages), prefs.thinkingDisplayMode, prefs.actionGrouping),
    [prefs.actionGrouping, prefs.thinkingDisplayMode, rewoundMessages],
  );
  // While a confirmed revert's rows fade out they stay in the rendered list
  // exactly as before the confirmation. The cut is a user-prompt boundary, so
  // the two groupings meet without merging: ids and keys are unchanged,
  // nothing remounts, nothing moves.
  const leavingAtSeq = revertPhase === "leaving" && rewoundRows.length > 0 ? model.rewind?.atSeq ?? null : null;
  const renderedMessages = useMemo(
    () => leavingAtSeq !== null ? [...visibleMessages, ...rewoundMessages] : visibleMessages,
    [leavingAtSeq, rewoundMessages, visibleMessages],
  );
  const rows = useMemo(
    () => leavingAtSeq !== null ? [...visibleRows, ...rewoundRows] : visibleRows,
    [leavingAtSeq, rewoundRows, visibleRows],
  );
  const hiddenRanges = useMemo(() => rewoundRanges(model.messages), [derived.epoch]);
  // Package timeline facts of the leaving cut leave with its rows.
  const renderedHiddenRanges = leavingAtSeq !== null
    ? hiddenRanges.filter(([, markerSeq]) => markerSeq !== model.rewind?.markerSeq)
    : hiddenRanges;
  const suppressRewindMarker = (pendingRewind?.kind === "regenerate" && pendingRewind.sessionId === sessionId)
    || revertPhase !== null;
  const renderRewindRow = (row: ActivityGroup | RenderMessage) => row.kind === "activity"
    ? <ActivityRow
        key={row.id}
        rev={activityRev(row)}
        g={row}
        subagents={model.subagents}
        livePresentation={false}
        sessionId={sessionId}
        resourceContext={resourceContext}
      />
    : <MessageRow
        key={row.id}
        rev={row.rev ?? 0}
        m={row}
        announce={announce}
        sessionId={sessionId}
        resourceContext={resourceContext}
      />;
  // A soft rewind never stops the turn it hid. The marker says so, and the
  // activity dock above the composer keeps showing that work with its Stop,
  // so the transcript itself stays calm while the prompt is being edited.
  const rewindRunning = model.rewind !== null && turnWorking;
  // One identity panel per completed turn, on the turn's terminal answer only.
  // The terminal answer is the last assistant message before the next prompt
  // (or the log tail); the map also records the opening prompt time so the
  // panel's duration stays truthful when the turn state is no longer in the
  // store. While the session is actively working no answer shows any metadata
  // row; panels appear once the turn completes.
  // Answers closed by a later prompt keep their footer's box through the next
  // turn (dormant: invisible while it works). Removing every completed footer
  // while a turn ran reflowed the whole transcript at each send and again at
  // each turn end. Only the trailing answer waits, unless a sent prompt
  // already closes it.
  const terminalAnswers = useMemo(() => {
    const terminal = new Map<number, number>();
    let openAt = 0;
    let openSeq = -1;
    let lastAssistant: AssistantMsg | null = null;
    for (const message of renderedMessages) {
      if (message.kind === "user" || message.kind === "github-conflict" || message.kind === "notice") {
        if (lastAssistant !== null) terminal.set(lastAssistant.eventSeq, openAt);
        lastAssistant = null;
        openAt = message.time;
        openSeq = message.eventSeq;
      } else if (message.kind === "assistant") {
        lastAssistant = message;
      }
    }
    if (lastAssistant !== null) terminal.set(lastAssistant.eventSeq, openAt);
    // Rows after `openSeq` belong to the newest (possibly still live) turn.
    return { terminal, trailing: lastAssistant?.eventSeq, openSeq };
  }, [derived.epoch, leavingAtSeq, rewoundMessages.length, visibleMessages.length]);
  const prompts = useMemo(() => promptIndex(visibleMessages), [derived.epoch]);
  const latestPending = pendingSends[pendingSends.length - 1];
  const latestPrompt: PromptBookmarkTarget | null = latestPending
    ? {
        id: latestPending.id,
        preview: promptBookmarkPreview(latestPending.text),
      }
    : (() => {
        const prompt = prompts[prompts.length - 1];
        if (!prompt) return null;
        const preview = promptBookmarkPreview(prompt.text);
        return {
          id: prompt.id,
          preview,
        };
      })();
  const latestPromptId = latestPrompt?.id ?? null;

  // An unloaded older tail is enough reason to mount the navigator: the rail's
  // load arrow is the only discoverable way to reach prompts outside the
  // initial event page when fewer than three prompts are cached.
  // When the bookmark is on for narrow windows only, the rail is its wide-window
  // form, so it keeps that history reachable there even before the third prompt.
  const showBookmark = prefs.pinLatestPrompt || prefs.promptBookmarkDesktop;
  const showNav = prefs.promptNavigator === "on"
    || (prefs.promptNavigator === "auto" && (prompts.length >= 3 || canLoadOlder
      || (prefs.pinLatestPrompt && !prefs.promptBookmarkDesktop && prompts.length > 0)));
  // Regenerate replaces the turn from the user prompt that produced each answer. One forward
  // pass — never a reverse scan per assistant row per streaming render.
  const regenerateSources = useMemo(() => {
    const bySeq = new Map<number, { eventSeq: number; text: string; attachments?: UserMsg["attachments"] }>();
    let lastUserMessage: UserMsg | undefined;
    for (const message of renderedMessages) {
      if (message.kind === "user") lastUserMessage = message;
      else if (message.kind === "github-conflict") lastUserMessage = undefined;
      else if (message.kind === "assistant" && lastUserMessage) {
        bySeq.set(message.eventSeq, {
          eventSeq: lastUserMessage.eventSeq,
          text: lastUserMessage.raw ?? lastUserMessage.text,
          ...(lastUserMessage.attachments?.length ? { attachments: lastUserMessage.attachments } : {}),
        });
      }
    }
    return bySeq;
  }, [derived.epoch, leavingAtSeq, rewoundMessages.length, visibleMessages.length]);
  const turnBroken = turn && (turn.status === "failed" || turn.status === "aborted");
  // A pending switch already points at its target, so the notice goes the
  // moment the user picks another harness, not only once the handoff lands.
  const currentHarnessId = useStore((s) => {
    const session = sessionId ? s.sessions.find((candidate) => candidate.id === sessionId) : undefined;
    return session?.harnessTransition?.targetHarnessId ?? session?.resolvedHarnessId ?? null;
  });
  const transientTurnKey = transientTurnNoticeKey(sessionId, turn ?? null, currentHarnessId);
  const shownTurnKey = useRef<string | null>(null);
  // A rewound prompt is not the one a failed turn would retry.
  const lastPromptBoundary = useMemo(() => model.messages.findLast((message) => !message.undone
    && (message.kind === "user" || message.kind === "github-conflict")), [derived.epoch]);
  const lastUser = lastPromptBoundary?.kind === "user" ? lastPromptBoundary : undefined;
  // Package fences in an answer read the user message that followed it
  // (MarkdownFenceContext.reply). Rows read the store during this render;
  // the effect reaches memoized rows that did not re-render.
  const [fenceReplies] = useState(createConversationReplies);
  // The epoch alone misses appended messages and rewinds; one O(n) pass.
  const replyMap = useMemo(() => followingReplies(model.messages), [derived.epoch, model.messages.length, rewoundMessages.length]);
  fenceReplies.replace(replyMap);
  useLayoutEffect(() => { fenceReplies.notify(); }, [fenceReplies, replyMap]);
  // Ordinary turn failures use the one host-owned transient surface. User
  // aborts are intentional and stay silent; rate limits remain inline because
  // their resume/cancel state outlives a toast.
  useEffect(() => {
    if (companion || !transientTurnKey || !turn || turn.status !== "failed") return;
    const detail = turn.error ? shortMessage(turn.error) : "";
    const message = detail
      ? `${tr("timeline.lastTurnFailed")}: ${detail}`
      : tr("timeline.lastTurnFailed");
    setUiError(
      message,
      lastUser && sessionId ? {
        label: tr("common.retry"),
        run: () => {
          void sendMessage(lastUser.raw ?? lastUser.text, undefined, undefined, {
            targetSessionId: sessionId,
            hiddenUserMessage: true,
            ...(lastUser.attachments?.length ? { attachments: lastUser.attachments } : {}),
          });
        },
      } : null,
      transientTurnKey,
    );
  }, [companion, transientTurnKey, turn, lastUser, sessionId]);
  // Withdraw this session's visible notice once it stops applying (harness
  // switch, new turn). Leaving the session keeps it, as before.
  useEffect(() => {
    const previous = shownTurnKey.current;
    shownTurnKey.current = transientTurnKey;
    if (previous && previous !== transientTurnKey && previous.startsWith(`${sessionId}:`)) dismissUiError(previous);
  }, [transientTurnKey, sessionId]);
  useLayoutEffect(() => {
    // The prompt bookmark follows the focused chat only.
    if (companion) return;
    const el = ref.current;
    // Resolved once and kept while the row stays mounted: this runs on every
    // scroll event, and the lookup walks the whole transcript.
    let cached: HTMLElement | null = null;
    const update = () => {
      if (latestPromptId && !cached?.isConnected) cached = promptRowNode(el, latestPromptId);
      const prompt = latestPromptId ? cached : null;
      if (!el || !prompt) {
        publishPromptVisibility(false);
        return;
      }
      const visibleArea = timelineVisibleArea(el);
      const row = prompt.getBoundingClientRect();
      const visible = row.bottom > visibleArea.top && row.top < visibleArea.bottom;
      publishPromptVisibility(visible);
    };
    update();
    el?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "function" && el
      ? new ResizeObserver(update)
      : null;
    if (el && observer) observer.observe(el);
    const chrome = el?.closest<HTMLElement>(".app")?.querySelector<HTMLElement>(".mobile-session-floats");
    if (chrome && observer) observer.observe(chrome);
    const prompt = latestPrompt ? promptRowNode(el, latestPrompt.id) : null;
    if (prompt && observer) observer.observe(prompt);
    return () => {
      el?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
      publishPromptVisibility(false);
    };
  }, [companion, sessionId, latestPromptId, limit]);

  // Timeline windowing: rows render as a suffix; revealing earlier rows keeps the
  // viewport anchored (scrollTop compensates for the height that appeared
  // above), and a jump to a hidden prompt grows the window first.
  const start = windowStart(rows.length, limit);
  const shownRows = start > 0 ? rows.slice(start) : rows;
  const timelineEventTypes = new Set(listSlots("session.timeline.event").flatMap((item) => {
    const value = item.meta?.eventTypes;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  }));
  // A projected activity group spans many seqs, so a timeline fact inside its
  // range (compaction, harness switch) would otherwise sort after the whole
  // block and pile up at the bottom. Split such groups at the visible facts
  // first; ungrouped mode has no spanning rows and is untouched.
  const visibleTimelineEvents = sessionEvents.filter((event) =>
    timelineEventTypes.has(event.type)
    && !renderedHiddenRanges.some(([from, to]) => event.seq >= from && event.seq < to));
  const spanningRows: Array<SpanningRow<ActivityGroup | RenderMessage>> = shownRows.map((row) =>
    row.kind === "activity"
      ? {
          id: row.id,
          seq: Math.min(...row.items.map((item) => item.eventSeq)),
          endSeq: Math.max(...row.items.map((item) => item.eventSeq)),
          row,
        }
      : { id: row.id, seq: row.eventSeq, row });
  const splitRows = splitRowsAtEvents(
    spanningRows,
    visibleTimelineEvents.map((event) => event.seq),
    (row) => row.kind === "activity" ? row.items : [],
    (item) => item.eventSeq,
    (row, items, index) => row.kind === "activity" ? activityGroup(row.id, items, index) : row,
  );
  const firstShownSeq = splitRows[0]?.seq ?? 0;
  const chronologicalRows = mergeTimelineEntries(
    splitRows.map((entry) => ({
      id: entry.row.kind === "activity" ? entry.row.id : entry.id,
      seq: entry.seq,
      row: entry.row,
    })),
    sessionEvents,
    timelineEventTypes,
    start === 0 ? 0 : firstShownSeq,
    renderedHiddenRanges,
  );
  // Split segments keep the original row id in `entry.id`, so the last one for
  // a given original id holds that row's newest items. Live presentation must
  // target the rendered segment, not the pre-split id.
  const lastSplitId = new Map<string, string>();
  for (const entry of splitRows) {
    const renderedId = entry.row.kind === "activity" ? entry.row.id : entry.id;
    lastSplitId.set(entry.id, renderedId);
  }
  const liveId = (id: string | undefined) => id === undefined ? undefined : lastSplitId.get(id) ?? id;
  const latestRowId = liveId(shownRows[shownRows.length - 1]?.id);
  const latestAssistantId = liveId([...shownRows].reverse().find((row) => row.kind === "assistant")?.id);
  const latestActivity = shownRows.findLast((row) => row.kind === "activity");
  const turnStart = sessionEvents.findLast((event) => event.type === "turn/started");
  // A new turn must not reactivate the previous turn's last block. Use event
  // order, not wall-clock timestamps, which can tie or move backwards.
  const currentActivityId = latestActivity?.kind === "activity"
    && latestActivity.items.some((item) => item.eventSeq > (turnStart?.seq ?? Infinity))
      ? latestActivity.id : undefined;
  const currentActivityState: RunSummaryState | undefined = turnWorking
    ? pendingQuestion || pendingPermission || pendingSecret ? "waiting" : "active"
    : turn?.status === "failed" ? "failed"
      : turn?.status === "aborted" ? "cancelled"
        : turn?.status === "stopped" ? "completed" : undefined;
  const renderedCurrentActivityId = liveId(currentActivityId);
  // A reveal activated from the keyboard can unmount its own control (the
  // final Show earlier chunk): focus must then hand off to the
  // named timeline region — never fall to BODY (a11y criteria 6–7).
  const revealHadFocus = useRef(false);
  // The first row before a reveal: rows mounted above it are the prepend.
  const revealFirstRow = useRef<Element | null>(null);
  const reveal = (next: number) => {
    const el = ref.current;
    if (el) anchor.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    revealFirstRow.current = el?.querySelector(`:scope > :is(${TIMELINE_LIFT_ROW_SELECTOR})`) ?? null;
    const active = document.activeElement;
    revealHadFocus.current = active instanceof Element && active.closest(".timeline-earlier") !== null;
    setLimit(next);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && a) el.scrollTop = a.scrollTop + (el.scrollHeight - a.scrollHeight);
    // Visible rows never move on a prepend; the revealed rows that land in
    // view fade in together, opacity only.
    const firstBefore = revealFirstRow.current;
    revealFirstRow.current = null;
    if (el && a && firstBefore?.parentElement === el && !timelineLiftMotionDisabled()) {
      const area = timelineVisibleArea(el);
      for (let row = firstBefore.previousElementSibling; row; row = row.previousElementSibling) {
        if (!(row instanceof HTMLElement) || typeof row.animate !== "function") continue;
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= area.top) break;
        if (rect.height <= 0 || rect.top >= area.bottom) continue;
        claimTimelineMotion(row);
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PREPEND_FADE_MS, easing: "ease-out" });
      }
    }
    const target = pendingJump.current;
    const smooth = pendingJumpSmooth.current;
    pendingJump.current = null;
    pendingJumpSmooth.current = false;
    if (target) {
      const node = promptRowNode(el, target);
      node?.scrollIntoView({
        block: "center",
        behavior: smooth && !timelineLiftMotionDisabled() ? "smooth" : "auto",
      });
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
    if (el) captureReaderAnchor(el);
    // captureReaderAnchor is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Initial hydration is a newest-first window. An older saved anchor can
      // be absent until background backfill lands, so retain it while the
      // server still advertises earlier canonical events.
      if (rows.length > 0 && !canLoadOlder) restoreRef.current = null;
      return;
    }
    restoreRef.current = null;
    el.scrollTop += restoreScrollDelta(el, node, a);
    captureReaderAnchor(el);
  });
  const jump = (id: string, opts?: { focus?: boolean; smooth?: boolean }) => {
    stopFollowing();
    const index = rows.findIndex((r) => r.kind !== "activity" && r.id === id);
    const next = limitToInclude(rows.length, limit, index);
    if (next !== limit) {
      pendingJump.current = id;
      pendingJumpFocus.current = opts?.focus === true;
      pendingJumpSmooth.current = opts?.smooth === true;
      setLimit(next);
      return;
    }
    const node = promptRowNode(ref.current, id);
    node?.scrollIntoView({
      block: "center",
      behavior: opts?.smooth === true && !timelineLiftMotionDisabled() ? "smooth" : "auto",
    });
    // A smooth jump re-anchors from its own scroll events.
    if (ref.current) captureReaderAnchor(ref.current);
    if (opts?.focus && node) {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
    }
  };
  jumpRef.current = jump;
  const revealTargetIndex = externalReveal === null ? -1 : rows.findIndex((row) =>
    row.kind !== "activity" && row.eventSeq === externalReveal.eventSeq);
  useLayoutEffect(() => {
    const request = externalReveal;
    if (!request) return;
    if (!request.current() || request.sessionId !== sessionId) {
      request.finish(false);
      setExternalReveal(null);
      return;
    }
    if (revealTargetIndex < 0) {
      if (!canLoadOlder) { request.finish(false); setExternalReveal(null); }
      return;
    }
    const next = limitToInclude(rows.length, limit, revealTargetIndex);
    if (next !== limit) { setLimit(next); return; }
    const target = rows[revealTargetIndex]!;
    const node = promptRowNode(ref.current, target.id);
    if (!node) { request.finish(false); setExternalReveal(null); return; }
    jumpRef.current?.(target.id, { focus: request.focus });
    request.finish(true);
    setExternalReveal(null);
  }, [externalReveal, revealTargetIndex, canLoadOlder, sessionId, rows.length, limit]);
  useEffect(() => {
    const request = externalReveal;
    if (!request || !request.current() || request.sessionId !== sessionId
      || revealTargetIndex >= 0 || !canLoadOlder || revealLoadInFlight.current) return;
    revealLoadInFlight.current = request;
    void loadOlderEvents(sessionId, 2000)
      .then(async (loaded) => {
        // Background backfill can already own a page. Wait briefly before
        // retrying, rather than polling that shared lock in a tight loop.
        if (!loaded && request.current()) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      })
      .catch(() => { request.finish(false); })
      .finally(() => {
        if (revealLoadInFlight.current === request) revealLoadInFlight.current = null;
        if (externalRevealRef.current?.current()) setRevealLoadEpoch((epoch) => epoch + 1);
      });
  }, [externalReveal, revealTargetIndex, canLoadOlder, sessionId, rows.length, revealLoadEpoch]);
  const bookmarkRows = useRef(rows);
  bookmarkRows.current = rows;
  const requestBookmarkJump = async (target: PromptBookmarkTarget) => {
    const generation = ++bookmarkJumpGeneration.current;
    stopFollowing();
    const cached = () => bookmarkRows.current.some((row) => row.kind !== "activity" && row.id === target.id)
      || promptRowNode(ref.current, target.id) !== null;
    const stored = () => sessionId !== null && getState().events[sessionId]?.some((event) => event.id === target.id);
    while (!cached() && !stored()) {
      if (!sessionId || generation !== bookmarkJumpGeneration.current || oldestSeq(sessionId) <= 1) {
        throw new Error("Prompt is no longer available");
      }
      // Preserve a contiguous canonical tail. Fetch only back to the selected
      // sequence, in bounded chunks, instead of hydrating the whole session.
      const distance = target.seq === undefined ? 2000 : oldestSeq(sessionId) - target.seq;
      if (distance <= 0 || !await loadOlderEvents(sessionId, Math.min(2000, distance))) {
        throw new Error("Prompt history could not be loaded");
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (generation !== bookmarkJumpGeneration.current) throw new Error("Prompt navigation cancelled");
    if (sessionId && stored() && !reduceSessionModel(sessionId, getState().events[sessionId]!).messages
      .some((message) => message.kind === "user" && message.id === target.id && !message.undone)) {
      throw new Error("Prompt is no longer available");
    }
    await new Promise<void>((resolve, reject) => {
      bookmarkRequest.current = { generation, resolve, reject };
      setBookmarkJumpId(target.id);
    });
  };
  // Hydration and React painting have different clocks. Hand off the jump
  // only after the selected row belongs to the committed timeline model.
  useLayoutEffect(() => {
    const request = bookmarkRequest.current;
    if (!request || !bookmarkJumpId) return;
    if (request.generation !== bookmarkJumpGeneration.current) {
      request.reject(new Error("Prompt navigation cancelled"));
    } else if (bookmarkRows.current.some((row) => row.kind !== "activity" && row.id === bookmarkJumpId)
      || promptRowNode(ref.current, bookmarkJumpId)) {
      jumpRef.current?.(bookmarkJumpId, { smooth: true, focus: true });
      request.resolve();
    } else return;
    bookmarkRequest.current = null;
    setBookmarkJumpId(null);
  });

  // Jump to latest (§2.4): scroll to the true final surface (error/retry and
  // turn footer included — they precede the tail clearance), mark follow mode
  // active, and hand focus to the latest message container since this control
  // unmounts. Appends no event.
  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    readerIntent.current = null;
    scrollbarPointer.current = false;
    readerDetached.current = false;
    readerSoftLock.current = false;
    atBottom.current = true;
    // The jump lifts the rows the reader sees right now.
    notePaintedLayout(el);
    if (turnSettleDue.current) {
      // The turn finished while the reader was away: the owed release is the
      // jump, landing on the composer edge.
      handOverTurnTail();
    } else {
      if (turnSheetPromptId.current === null) resetTimelineExtent(el);
      syncTurnSheet();
      scrollToTail();
    }
    setShowJump(false);
    const msgs = el.querySelectorAll<HTMLElement>(":scope > .msg");
    const target = msgs[msgs.length - 1] ?? el;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  };
  // A question taller than the reading area opens at its start, not with its
  // actions on the composer edge: the reader begins at the question, and the
  // card's sticky footer keeps the decision in view while it scrolls. Once per
  // question, and only for a reader who was following the tail.
  const openQuestionRowId = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index]!;
      if (message.kind === "question" && message.status === "pending") return message.id;
    }
    return null;
  }, [visibleMessages]);
  const openedQuestionRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || openQuestionRowId === null || openedQuestionRow.current === openQuestionRowId) return;
    const card = Array.from(el.children).find((child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches(".question-open") && child.dataset.msgId === openQuestionRowId);
    if (!card) return;
    openedQuestionRow.current = openQuestionRowId;
    if (!atBottom.current || touchActive.current) return;
    const visible = timelineVisibleArea(el);
    if (card.offsetHeight <= visible.height - timelineTailClearance(el)) return;
    const gap = Number.parseFloat(getComputedStyle(el).rowGap) || 0;
    const target = Math.max(0, card.offsetTop - visible.inset - gap);
    if (target >= el.scrollTop - 0.5) return;
    expectedScrollTop.current = target;
    el.scrollTop = target;
    lastScrollTop.current = el.scrollTop;
    readerDetached.current = true;
    atBottom.current = false;
    captureReaderAnchor(el);
    notePaintedLayout(el);
    setShowJump(!timelineTailRevealed(el));
  }, [openQuestionRowId, captureReaderAnchor, notePaintedLayout]);
  // An open question is a row of the conversation, so the jump is the way
  // back to it; permission and secret cards pin themselves to the tail.
  const latestReveal = showJump && !pendingPermission && !pendingSecret ? (
    <div className="timeline-reveal">
      <button className={`jump-latest${model.turn?.status === "working" ? " agent-working" : ""}`} aria-label={JUMP_TO_LATEST_NAME} title={JUMP_TO_LATEST_NAME} onClick={jumpToLatest}>
        ↓
      </button>
    </div>
  ) : null;
  // Revert and edit: only the clicked control shows pending; nothing moves or
  // fades before the server confirms. With motion on, the confirmation plays
  // the choreography (see the revert layout effects) and the draft waits for
  // its glide; motion off applies both in the confirming commit.
  const revert = useCallback((message: UserMsg | QuestionMsg) => {
    if (!sessionId) return;
    if (revertPendingRef.current === sessionId) return;
    // A question keeps its place; the cut starts at the person's answer.
    const atSeq = message.kind === "question" ? message.answeredSeq : message.eventSeq;
    if (atSeq === undefined) return;
    revertPendingRef.current = sessionId;
    setRevertPendingSession(sessionId);
    revertDraft.current = null;
    if (!timelineLiftMotionDisabled()) {
      setRevertChoreography({ sessionId, atSeq, markerSeq: null, phase: "confirming" });
    }
    void api.rewind(sessionId, atSeq).then((marker) => {
      const draft: RewindDraft = message.kind === "question"
        ? {
            sessionId,
            markerSeq: marker.seq,
            atSeq,
            text: questionAnswerDraft(normalizeQuestions(message.questions), (message.answers ?? {}) as AnswerMap),
          }
        : {
            sessionId,
            markerSeq: marker.seq,
            atSeq,
            text: message.raw ?? message.text,
            ...(message.attachments && message.attachments.length > 0
              ? { attachments: message.attachments }
              : {}),
          };
      const exit = revertExitRef.current;
      const choreographed = exit !== null && exit.sessionId === sessionId && exit.atSeq === atSeq;
      if (choreographed) revertDraft.current = draft;
      applyEvent(marker); // WS re-delivery dedupes by seq
      if (!choreographed) applyRewindDraftRef.current(draft);
    }).catch((err) => {
      const exit = revertExitRef.current;
      if (exit?.phase === "confirming" && exit.sessionId === sessionId && exit.atSeq === atSeq) {
        setRevertChoreography(null);
      }
      revertDraft.current = null;
      const text = mutationErrorMessage("revert", err);
      announce(text, { role: "user", eventSeq: atSeq });
      setUiError(text);
    }).finally(() => {
      if (revertPendingRef.current === sessionId) {
        revertPendingRef.current = null;
        setRevertPendingSession(null);
      }
    });
    // setRevertChoreography only touches a ref and a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, announce]);
  // Fork and edit: navigation happens only after the child is published; a
  // failure keeps the source selected with a bounded explanation (spec).
  const fork = useCallback((message: UserMsg) => {
    if (!sessionId) return;
    void forkSession(sessionId, message.eventSeq).catch((err) => {
      const text = mutationErrorMessage("fork", err);
      announce(text, { role: "user", eventSeq: message.eventSeq });
      setUiError(text);
    });
  }, [sessionId, announce]);
  // Restore original timeline. An untouched seed is cleared silently; an
  // edited draft asks first, inline in the marker (both outcomes named).
  // Focus lands on the invoking control when it survives, otherwise on the
  // restored target's Revert action — never on BODY.
  const [confirmRestore, setConfirmRestore] = useState(false);
  const rewindMarkerSeq = model.rewind?.markerSeq;
  // A confirmation belongs to one marker; a new or resolved rewind drops it.
  useEffect(() => { setConfirmRestore(false); }, [rewindMarkerSeq]);
  const restore = (opts?: { confirmed?: boolean; invoker?: HTMLElement | null }) => {
    if (!sessionId || !model.rewind) return;
    const draftState = draftStateOf(loadSeedRecord(sessionId), loadDraft(sessionId));
    if (draftState === "edited" && !opts?.confirmed) {
      setConfirmRestore(true);
      return;
    }
    const atSeq = model.rewind.atSeq;
    const invoker = opts?.invoker ?? null;
    if (ref.current) {
      rewindMotionActive.current = beginRestoreMotion(sessionId, atSeq, ref.current);
    }
    void api.clearRewind(sessionId).then((cleared) => {
      applyEvent(cleared);
      discardComposerSeed(sessionId);
      requestComposerReplace("");
      setConfirmRestore(false);
      announce(tr("timeline.originalTimelineRestored"));
      requestAnimationFrame(() => {
        if (invoker && document.contains(invoker)) { invoker.focus({ preventScroll: true }); return; }
        const el = ref.current;
        // The restored prompt itself takes focus: it is announced as the
        // message it is, and no action tooltip pops up over the transcript.
        const row = el?.querySelector<HTMLElement>(`:scope > .msg.user[data-message-seq="${atSeq}"]`);
        if (row) {
          row.tabIndex = -1;
          row.focus({ preventScroll: true });
          return;
        }
        const target = el?.querySelector<HTMLElement>(`[data-revert-seq="${atSeq}"]`)
          ?? el?.querySelector<HTMLElement>(`[data-actions-seq="${atSeq}"]`);
        if (target) { target.focus({ preventScroll: true }); return; }
        if (el) { el.focus({ preventScroll: true }); }
      });
    }).catch((err) => {
      cancelRewindMotion(sessionId, atSeq);
      rewindMotionActive.current = false;
      const text = mutationErrorMessage("restore", err);
      announce(text);
      setUiError(text);
    });
  };

  // Bounded, already-reduced summary for the timeline before/after hosts —
  // contributions never receive live events or a mutable model reference.
  // Pending approvals/secrets belong here: permissions and secure-safe render
  // in `session.timeline.after` from this context, not from a live store.
  const slotSummary = timelineAfterSlotContext({
    sessionId,
    projectId,
    messageCount: model.messages.length,
    promptCount: prompts.length,
    turnStatus: turn?.status ?? null,
    permissions: model.permissions,
    secrets: model.secrets,
  });

  // One timeline, one scroll root (§2.1): the shell stacks the reserved
  // utility region, the single `.timeline` scrollport, and the reserved
  // latest-reveal region as normal-flow siblings. Absolute siblings of the
  // scroller live in `.timeline-viewport`: the prompt rail in the right
  // gutter, and the clipped live-action layer so flight cannot grow
  // scrollHeight.
  return (
    <PersonSelection.Provider value={personSelection}>
    <PersonNames.Provider value={personNames}>
    <PersonTones.Provider value={personTones}>
    <ConversationRepliesContext.Provider value={fenceReplies}>
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
          // Trackpad pinch zoom and a predominantly horizontal gesture are
          // viewport/content actions, not a request to leave tail follow.
          if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
          if (event.deltaY < 0) stopFollowing();
          else if (event.deltaY > 0) noteReaderIntent("toward-tail");
        }}
        onKeyDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.matches("input, textarea, select, [contenteditable=true]")) return;
          const towardHistory = event.key === "ArrowUp"
            || event.key === "PageUp"
            || event.key === "Home"
            || ((event.key === " " || event.key === "Spacebar") && event.shiftKey)
            || (event.metaKey && event.key === "ArrowUp");
          const towardTail = event.key === "ArrowDown"
            || event.key === "PageDown"
            || event.key === "End"
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
          const inScrollbar = direction === "rtl"
            ? event.clientX <= rect.left + gutter
            : event.clientX >= rect.right - gutter;
          scrollbarPointer.current = event.button === 1
            || (event.button === 0 && inScrollbar && el.scrollHeight > el.clientHeight);
        }}
        onPointerUpCapture={() => { scrollbarPointer.current = false; }}
        onPointerCancelCapture={() => { scrollbarPointer.current = false; }}
        onTouchStartCapture={(event) => {
          touchActive.current = true;
          if (touchRestTimer.current !== null) {
            clearTimeout(touchRestTimer.current);
            touchRestTimer.current = null;
          }
          touchScrolled.current = false;
          touchY.current = event.touches[0]?.clientY ?? null;
          // The touched node can unmount mid-gesture (a live line re-keys
          // under the finger); its end events then never reach the
          // timeline, so the document hears them too.
          if (touchEndCleanup.current === null && typeof document !== "undefined") {
            const end = (touchEvent: TouchEvent) => { if (touchEvent.touches.length === 0) finishTouchScroll(); };
            document.addEventListener("touchend", end, true);
            document.addEventListener("touchcancel", end, true);
            touchEndCleanup.current = () => {
              document.removeEventListener("touchend", end, true);
              document.removeEventListener("touchcancel", end, true);
            };
          }
        }}
        onTouchMoveCapture={(event) => {
          const y = event.touches[0]?.clientY;
          if (touchY.current !== null && y !== undefined) {
            const deltaY = y - touchY.current;
            // Ignore tap jitter, but accumulate it against the last accepted
            // sample so a slow deliberate drag still wins after a few pixels.
            if (deltaY > 2) {
              stopFollowing();
              touchY.current = y;
            } else if (deltaY < -2) {
              noteReaderIntent("toward-tail");
              touchY.current = y;
            }
          }
        }}
        onTouchEndCapture={(event) => { if (event.touches.length === 0) finishTouchScroll(); }}
        onTouchCancelCapture={(event) => { if (event.touches.length === 0) finishTouchScroll(); }}
      >
        <SlotHost slot="session.timeline.before" context={slotSummary} customizable />
        {model.messages.length === 0 && !model.workflowRun && pendingSends.length === 0 && (
          <div className="empty">
            <div>{emptyCopy}</div>
          </div>
        )}
        {/* One stable host while earlier history exists: its button swaps
            between Show earlier / Load earlier / busy in place (same element,
            focus kept), and its arrival or removal moves no visible row. */}
        {(start > 0 || canLoadOlder) && (
          <div className="timeline-earlier">
            {start > 0 ? (
              <Button size="sm" onClick={() => reveal(grownLimit(rows.length, limit))}>
                {tr("timeline.show")}{" "}{Math.min(TIMELINE_CHUNK, start)} {tr("timeline.earlier")}</Button>
            ) : (
              <Button size="sm" busy={olderBusy} onClick={() => void loadOlder()}>
                {olderBusy ? tr("timeline.loadingEarlierHistory") : tr("timeline.loadEarlierHistory")}</Button>
            )}
          </div>
        )}
        {chronologicalRows.map((entry, index) => {
          if (entry.kind === "timeline-event") {
            return <SlotHost
              key={entry.id}
              slot="session.timeline.event"
              context={{ ...slotSummary, event: entry.event }}
            />;
          }
          const r = entry.row;
          // A confirmed revert's cut fades out in place: same key, same DOM.
          const leaving = leavingAtSeq !== null && entry.seq >= leavingAtSeq;
          return r.kind === "activity"
            ? <ActivityRow
                key={r.id}
                rev={activityRev(r)}
                g={r}
                subagents={model.subagents}
                state={r.id === renderedCurrentActivityId ? currentActivityState : undefined}
                entering={r.id === latestRowId}
                leaving={leaving}
                livePresentation={turnWorking && r.id === renderedCurrentActivityId}
                // The live block names its step in progress while nothing
                // follows it; every row renders the moment it arrives.
                ticking={turnWorking && r.id === renderedCurrentActivityId && r.id === latestRowId}
                sessionId={sessionId}
                resourceContext={resourceContext}
              />
            : (
              <MessageRow
                key={r.id}
                rev={r.rev ?? 0}
                m={r}
                leaving={leaving}
                answerLeaving={leavingAtSeq !== null && r.kind === "question" && r.answeredSeq !== undefined
                  && r.answeredSeq >= leavingAtSeq}
                plan={r.kind === "assistant" && r.id === latestAssistantId && model.tasks ? model.tasks : undefined}
                regeneratePrompt={r.kind === "assistant" ? regenerateSources.get(r.eventSeq) : undefined}
                turn={r.kind === "assistant" && r.id === latestAssistantId && turn?.status !== "working" ? turn : undefined}
                // The latest assistant row of a working turn owns the live
                // thinking state; every row displays the received text directly.
                live={r.kind === "assistant" && turnWorking && r.id === latestAssistantId}
                entering={r.id === latestRowId}
                terminal={r.kind === "assistant" && terminalAnswers.terminal.has(r.eventSeq)
                  && (!turnInProgress || pendingSends.length > 0 || r.eventSeq !== terminalAnswers.trailing)}
                dormant={turnInProgress}
                progress={r.kind === "assistant" && nextRowIsActivity(chronologicalRows, index)}
                // An interim answer of a live turn takes its (still invisible)
                // footer's box the moment a row lands under it, while it is
                // the tail's neighbour: added at turn end instead, every
                // footer in view pushed the rows below it down at once.
                settled={r.kind === "assistant"
                  && (!turnInProgress || pendingSends.length > 0 || r.eventSeq < terminalAnswers.openSeq
                    || r.id !== latestRowId)}
                 segmentStartedAt={r.kind === "assistant" ? terminalAnswers.terminal.get(r.eventSeq) : undefined}
                 announce={announce}
                 onRevert={revert}

                onFork={fork}
                revert={revertOk}
                fork={forkOk}
                sessionId={sessionId}
                resourceContext={resourceContext}
              />
            );
        })}
        {/* The cut point of an active rewind sits at the end of the retained
            prefix. The confirmed exit/glide owns marker timing; a replacement
            prompt still removes it in the same commit as its optimistic echo. */}
        {model.rewind && pendingSends.length === 0 && !suppressRewindMarker && (
          <RewindMarker
            key={model.rewind.markerSeq}
            running={rewindRunning}
            confirming={confirmRestore}
            canPeek={rewoundRows.length > 0}
            onRestore={(invoker) => restore({ invoker })}
            onConfirmRestore={(invoker) => restore({ confirmed: true, invoker })}
            onKeepEditing={() => {
              setConfirmRestore(false);
              focusComposer();
            }}
            renderRewound={() => rewoundRows.map(renderRewindRow)}
          />
        )}
        {pendingSends.map((send) => <PendingPrompt key={send.id} send={send} />)}
        {turnBroken && turn.status === "failed" && turn.limit && sessionId && (
          <RateLimitNotice sessionId={sessionId} limit={turn.limit} turnError={turn.error} />
        )}
        {session?.paused && sessionId && !companion && pendingSends.length === 0 && (
          <PausedNotice sessionId={sessionId} />
        )}
        <div className="msg-live sr-only" role="status" aria-live="polite">{liveText}</div>
        <SlotHost slot="session.timeline.after" context={slotSummary} customizable />
        <div className="timeline-extent-floor" aria-hidden="true" />
      </div>
      {showBookmark && sessionId && (latestPrompt || canLoadOlder) && (
        <PromptBookmark
          key={`${spaceId ?? "none"}:${sessionId}`}
          sessionId={sessionId}
          spaceId={spaceId}
          revision={`${latestPromptId ?? "none"}:${model.rewind?.markerSeq ?? "none"}`}
          prompt={latestPrompt}
          narrow={prefs.pinLatestPrompt}
          wide={prefs.promptBookmarkDesktop}
          onJump={requestBookmarkJump}
          onCancelJump={() => {
            bookmarkJumpGeneration.current += 1;
            bookmarkRequest.current?.reject(new Error("Prompt navigation cancelled"));
            bookmarkRequest.current = null;
            setBookmarkJumpId(null);
          }}
        />
      )}
      {showNav && (
        <PromptNavigator
          prompts={prompts}
          side={prefs.promptNavigatorSide}
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
      {sessionId && selectionState.dialogOpen && (
        <ConversationStartDialog
          open
          sessionId={sessionId}
          sourceSeqs={[...selectedSeqs]}
          defaultTitle={session?.title ?? ""}
          sources={model.messages.flatMap((message) => message.kind === "person-message" && selectedSeqs.includes(message.eventSeq)
            ? [{ seq: message.eventSeq, author: message.author?.name?.trim() || tr("timeline.anotherPerson"), text: message.text }]
            : [])}
          onClose={closeConversationStart}
          onStarted={endConversationSelection}
        />
      )}
    </div>
    </ConversationRepliesContext.Provider>
    </PersonTones.Provider>
    </PersonNames.Provider>
    </PersonSelection.Provider>
  );
}
