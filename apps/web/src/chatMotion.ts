const USER_SEND_TTL_MS = 8_000;
const NAVIGATION_QUIET_MS = 180;
const DESKTOP_DURATION_MS = 300;
const TOUCH_DURATION_MS = 260;
const STATUS_DURATION_MS = 220;
const DESKTOP_DISTANCE_PX = 8;
const TOUCH_DISTANCE_PX = 6;
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";

const LIVE_ROW_SELECTOR = [
  ".msg.user",
  ".msg.assistant",
  ".activity-group",
  ".execution-row",
  ".reasoning",
  ".task-activity",
  ".github-conflict-card",
].join(",");

let pendingUserSendUntil = 0;
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

function markUserSend(): void {
  pendingUserSendUntil = now() + USER_SEND_TTL_MS;
  // A deliberate send establishes a live continuation even when the current
  // screen was reached by navigation moments earlier.
  navigationPending = false;
  quietUntil = 0;
}

function consumeUserSend(): boolean {
  if (pendingUserSendUntil <= now()) {
    pendingUserSendUntil = 0;
    return false;
  }
  pendingUserSendUntil = 0;
  return true;
}

function markNavigation(): void {
  // Creating the first session changes the route as part of the send. Do not
  // treat that as historical navigation or the freshly sent prompt would lose
  // its entrance motion.
  if (pendingUserSendUntil > now()) return;
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
    if (sibling.matches(".msg, .activity-group, .task-activity, .github-conflict-card")) meaningfulFollowers += 1;
    if (meaningfulFollowers > 2) return false;
  }
  return true;
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

function animateAddedNode(node: Node, suppressChat = false): void {
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
      const explicitSend = consumeUserSend();
      // Explicit send provenance wins even if route bookkeeping is still
      // settling. Other live user rows may animate when they arrive at the
      // timeline tail (e.g. interrupt/send-now paths).
      if (explicitSend || (!suppressChat && now() >= quietUntil && nearTimelineTail(element))) {
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

    for (const record of records) {
      for (const node of record.addedNodes) animateAddedNode(node, suppressNavigationBatch);
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
