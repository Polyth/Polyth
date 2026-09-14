const USER_SEND_TTL_MS = 8_000;
const SEND_TRANSITION_TTL_MS = 1_800;
const NAVIGATION_QUIET_MS = 180;
const DESKTOP_DURATION_MS = 300;
const TOUCH_DURATION_MS = 260;
const STATUS_DURATION_MS = 220;
const SEND_LIFT_DESKTOP_MS = 360;
const SEND_LIFT_TOUCH_MS = 420;
const DESKTOP_DISTANCE_PX = 8;
const TOUCH_DISTANCE_PX = 6;
const PROMPT_SETTLE_PX = 2;
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";
const SEND_LIFT_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

const LIVE_ROW_SELECTOR = [
  ".msg.user",
  ".msg.assistant",
  ".activity-group",
  ".activity-live",
  ".execution-row",
  ".reasoning",
  ".task-activity",
  ".github-conflict-card",
].join(",");
const TOP_LEVEL_TIMELINE_ROW_SELECTOR = ".msg, .activity-group, .activity-live, .task-activity, .github-conflict-card";

interface RectSnapshot {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface SendTransitionSnapshot {
  capturedAt: number;
  source: RectSnapshot | null;
  timeline: HTMLElement | null;
  rows: Array<{ element: HTMLElement; rect: RectSnapshot }>;
}

let pendingUserSendUntil = 0;
let pendingSendTransition: SendTransitionSnapshot | null = null;
let quietUntil = 0;
let navigationPending = false;
let lastLocation = typeof location === "undefined" ? "" : location.href;
const animated = new WeakSet<HTMLElement>();

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function motionDisabled(): boolean {
  if (typeof document === "undefined") return true;
  if (document.hidden) return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function touchProfile(): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(pointer: coarse)").matches || matchMedia("(max-width: 620px)").matches;
}

function snapshotRect(rect: DOMRect): RectSnapshot {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function composerAnchor(): RectSnapshot | null {
  const composerInput = document.querySelector<HTMLElement>(".composer-chat [data-composer-input]")
    ?? document.querySelector<HTMLElement>(".composer-chat .composer-input");
  return composerInput ? snapshotRect(composerInput.getBoundingClientRect()) : null;
}

function captureSendTransition(): SendTransitionSnapshot | null {
  if (motionDisabled()) return null;
  const timeline = document.querySelector<HTMLElement>(".timeline");
  const viewport = timeline?.getBoundingClientRect();
  const rows: SendTransitionSnapshot["rows"] = [];
  if (timeline && viewport) {
    for (const child of Array.from(timeline.children)) {
      if (!(child instanceof HTMLElement) || !child.matches(TOP_LEVEL_TIMELINE_ROW_SELECTOR)) continue;
      const rect = child.getBoundingClientRect();
      // Only rows the reader can currently see participate in the FLIP. Rows
      // already outside the viewport need no animation and would waste work.
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      rows.push({ element: child, rect: snapshotRect(rect) });
    }
  }
  return {
    capturedAt: now(),
    source: composerAnchor(),
    timeline,
    rows,
  };
}

function markUserSend(): void {
  pendingUserSendUntil = now() + USER_SEND_TTL_MS;
  pendingSendTransition = captureSendTransition();
  // A deliberate send establishes a live continuation even when the current
  // screen was reached by navigation moments earlier.
  navigationPending = false;
  quietUntil = 0;
}

function consumeUserSend(): boolean {
  if (pendingUserSendUntil <= now()) {
    pendingUserSendUntil = 0;
    pendingSendTransition = null;
    return false;
  }
  pendingUserSendUntil = 0;
  return true;
}

function consumeSendTransition(): SendTransitionSnapshot | null {
  const snapshot = pendingSendTransition;
  pendingSendTransition = null;
  if (!snapshot || now() - snapshot.capturedAt > SEND_TRANSITION_TTL_MS) return null;
  return snapshot;
}

function markNavigation(): void {
  // Creating the first session changes the route as part of the send. Do not
  // treat that as historical navigation or the freshly sent prompt would lose
  // its entrance motion.
  if (pendingUserSendUntil > now()) return;
  pendingSendTransition = null;
  navigationPending = true;
  quietUntil = now() + NAVIGATION_QUIET_MS;
}

function installHistoryWatcher(): void {
  const pushState = history.pushState.bind(history);
  history.pushState = ((...args: Parameters<History["pushState"]>) => {
    const before = location.href;
    pushState(...args);
    if (location.href !== before) markNavigation();
  }) as History["pushState"];

  const replaceState = history.replaceState.bind(history);
  history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
    const before = location.href;
    replaceState(...args);
    if (location.href !== before) markNavigation();
  }) as History["replaceState"];

