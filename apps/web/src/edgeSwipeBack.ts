// Interactive Back for phone layers: drag a layer toward the inline end and it
// follows the finger while the layer beneath settles in behind it; release
// completes the Back or springs the layer home. The touch lifecycle is the
// shared shell-swipe controller's (swipeSurface.ts); this file owns what
// moves: the inline transforms and the hand-off to the CSS exit.
//
// Hand-off, not a second animation: on a completing release the layer's
// position is published as `--stack-from` (and the layer beneath's progress as
// `--stack-uncover-from` / `--stack-dim-from`), the inline drag styles are
// removed in the same task, and `onBack()` flips the state that already drives
// the stack's exit animation. That animation starts where the finger left off,
// so a drag and a button tap end in exactly the same motion. `--stack-settle`
// shortens both layers' animations together to the rest of the travel, so a
// flick is not slowed down and the pair still covers the screen as one.
import { edgeSwipeProgress, type SwipeZone } from "./mobileGestures.ts";
import { stackMotionDurationMs } from "./motionPresence.ts";
import { attachSwipeSurface, holdHandoff, parkLeavingLayer, SWIPE_OPT_OUT } from "./swipeSurface.ts";

export interface EdgeSwipeBackOptions {
  /** The layer that follows the finger; `null` when there is nothing to pull. */
  layer(): HTMLElement | null;
  /** The layer revealed beneath it, which peeks in as the first one leaves. */
  under?(): HTMLElement | null;
  /**
   * The element whose settle-back animation (`stack-uncover`) runs for
   * `under`; the release's settle time is held until that animation hands
   * over. Defaults to `under`'s first child (the sheet inside a layer host).
   */
  underMotion?(): HTMLElement | null;
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

/** Attach to a document; returns the cleanup. */
export function attachEdgeSwipeBack(options: EdgeSwipeBackOptions, doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  let handoffCleanup: (() => void) | null = null;

  const detach = attachSwipeSurface({
    surface: () => options.layer(),
    direction: "toward-end",
    zone: () => options.zone?.() ?? "edge",
    enabled: () => options.enabled(),
    motion: "--motion-stack",
    begin: ({ rtl, width }) => {
      const layer = options.layer();
      if (!layer) return null;
      const under = options.under?.() ?? null;
      under?.setAttribute("data-peek", "true");
      layer.style.willChange = "transform";
      // Marks the layer while a finger moves it. An animation outranks the
      // inline transform, even a finished one that fills forwards, so a layer
      // that can be dragged must never rest on a forwards-filled animation.
      layer.setAttribute("data-swiping", "true");

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

      return {
        paint(travel) {
          const progress = edgeSwipeProgress(travel, width);
          layer.style.transform = `translate3d(${(rtl ? -1 : 1) * travel}px, 0, 0)`;
          if (under) {
            under.style.setProperty("--stack-peek-x", veilExpression(1 - progress));
            under.style.setProperty("--stack-peek-dim", (1 - progress).toFixed(4));
          }
        },
        cancel: clear,
        commit({ travel, settleMs }) {
          const progress = edgeSwipeProgress(travel, width);
          // Publish where the finger left each layer, then drop the inline
          // styles in the same task: the exit animation takes over from these.
          layer.style.setProperty("--stack-from", `${travel}px`);
          under?.style.setProperty("--stack-uncover-from", veilExpression(1 - progress));
          under?.style.setProperty("--stack-dim-from", (1 - progress).toFixed(4));
          // Both layers finish in the rest of the travel time, together.
          if (settleMs > 0) {
            holdHandoff(layer, {
              pacing: { "--stack-out-settle": `${settleMs}ms` },
              animations: ["stack-out"],
              fallbackMs: 0,
            });
            if (under) {
              // The value sits on the layer's host (it reaches the veil too);
              // the settle itself runs on the sheet inside it.
              holdHandoff(under, {
                pacing: { "--stack-uncover-settle": `${settleMs}ms` },
                animations: ["stack-uncover", "stack-dim-out"],
                fallbackMs: 0,
                watch: options.underMotion?.() ?? (under.firstElementChild as HTMLElement | null) ?? under,
              });
            }
          }
          clear();
          if (settleMs <= 0) parkLeavingLayer(layer, `translate3d(${rtl ? "-" : ""}100%, 0, 0)`);
          options.onBack();
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
          const timer = win.setTimeout(release, stackMotionDurationMs() + 320);
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
