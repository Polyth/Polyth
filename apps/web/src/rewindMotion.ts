import { claimTimelineMotion } from "./timelineMotionClaims.ts";
import { timelineLiftMotionDisabled } from "./timelineLift.ts";
import { timelineVisibleArea } from "./timelineVisibleArea.ts";

/**
 * Rewind motion is one restrained layout transition, not a second send
 * animation. The action captures the visible timeline, lets the reversible
 * tail leave, and the commit that applies the canonical event settles the
 * remaining rows with a single FLIP. Prompt echoes keep using chatMotion's
 * normal composer-to-timeline transition.
 *
 * Revert & edit is not here: Timeline keeps the confirmed cut in place for a
 * model-driven exit, then glides the survivors with the tail-lift engine.
 */

export type RewindMotionKind = "restore" | "regenerate";

const PENDING_TTL_MS = 4_000;
const REGENERATE_EXIT_MS = 120;
const ENTER_MS = 180;
const REFLOW_MS = 220;
const MAX_TRAVEL_PX = 720;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

interface Snapshot {
  timeline: HTMLElement;
  rows: Array<{ element: HTMLElement; top: number }>;
}

interface Pending {
  kind: RewindMotionKind;
  sessionId: string;
  atSeq: number;
  snapshot: Snapshot;
  exits: Animation[];
  exiting: HTMLElement[];
  /** Regenerate keeps the source prompt's screen position as its anchor. */
  promptTop?: number;
  createdAt: number;
}

let pending: Pending | null = null;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function motionOff(): boolean {
  return timelineLiftMotionDisabled();
}

function intersects(element: HTMLElement, area: ReturnType<typeof timelineVisibleArea>): boolean {
  const rect = element.getBoundingClientRect();
  return rect.height > 0 && rect.bottom > area.top && rect.top < area.bottom;
}

function timelineRows(timeline: HTMLElement): HTMLElement[] {
  return Array.from(timeline.children).filter((child): child is HTMLElement =>
    child instanceof HTMLElement
    && !child.classList.contains("timeline-extent-floor")
    && !child.classList.contains("sr-only")
    && !child.hasAttribute("hidden"));
}

function capture(timeline: HTMLElement): Snapshot {
  const area = timelineVisibleArea(timeline);
  return {
    timeline,
    rows: timelineRows(timeline)
      .filter((element) => intersects(element, area))
      .map((element) => ({ element, top: element.getBoundingClientRect().top })),
  };
}

function rowFor(timeline: HTMLElement, seq: number): HTMLElement | null {
  const marked = timeline.querySelector<HTMLElement>(`:scope > .msg.user[data-message-seq="${seq}"]`);
  if (marked) return marked;
  const actions = timeline.querySelector<HTMLElement>(`[data-actions-seq="${seq}"]`);
  const row = actions?.closest<HTMLElement>(".msg.user") ?? null;
  return row?.parentElement === timeline ? row : null;
}

function tailAfter(
  timeline: HTMLElement,
  row: HTMLElement,
  inclusive: boolean,
  area: ReturnType<typeof timelineVisibleArea>,
): HTMLElement[] {
  const rows = timelineRows(timeline);
  const at = rows.indexOf(row);
  if (at < 0) return [];
  return rows.slice(inclusive ? at : at + 1)
    .filter((element) => !element.matches("[data-pending-send], .msg-live"))
    .filter((element) => intersects(element, area));
}

function fadeOut(elements: readonly HTMLElement[]): Animation[] {
  const animations: Animation[] = [];
  for (const element of elements) {
    if (typeof element.animate !== "function") continue;
    const previousWillChange = element.style.willChange;
    element.style.willChange = "opacity, transform";
    const animation = element.animate([
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
      { opacity: 0, transform: "translate3d(0, 4px, 0)" },
    ], {
      duration: REGENERATE_EXIT_MS,
      easing: EASE,
      fill: "forwards",
    });
    animations.push(animation);
    void animation.finished.catch(() => undefined).finally(() => {
      if (element.isConnected) element.style.willChange = previousWillChange;
    });
  }
  return animations;
}

function restoreExits(entry: Pending, animateBack: boolean): void {
  for (const animation of entry.exits) animation.cancel();
  if (!animateBack || motionOff()) return;
  for (const element of entry.exiting) {
    if (!element.isConnected || typeof element.animate !== "function") continue;
    const animation = element.animate([
      { opacity: 0, transform: "translate3d(0, 4px, 0)" },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], { duration: ENTER_MS, easing: EASE });
    void animation.finished.catch(() => undefined);
  }
}

function supersede(): void {
  if (!pending) return;
  restoreExits(pending, true);
  pending = null;
}

function begin(entry: Omit<Pending, "createdAt">): boolean {
  supersede();
  pending = { ...entry, createdAt: now() };
  return true;
}

/** Capture the cut before Restore reveals the original tail. */
export function beginRestoreMotion(sessionId: string, atSeq: number, timeline: HTMLElement): boolean {
  if (motionOff()) return false;
  return begin({
    kind: "restore",
    sessionId,
    atSeq,
    snapshot: capture(timeline),
    exiting: [],
    exits: [],
  });
}