  addEventListener("popstate", markNavigation, { passive: true });
}

function isTextEntry(target: Element): boolean {
  return target.matches("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
}

function installSendWatcher(): void {
  document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const send = target?.closest<HTMLButtonElement>(".composer-chat button.send");
    if (send && !send.disabled) markUserSend();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !isTextEntry(target) || !target.closest(".composer-chat")) return;
    markUserSend();
  }, true);
}

function topLevelTimelineRow(element: HTMLElement, timeline: HTMLElement): HTMLElement | null {
  let row: HTMLElement | null = element;
  while (row?.parentElement && row.parentElement !== timeline) row = row.parentElement;
  return row?.parentElement === timeline ? row : null;
}

function nearTimelineTail(element: HTMLElement): boolean {
  const timeline = element.closest<HTMLElement>(".timeline");
  if (!timeline) return false;
  const row = topLevelTimelineRow(element, timeline);
  if (!row) return false;
  let meaningfulFollowers = 0;
  for (let sibling = row.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    if (!(sibling instanceof HTMLElement)) continue;
    if (sibling.matches(".msg, .activity-group, .activity-live, .task-activity, .github-conflict-card")) meaningfulFollowers += 1;
    if (meaningfulFollowers > 2) return false;
  }
  return true;
}

function playTransform(
  element: HTMLElement,
  deltaY: number,
  duration: number,
  opacityFrom = 1,
  settle = false,
): boolean {
  if (typeof element.animate !== "function" || Math.abs(deltaY) < 1) return false;
  const previousWillChange = element.style.willChange;
  element.style.willChange = "opacity, transform";
  const keyframes: Keyframe[] = [
    { opacity: opacityFrom, transform: `translate3d(0, ${deltaY}px, 0)` },
    // Opacity lands early on its own offset: a fade stretched across the whole
    // travel reads as a smear, while a solid row gliding into place reads as
    // one object moving. Transform still spans the full duration.
    { opacity: 1, offset: settle ? 0.28 : 0.32 },
    ...(settle ? [{
      opacity: 1,
      transform: `translate3d(0, -${PROMPT_SETTLE_PX}px, 0)`,
      offset: 0.88,
    }] : []),
    { opacity: 1, transform: "translate3d(0, 0, 0)" },
  ];
  const animation = element.animate(keyframes, {
    duration,
    easing: SEND_LIFT_EASE,
    fill: "both",
  });
  void animation.finished.catch(() => undefined).finally(() => {
    if (element.isConnected) element.style.willChange = previousWillChange;
    // Release the filled end state. It equals the element's natural style, and
    // a retained fill would outrank the CSS exit transition on the same row.
    if (animation.playState === "finished") animation.cancel();
  });
  return true;
}

/** Vertical origin of a row that should appear to come out of the composer.
 *  The composer sits immediately below the timeline on phones, so the seam is
 *  the floor: start there rather than beyond the overflow clip. */
function composerOrigin(element: HTMLElement, timeline: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const floor = timeline.getBoundingClientRect().bottom - Math.min(12, rect.height);
  const anchor = composerAnchor();
  return (anchor ? Math.min(anchor.top, floor) : floor) - rect.top;
}

/** The flying row lives in `.activity-live-layer`, a sibling of the scroller.
 *  `closest(".timeline")` therefore misses after portal; the viewport still
 *  owns the composer seam used as the rise origin. */
function actionRiseTimeline(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>(".timeline")
    ?? element.closest(".timeline-viewport")?.querySelector<HTMLElement>(":scope > .timeline")
    ?? null;
}

