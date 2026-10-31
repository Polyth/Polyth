/**
 * Queue → timeline handoff. A queued prompt that leaves for the chat (its own
 * steer, an empty-composer promotion or the server's dispatch) records where
 * its chip stood; chatMotion then flies the arriving prompt row up from that
 * place instead of from the composer input. The chip itself only folds away.
 *
 * Side-effect free like timelineMotionClaims.ts: the queue list imports it
 * without pulling chatMotion's global watchers into its graph.
 */

/** The chip's row reaches the timeline in the same commit (server dispatch)
 *  or within a frame (steer echo). Anything older is not this launch. */
const LAUNCH_TTL_MS = 900;
/** The chip fades fast — the prompt row is the object that keeps moving —
 *  while its slot closes slightly slower so the composer glides, not jumps. */
export const QUEUE_CHIP_EXIT_FADE_MS = 120;
export const QUEUE_CHIP_EXIT_MS = 220;
const EXIT_EASE = "cubic-bezier(0.2, 0, 0, 1)";

let launch: { top: number; at: number } | null = null;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function queueMotionDisabled(): boolean {
  if (typeof document === "undefined") return true;
  if (document.hidden) return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Whether a leaving chip can play a folding exit at all. Without WAAPI (old
 *  WebViews, tests) or with reduced motion the row simply leaves. */
export function queueChipExitAvailable(): boolean {
  return typeof HTMLElement !== "undefined"
    && typeof HTMLElement.prototype.animate === "function"
    && !queueMotionDisabled();
}

export function markQueuedPromptLaunch(chip: HTMLElement): void {
  if (queueMotionDisabled()) return;
  launch = { top: chip.getBoundingClientRect().top, at: now() };
}

/** The viewport top the prompt row should fly from, consumed once. */
export function takeQueuedPromptLaunch(): number | null {
  const current = launch;
  launch = null;
  if (!current || now() - current.at > LAUNCH_TTL_MS) return null;
  return current.top;
}

/** Fold a departing chip: a quick fade with a slight lift toward the chat,
 *  then its slot (height and the list gap) closes. Null when it cannot play. */
export function playQueueChipExit(chip: HTMLElement): Animation | null {
  if (typeof chip.animate !== "function" || queueMotionDisabled()) return null;
  const height = chip.getBoundingClientRect().height;
  const style = getComputedStyle(chip);
  const gap = Number.parseFloat(getComputedStyle(chip.parentElement ?? chip).rowGap) || 0;
  const fadeEnd = QUEUE_CHIP_EXIT_FADE_MS / QUEUE_CHIP_EXIT_MS;
  // `.queue-chip-leaving` drops min-height so the border-box can close fully.
  const animation = chip.animate([
    {
      opacity: 1, transform: "translate3d(0, 0, 0)", height: `${height}px`,
      paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: "0px",
    },
    { opacity: 0, transform: "translate3d(0, -6px, 0)", offset: fadeEnd },
    {
      opacity: 0, transform: "translate3d(0, -6px, 0)", height: "0px",
      paddingTop: "0px", paddingBottom: "0px", marginBottom: `${-gap}px`,
    },
  ], { duration: QUEUE_CHIP_EXIT_MS, easing: EXIT_EASE, fill: "forwards" });
  return animation;
}
