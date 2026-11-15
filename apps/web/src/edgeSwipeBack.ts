// Interactive Back for phone layers: drag a layer toward the inline end and it
// follows the finger while the layer beneath settles in behind it; release
// completes the Back or springs the layer home. The touch lifecycle is the
// shared shell-swipe controller's (swipeSurface.ts); this file owns what
// moves: the inline transforms and the hand-off to the CSS exit.
//
// The release: the rest of the travel is the controller's spring, played on
// both layers as compositor animations started in the same task as the
// release (`settle`). `onBack()`, the state change that unmounts or hides the
// layer, follows about a frame later, under layers that are already moving,
// so its cost never shows as a pause between the finger and the settle.
//
// While the spring runs, the stack's own CSS exit must not start on those
// elements: a CSS animation that begins on an element the compositor is
// already moving makes the browser re-send the spring, and the layer shows a
// stale frame. So the layer carries `data-swipe-handoff="out"` (no CSS
// animation, parked off-screen by its inline transform) and the layer beneath
// keeps peeking, at rest. Both marks go when the spring is over; the CSS exit
// that starts then is parked at its destination (`--stack-from: 100%`, the
// layer beneath at rest) and is never seen. A layer whose owner unmounts it
// at once leaves an exit ghost (exitGhost.ts): the spring moves on to it.
//
// Without Web Animations the exit is a CSS hand-off instead: the layer's
// position is published as `--stack-from` (and the layer beneath's progress as
// `--stack-uncover-from` / `--stack-dim-from`), `onBack()` runs at once, and
// the exit animation carries on from where the finger left off, shortened to
// the rest of the travel and bent to the finger's speed (`--stack-swipe-ease`).
import { edgeSwipeProgress, type SwipeZone } from "./mobileGestures.ts";
import { stackMotionDurationMs } from "./motionPresence.ts";
import { animateSettle, attachSwipeSurface, holdHandoff, parkLeavingLayer, SWIPE_OPT_OUT, type SwipeSettle } from "./swipeSurface.ts";

export interface EdgeSwipeBackOptions {
  /** The layer that follows the finger; `null` when there is nothing to pull. */
  layer(): HTMLElement | null;
  /** The layer revealed beneath it, which peeks in as the first one leaves. */
  under?(): HTMLElement | null;
  /**
   * The element(s) of `under` that move as it peeks and settles back (the
   * ones its `stack-uncover` runs on); the release's settle time is held until
   * the first one's animation hands over. Defaults to `under`'s first child
   * (the sheet inside a layer host).
   */
  underMotion?(): HTMLElement | readonly HTMLElement[] | null;
  /** The element that dims `under`. Defaults to the `::after` veil of the first moving element. */
  underDim?(): HTMLElement | null;
  /** Whether a swipe may start right now. */
  enabled(): boolean;
  /** Where a swipe may start: the inline-start edge (default) or anywhere on the layer. */
  zone?(): SwipeZone;
  /** Complete the Back (the state change that starts the exit). */
  onBack(): void;
}

/** A subtree that owns horizontal gestures at the edge opts out with this attribute. */
export const EDGE_SWIPE_OPT_OUT = SWIPE_OPT_OUT;

const veilExpression = (remaining: number): string =>
  `calc(var(--stack-dir, 1) * var(--stack-parallax, 28%) * -${remaining.toFixed(4)})`;
const live = <T>(value: T | null): value is T => value !== null;

