import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { HarnessSelection, SessionEvent } from "@polyth/contracts";
import { renderMarkdown } from "../markdown.tsx";
import { fmtDuration } from "../format.ts";
import { groupActivity, mergeThinking, promptIndex, loadDraft, type ActivityGroup, type ActivityItem } from "../utils.ts";
import { executionPresentation, reasoningHead, reasoningTail } from "../execution.ts";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { cancelResume, forkSession, loadOlderEvents, resumeNow } from "../init.ts";
import { resumeOptionsForModel } from "../rateLimitRecovery.ts";
import { useSpaces } from "../spaces.ts";
import { markSessionPerformance } from "../sessionPerformance.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import {
  applyEvent, setUiError, useStore,
} from "../store.ts";
import { api } from "@polyth/session/web-api";
import {
  COPY_REASONING_NAME,
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
  freshTurnContextOffset,
  requiredTurnSheetPadding,
  timelineFollowState,
  timelineMutationAffectsFollow,
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
import WorkflowTimelineCard from "../../../../packages/workflow/widgets/WorkflowTimelineCard.tsx";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { tr } from "../i18n/index.ts";
import ExecutionRow, { DiffStat, useCollapsePresence } from "./ExecutionRow.tsx";
import { Button, Notice, RunSummary, type RunSummaryState } from "./ui/index.ts";
import type { TurnLimitState } from "../reduce.ts";
import ChatResponseFooter from "./ChatResponseFooter.tsx";
import MessageQuickActions from "./MessageQuickActions.tsx";

const EMPTY_SESSION_EVENTS: SessionEvent[] = [];

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

export function shellCardCopyText(
  input: ToolMsg["input"],
  output?: string,
  error?: string,
): string {
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

/** Matches --activity-live-exit: the floating row must stay mounted for the
 *  whole fold-away before it is handed to the block. */
const ACTIVITY_LIVE_EXIT_MS = 280;
/** Minimum time an arriving action stays outside the block — long enough to
 *  rise, be read, and fold away as one deliberate beat rather than a flash.
 *  Status alone cannot decide this: a tool whose call and result land in the
 *  same render batch is never observed running. */
const ACTION_SHOW_MS = 1_500;
/** Quiet beat between two actions: the previous card is fully gone before the
 *  next rises, so a burst pulses evenly instead of stampeding. */
const ACTION_GAP_MS = ACTIVITY_LIVE_EXIT_MS;
/** At most two actions wait their turn. Narrating a stale burst matters less
 *  than staying in step with what the agent is actually doing; the overflow
 *  folds straight into the block. */
const ACTION_BACKLOG_MS = 2 * (ACTION_SHOW_MS + ACTION_GAP_MS);

/** An action is live while it is still executing. Live actions float above the
 *  activity block instead of expanding it, so the block can stay folded. */
function inFlight(item: ActivityItem): boolean {
  if (item.kind === "tool") return item.status === "pending" || item.status === "running";
  if (item.kind === "assistant") return !item.finalized;
  return item.action === "started";
}

interface ActionSchedule {
  /** The one action currently presented to the reader. */
  showing: Set<string>;
  /** The previous action during its fold-away beat. */
  leaving: Set<string>;
  /** Showing, leaving, and not-yet-shown ids stay out of expanded history. */
  scheduled: Set<string>;
}

/** Ids currently inside their turn outside the block. Arrivals are queued one
 *  at a time rather than shown the moment they land: without that, a burst of
 *  fast tools cuts each other's motion short and reads as flicker. Each action
 *  gets the full show, then a gap, then the next one rises — fast work is
 *  emphasised, not chaotic. Rows already present at mount are dated by their
 *  own timestamp so replayed history stays folded on scroll-back, clamped to
 *  now because a skewed clock must not park a row outside the block. */
function useActionSchedule(items: ActivityItem[]): ActionSchedule {
  // id -> start of its turn outside the block; 0 means it never gets one.
  const turns = useRef(new Map<string, number>());
  const cursor = useRef(0);
  const mounted = useRef(false);
  const [, redraw] = useState(0);
  const at = Date.now();
  for (const item of items) {
    if (turns.current.has(item.id)) continue;
    // A live action restored after navigation still deserves one visible turn;
    // completed history uses its recorded time and stays folded on replay.
    const arrivedAt = mounted.current || inFlight(item) ? at : Math.min(at, item.time);
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
  const leaving = new Set<string>();
  const scheduled = new Set<string>();
  let next = Infinity;
  for (const item of items) {
    const startAt = turns.current.get(item.id) ?? 0;
    if (startAt === 0) continue;
    const showEnd = startAt + ACTION_SHOW_MS;
    const exitEnd = showEnd + ACTIVITY_LIVE_EXIT_MS;
    if (at < exitEnd) scheduled.add(item.id);
    if (at < startAt) next = Math.min(next, startAt);
    else if (at < showEnd) {
      showing.add(item.id);
      next = Math.min(next, showEnd);
    } else if (at < exitEnd) {
      leaving.add(item.id);
      next = Math.min(next, exitEnd);
    }
  }
  // Wake on the next boundary only — a queue that polls would re-render the
  // whole group for nothing while the agent works.
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => redraw((value) => value + 1), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [next]);
  return { showing, leaving, scheduled };
}

function activityItemNode(
  item: ActivityItem,
  subagents: SubagentState | null,
  live: boolean,
  entering: boolean,
) {
  // An arriving action shows what it is, not its whole output: it stays folded
  // outside the block exactly as it will be inside it.
  return item.kind === "tool"
    ? <ExecutionRow key={item.id} message={item} subagent={childForTool(item, subagents)} entering={entering} />
    : item.kind === "assistant"
      ? <Thinking key={item.id} m={item} live={live} entering={entering} />
      : <TaskActivityRow key={item.id} activity={item} entering={entering} />;
}

function liveLayerFor(group: Element | null): HTMLElement | null {
  const layer = group?.closest(".timeline-viewport")?.querySelector(":scope > .activity-live-layer");
  return layer instanceof HTMLElement ? layer : null;
}

function syncLiveStage(stage: HTMLElement, group: HTMLElement): void {
  const layer = stage.parentElement;
  if (!layer?.classList.contains("activity-live-layer")) return;
  const groupBox = group.getBoundingClientRect();
  const layerBox = layer.getBoundingClientRect();
  stage.style.left = `${groupBox.left - layerBox.left}px`;
  stage.style.width = `${Math.max(0, groupBox.width)}px`;
  stage.style.top = `${groupBox.bottom - layerBox.top}px`;
}

function derivedActivityState(g: ActivityGroup): RunSummaryState {
  const latestTasks = new Map(g.tasks.map((task) => [task.taskId, task]));
  if (g.tools.some((tool) => tool.status === "error" && /cancel(?:led|ed)|aborted|stopped|interrupted/i.test(tool.error ?? ""))) return "cancelled";
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
  // The block never opens itself. Running work is shown by the floating live
  // rows below it; opening the block is a reader decision only.
  const [open, setOpen] = useState(false);
  const itemsPresent = useCollapsePresence(open);
  const schedule = useActionSchedule(g.items);
  const liveIds = g.items.filter((item) => schedule.showing.has(item.id)).map((item) => item.id);
  const leavingIds = g.items.filter((item) => schedule.leaving.has(item.id)).map((item) => item.id);
  const floatingIds = new Set([...liveIds, ...leavingIds]);
  const floating = g.items.filter((item) => floatingIds.has(item.id));
  const folded = g.items.filter((item) => !schedule.scheduled.has(item.id));
  // Mount the summary with the first action. Later arrivals then only update
  // its text and enter the invisible queue; they cannot insert a new row above
  // the currently visible action and shove the conversation down.
  const showBlock = g.items.length > 0;
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
  // A live action is its own visual timeline row, not part of the folded
  // block's layout. It is portaled into the clipped viewport overlay so
  // flight cannot grow timeline overflow; then it folds away into the block.
  const groupRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [liveLayer, setLiveLayer] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    const layer = document.querySelector(".timeline-viewport > .activity-live-layer");
    return layer instanceof HTMLElement ? layer : null;
  });
  const bindGroupRef = useCallback((node: HTMLElement | null) => {
    groupRef.current = node;
    if (!node) return;
    const layer = liveLayerFor(node);
    setLiveLayer((current) => (current === layer ? current : layer));
  }, []);
  useLayoutEffect(() => {
    setLiveLayer(liveLayerFor(groupRef.current));
  }, [showBlock, floating.length]);
  useLayoutEffect(() => {
    const group = groupRef.current;
    const stage = stageRef.current;
    if (!group || !stage || !liveLayer) return;
    const sync = () => syncLiveStage(stage, group);
    sync();
    const timeline = group.closest(".timeline");
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    resize?.observe(group);
    timeline?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => {
      resize?.disconnect();
      timeline?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [liveLayer, floating.length]);
  const stage = floating.length > 0 ? (
    <div className="activity-live-stage" ref={stageRef}>
      {floating.map((item) => {
        const live = liveIds.includes(item.id);
        return <div
          key={item.id}
          className={`activity-live${item.kind === "task" && item.action === "started" ? " task-started" : ""}${live ? "" : " leaving"}`}
          aria-hidden={!live || undefined}
          inert={!live}
        >
          <div className="activity-live-content">
            {activityItemNode(item, subagents, live, false)}
          </div>
        </div>;
      })}
    </div>
  ) : null;
  return (
    <>
      {showBlock && (
        <section ref={bindGroupRef} className={`msg assistant activity-group${entering ? " timeline-row-enter" : ""}${open ? " open" : ""}${active ? " current" : ""}`} aria-label={tr("timeline.agentActivity")}>
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
            onToggle={() => setOpen((value) => !value)}
          />
          <div className="activity-group-expand-shell" aria-hidden={!open}>
            <div className="activity-group-collapse-content">
              {itemsPresent && (
                <div className="activity-group-items">
                  {folded.map((item, index) =>
                    activityItemNode(item, subagents, false, entering && active && index === folded.length - 1))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}
      {liveLayer && stage ? createPortal(stage, liveLayer) : null}
    </>
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
  if (a.kind === "notice" && b.kind === "notice") {
    return a.topic === b.topic && a.branch === b.branch && a.commit === b.commit;
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
 *  cancel-wait and a full harness-qualified model recovery picker. Replaces
 *  the generic "Last turn failed" line while `turn.limit` is set. */
function RateLimitNotice({ sessionId, limit }: { sessionId: string; limit: TurnLimitState }) {
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
  const selectedHarnessId = harnessSelection.mode === "pinned"
    ? harnessSelection.harnessId
    : currentHarnessId;
  const routeCatalog = useRuntimeCatalog(session, models, agents, {
    spaceId,
    projectId: session?.projectId,
    harnessId: selectedHarnessId,
  });
  const catalogHarnessId = routeCatalog.harnessId ?? selectedHarnessId;
  const selectedModel = selectedHarnessId === currentHarnessId && session?.model
    ? { ...session.model, ...(currentHarnessId ? { harnessId: currentHarnessId } : {}) }
    : undefined;
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
    setBusy("switch");
    void resumeNow(sessionId, options)
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
            variant="quiet"
            className="turn-rate-limit-action"
            busy={busy === "resume"}
            disabled={busy !== null}
            onClick={() => run("resume", resumeNow(sessionId))}
          >{tr("timeline.rateLimit.resumeNow")}</Button>
          <span className="turn-rate-limit-model">
            <ModelPicker
              models={routeCatalog.models}
              harnessId={catalogHarnessId}
              value={selectedModel}
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
          <Button
            size="sm"
            variant="quiet"
            className="turn-rate-limit-action"
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

/** The fresh-turn anchor keeps continuity with the immediately preceding
 * assistant answer. Do not reach across another user turn when unusual slot
 * or recovery rows sit between messages. */
function previousAssistantRow(prompt: HTMLElement): HTMLElement | null {
  for (let row = prompt.previousElementSibling; row; row = row.previousElementSibling) {
    if (!(row instanceof HTMLElement)) continue;
    if (row.matches(".msg.user, .github-conflict-card")) return null;
    if (row.matches(".msg.assistant")) return row;
  }
  return null;
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
  const sessionEvents = useStore((s) => s.activeSessionId
    ? s.events[s.activeSessionId] ?? EMPTY_SESSION_EVENTS
    : EMPTY_SESSION_EVENTS);
  const latestUserMessage = [...model.messages].reverse()
    .find((message) => message.kind === "user" && !message.undone);
  useSlotVersion();
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
  // Reader intent is separate from proximity. In particular, one slow wheel
  // tick upward must stay detached even while it is only a pixel from the end.
  const readerDetached = useRef(false);
  const lastScrollTop = useRef(0);
  const touchY = useRef<number | null>(null);
  const scrollbarPointer = useRef(false);
  const readerIntent = useRef<{
    direction: "toward-history" | "toward-tail";
    until: number;
  } | null>(null);
  const expectedScrollTop = useRef<number | null>(null);
  // A newly appended user prompt owns a contextual fresh-turn tail.
  // Presentation-only padding leaves the end of the previous answer above
  // that prompt, then yields pixel for pixel as the new response grows.
  const turnSheetPromptId = useRef<string | null>(null);
  const turnSheetPadding = useRef(0);
  const observedPrompt = useRef({
    sessionId,
    seq: latestUserMessage?.eventSeq ?? 0,
  });
  // Latest-reveal state (§2.4): true while the reader holds a position away
  // from the tail, mounting the reserved Jump to latest region.
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
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => markSessionPerformance("first_message_painted", sessionId));
    });
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
    } else {
      // A no-op assignment emits no scroll event; never leave a stale
      // programmatic target that could swallow the reader's next End/drag.
      expectedScrollTop.current = null;
    }
    // A no-op assignment emits no scroll event, so keep the direction sample
    // current here as well as in onScroll.
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
    const prompt = [...el.querySelectorAll<HTMLElement>(".msg.user")]
      .find((row) => row.dataset.msgId === promptId);
    if (!prompt) {
      turnSheetPromptId.current = null;
      setTurnSheetPadding(0);
      return;
    }
    const port = el.getBoundingClientRect();
    const row = prompt.getBoundingClientRect();
    const paddingTop = Number.parseFloat(getComputedStyle(el).paddingTop) || 0;
    const promptContentTop = el.scrollTop + row.top - port.top;
    const previousAssistant = previousAssistantRow(prompt);
    const answerBubble = previousAssistant?.querySelector<HTMLElement>(":scope > .bubble") ?? null;
    const bubbleRect = answerBubble?.getBoundingClientRect();
    const bubbleStyle = answerBubble ? getComputedStyle(answerBubble) : null;
    const fontSize = Number.parseFloat(bubbleStyle?.fontSize ?? "") || 16;
    const lineHeight = Number.parseFloat(bubbleStyle?.lineHeight ?? "") || fontSize * 1.6;
    const contextOffset = bubbleRect ? freshTurnContextOffset({
      viewportHeight: el.clientHeight,
      promptHeight: row.height,
      responseHeight: bubbleRect.height,
      responseToPromptGap: Math.max(0, row.top - bubbleRect.bottom),
      responseLineHeight: lineHeight,
    }) : 0;
    const desiredScrollTop = Math.max(0, promptContentTop - paddingTop - contextOffset);
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
      } else {
        expectedScrollTop.current = null;
      }
      lastScrollTop.current = el.scrollTop;
    }
  }, [setTurnSheetPadding]);

  // Session changes restore their saved anchor. A later, monotonically newer
  // user event in the SAME session starts a fresh sheet and deliberately takes
  // focus away from whatever older reading position was held.
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

  // Model commits cover durable/streamed rows. Resize observation additionally
  // covers local disclosure animation and smoothed text renders, so an open
  // live action cannot grow underneath the composer/status dock.
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
    const mutations = typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
        observeRows();
        if (timelineMutationAffectsFollow(records)) refresh();
      })
      : null;
    mutations?.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "open", "aria-expanded"],
    });
    return () => {
      resize?.disconnect();
      mutations?.disconnect();
    };
  }, [sessionId, scrollToTail, syncTurnSheet]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteReaderIntent = (direction: "toward-history" | "toward-tail") => {
    // One physical gesture can deliver several scroll events (wheel momentum,
    // touch inertia, scrollbar drag). Keep its direction briefly, but never
    // infer intent from geometry alone: reflow emits the same scroll event.
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
    const programmatic = intent === null && expectedScrollTop.current !== null
      && Math.abs(el.scrollTop - expectedScrollTop.current) < 1;
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
  const isolated = useStore((s) =>
    s.activeSessionId !== null && s.sessions.find((x) => x.id === s.activeSessionId)?.isolation?.kind === "git-worktree");
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
  const visibleMessages = useMemo(() => model.messages.filter((message) => !message.undone && !blankAssistant(message)), [model]);
  const undoneMessages = useMemo(() => model.messages.filter((message) => message.undone && !blankAssistant(message)), [model]);
  const rows = useMemo(() => groupActivity(mergeThinking(visibleMessages)), [visibleMessages]);
  const undoneRows = useMemo(() => groupActivity(mergeThinking(undoneMessages)), [undoneMessages]);
  // A running turn keeps producing canonical activity after its soft rewind
  // marker. Those rows remain excluded from effective model history, but the
  // latest group stays visible so Revert never masquerades as Stop.
  const rewoundLiveActivity = model.rewind && turnWorking
    ? undoneRows.findLast((row): row is ActivityGroup =>
        row.kind === "activity"
        && row.items.some((item) => item.time >= (turn.startedAt ?? Number.POSITIVE_INFINITY)))
    : undefined;
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
      if (message.kind === "user" || message.kind === "github-conflict" || message.kind === "notice") {
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
      // Initial hydration is a newest-first window. An older saved anchor can
      // be absent until background backfill lands, so retain it while the
      // server still advertises earlier canonical events.
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
    if (revertPendingRef.current === sessionId) return;
    revertPendingRef.current = sessionId;
    setRevertPendingSession(sessionId);
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
    }).finally(() => {
      if (revertPendingRef.current === sessionId) {
        revertPendingRef.current = null;
        setRevertPendingSession(null);
      }
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
  // Pending approvals/secrets belong here: permissions and secure-safe render
  // in `session.timeline.after` from this context, not from a live store.
  const slotSummary = timelineAfterSlotContext({
    sessionId,
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
        onTouchStartCapture={(event) => { touchY.current = event.touches[0]?.clientY ?? null; }}
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
        onTouchEndCapture={() => { touchY.current = null; }}
        onTouchCancelCapture={() => { touchY.current = null; }}
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
        {chronologicalRows.map((entry) => {
          if (entry.kind === "timeline-event") {
            return <SlotHost
              key={entry.id}
              slot="session.timeline.event"
              context={{ ...slotSummary, event: entry.event }}
            />;
          }
          const r = entry.row;
          return r.kind === "activity"
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
            );
        })}
        {rewoundLiveActivity && (
          <ActivityRow
            key={`rewound-live-${rewoundLiveActivity.id}`}
            rev={activityRev(rewoundLiveActivity)}
            g={rewoundLiveActivity}
            subagents={model.subagents}
            state={currentActivityState}
          />
        )}
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
      <div className="activity-live-layer" />
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
