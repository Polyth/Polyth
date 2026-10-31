import { sendFlightsInAir, TIMELINE_ENTRANCE_ANIMATION_ID, TIMELINE_SEND_FLIGHT_ANIMATION_ID, timelineMotionClaims } from "./timelineMotionClaims.ts";
import { timelineLiftOwns } from "./timelineLift.ts";
import { takeQueuedPromptLaunch } from "./queueLaunchMotion.ts";
import { timelineVisibleArea } from "./timelineVisibleArea.ts";

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
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";
const SEND_LIFT_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

const LIVE_ROW_SELECTOR = [
  ".msg.user",
  ".msg.assistant",
  ".activity-group",
  ".execution-row",
  ".reasoning",
  ".task-activity",
  ".github-conflict-card",
  ".rewind-marker",
  ".pkg-harnesses-switch-marker",
].join(",");
const TOP_LEVEL_TIMELINE_ROW_SELECTOR = ".msg, .activity-group, .task-activity, .github-conflict-card, .rewind-marker, .pkg-harnesses-switch-marker";

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
// Shared with the rewind choreography: an element claimed there is never
// given a second entrance here.
const animated = timelineMotionClaims;
// Detached echoes no longer appear in getAnimations(); retain only their send
// animation so admission can retarget it without restarting its clock.
const sendMotions = new WeakMap<Element, Animation>();

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

function composerAnchor(composer: HTMLElement): RectSnapshot | null {
  const composerInput = composer.querySelector<HTMLElement>("[data-composer-input]")
    ?? composer.querySelector<HTMLElement>(".composer-input");
  return composerInput ? snapshotRect(composerInput.getBoundingClientRect()) : null;
}

function captureSendTransition(composer: HTMLElement): SendTransitionSnapshot | null {
  if (motionDisabled()) return null;
  const timeline = composer.closest(".focus-conversation")?.querySelector<HTMLElement>(".timeline") ?? null;
  const viewport = timeline ? timelineVisibleArea(timeline) : null;
  const rows: SendTransitionSnapshot["rows"] = [];
  if (timeline && viewport) {
    for (const child of Array.from(timeline.children)) {
      if (!(child instanceof HTMLElement) || !child.matches(TOP_LEVEL_TIMELINE_ROW_SELECTOR)) continue;
      const rect = child.getBoundingClientRect();
      // Only rows the reader can currently see participate in the FLIP. Rows
      // already outside the viewport need no animation and would waste work.
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      rows.push({ element: child, rect: snapshotRect(rect) });
    }
  }
  return {
    capturedAt: now(),
    source: composerAnchor(composer),
    timeline,
    rows,
  };
}

function markUserSend(composer: HTMLElement): void {
  pendingUserSendUntil = now() + USER_SEND_TTL_MS;
  pendingSendTransition = captureSendTransition(composer);
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
    if (send && !send.disabled) markUserSend(send.closest<HTMLElement>(".composer-chat")!);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !isTextEntry(target)) return;
    const composer = target.closest<HTMLElement>(".composer-chat");
    if (composer) markUserSend(composer);
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
    if (sibling.matches(TOP_LEVEL_TIMELINE_ROW_SELECTOR)) meaningfulFollowers += 1;
    if (meaningfulFollowers > 2) return false;
  }
  return true;
}

function inTimelineReadingArea(element: HTMLElement): boolean {
  const timeline = element.closest<HTMLElement>(".timeline");
  if (!timeline) return false;
  const area = timelineVisibleArea(timeline);
  const rect = element.getBoundingClientRect();
  return rect.bottom > area.top && rect.top < area.bottom;
}