/** Every agent action enters the way a prompt does: it rises out of the
 *  composer, then folds into the activity block when it settles. */
function playActionRise(element: HTMLElement): void {
  if (animated.has(element) || motionDisabled()) return;
  // A transient in-flow mount would inflate scroller overflow; only rise once
  // the row lives in the clipped viewport overlay beside the scroller.
  if (element.closest(".timeline") && !element.closest(".activity-live-layer")) return;
  const timeline = actionRiseTimeline(element);
  const delta = timeline ? composerOrigin(element, timeline) : 0;
  // A long travel needs longer. Held at the short duration, a row crossing the
  // whole timeline reads as a teleport instead of a lift.
  const base = touchProfile() ? SEND_LIFT_TOUCH_MS : SEND_LIFT_DESKTOP_MS;
  const duration = Math.round(base * (1 + Math.min(Math.abs(delta) / 1200, 0.45)));
  if (timeline && playTransform(element, delta, duration, 0)) {
    animated.add(element);
    return;
  }
  playEntrance(element);
}

/**
 * The timeline aligns every fresh prompt below a visible tail of the previous
 * answer immediately.
 * Capture the pre-send geometry, then FLIP the already-correct final layout:
 * the new prompt rises from the composer edge while all previously visible
 * rows retain their old pixels for frame zero and slide upward together. This
 * keeps scroll state canonical (no synthetic smooth-scroll events fighting the
 * reader-intent logic) while making the send feel like one continuous motion.
 */
function playSendTransition(element: HTMLElement): boolean {
  const snapshot = consumeSendTransition();
  if (!snapshot || motionDisabled()) return false;
  const timeline = element.closest<HTMLElement>(".timeline");
  if (!timeline) return false;
  const duration = touchProfile() ? SEND_LIFT_TOUCH_MS : SEND_LIFT_DESKTOP_MS;
  let moved = false;

  if (snapshot.timeline === timeline) {
    for (const row of snapshot.rows) {
      if (!row.element.isConnected || row.element.parentElement !== timeline) continue;
      const after = row.element.getBoundingClientRect();
      moved = playTransform(row.element, row.rect.top - after.top, duration) || moved;
    }
  }

  const promptRect = element.getBoundingClientRect();
  const viewport = timeline.getBoundingClientRect();
  // The composer sits immediately below the timeline on phones. Start at that
  // seam instead of beyond the overflow clip, so the bubble visibly emerges
  // from the composer and travels all the way to its contextual anchor. The
  // pre-send rect is used because sending resets the composer's height.
  const sourceTop = snapshot.source
    ? Math.min(snapshot.source.top, viewport.bottom - Math.min(12, promptRect.height))
    : viewport.bottom - Math.min(12, promptRect.height);
  const promptMoved = playTransform(element, sourceTop - promptRect.top, duration, 0.72, true);
  if (promptMoved) animated.add(element);
  return promptMoved || moved;
}

function playEntrance(element: HTMLElement, status = false): void {
  if (animated.has(element) || motionDisabled()) return;
  animated.add(element);
  const touch = touchProfile();
  const duration = status ? STATUS_DURATION_MS : touch ? TOUCH_DURATION_MS : DESKTOP_DURATION_MS;
  const distance = status ? 4 : touch ? TOUCH_DISTANCE_PX : DESKTOP_DISTANCE_PX;

  if (typeof element.animate === "function") {
    const previousWillChange = element.style.willChange;
    element.style.willChange = "opacity, transform";
    const animation = element.animate([
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration,
      easing: EASE_OUT,
      fill: "both",
    });
    void animation.finished.catch(() => undefined).finally(() => {
      if (element.isConnected) element.style.willChange = previousWillChange;
    });
    return;
  }

  // Old embedded WebViews: keep the same motion contract without requiring
  // WAAPI. React may own className, so this is intentionally only a fallback.
  element.classList.add("chat-motion-enter");
  window.setTimeout(() => element.classList.remove("chat-motion-enter"), duration + 40);
}

function candidatesFrom(node: Node): HTMLElement[] {
  if (!(node instanceof Element)) return [];
  const candidates: HTMLElement[] = [];
  if (node.matches(LIVE_ROW_SELECTOR)) candidates.push(node as HTMLElement);
  candidates.push(...node.querySelectorAll<HTMLElement>(LIVE_ROW_SELECTOR));
  return candidates;
}