/** Regenerate leaves the answer, while the source prompt remains the anchor. */
export function beginRegenerateMotion(sessionId: string, atSeq: number, timeline: HTMLElement | null): boolean {
  if (motionOff() || !timeline) return false;
  const row = rowFor(timeline, atSeq);
  if (!row) return false;
  const area = timelineVisibleArea(timeline);
  const exiting = tailAfter(timeline, row, false, area);
  return begin({
    kind: "regenerate",
    sessionId,
    atSeq,
    snapshot: capture(timeline),
    exiting,
    exits: fadeOut(exiting),
    promptTop: row.getBoundingClientRect().top,
  });
}

/** A failed mutation brings its optimistic exit back. */
export function cancelRewindMotion(sessionId: string, atSeq: number): void {
  if (!pending || pending.sessionId !== sessionId || pending.atSeq !== atSeq) return;
  const entry = pending;
  pending = null;
  restoreExits(entry, true);
}

function release(animation: Animation, element: HTMLElement, previousWillChange: string): void {
  void animation.finished.catch(() => undefined).finally(() => {
    if (element.isConnected) element.style.willChange = previousWillChange;
    if (animation.playState === "finished") animation.cancel();
  });
}

function glide(element: HTMLElement, fromTop: number, limit: number): Animation | null {
  if (typeof element.animate !== "function") return null;
  let delta = fromTop - element.getBoundingClientRect().top;
  if (Math.abs(delta) < 1) return null;
  if (Math.abs(delta) > limit) delta = Math.sign(delta) * limit;
  claimTimelineMotion(element);
  const previousWillChange = element.style.willChange;
  element.style.willChange = "transform";
  const animation = element.animate([
    { transform: `translate3d(0, ${delta}px, 0)` },
    { transform: "translate3d(0, 0, 0)" },
  ], {
    duration: REFLOW_MS,
    easing: EASE,
    fill: "both",
  });
  release(animation, element, previousWillChange);
  return animation;
}

function enter(element: HTMLElement): Animation | null {
  claimTimelineMotion(element);
  if (typeof element.animate !== "function") return null;
  const previousWillChange = element.style.willChange;
  element.style.willChange = "opacity, transform";
  const animation = element.animate([
    { opacity: 0, transform: "translate3d(0, 4px, 0)" },
    { opacity: 1, transform: "translate3d(0, 0, 0)" },
  ], {
    duration: ENTER_MS,
    easing: EASE,
    fill: "both",
  });
  release(animation, element, previousWillChange);
  return animation;
}

export interface RewindMotionState {
  sessionId: string | null;
  /** `model.rewind.atSeq`, or null when no rewind is active. */
  rewindAtSeq: number | null;
  /** Optimistic prompt echoes currently rendered for this session. */
  echoIds: readonly string[];
}

function ready(entry: Pending, state: RewindMotionState): boolean {
  if (entry.sessionId !== state.sessionId) return false;
  if (entry.kind === "restore") return state.rewindAtSeq === null;
  if (state.rewindAtSeq !== entry.atSeq) return false;
  return state.echoIds.length > 0;
}

/**
 * Settle from Timeline's layout effect in the commit that renders the new
 * canonical state. The returned promise lasts only for the compact reflow.
 */
export function settleRewindMotion(timeline: HTMLElement, state: RewindMotionState): Promise<void> | null {
  const entry = pending;
  if (!entry) return null;
  if (
    now() - entry.createdAt > PENDING_TTL_MS
    || entry.snapshot.timeline !== timeline
    || entry.sessionId !== state.sessionId
  ) {
    pending = null;
    restoreExits(entry, true);
    return null;
  }
  if (!ready(entry, state)) return null;

  pending = null;
  restoreExits(entry, false);
  const area = timelineVisibleArea(timeline);
  const limit = Math.max(Math.min(area.height, MAX_TRAVEL_PX), 1);
  const before = new Map(entry.snapshot.rows.map((row) => [row.element, row.top]));
  const animations: Array<Animation | null> = [];
  const handled = new Set<HTMLElement>();
  const lastEchoId = state.echoIds.at(-1);

  for (const element of timelineRows(timeline)) {
    if (handled.has(element)) continue;
    handled.add(element);
    if (entry.kind === "regenerate" && lastEchoId && element.dataset.pendingSend === lastEchoId) {
      if (entry.promptTop !== undefined) animations.push(glide(element, entry.promptTop, limit));
      continue;
    }
    const top = before.get(element);
    if (top !== undefined) {
      animations.push(glide(element, top, limit));
      continue;
    }
    // A normal optimistic prompt is owned by chatMotion. The rewind only
    // supplies the replacement echo above when regeneration reuses the source
    // prompt in place.
    if (element.matches("[data-pending-send]")) continue;
    if (intersects(element, area)) animations.push(enter(element));
  }

  const running = animations.filter((animation): animation is Animation => animation !== null);
  if (running.length === 0) return Promise.resolve();
  return Promise.allSettled(running.map((animation) => animation.finished)).then(() => undefined);
}

/** Test seam: the pending choreography, if any. */
export function pendingRewindMotion(): { kind: RewindMotionKind; sessionId: string; atSeq: number } | null {
  return pending ? { kind: pending.kind, sessionId: pending.sessionId, atSeq: pending.atSeq } : null;
}
