// A phone or native boot shows the launch veil (index.html) until
// the workspace underneath is complete, then lifts it once. Everything that
// used to pop in at its own pace — theme and wallpaper from the synced
// settings, the project registry, the restored session or fresh-chat hero,
// package composer buttons, the branch label — settles behind the veil, so
// the first frame the user sees is the finished screen. Every wait is capped:
// a slow server reveals honest loading states instead of an endless splash.
//
// The decision is a pure function of observed progress (decideLaunchReveal);
// the controller below only feeds it milestones and lifts the veil.
import type { LaunchVeil } from "@polyth/mobile/launch";

export type LaunchBootPhase = "checking" | "setup" | "restart" | "locked" | "ready" | "unavailable";

/** Milestones in ms on one clock (performance.now() of the document). */
export interface LaunchProgress {
  phase: LaunchBootPhase;
  /** When the current phase's screen was committed. */
  committedAt: number | null;
  /** When projects and the initial selection (session or fresh chat) were restored. */
  hydratedAt: number | null;
  settingsSettled: boolean;
  packagesSettled: boolean;
  /** Critical first-screen reads still in flight (e.g. the composer's branch). */
  holds: number;
  /** Last structural or text change inside the app root. */
  lastChangeAt: number;
}

export const LAUNCH_REVEAL_TIMING = {
  /** The screen must stop changing for this long before it is shown. */
  quietMs: 160,
  /** Sign-in, setup and error screens show at the latest this long after they commit. */
  phaseCapMs: 600,
  /** Packages may add composer buttons and hero widgets this long after
   *  hydration; a later one fades in on its own (MobileComposerRail). */
  packagesGraceMs: 1_800,
  /** Critical first-screen reads may finish this long after hydration. */
  holdsGraceMs: 1_600,
  /** After hydration, show whatever is there by now. */
  settledCapMs: 3_200,
  /** Never keep a document behind the veil longer than this. */
  hardCapMs: 9_000,
  /** A boot still running by then gets the breathing mark and a status line. */
  waitingAfterMs: 1_600,
} as const;

export type LaunchRevealTiming = typeof LAUNCH_REVEAL_TIMING;

export type LaunchRevealDecision =
  | { reveal: true; reason: "phase" | "settled" | "settle-cap" | "hard-cap" }
  | { reveal: false; wakeAt: number };

export function decideLaunchReveal(
  progress: LaunchProgress,
  now: number,
  timing: LaunchRevealTiming = LAUNCH_REVEAL_TIMING,
): LaunchRevealDecision {
  if (now >= timing.hardCapMs) return { reveal: true, reason: "hard-cap" };
  if (progress.phase === "checking" || progress.committedAt === null) {
    return { reveal: false, wakeAt: timing.hardCapMs };
  }
  // Sign-in, setup and the unreachable-server card are complete screens of
  // their own: show them as soon as they stop changing.
  if (progress.phase !== "ready") {
    const quietAt = Math.max(progress.lastChangeAt, progress.committedAt) + timing.quietMs;
    const showAt = Math.min(quietAt, progress.committedAt + timing.phaseCapMs);
    return now >= showAt ? { reveal: true, reason: "phase" } : { reveal: false, wakeAt: showAt };
  }
  if (progress.hydratedAt === null) return { reveal: false, wakeAt: timing.hardCapMs };

  const sinceHydrated = now - progress.hydratedAt;
  if (sinceHydrated >= timing.settledCapMs) return { reveal: true, reason: "settle-cap" };
  const wakes = [progress.hydratedAt + timing.settledCapMs];
  let blocked = !progress.settingsSettled;
  if (!progress.packagesSettled && sinceHydrated < timing.packagesGraceMs) {
    blocked = true;
    wakes.push(progress.hydratedAt + timing.packagesGraceMs);
  }
  if (progress.holds > 0 && sinceHydrated < timing.holdsGraceMs) {
    blocked = true;
    wakes.push(progress.hydratedAt + timing.holdsGraceMs);
  }
  if (blocked) return { reveal: false, wakeAt: Math.min(...wakes) };

  const quietAt = Math.max(progress.lastChangeAt, progress.committedAt, progress.hydratedAt) + timing.quietMs;
  if (now >= quietAt) return { reveal: true, reason: "settled" };
  return { reveal: false, wakeAt: Math.min(quietAt, ...wakes) };
}

// ---- controller ---------------------------------------------------------------

const progress: LaunchProgress = {
  phase: "checking",
  committedAt: null,
  hydratedAt: null,
  settingsSettled: false,
  packagesSettled: false,
  holds: 0,
  lastChangeAt: 0,
};
const holds = new Set<symbol>();
/** Streaming transcript text and live status lines keep changing for as long
 *  as a turn runs: content arriving, not a screen still assembling. */
