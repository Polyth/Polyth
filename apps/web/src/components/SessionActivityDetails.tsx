// The agent activity details: the context card, the figure tiles, the latest
// request and the plan, as two tabs or one view (Chat settings,
// `sessionActivityDetails`). The surface that holds them (the activity panel
// above the composer, the desktop session overview) owns geometry and
// dismissal; this component owns the blocks.
//
// The blocks are the person's to arrange (sessionActivityLayout.ts), the way an
// iOS Home Screen is, with no edit button on screen: holding any block still
// (ARRANGE_ACTIVATE_MS, any pointer) turns editing on and lifts that block at
// once, so the same press carries on as a drag (workspaceArrange.ts
// `activate`); holding an empty spot between the blocks turns it on too. While
// editing every block jiggles and takes no taps, the figures this agent does
// not report show as well, so the saved order is complete, and a dock floats
// over the bottom edge with the hint and Reset. Done (the activity panel's
// head, or the dock when the details stand alone), Escape or a tap beside the
// blocks ends it; the figures that only editing shows fade where they stood.
// Keyboard users reach a visually hidden "Arrange blocks" button instead. The
// tab that was open last opens again.
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { fmtCost, fmtDuration, fmtTokens } from "../format.ts";
import { tr, formatNumber } from "../i18n/index.ts";
import { tapFeedback } from "../haptics.ts";
import { contextUsageLabel, latestRequestExcerpt, reportedSessionUsage, sessionDurationMs, sessionMessageCounts } from "../sessionMetrics.ts";
import {
  activityBlock,
  activityBlocksOf,
  isDefaultActivityOrder,
  permuteActivityOrder,
  resetActivityOrder,
  setActivityOrder,
  setActivityTab,
  useActivityLayout,
  type ActivityBlockId,
  type ActivityTab,
} from "../sessionActivityLayout.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { useEscape } from "../useEscape.ts";
import { ARRANGE_ACTIVATE_MS, useArrange } from "../workspaceArrange.ts";
import { motionDurationMs } from "../motionPresence.ts";
import { contextTone, formatContextPercent, type ContextGauge, type RenderModel, type TaskListState } from "../reduce.ts";
import { Button, RefreshIcon, TabPanel, Tabs } from "./ui/index.ts";
import "./SessionActivityDetails.css";

type SessionTask = TaskListState["items"][number];

/** Finger travel that turns a hold on an empty spot into a scroll. */
const HOLD_SLOP_PX = 8;
const JIGGLE_PHASES = 7;
const TABS: readonly ActivityTab[] = ["stats", "content"];

/** A stable phase per block, from its id: reordering never restarts a wobble. */
function jigglePhase(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return Math.abs(hash) % JIGGLE_PHASES;
}

export interface SessionActivityDetailsProps {
  prompt?: string;
  modelName?: string | null;
  tasks: readonly SessionTask[];
  session: SessionProjection | null;
  model: RenderModel;
  usageEvents?: readonly SessionEvent[];
  gauge?: ContextGauge | null;
  contextNotice?: string | null;
  /** Controlled edit mode; the owner then draws Done (the activity panel's
   *  head). Without it the component keeps its own and puts Done in its dock. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

function progressOf(tasks: readonly SessionTask[]): { done: number; failed: number; percent: number } {
  const done = tasks.filter((task) => task.status === "done").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  return { done, failed, percent: tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0 };
}

function TaskMark({ status }: { status: SessionTask["status"] }) {
  if (status === "done") return <span className="session-activity-task-mark is-done" aria-hidden="true">✓</span>;
  if (status === "failed") return <span className="session-activity-task-mark is-failed" aria-hidden="true">×</span>;
  if (status === "active") return <span className="session-activity-task-mark is-active" aria-hidden="true"><i /></span>;
  return <span className="session-activity-task-mark is-pending" aria-hidden="true" />;
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={`session-activity-stat${value === null ? " is-unreported" : ""}`}>
      <span className="session-activity-stat-label">{label}</span>
      <strong className="session-activity-stat-value">{value ?? "—"}</strong>
    </div>
  );
}

/** The context-window card: used/limit, percent and a level-tinted meter.
 *  Shared by the activity details and the composer's context pie so both
 *  surfaces word and color the same gauge identically. */
export function ContextUsageCard({
  gauge,
  contextNotice,
  modelName,
}: Pick<SessionActivityDetailsProps, "gauge" | "contextNotice" | "modelName">) {
  const contextPercent = gauge?.percent ?? null;
  const contextPercentLabel = gauge ? formatContextPercent(gauge) : null;
  const contextValue = contextUsageLabel(gauge, contextPercentLabel, contextNotice, tr("common.unavailable"), fmtTokens);
  return (
    <div className="session-activity-context-card">
      <div className="session-activity-context-head">
        <span className="session-activity-section-label">{tr("capabilities.context")}</span>
        {contextPercentLabel && contextPercentLabel !== contextValue && <span className="session-activity-context-percent">{contextPercentLabel}</span>}
      </div>
      <strong className="session-activity-context-value">{contextValue}</strong>
      <div
        className={`session-activity-meter level-${gauge ? contextTone(gauge) : "unknown"}`}
        role="progressbar"
        aria-label={tr("capabilities.context")}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(contextPercentLabel && contextPercent !== null ? { "aria-valuenow": Math.min(100, Math.max(0, contextPercent)) } : { "aria-valuetext": contextValue })}
      >
        <span style={{ width: contextPercent === null ? "0%" : `${contextPercent}%` }} />
      </div>
      {modelName && <span className="session-activity-context-model">{modelName}</span>}
    </div>
  );
}

