// Package window morph: one continuous resize between two presentations of an
// open window (floating ⇄ pinned ⇄ full screen, or one package's width to the
// next). ContextRail measures the frame before React commits the new
// presentation and hands both readings here; the window then really resizes
// from the old box to the new one, so its content reflows as it would under a
// drag, and Chat gives up or takes back its room on the same clock. Nothing is
// faded or scaled, and no state is kept: `data-rail-motion` and the store stay
// the only authorities for what is open.

/** What the window looks like right now (viewport boxes). */
export interface RailFrameReading {
  /** The window frame: its inline size, the edge it draws at its inline start
   *  (a docked window leaves that edge to its host) and the gutter it keeps
   *  against the launcher seam. */
  pane: { width: number; top: number; bottom: number; edge: number; gutter: number; fill: string } | null;
  /** Chat's inline size. */
  workspace: number | null;
}

/** How the new presentation sizes the frame, which decides what can animate. */
export type RailFrameLayout =
  /** Out of flow, anchored at the launcher seam: its width is the frame. */
  | "floating"
  /** In flow beside Chat: its width also takes Chat's room. */
  | "docked"
  /** Fills the workspace layer: it has no width of its own to set. */
  | "layer";

export interface RailMorphTargets {
  pane: HTMLElement | null;
  workspace: HTMLElement | null;
}

export interface RailMorphTiming {
  duration: number;
  easing: string;
}

/** Sub-pixel differences are layout rounding, not a change worth animating. */
const MORPH_EPSILON = 1;
const BLOCK_EPSILON = 3;

export function readRailFrame({ pane, workspace }: RailMorphTargets): RailFrameReading {
  const paneBox = pane !== null && pane.isConnected && visible(pane) ? pane.getBoundingClientRect() : null;
  const paneStyle = pane !== null && paneBox !== null ? getComputedStyle(pane) : null;
  return {
    pane: paneBox !== null && paneStyle !== null && paneBox.width > 0
      ? {
          width: paneBox.width,
          top: paneBox.top,
          bottom: paneBox.bottom,
          edge: Number.parseFloat(paneStyle.borderInlineStartWidth) || 0,
          gutter: Number.parseFloat(paneStyle.paddingInlineEnd) || 0,
          fill: paneStyle.background,
        }
      : null,
    workspace: workspace !== null && workspace.isConnected ? workspace.getBoundingClientRect().width : null,
  };
}

function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** The window clock (tokens.css `--motion-window*`), or null when motion is off. */
export function railMorphTiming(element: HTMLElement): RailMorphTiming | null {
  const root = document.documentElement;
  if (root.dataset.reduceAnimations === "true" || document.body?.dataset.desktopLowResource === "true") return null;
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const style = getComputedStyle(element);
  const duration = parseDuration(style.getPropertyValue("--motion-window"));
  if (!(duration > 0)) return null;
  const easing = style.getPropertyValue("--motion-window-ease").trim() || "ease-out";
  return { duration, easing };
}

function parseDuration(value: string): number {
  const text = value.trim();
  const amount = Number.parseFloat(text);
  if (!Number.isFinite(amount)) return 0;
  return text.endsWith("ms") ? amount : text.endsWith("s") ? amount * 1000 : amount;
}

/** The keyframes that carry the frame from its old width to the new one.
 *  Pure, so the geometry can be tested without a browser. */
export function railFrameKeyframes(
  layout: RailFrameLayout,
  before: NonNullable<RailFrameReading["pane"]>,
  after: NonNullable<RailFrameReading["pane"]>,
): Keyframe[] | null {
  // The content's inline-start edge is what the eye follows: hold it where it
  // was, whichever element draws the frame's own edge in each presentation.
  const from = before.width - before.edge + after.edge;
  const to = after.width;
  const resized = from > 0 && to > 0 && Math.abs(from - to) >= MORPH_EPSILON;
  const regutter = Math.abs(before.gutter - after.gutter) >= MORPH_EPSILON;
  // The block axis: a layer may start under the bar where a window starts at
  // the column's top. Margins hold a stretched frame at the old edges; a
  // floating frame has a height of its own, so it carries that instead.
  const lift = before.top - after.top;
  const drop = after.bottom - before.bottom;
  // A pixel or two is only which element draws the frame's block edge.
  const reblock = Math.abs(lift) >= BLOCK_EPSILON || Math.abs(drop) >= BLOCK_EPSILON;
  if (!resized && !regutter && !reblock) return null;
  const size = (width: number) => `${round(width)}px`;
  const block = (start: boolean): Keyframe => {
    if (!reblock) return {};
    if (layout === "floating") {
      return start
        ? { marginBlockStart: size(lift), height: size(before.bottom - before.top), maxHeight: "none" }
        : { marginBlockStart: "0px", height: size(after.bottom - after.top), maxHeight: "none" };
    }
    return start
      ? { marginBlockStart: size(lift), marginBlockEnd: size(drop) }
      : { marginBlockStart: "0px", marginBlockEnd: "0px" };
  };
  const gutter = (value: number, start: boolean): Keyframe => ({
    ...(regutter ? { paddingInlineEnd: size(value) } : {}),
    ...block(start),
  });
  if (!resized) return [gutter(before.gutter, true), gutter(after.gutter, false)];
  if (layout === "floating") {
    return [
      { width: size(from), maxWidth: "none", ...gutter(before.gutter, true) },
      { width: size(to), maxWidth: "none", ...gutter(after.gutter, false) },
    ];
  }
  if (layout === "docked") {
    // The frame's own width runs from → to while a matching negative margin
    // keeps its footprint in the row at the final width the whole way: Chat's
    // room is animated once, by `railWorkspaceKeyframes`, not twice.
    return [
      { width: size(from), flexBasis: size(from), minWidth: "0px", maxWidth: "none", marginInlineStart: size(to - from), ...gutter(before.gutter, true) },
      { width: size(to), flexBasis: size(to), minWidth: "0px", maxWidth: "none", marginInlineStart: "0px", ...gutter(after.gutter, false) },
    ];
  }
  // The layer stretches to its host; an inline-start margin is the only way to
  // hold it at the old width, and it keeps the frame on the launcher seam.
  return [
    { marginInlineStart: size(to - from), ...gutter(before.gutter, true) },
    { marginInlineStart: "0px", ...gutter(after.gutter, false) },
  ];
}