function playTransform(
  element: HTMLElement,
  deltaY: number,
  duration: number,
  opacityFrom = 1,
  id = "",
): boolean {
  if (typeof element.animate !== "function" || Math.abs(deltaY) < 1) return false;
  // A running transform animation is composited by itself: no will-change is
  // written, so no layer is forced before or kept after the flight.
  const keyframes: Keyframe[] = [
    { opacity: opacityFrom, transform: `translate3d(0, ${deltaY}px, 0)` },
    // Opacity lands early on its own offset: a fade stretched across the whole
    // travel reads as a smear, while a solid row gliding into place reads as
    // one object moving. Transform still spans the full duration.
    { opacity: 1, offset: 0.32 },
    { opacity: 1, transform: "translate3d(0, 0, 0)" },
  ];
  const animation = element.animate(keyframes, {
    duration,
    easing: SEND_LIFT_EASE,
    fill: "both",
    ...(id ? { id } : {}),
  });
  if (id === TIMELINE_SEND_FLIGHT_ANIMATION_ID) {
    sendMotions.set(element, animation);
    sendFlightsInAir.add(animation);
  }
  void animation.finished.catch(() => undefined).finally(() => {
    sendMotions.delete(element);
    sendFlightsInAir.delete(animation);
    // Release the filled end state. It equals the element's natural style, and
    // a retained fill would outrank the CSS exit transition on the same row.
    if (animation.playState === "finished") animation.cancel();
  });
  return true;
}

/** Keep previous rows continuous across send alignment, while the prompt
 * rises from the composer seam into the same moving transcript. */
function playSendTransition(element: HTMLElement, queuedLaunchTop: number | null = null): boolean {
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

  // A promoted queued prompt leaves from its chip, not from the composer input.
  const promptMoved = playPromptFlight(element, timeline, queuedLaunchTop ?? snapshot.source?.top ?? null, duration);
  return promptMoved || moved;
}

function playPromptFlight(element: HTMLElement, timeline: HTMLElement, source: number | null, duration: number): boolean {
  const promptRect = element.getBoundingClientRect();
  const viewport = timelineVisibleArea(timeline);
  const seam = viewport.bottom - Math.min(12, promptRect.height);
  const sourceTop = source === null ? seam : Math.min(source, seam);
  const promptMoved = playTransform(element, sourceTop - promptRect.top, duration, 0.72, TIMELINE_SEND_FLIGHT_ANIMATION_ID);
  if (promptMoved) animated.add(element);
  return promptMoved;
}

/** A queued prompt the server dispatched (or a steer without a composer send)
 *  rises from the chip that just folded away — the same flight as a send. */
function playQueuedLaunch(element: HTMLElement, sourceTop: number): boolean {
  if (motionDisabled() || !inTimelineReadingArea(element)) return false;
  const timeline = element.closest<HTMLElement>(".timeline");
  if (!timeline) return false;
  return playPromptFlight(element, timeline, sourceTop, touchProfile() ? SEND_LIFT_TOUCH_MS : SEND_LIFT_DESKTOP_MS);
}