const LIVE_CONTENT = ".timeline, [aria-live]";

function assembling(record: MutationRecord): boolean {
  const node = record.target;
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return !element?.closest(LIVE_CONTENT);
}

let veil: LaunchVeil | null = null;
let waitingStatus: (() => string) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let waitingTimer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;
let revealed = true;

/** The document's clock: caps count from navigation start, when the veil
 *  first painted. */
const documentClock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
let now = documentClock;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 16);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

function stop(): void {
  if (timer !== null) clearTimeout(timer);
  if (waitingTimer !== null) clearTimeout(waitingTimer);
  timer = null;
  waitingTimer = null;
  observer?.disconnect();
  observer = null;
}

function reveal(): void {
  if (revealed) return;
  revealed = true;
  stop();
  const current = veil;
  // Two frames: React's last commit is laid out and painted under the veil
  // before it starts to clear.
  void nextFrame().then(nextFrame).then(() => current?.lift());
}

function evaluate(): void {
  if (revealed) return;
  const at = now();
  const decision = decideLaunchReveal({ ...progress, holds: holds.size }, at);
  if (decision.reveal) {
    reveal();
    return;
  }
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    evaluate();
  }, Math.max(16, decision.wakeAt - at));
}

/**
 * Start holding the veil for this document. A no-op when no veil is on screen
 * (desktop browsers), so every milestone call below is free there.
 */
export function startLaunchReveal(options: {
  veil: LaunchVeil;
  /** The status line shown once the boot is slow; read lazily (locale). */
  waitingStatus?: () => string;
  /** Tests only: a clock starting at the veil's first paint. */
  clock?: () => number;
}): void {
  if (!options.veil.active || !revealed) return;
  now = options.clock ?? documentClock;
  veil = options.veil;
  revealed = false;
  waitingStatus = options.waitingStatus ?? null;
  progress.lastChangeAt = now();
  const root = typeof document !== "undefined" ? document.getElementById("root") : null;
  if (root && typeof MutationObserver === "function") {
    // Attribute churn (an input's state, aria flags) never moves pixels the
    // way an arriving button or a changed label does; only those count.
    observer = new MutationObserver((records) => {
      if (records.some(assembling)) progress.lastChangeAt = now();
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
  }
  waitingTimer = setTimeout(() => {
    waitingTimer = null;
    if (!revealed) veil?.wait(waitingStatus?.() ?? null);
  }, Math.max(0, LAUNCH_REVEAL_TIMING.waitingAfterMs - now()));
  evaluate();
}

/** The boot phase whose screen just committed (sign-in, setup, workspace…). */
export function noteLaunchPhase(phase: LaunchBootPhase): void {
  if (progress.phase === phase && progress.committedAt !== null) return;
  progress.phase = phase;
  progress.committedAt = phase === "checking" ? null : now();
  evaluate();
}

/** Projects are listed and the initial session or fresh chat is restored. */
export function noteLaunchHydrated(): void {
  if (progress.hydratedAt !== null) return;
  progress.hydratedAt = now();
  // The first screen's text is laid out by now: a web font still loading
  // would reflow it right after the reveal.
  const fonts = typeof document !== "undefined" ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  if (!revealed && fonts?.status === "loading") {
    const release = holdLaunchReveal();
    void fonts.ready.then(release, release);
  }
  evaluate();
}

export function noteLaunchSettingsSettled(): void {
  if (progress.settingsSettled) return;
  progress.settingsSettled = true;
  evaluate();
}

export function noteLaunchPackagesSettled(): void {
  if (progress.packagesSettled) return;
  progress.packagesSettled = true;
  evaluate();
}

/**
 * Keep the veil while a read the first screen depends on is in flight (for
 * example the branch label of the fresh-chat composer). Bounded by the
 * reveal's grace and caps; returns the release.
 */
export function holdLaunchReveal(): () => void {
  if (revealed) return () => undefined;
  const token = Symbol("launch-hold");
  holds.add(token);
  return () => {
    if (!holds.delete(token)) return;
    evaluate();
  };
}

/** Test seam: forget this document's launch (the controller is a singleton). */
export function resetLaunchRevealForTest(): void {
  stop();
  revealed = true;
  veil = null;
  waitingStatus = null;
  holds.clear();
  now = documentClock;
  Object.assign(progress, {
    phase: "checking",
    committedAt: null,
    hydratedAt: null,
    settingsSettled: false,
    packagesSettled: false,
    holds: 0,
    lastChangeAt: 0,
  } satisfies LaunchProgress);
}