/** A docked window that leaves gives Chat back more than its own width: the
 *  launcher strip stops taking room too (idle, it floats over Chat). Chat
 *  grows over that lane while the window collapses, so the hand-over to the
 *  idle layout moves nothing. Held at its end until the caller cancels it. */
export function playRailRelease(
  workspace: HTMLElement | null,
  lane: number,
  timing: RailMorphTiming | null,
): RailMorphHandle | null {
  if (workspace === null || timing === null || !(lane >= MORPH_EPSILON)) return null;
  if (typeof workspace.animate !== "function") return null;
  const side = workspaceRailSide(workspace);
  const animation = workspace.animate(
    [{ [side]: "0px" }, { [side]: `${round(-lane)}px` }],
    { duration: timing.duration, easing: timing.easing, fill: "forwards" },
  );
  return {
    cancel() { animation.cancel(); },
    finished: animation.finished.then(() => undefined, () => undefined),
    duration: timing.duration,
  };
}

/** The exit clock (tokens.css `--motion-window-exit*`), or null when motion is off. */
export function railExitTiming(element: HTMLElement): RailMorphTiming | null {
  const entry = railMorphTiming(element);
  if (entry === null) return null;
  const style = getComputedStyle(element);
  const duration = parseDuration(style.getPropertyValue("--motion-window-exit"));
  if (!(duration > 0)) return null;
  return { duration, easing: style.getPropertyValue("--motion-window-exit-ease").trim() || "ease-in" };
}

/** Chat keeps the width it had and reaches the new one with the frame. A
 *  negative margin on the launcher's side lets it run on under a window that
 *  now takes its room. */
export function railWorkspaceKeyframes(
  from: number | null,
  to: number | null,
  side: WorkspaceSide = "marginRight",
): Keyframe[] | null {
  if (from === null || to === null || !(from > 0) || !(to > 0) || Math.abs(from - to) < MORPH_EPSILON) return null;
  return [{ [side]: `${round(to - from)}px` }, { [side]: "0px" }];
}

/** Chat's margin on the launcher's side. Physical on purpose: a mirrored shell
 *  flips the shell's direction while Chat keeps the document's, so Chat's own
 *  logical inline end would be the navigator's side. */
export type WorkspaceSide = "marginLeft" | "marginRight";
export function workspaceRailSide(workspace: HTMLElement): WorkspaceSide {
  const shell = workspace.parentElement;
  return shell !== null && getComputedStyle(shell).direction === "rtl" ? "marginLeft" : "marginRight";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface RailMorphHandle {
  cancel(): void;
  /** Resolves when the resize has run to its end (never after `cancel`). */
  finished: Promise<void>;
  duration: number;
}

/** Run the resize. `before` was read before the commit, the new layout is on
 *  screen now. Returns a handle that drops the motion at once (the next
 *  transition measures the live boxes first, so an interrupted morph continues
 *  from where it is). */
export function playRailMorph(
  targets: RailMorphTargets,
  before: RailFrameReading,
  layout: RailFrameLayout,
  timing: RailMorphTiming | null,
): RailMorphHandle | null {
  const { pane, workspace } = targets;
  if (timing === null || pane === null || before.pane === null) return null;
  if (typeof pane.animate !== "function") return null;
  const after = readRailFrame(targets);
  if (after.pane === null) return null;
  const options: KeyframeAnimationOptions = { duration: timing.duration, easing: timing.easing, fill: "none" };
  const running: Animation[] = [];
  const frame = railFrameKeyframes(layout, before.pane, after.pane);
  if (frame !== null) running.push(pane.animate(frame, options));
  // A layer is opaque where a window is glass. The old material stays on a
  // veil under the content and fades, so the frame changes fill, not flashes.
  let veil: HTMLElement | null = null;
  if (before.pane.fill !== "" && before.pane.fill !== after.pane.fill) {
    veil = document.createElement("div");
    veil.className = "rail-morph-veil";
    veil.setAttribute("aria-hidden", "true");
    veil.style.background = before.pane.fill;
    pane.prepend(veil);
    running.push(veil.animate([{ opacity: 1 }, { opacity: 0 }], { ...options, fill: "forwards" }));
  }
  const dropVeil = () => { veil?.remove(); veil = null; };
  const chat = workspace !== null
    ? railWorkspaceKeyframes(before.workspace, after.workspace, workspaceRailSide(workspace))
    : null;
  if (chat !== null && workspace !== null && typeof workspace.animate === "function") {
    running.push(workspace.animate(chat, options));
  }
  if (running.length === 0) return null;
  let cancelled = false;
  const finished = new Promise<void>((resolve) => {
    void Promise.all(running.map((animation) => animation.finished)).then(
      () => { dropVeil(); if (!cancelled) resolve(); },
      () => undefined,
    );
  });
  return {
    cancel() {
      cancelled = true;
      for (const animation of running) animation.cancel();
      dropVeil();
    },
    finished,
    duration: timing.duration,
  };
}