function RequestBlock({ prompt }: { prompt: string | undefined }) {
  const latestRequest = latestRequestExcerpt(prompt);
  return (
    <section className="session-activity-intent">
      <span className="session-activity-section-label">{tr("sessionActivity.latestRequestExcerpt")}</span>
      <p>{latestRequest || tr("mobile.island.noPrompt")}</p>
    </section>
  );
}

function PlanBlock({ tasks }: { tasks: readonly SessionTask[] }) {
  if (tasks.length === 0) {
    return (
      <section className="session-activity-plan is-empty">
        <span className="session-activity-section-label">{tr("timeline.currentTaskPlan")}</span>
        <p>{tr("sessionActivity.noPlan")}</p>
      </section>
    );
  }
  const progress = progressOf(tasks);
  return (
    <section className="session-activity-plan">
      <div className="session-activity-section-head">
        <div>
          <span className="session-activity-section-label">{tr("timeline.currentTaskPlan")}</span>
          <strong>{`${formatNumber(progress.done)}/${formatNumber(tasks.length)} ${tr("timeline.completed").toLowerCase()}${progress.failed > 0 ? ` · ${formatNumber(progress.failed)} ${tr("timeline.failed")}` : ""}`}</strong>
        </div>
        <span className="session-activity-plan-percent">{progress.percent}%</span>
      </div>
      <div className="session-activity-meter session-activity-plan-meter" role="progressbar" aria-label={tr("timeline.currentTaskPlan")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <ul className="session-activity-task-list">
        {tasks.map((task) => (
          <li key={task.id} className={`is-${task.status}`}>
            <TaskMark status={task.status} />
            <span>{task.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function blockLabel(id: ActivityBlockId): string {
  switch (id) {
    case "context": return tr("capabilities.context");
    case "duration": return tr("chatmetrics.duration");
    case "messages": return tr("chatmetrics.messages");
    case "tokens": return tr("chatmetrics.tokens");
    case "cost": return tr("timeline.cost");
    case "input": return tr("timeline.input");
    case "output": return tr("timeline.output");
    case "cacheRead": return tr("sessionActivity.cacheRead");
    case "cacheWrite": return tr("sessionActivity.cacheWrite");
    case "request": return tr("sessionActivity.latestRequestExcerpt");
    case "plan": return tr("timeline.currentTaskPlan");
  }
}

/** The nearest ancestor that scrolls the blocks (the panel body or popover). */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return element;
}

/** Hold `scroller` at the height it has now (it may still shrink when its
 *  surface does: the keyboard). Not when the blocks scroll themselves. */
function pinHeight(scroller: HTMLElement | null, grid: HTMLElement | null): HTMLElement | null {
  if (!scroller || scroller === grid || typeof scroller.getBoundingClientRect !== "function") return null;
  const height = scroller.getBoundingClientRect().height;
  if (height <= 0) return null;
  scroller.style.flex = "0 1 auto";
  scroller.style.height = `${height}px`;
  return scroller;
}

function unpinHeight(scroller: HTMLElement | null): void {
  scroller?.style.removeProperty("flex");
  scroller?.style.removeProperty("height");
}

interface LeavingCopy {
  element: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Copies of the blocks not in `staying`, where they sit now, relative to `host`. */
function copyLeaving(grid: HTMLElement | null, host: HTMLElement | null, staying: ReadonlySet<string>): LeavingCopy[] {
  if (!grid || !host || typeof grid.getBoundingClientRect !== "function") return [];
  if (motionDurationMs("--motion-normal") <= 0) return [];
  const frame = host.getBoundingClientRect();
  return [...grid.querySelectorAll<HTMLElement>("[data-activity-block]")]
    .filter((block) => !staying.has(block.dataset.activityBlock ?? ""))
    .map((block) => {
      const box = block.getBoundingClientRect();
      const element = block.cloneNode(true) as HTMLElement;
      for (const attribute of ["data-activity-block", "data-arrange-id", "data-arrange-pressing", "tabindex", "role", "aria-label", "id"]) {
        element.removeAttribute(attribute);
      }
      element.classList.add("is-leaving");
      element.setAttribute("aria-hidden", "true");
      return { element, left: box.left - frame.left, top: box.top - frame.top, width: box.width, height: box.height };
    });
}

/** The copies sink and fade where their blocks stood, then go. */
function playLeaving(copies: readonly LeavingCopy[], host: HTMLElement | null): void {
  const duration = motionDurationMs("--motion-normal");
  if (!host || duration <= 0) return;
  for (const copy of copies) {
    Object.assign(copy.element.style, { left: `${copy.left}px`, top: `${copy.top}px`, width: `${copy.width}px`, height: `${copy.height}px` });
    host.append(copy.element);
    if (typeof copy.element.animate !== "function") {
      copy.element.remove();
      continue;
    }
    const animation = copy.element.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.9)" }],
      { duration, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    const done = () => copy.element.remove();
    animation.addEventListener("finish", done);
    animation.addEventListener("cancel", done);
  }
}

export default function SessionActivityDetails({
  prompt,
  modelName,
  tasks,
  session,
  model,
  usageEvents,
  gauge,
  contextNotice,
  editing: editingProp,
  onEditingChange,
}: SessionActivityDetailsProps) {
  const prefs = useUiSettings();
  const layout = useActivityLayout();
  const [ownEditing, setOwnEditing] = useState(false);
  const editing = editingProp ?? ownEditing;
  const [now, setNow] = useState(() => Date.now());
  const tabsId = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // A hold on an empty spot between the blocks also turns editing on; the
  // click that ends that hold must not count as the tap that ends editing.
  const hold = useRef<{ pointerId: number; timer: number; x: number; y: number } | null>(null);
  const heldIn = useRef(false);
  // Entered from the keyboard: focus lands on the first block to move.
  const focusFirst = useRef(false);
  const durationMs = sessionDurationMs(session, model, now);
  const usage = useMemo(() => reportedSessionUsage(model.totals, usageEvents), [model.totals, usageEvents]);
  const messageCount = sessionMessageCounts(model).visible;
  const showTabs = prefs.sessionActivityDetails === "tabs";
  const tab = layout.tab;
  const scope = showTabs ? tab : null;
  // Set by a switch made here, so the first open does not slide a tab in.
  const [switched, setSwitched] = useState(false);
  const chooseTab = (next: ActivityTab) => {
    if (next === tab) return;
    setSwitched(true);
    setActivityTab(next);
  };

  const editingRef = useRef(editing);
  editingRef.current = editing;
  const setEditing = (next: boolean) => {
    if (next === editingRef.current) return;
    if (onEditingChange) onEditingChange(next);
    else setOwnEditing(next);
  };
  const finishEditing = () => {
    if (!editingRef.current) return;
    setEditing(false);
    tapFeedback();
  };
  // Escape (and Android Back) leaves the edit mode before it can close the
  // surface around it: the mode is the topmost Escape layer.
  useEscape(editing, finishEditing);

  useEffect(() => {
    if (model.turn?.status !== "working" || model.messages.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [model.turn?.status, model.turn?.startedAt, model.messages.length]);

  const tokenValue = (value: number | null) => value === null ? null : fmtTokens(value);
  const figures: Partial<Record<ActivityBlockId, string | null>> = {
    duration: durationMs === null ? null : fmtDuration(durationMs),
    messages: formatNumber(messageCount),
    tokens: tokenValue(usage.tokens),
    cost: usage.cost === null ? null : fmtCost(usage.cost),
    input: tokenValue(usage.input),
    output: tokenValue(usage.output),
    cacheRead: tokenValue(usage.cacheRead),
    cacheWrite: tokenValue(usage.cacheWrite),
  };
  const reported = (id: ActivityBlockId): boolean => {
    if (id === "plan") return tasks.length > 0 || showTabs;
    return activityBlock(id).shape === "row" || figures[id] !== null;
  };
  const scopeBlocks = activityBlocksOf(layout.order, scope);
  // Editing shows every block of the view, so the order saved is complete.
  const shown = editing ? scopeBlocks : scopeBlocks.filter(reported);
  const unreported = editing ? [] : scopeBlocks.filter((id) => activityBlock(id).shape === "tile" && figures[id] === null);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const arrange = useArrange({
    items: shown.map((id) => ({ id, shape: activityBlock(id).shape })),
    enabled: editing,
    scroller: () => scrollParent(gridRef.current),
    ghostHost: () => rootRef.current,
    // Holding a block outside editing turns editing on and lifts it at once:
    // the editing layout must be on screen before the engine lifts the copy.
    activate: () => {
      if (editingRef.current) return false;
      flushSync(() => setEditing(true));
      return true;
    },
    onCommit: (next) => setActivityOrder(permuteActivityOrder(layoutRef.current.order, next as ActivityBlockId[])),
  });
  const { engine, order, draggingId } = arrange;
  // Entering or leaving the mode shows or hides the figures this agent does
  // not report and the dock: snapshot the blocks while the DOM still has the
  // old layout, so the newcomers grow in and the rest glide instead of
  // jumping. On the way out, copies of the blocks that go fade where they
  // stood (taken now, before React removes them, played after the commit).
  // Like a Home Screen, the surface keeps its size while the blocks are
  // arranged (what no longer fits scrolls), so its edge never jumps: the
  // scroller's height is pinned here, before the commit, so the engine
  // measures the layout that is shown; leaving lets it go after the snapshot.
  const renderedEditing = useRef(editing);
  const leaving = useRef<LeavingCopy[]>([]);
  const pinned = useRef<HTMLElement | null>(null);
  if (renderedEditing.current !== editing) {
    renderedEditing.current = editing;
    engine.animateNextLayout();
    if (editing) pinned.current = pinHeight(scrollParent(gridRef.current), gridRef.current);
    else {
      leaving.current = copyLeaving(gridRef.current, rootRef.current, new Set(scopeBlocks.filter(reported)));
      unpinHeight(pinned.current);
      pinned.current = null;
    }
  }
  useLayoutEffect(() => {
    const copies = leaving.current;
    if (copies.length === 0) return;
    leaving.current = [];
    playLeaving(copies, rootRef.current);
  });
  useEffect(() => () => unpinHeight(pinned.current), []);

  const endHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => endHold, []);
  useEffect(() => {
    if (!editing || !focusFirst.current) return;
    focusFirst.current = false;
    gridRef.current?.querySelector<HTMLElement>("[data-activity-block]")?.focus({ preventScroll: true });
  }, [editing]);
  const emptySpot = (target: EventTarget | null) => {
    const element = target as Element | null;
    return typeof element?.closest === "function" && !element.closest("[data-activity-block], button, a, input, textarea, select");
  };

  const gridProps = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (editing || hold.current || !emptySpot(event.target) || (event.pointerType === "mouse" && event.button !== 0)) return;
      hold.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
          hold.current = null;
          heldIn.current = true;
          tapFeedback();
          setEditing(true);
        }, ARRANGE_ACTIVATE_MS),
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const pending = hold.current;
      if (pending && event.pointerId === pending.pointerId
        && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > HOLD_SLOP_PX) endHold();
    },
    onPointerUp: endHold,
    onPointerCancel: endHold,
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
      // Android raises its menu at the same hold that turns editing on.
      const target = event.target as Element;
      if (editing || hold.current || target.closest?.("[data-arrange-pressing]")) event.preventDefault();
    },
  };

  const renderBlock = (id: ActivityBlockId): ReactNode => {
    switch (id) {
      case "context": return <ContextUsageCard gauge={gauge} contextNotice={contextNotice} modelName={modelName} />;
      case "request": return <RequestBlock prompt={prompt} />;
      case "plan": return <PlanBlock tasks={tasks} />;
      default: return <Stat label={blockLabel(id)} value={figures[id] ?? null} />;
    }
  };

  // What this agent does not report is said once, right after its figures.
  const footnote = unreported.length > 0
    ? <p className="session-activity-footnote">{tr("sessionActivity.notReported", { items: unreported.map(blockLabel).join(" · ") })}</p>
    : null;
  const footnoteAfter = order.reduce((last, id, index) => activityBlock(id as ActivityBlockId).shape === "tile" ? index : last, -1);

  const blocks = (
    <div
      ref={(element) => {
        gridRef.current = element;
        engine.listRef(element);
      }}
      className="session-activity-blocks"
      // A few tiles share the line instead of leaving its end empty. Counted
      // from what shows outside editing, so the figures editing adds wrap
      // onto more lines instead of resizing every block under the finger.
      data-tiles={Math.min(4, scopeBlocks.filter((id) => activityBlock(id).shape === "tile" && reported(id)).length)}
      {...gridProps}
    >
      {order.map((value, index) => {
        const id = value as ActivityBlockId;
        const { shape } = activityBlock(id);
        const item = engine.itemProps(id);
        return (
          <Fragment key={id}>
          <div
            className={`session-activity-block is-${shape}${draggingId === id ? " is-hole" : ""}`}
            data-activity-block={id}
            data-editing={editing ? "true" : undefined}
            style={{ "--jiggle-phase": jigglePhase(id) } as CSSProperties}
            {...item}
            {...(editing ? {
              tabIndex: 0,
              role: "button",
              "aria-label": tr("workspace.panel.moveValue", { value: blockLabel(id) }),
              onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => engine.onArrangeKey(id, event),
            } : {})}
          >
            {renderBlock(id)}
          </div>
          {index === footnoteAfter && footnote}
          </Fragment>
        );
      })}
      {footnoteAfter < 0 && footnote}
    </div>
  );

  const progress = progressOf(tasks);
  const tabIndex = TABS.indexOf(tab);
  const lastTabIndex = useRef(tabIndex);
  const direction = tabIndex >= lastTabIndex.current ? "forward" : "back";
  useEffect(() => { lastTabIndex.current = tabIndex; }, [tabIndex]);

  return (
    <div
      ref={rootRef}
      className={`session-activity-details${showTabs ? " has-tabs" : " is-combined"}`}
      data-editing={editing ? "true" : undefined}
      data-arrange-dragging={draggingId ? "true" : undefined}
      // A new press forgets a hold whose release landed elsewhere.
      onPointerDownCapture={() => { heldIn.current = false; }}
      onClick={(event) => {
        if (heldIn.current) {
          heldIn.current = false;
          return;
        }
        // A tap beside the blocks ends editing, as on a Home Screen.
        if (editing && emptySpot(event.target) && !(event.target as Element).closest("[role='tab']")) finishEditing();
      }}
    >
      {showTabs && (
        <Tabs
          idBase={tabsId}
          label={tr("timeline.activityDetail")}
          value={tab}
          tabs={[
            { id: "stats", label: tr("sessionActivity.usageTab") },
            {
              id: "content",
              label: <>
                {tr("sessionActivity.contentTab")}
                {tasks.length > 0 && <span className="session-activity-tab-count">{`${formatNumber(progress.done)}/${formatNumber(tasks.length)}`}</span>}
              </>,
            },
          ]}
          onChange={(value) => {
            if (value === "stats" || value === "content") chooseTab(value);
          }}
          className="session-activity-tabs"
          size="md"
        />
      )}
      {showTabs ? (
        <div
          className="session-activity-swipe-content"
          data-direction={direction}
          data-switched={switched ? "" : undefined}
          onPointerDown={(event) => {
            if (editing || event.pointerType !== "touch" || (event.target as Element).closest("button, a, input, select, textarea")) return;
            touchStart.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={(event) => {
            const start = touchStart.current;
            touchStart.current = null;
            if (editing || event.pointerType !== "touch" || !start) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
            chooseTab(dx < 0 ? "content" : "stats");
          }}
          onPointerCancel={() => { touchStart.current = null; }}
        >
          <TabPanel key={tab} idBase={tabsId} tabId={tab} active className="session-activity-tab-panel">
            {blocks}
          </TabPanel>
        </div>
      ) : blocks}
      {/* Floats over the bottom edge of whatever scrolls the blocks: what a
          held block does, and the way back to the default order. Standing
          alone (the desktop overview) the details put Done here too. */}
      {editing && (
        <div className="session-activity-edit-dock" role="toolbar" aria-label={tr("sessionActivity.arrange")}>
          <p className="session-activity-edit-hint">{tr("sessionActivity.arrangeHint")}</p>
          <Button
            size="sm"
            variant="ghost"
            iconStart={RefreshIcon}
            disabled={isDefaultActivityOrder(layout.order)}
            onClick={() => { engine.animateNextLayout(); resetActivityOrder(); }}
          >
            {tr("workspace.panel.reset")}
          </Button>
          {!onEditingChange && (
            <button type="button" className="session-activity-done" onClick={finishEditing}>{tr("common.done")}</button>
          )}
        </div>
      )}
      {/* The way in without a long press: shown only when the keyboard
          reaches it, so touch and pointer screens stay as calm as iOS's. */}
      {!editing && (
        <button
          type="button"
          className="session-activity-arrange-entry"
          onClick={() => {
            focusFirst.current = true;
            setEditing(true);
          }}
        >
          {tr("sessionActivity.arrange")}
        </button>
      )}
    </div>
  );
}
