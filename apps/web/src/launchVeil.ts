// Driver for the launch veil index.html paints before anything else loads
// (brand night, the 112px mark at the viewport centre — the native launch
// screen's twin). It only moves pixels; when the veil lifts is decided by
// launchReveal.ts in the workspace and by the Connection Hub while connecting.
import type { LaunchVeil } from "@polyth/mobile/launch";
import { motionIsReduced } from "./motionPresence.ts";

const VEIL_ID = "polyth-launch";
const VEIL_NIGHT = "rgb(7, 9, 28)";
const VEIL_CLEAR = "rgba(7, 9, 28, 0)";
/** A mark that is not decoded by then is not worth holding a launch for. */
const MARK_DECODE_BUDGET_MS = 400;
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";

function veilElement(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById(VEIL_ID);
}

function markOf(veil: HTMLElement): HTMLImageElement | null {
  return veil.querySelector<HTMLImageElement>(".polyth-launch-mark");
}

function canAnimate(element: Element): boolean {
  return typeof (element as HTMLElement).animate === "function";
}

function finished(animations: Array<Animation | null>): Promise<void> {
  return Promise.all(animations.map((animation) => animation?.finished.catch(() => undefined)))
    .then(() => undefined);
}

/** The mark's layout box (transform-free), in viewport coordinates: the veil
 *  is fixed at the origin, so offsets are viewport positions. */
function markBox(mark: HTMLImageElement): { x: number; y: number; size: number } {
  return { x: mark.offsetLeft, y: mark.offsetTop, size: mark.offsetWidth };
}