function playEntrance(element: HTMLElement, status = false): void {
  if (animated.has(element) || motionDisabled()) return;
  animated.add(element);
  const touch = touchProfile();
  const duration = status ? STATUS_DURATION_MS : touch ? TOUCH_DURATION_MS : DESKTOP_DURATION_MS;
  const distance = status ? 4 : touch ? TOUCH_DISTANCE_PX : DESKTOP_DISTANCE_PX;

  if (typeof element.animate === "function") {
    // The tail lift of the same commit already carries the row up from where
    // it was inserted; the entrance only fades it in on the way.
    const animation = element.animate(timelineLiftOwns(element) ? [{ opacity: 0 }, { opacity: 1 }] : [
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration,
      easing: EASE_OUT,
      fill: "both",
      // A tail lift in the same commit takes over this row's transform.
      id: TIMELINE_ENTRANCE_ANIMATION_ID,
    });
    void animation.finished.catch(() => undefined).finally(() => {
      if (animation.playState === "finished") animation.cancel();
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
function pendingSendHandovers(records: MutationRecord[]): Array<Animation | null> {
  const motions: Array<Animation | null> = [];
  for (const record of records) {
    for (const node of record.removedNodes) {
      if (!(node instanceof Element)) continue;
      const echoes = node.matches(PENDING_SEND_SELECTOR) ? [node] : node.querySelectorAll(PENDING_SEND_SELECTOR);
      for (const echo of echoes) motions.push(sendMotions.get(echo) ?? null);
    }
  }
  return motions;
}

/** A dock replaced by another dock in one batch is one status handover: the
 *  startup dock and the live activity dock are the same shell in the same
 *  place, so the replacement swaps the text instead of fading a blank in. */
function pendingDockHandovers(records: MutationRecord[]): number {
  let count = 0;
  for (const record of records) {
    for (const node of record.removedNodes) {
      if (!(node instanceof Element)) continue;
      count += node.matches(".agent-status-dock")
        ? 1
        : node.querySelectorAll(".agent-status-dock").length;
    }
  }
  return count;
}

/** The first send mounts the whole conversation surface. Animate only the
 *  prompt the reader just submitted — with the composer-to-timeline entrance — and
 *  let the surrounding transcript arrive as the surface itself. */
function animateFirstSendPrompt(node: Element): void {
  if (pendingUserSendUntil <= now()) return;
  const prompts = node.matches(".msg.user")
    ? [node as HTMLElement]
    : Array.from(node.querySelectorAll<HTMLElement>(".msg.user"));
  const prompt = prompts.find((element) => !animated.has(element));
  if (!prompt) return;
  const explicitSend = consumeUserSend();
  if (explicitSend && !playSendTransition(prompt)) playEntrance(prompt);
}

function firstSendTimeline(node: Element): Element | null {
  const timeline = node.matches(".timeline") ? node : node.querySelector(".timeline");
  return timeline?.closest("[data-first-send]") ? timeline : null;
}

function animateAddedNode(
  node: Node,
  suppressChat = false,
  handover = { motions: [] as Array<Animation | null> },
  dockHandover = { remaining: 0 },
): void {
  if (!(node instanceof Element)) return;

  // A newly mounted timeline is hydration/navigation, not a sequence of new
  // chat events — except for the first-send handoff, where the conversation
  // surface mounts with the prompt the reader just submitted.
  if (node.matches(".timeline") || node.querySelector(".timeline")) {
    const timeline = firstSendTimeline(node);
    if (timeline) animateFirstSendPrompt(timeline);
    return;
  }

  const statuses: HTMLElement[] = [];
  if (node.matches(".agent-status-dock")) statuses.push(node as HTMLElement);
  statuses.push(...node.querySelectorAll<HTMLElement>(".agent-status-dock"));
  for (const status of statuses) {
    if (dockHandover.remaining > 0) {
      dockHandover.remaining -= 1;
      animated.add(status);
      continue;
    }
    playEntrance(status, true);
  }

  const all = candidatesFrom(node);
  if (all.length === 0) return;
  const set = new Set(all);

  for (const element of all) {
    if (animated.has(element)) continue;

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
      if (handover.motions.length > 0) {
        const motion = handover.motions.shift();
        if (!motionDisabled() && motion?.playState === "running" && motion.effect) {
          (motion.effect as KeyframeEffect).target = element;
        }
        animated.add(element);
        continue;
      }
      const explicitSend = consumeUserSend();
      const queuedLaunchTop = takeQueuedPromptLaunch();
      // Explicit sends move the prompt and previous rows together.
      if (explicitSend) {
        if (!playSendTransition(element, queuedLaunchTop)) playEntrance(element);
      } else if (queuedLaunchTop !== null && !suppressChat && playQueuedLaunch(element, queuedLaunchTop)) {
        continue;
      } else if (!suppressChat && now() >= quietUntil && nearTimelineTail(element) && inTimelineReadingArea(element)) {
        playEntrance(element);
      }
      continue;
    }

    if (suppressChat || now() < quietUntil) continue;

    if (!nearTimelineTail(element) || !inTimelineReadingArea(element)) continue;
    playEntrance(element);
  }
}

function nodeHasChatCandidates(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches(".timeline") || node.matches(LIVE_ROW_SELECTOR)
    || !!node.querySelector(`.timeline, ${LIVE_ROW_SELECTOR}`);
}

/** The host marks a session surface while it lands (builtinSurfaces): its
 *  history arrives as one revealed surface, never as a row-by-row replay. */
function sessionRevealActive(): boolean {
  return document.documentElement.dataset.sessionReveal === "active";
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
    const navigationBatch = navigationPending
      && records.some((record) => Array.from(record.addedNodes).some(nodeHasChatCandidates));
    if (navigationBatch) navigationPending = false;
    // A session surface that is landing is revealed as one piece by the host,
    // exactly like a navigation batch: its rows get no per-row entrance.
    const suppressNavigationBatch = navigationBatch || sessionRevealActive();

    const handover = { motions: pendingSendHandovers(records) };
    const dockHandover = { remaining: pendingDockHandovers(records) };
    for (const record of records) {
      for (const node of record.addedNodes) animateAddedNode(node, suppressNavigationBatch, handover, dockHandover);
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
