// Pure maths and settings normalisation for the Navigator's session-row swipe.
// The row (MobileNavigator.tsx) owns the pointer events and the side effects;
// everything that can be decided from numbers lives here so it is testable.
//
// Offsets are signed along the inline axis, already mirrored for RTL by the
// caller: positive reveals the leading tray (the row moves toward the inline
// end), negative reveals the trailing tray.

export type RowSwipeActionId = "pin" | "archive" | "mute" | "delete";
export const ROW_SWIPE_ACTION_IDS: readonly RowSwipeActionId[] = ["pin", "archive", "mute", "delete"];

export interface RowSwipeSettings {
  /** Actions revealed by a swipe toward the inline end; the first one is the full-swipe action. */
  leading: RowSwipeActionId[];
  /** Actions revealed by a swipe toward the inline start. */
  trailing: RowSwipeActionId[];
  /** Whether dragging far enough commits the side's first action. */
  fullSwipe: boolean;
}

export const ROW_SWIPE_DEFAULTS: RowSwipeSettings = {
  leading: ["pin", "archive"],
  trailing: [],
  fullSwipe: true,
};

/** A tray holds at most this many buttons (each is `ROW_SWIPE_BUTTON_PX` wide). */
export const ROW_SWIPE_MAX_ACTIONS = 3;

/** Ordered, de-duplicated, known ids only. Anything else falls back to `fallback`. */
export function parseRowSwipeActions(value: unknown, fallback: readonly RowSwipeActionId[]): RowSwipeActionId[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<RowSwipeActionId>();
  for (const item of value) {
    if (ROW_SWIPE_ACTION_IDS.includes(item as RowSwipeActionId)) seen.add(item as RowSwipeActionId);
  }
  return [...seen].slice(0, ROW_SWIPE_MAX_ACTIONS);
}

export function parseRowSwipeFull(value: unknown): boolean {
  return typeof value === "boolean" ? value : ROW_SWIPE_DEFAULTS.fullSwipe;
}

export interface RowSwipeContext {
  conversation: boolean;
  manage: boolean;
}

/** What a row can offer: mute only on conversations, archive and delete only with manage access. */
export function availableRowSwipeActions(ids: readonly RowSwipeActionId[], ctx: RowSwipeContext): RowSwipeActionId[] {
  return ids.filter((id) => {
    if (id === "mute") return ctx.conversation;
    if (id === "archive" || id === "delete") return ctx.manage;
    return true;
  });
}

/** Delete never runs from a full swipe: the tray button (and its confirmation) is the only path. */
export function fullSwipeAction(available: readonly RowSwipeActionId[], fullSwipe: boolean): RowSwipeActionId | null {
  const first = available[0];
  if (!fullSwipe || first === undefined || first === "delete") return null;
  return first;
}

/** Which `data-owns-swipe` value the row publishes (undefined = the row owns no swipe). */
export function swipeOwnership(
  leading: number,
  trailing: number,
  open: boolean,
): "" | "toward-end" | "toward-start" | undefined {
  // Open: dragging back is the row's, whichever side is showing.
  if (open) return "";
  if (leading > 0 && trailing > 0) return "";
  if (leading > 0) return "toward-end";
  if (trailing > 0) return "toward-start";
  return undefined;
}

export const ROW_SWIPE_BUTTON_PX = 64;
/** Share of the row's width a drag has to cover to commit. */
export const ROW_SWIPE_COMMIT_RATIO = 0.6;
/** px/ms: a flick at least this fast decides the release by itself. */
export const ROW_SWIPE_FLICK_VELOCITY = 0.45;
/** px/ms: a flick this fast from an open tray commits the full-swipe action. */
export const ROW_SWIPE_COMMIT_VELOCITY = 1.3;

export function trayWidth(count: number): number {
  return Math.max(0, count) * ROW_SWIPE_BUTTON_PX;
}

export function commitDistance(rowWidth: number): number {
  return Math.max(trayWidth(1) * 2, rowWidth * ROW_SWIPE_COMMIT_RATIO);
}

/**
 * Where the row is painted for a raw finger offset. The row follows the finger
 * 1:1 through the tray. Past it, a row that can commit keeps following at half
 * speed (the button growing is the cue); a row that cannot stops with an
 * asymptotic rubber band.
 */
export function rubberBandOffset(raw: number, tray: number, canCommit: boolean, rowWidth: number): number {
  const magnitude = Math.abs(raw);
  const sign = raw < 0 ? -1 : 1;
  if (tray <= 0) return 0;
  if (magnitude <= tray) return raw;
  const over = magnitude - tray;
  if (canCommit) return sign * Math.min(Math.max(rowWidth, tray), tray + over * 0.5);
  const limit = 28;
  return sign * (tray + limit * (1 - 1 / (over / limit + 1)));
}

/** 0 at rest, 1 once the tray is fully revealed: drives the icons' scale and fade. */
export function revealProgress(visual: number, tray: number): number {
  if (tray <= 0) return 0;
  return Math.min(1, Math.max(0, Math.abs(visual) / tray));
}

/** Whether a raw finger offset is past the commit threshold on the given side. */
export function isCommitting(raw: number, canCommit: boolean, rowWidth: number): boolean {
  return canCommit && Math.abs(raw) >= commitDistance(rowWidth);
}

export type RowSwipeSettle = "commit" | "open" | "close";

export interface RowSwipeRelease {
  /** Raw (un-banded) offset at release, signed. */
  raw: number;
  /** Signed finger velocity, px/ms, same axis as `raw`. */
  velocity: number;
  /** Tray width of the side the offset is on. */
  tray: number;
  rowWidth: number;
  canCommit: boolean;
  /** The tray was already open when this touch began. */
  openAtStart: boolean;
}

export function settleRowSwipe(release: RowSwipeRelease): RowSwipeSettle {
  const { raw, velocity, tray, rowWidth, canCommit, openAtStart } = release;
  const magnitude = Math.abs(raw);
  if (tray <= 0 || magnitude === 0) return "close";
  const outward = raw < 0 ? -velocity : velocity;
  if (isCommitting(raw, canCommit, rowWidth)) return "commit";
  // Pulling an open tray further with a fast flick commits too.
  if (canCommit && openAtStart && magnitude > tray && outward >= ROW_SWIPE_COMMIT_VELOCITY) return "commit";
  if (outward >= ROW_SWIPE_FLICK_VELOCITY) return "open";
  if (outward <= -ROW_SWIPE_FLICK_VELOCITY) return "close";
  return magnitude > tray / 2 ? "open" : "close";
}

/** Settle time (ms) for travelling `distance` px at the release velocity, clamped. */
export function settleDuration(distance: number, velocity: number): number {
  const speed = Math.abs(velocity);
  if (speed < 0.05) return 220;
  return Math.round(Math.min(320, Math.max(120, Math.abs(distance) / speed)));
}

export interface VelocitySample { x: number; t: number }

/** Velocity (px/ms) over the last ~100 ms of samples; 0 when there is too little data. */
export function releaseVelocity(samples: readonly VelocitySample[], now: number): number {
  const recent = samples.filter((sample) => now - sample.t <= 100);
  if (recent.length < 2) return 0;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}