/** Transform that lays the veil mark exactly over `target` (same image). */
function flightTransform(mark: HTMLImageElement, target: Element): string | null {
  const box = markBox(mark);
  const rect = target.getBoundingClientRect();
  if (box.size <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = rect.width / box.size;
  const dx = rect.left + rect.width / 2 - (box.x + box.size / 2);
  const dy = rect.top + rect.height / 2 - (box.y + box.size / 2);
  return `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
}

function setTargetVisible(target: Element | null | undefined, visible: boolean): void {
  if (!(target instanceof HTMLElement)) return;
  target.style.visibility = visible ? "" : "hidden";
}

let lifting: Promise<void> | null = null;

function settleHidden(veil: HTMLElement, animations: Array<Animation | null>): void {
  veil.hidden = true;
  delete veil.dataset.state;
  delete veil.dataset.status;
  document.documentElement.removeAttribute("data-launch");
  // Hidden first, then cancelled: the element returns to its resting styles
  // for a later restore() without ever painting them.
  for (const animation of animations) animation?.cancel();
}

export const launchVeil: LaunchVeil = {
  get active(): boolean {
    const veil = veilElement();
    return !!veil && !veil.hidden && veil.dataset.state !== "leaving";
  },

  async ready(): Promise<void> {
    const veil = veilElement();
    const mark = veil ? markOf(veil) : null;
    if (!mark || (mark.complete && mark.naturalWidth > 0)) return;
    await Promise.race([
      typeof mark.decode === "function" ? mark.decode().catch(() => undefined) : Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, MARK_DECODE_BUDGET_MS)),
    ]);
  },

  wait(status?: string | null): void {
    const veil = veilElement();
    if (!veil || veil.hidden || veil.dataset.state === "leaving") return;
    if (!motionIsReduced()) veil.dataset.state = "waiting";
    if (status !== undefined) this.setStatus(status);
  },

  setStatus(status: string | null): void {
    const veil = veilElement();
    const line = veil?.querySelector<HTMLElement>(".polyth-launch-status");
    if (!veil || !line) return;
    if (status) {
      line.textContent = status;
      veil.dataset.status = "shown";
    } else {
      delete veil.dataset.status;
    }
  },

  lift(options: { into?: Element | null } = {}): Promise<void> {
    if (lifting) return lifting;
    const veil = veilElement();
    if (!veil || veil.hidden) {
      document.documentElement.removeAttribute("data-launch");
      return Promise.resolve();
    }
    const mark = markOf(veil);
    // Freeze a breathing mark where it is: the exit starts from the frame on
    // screen instead of snapping back to rest first.
    const style = mark ? getComputedStyle(mark) : null;
    const fromTransform = style && style.transform !== "none" ? style.transform : "none";
    const fromOpacity = style ? Number(style.opacity) || 1 : 1;
    veil.dataset.state = "leaving";
    delete veil.dataset.status;

    if (!canAnimate(veil) || motionIsReduced()) {
      const animations = canAnimate(veil)
        ? [veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "linear", fill: "forwards" })]
        : [];
      lifting = finished(animations).then(() => settleHidden(veil, animations));
      return lifting;
    }

    const flight = mark && options.into ? flightTransform(mark, options.into) : null;
    const animations: Array<Animation | null> = [];
    if (mark && flight) {
      // The mark travels onto the brand mark it becomes; the night behind it
      // dissolves while it flies.
      setTargetVisible(options.into, false);
      animations.push(mark.animate(
        [{ transform: fromTransform, opacity: fromOpacity }, { transform: flight, opacity: 1 }],
        { duration: 560, easing: EASE_OUT, fill: "forwards" },
      ));
      animations.push(veil.animate(
        [{ backgroundColor: VEIL_NIGHT }, { backgroundColor: VEIL_CLEAR }],
        { duration: 440, delay: 60, easing: EASE_IN_OUT, fill: "forwards" },
      ));
    } else {
      // The workspace reveal: the mark swells a little as it dissolves and
      // the night clears to the workspace underneath.
      // The mark is gone before the workspace is half visible, so it never
      // ghosts over the content it uncovers.
      if (mark) {
        animations.push(mark.animate(
          [
            { transform: fromTransform, opacity: fromOpacity },
            { opacity: 0, offset: 0.62 },
            { transform: "scale(1.1)", opacity: 0 },
          ],
          { duration: 360, easing: EASE_OUT, fill: "forwards" },
        ));
      }
      animations.push(veil.animate(
        [{ backgroundColor: VEIL_NIGHT }, { backgroundColor: VEIL_CLEAR }],
        { duration: 440, delay: 50, easing: EASE_IN_OUT, fill: "forwards" },
      ));
    }
    lifting = finished(animations).then(() => {
      settleHidden(veil, animations);
      setTargetVisible(options.into, true);
    });
    return lifting;
  },

  async restore(options: { from?: Element | null } = {}): Promise<void> {
    const veil = veilElement();
    if (!veil) return;
    // Already up and not lifting: nothing to bring back.
    if (!lifting && !veil.hidden) return;
    if (lifting) await lifting;
    lifting = null;
    const mark = markOf(veil);
    delete veil.dataset.state;
    delete veil.dataset.status;
    document.documentElement.setAttribute("data-launch", "veiled");
    veil.hidden = false;
    if (!canAnimate(veil) || motionIsReduced()) {
      if (canAnimate(veil)) {
        await finished([veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "linear" })]);
      }
      return;
    }
    const flight = mark && options.from ? flightTransform(mark, options.from) : null;
    const animations: Animation[] = [
      veil.animate(
        [{ backgroundColor: VEIL_CLEAR }, { backgroundColor: VEIL_NIGHT }],
        { duration: flight ? 360 : 240, easing: EASE_IN_OUT },
      ),
    ];
    if (mark && flight) {
      setTargetVisible(options.from, false);
      animations.push(mark.animate(
        [{ transform: flight }, { transform: "none" }],
        { duration: 480, easing: EASE_OUT },
      ));
    } else if (mark) {
      animations.push(mark.animate(
        [{ transform: "scale(0.94)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 300, easing: EASE_OUT },
      ));
    }
    await finished(animations);
    setTargetVisible(options.from, true);
  },
};

/** Reload the page from behind its veil: the next document paints the same
 *  picture first, so a sign-in or retry never cuts to it. */
export function reloadBehindVeil(): void {
  void launchVeil.restore().catch(() => undefined).finally(() => location.reload());
}