/** Attach to a document; returns the cleanup. */
export function attachEdgeSwipeBack(options: EdgeSwipeBackOptions, doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  let handoffCleanup: (() => void) | null = null;
  /** Takes back what a sprung release left on the layers for the spring's duration. */
  let unpark: (() => void) | null = null;

  const detach = attachSwipeSurface({
    surface: () => options.layer(),
    direction: "toward-end",
    zone: () => options.zone?.() ?? "edge",
    enabled: () => options.enabled(),
    motion: "--motion-stack",
    begin: ({ rtl, width }) => {
      const layer = options.layer();
      if (!layer) return null;
      unpark?.();
      const under = options.under?.() ?? null;
      under?.setAttribute("data-peek", "true");
      layer.style.willChange = "transform";
      // Marks the layer while a finger moves it. An animation outranks the
      // inline transform, even a finished one that fills forwards, so a layer
      // that can be dragged must never rest on a forwards-filled animation.
      layer.setAttribute("data-swiping", "true");

      const at = (travel: number): string => `translate3d(${(rtl ? -1 : 1) * travel}px, 0, 0)`;
      const moving = (): HTMLElement[] => {
        if (!under) return [];
        const parts = options.underMotion?.() ?? (under.firstElementChild as HTMLElement | null) ?? under;
        return parts instanceof win.HTMLElement ? [parts] : [...(parts as readonly HTMLElement[])];
      };
      const frame = (travel: number): Keyframe => ({ transform: at(travel) });
      /** The spring that is taking both layers to the end of the Back. */
      let spring: { settle: SwipeSettle; lead: Animation } | null = null;

      const clear = (): void => {
        layer.removeAttribute("data-swiping");
        layer.style.removeProperty("transform");
        layer.style.removeProperty("will-change");
        if (under) {
          under.removeAttribute("data-peek");
          under.style.removeProperty("--stack-peek-x");
          under.style.removeProperty("--stack-peek-dim");
        }
      };

      const paint = (travel: number): void => {
        const progress = edgeSwipeProgress(travel, width);
        layer.style.transform = at(travel);
        if (under) {
          under.style.setProperty("--stack-peek-x", veilExpression(1 - progress));
          under.style.setProperty("--stack-peek-dim", (1 - progress).toFixed(4));
        }
      };

      return {
        paint,
        settle(settle) {
          // Both layers, one spring: the peek rules position the layer beneath
          // without `!important`, so these outrank them until they are let go.
          const parts = moving();
          const dim = options.underDim?.() ?? null;
          const veil = dim ?? parts[0] ?? null;
          const lead = animateSettle(layer, settle, frame);
          spring = lead && settle.outcome === "commit" ? { settle, lead } : null;
          if (!lead) return null;
          return [
            lead,
            ...parts.map((part) => animateSettle(part, settle, (_travel, progress) => ({
              transform: `translate3d(${veilExpression(1 - progress)}, 0, 0)`,
            }))),
            veil && animateSettle(veil, settle, (_travel, progress) => ({ opacity: (1 - progress).toFixed(4) }), dim ? undefined : "::after"),
          ].filter(live);
        },
        cancel: clear,
        commit({ travel, settleMs, easing }) {
          const sprung = spring;
          // Where the CSS exit starts: at its end when the spring is already
          // taking the layers there, else where the finger left each of them.
          const progress = sprung ? 1 : edgeSwipeProgress(travel, width);
          // Published before the inline styles go, in the same task.
          layer.style.setProperty("--stack-from", sprung ? "100%" : `${travel}px`);
          under?.style.setProperty("--stack-uncover-from", veilExpression(1 - progress));
          under?.style.setProperty("--stack-dim-from", (1 - progress).toFixed(4));
          // Both layers finish in the rest of the travel time, together.
          if (settleMs > 0) {
            holdHandoff(layer, {
              pacing: { "--stack-out-settle": `${settleMs}ms`, "--stack-swipe-ease": easing },
              animations: ["stack-out"],
              fallbackMs: 0,
            });
            if (under) {
              // The value sits on the layer's host (it reaches the veil too);
              // the settle itself runs on the sheet inside it.
              holdHandoff(under, {
                // After a spring the settle-back has nothing left to show: it
                // only has to let the layer take input again.
                pacing: { "--stack-uncover-settle": sprung ? "1ms" : `${settleMs}ms`, "--stack-swipe-ease": easing },
                animations: ["stack-uncover", "stack-dim-out"],
                fallbackMs: 0,
                watch: moving()[0] ?? under,
              });
            }
          }
          if (sprung) {
            // Parked where the spring ends, with no CSS animation of their
            // own, for as long as it runs.
            layer.setAttribute("data-swipe-handoff", "out");
            paint(width);
            const settled = (): void => {
              win.clearTimeout(parked);
              if (unpark === settled) unpark = null;
              layer.removeAttribute("data-swipe-handoff");
              clear();
            };
            const parked = win.setTimeout(settled, settleMs);
            unpark = settled;
          } else {
            clear();
          }
          if (settleMs <= 0) parkLeavingLayer(layer, `translate3d(${rtl ? "-" : ""}100%, 0, 0)`);
          options.onBack();
          if (sprung && !layer.isConnected) {
            // Unmounted in this task: its ghost takes the spring over at the same moment of it.
            const ghost = doc.querySelector<HTMLElement>('[data-exit-ghost] [data-swipe-handoff="out"], [data-exit-ghost][data-swipe-handoff="out"]');
            const carried = ghost && animateSettle(ghost, sprung.settle, frame);
            // By its start, not its current time: that one is a frame old.
            if (carried && sprung.lead.startTime !== null) carried.startTime = sprung.lead.startTime;
          }
          // The hand-off values are read by the animation for its whole run;
          // release them when it ends (or, with motion off, shortly after) so
          // the next exit starts from the origin again.
          handoffCleanup?.();
          const release = (): void => {
            layer.style.removeProperty("--stack-from");
            under?.style.removeProperty("--stack-uncover-from");
            under?.style.removeProperty("--stack-dim-from");
            layer.removeEventListener("animationend", onAnimationEnd);
            win.clearTimeout(timer);
            if (handoffCleanup === release) handoffCleanup = null;
          };
          const onAnimationEnd = (event: AnimationEvent): void => {
            if (event.target === layer && event.animationName === "stack-out") release();
          };
          layer.addEventListener("animationend", onAnimationEnd);
          // After a spring the (parked) exit only starts once it is over.
          const timer = win.setTimeout(release, Math.max(stackMotionDurationMs() + 320, sprung ? settleMs * 2 + 120 : 0));
          handoffCleanup = release;
        },
      };
    },
  }, doc);

  // Deliberately NOT releasing a pending hand-off on detach: completing the
  // Back is what disables this layer, so detaching is exactly when the exit
  // animation is about to read `--stack-from`. Its own animationend/timer
  // releases it.
  return detach;
}