/** Optimistic prompt echoes carry this marker until their canonical row lands. */
const PENDING_SEND_SELECTOR = "[data-pending-send]";

/** An echo leaving the DOM in the same batch a canonical prompt enters it is a
 *  handover, not a new event: the two rows are the same prompt at the same
 *  place, already animated once on submit. Replaying an entrance would blink
 *  a settled bubble. Counted per batch so rapid sends hand over one for one. */
function pendingSendHandovers(records: MutationRecord[]): number {
  let count = 0;
  for (const record of records) {
    for (const node of record.removedNodes) {
      if (!(node instanceof Element)) continue;
      count += node.matches(PENDING_SEND_SELECTOR)
        ? 1
        : node.querySelectorAll(PENDING_SEND_SELECTOR).length;
    }
  }
  return count;
}

function animateAddedNode(node: Node, suppressChat = false, handover = { remaining: 0 }): void {
  if (!(node instanceof Element)) return;

  // A newly mounted timeline is hydration/navigation, not a sequence of new
  // chat events. Its descendants should appear immediately.
  if (node.matches(".timeline") || node.querySelector(".timeline")) return;

  const statuses: HTMLElement[] = [];
  if (node.matches(".agent-status-dock")) statuses.push(node as HTMLElement);
  statuses.push(...node.querySelectorAll<HTMLElement>(".agent-status-dock"));
  for (const status of statuses) playEntrance(status, true);

  const all = candidatesFrom(node);
  if (all.length === 0) return;
  const set = new Set(all);

  for (const element of all) {
    // Live actions fly in the viewport overlay, not as scroller descendants.
    // They still need their own rise; handle them before nested-subtree
    // de-duplication below.
    if (element.matches(".activity-live")) {
      if (!suppressChat && now() >= quietUntil) playActionRise(element);
      continue;
    }

    // Animate one visual layer per added subtree: a new activity group owns its
    // first frame; rows appended later to that existing group animate alone.
    let parent = element.parentElement;
    let nested = false;
    while (parent) {
      if (set.has(parent)) {
        nested = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (nested) continue;

    if (element.matches(".msg.user")) {
      if (handover.remaining > 0) {
        handover.remaining -= 1;
        animated.add(element);
        continue;
      }
      const explicitSend = consumeUserSend();
      // Explicit sends get the larger composer→prompt FLIP: the prompt rises
      // to the contextual fresh-turn anchor while previous agent rows slide
      // up with it, leaving the previous answer's tail on screen.
      // Non-send user rows keep the ordinary short entrance.
      if (explicitSend) {
        if (!playSendTransition(element)) playEntrance(element);
      } else if (!suppressChat && now() >= quietUntil && nearTimelineTail(element)) {
        playEntrance(element);
      }
      continue;
    }

    if (suppressChat || now() < quietUntil) continue;

    if (!nearTimelineTail(element)) continue;
    playEntrance(element);
  }
}

function nodeHasChatCandidates(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches(".timeline") || node.matches(LIVE_ROW_SELECTOR)
    || !!node.querySelector(`.timeline, ${LIVE_ROW_SELECTOR}`);
}

function installMutationWatcher(): void {
  const observer = new MutationObserver((records) => {
    const href = location.href;
    if (href !== lastLocation) {
      lastLocation = href;
      markNavigation();
    }

    // Navigation may load data asynchronously, so a fixed timeout alone is not
    // enough. Suppress the first actual chat insertion batch after navigation,
    // then immediately return to live event motion.
    const suppressNavigationBatch = navigationPending
      && records.some((record) => Array.from(record.addedNodes).some(nodeHasChatCandidates));
    if (suppressNavigationBatch) navigationPending = false;

    const handover = { remaining: pendingSendHandovers(records) };
    for (const record of records) {
      for (const node of record.addedNodes) animateAddedNode(node, suppressNavigationBatch, handover);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function start(): void {
  installHistoryWatcher();
  installSendWatcher();
  installMutationWatcher();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
