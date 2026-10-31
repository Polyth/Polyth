// Exit motion for surfaces whose owner unmounts them at once.
//
// Most transient surfaces (menus, popovers, sheets, dialogs, Settings) are
// rendered conditionally: the moment they close, React removes their DOM and
// nothing is left to animate. Keeping every owner mounted through an exit would
// ripple into focus, scroll-lock and Escape lifetimes across dozens of callers.
// Instead the surface leaves a ghost: an inert, presentation-only copy of its
// last frame, inserted where it was, that plays the surface's exit animation
// (selected in CSS by `[data-exit-ghost="<kind>"]`) and removes itself.
//
// The ghost is never interactive, never focusable, hidden from assistive
// technology and carries no ids or roles, so nothing can find or reach it. With
// motion reduced (or where nothing animates it, like a test DOM without the
// stylesheet) it is removed in the same task, before anything paints.
import { useCallback, useRef, type MutableRefObject, type RefCallback } from "react";
import { motionIsReduced } from "./motionPresence.ts";

export interface ExitGhostSpec {
  /** Selects the exit animation: `[data-exit-ghost="<kind>"]`. */
  kind: string;
  /** Custom properties the exit reads (where a swipe left the surface, its pace). */
  vars?: Readonly<Record<string, string>>;
}

/** Longest a ghost may outlive its exit before it is removed regardless. */
const GHOST_SLACK_MS = 160;
const GHOST_CEILING_MS = 1200;

/** Copy what `cloneNode` leaves behind: scroll offsets, field values, canvas pixels. */
function copyLiveState(source: HTMLElement, ghost: HTMLElement): void {
  const from = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const to = [ghost, ...ghost.querySelectorAll<HTMLElement>("*")];
  if (from.length !== to.length) return;
  for (let i = 0; i < from.length; i++) {
    const original = from[i]!;
    const copy = to[i]!;
    if (original.scrollTop || original.scrollLeft) {
      copy.scrollTop = original.scrollTop;
      copy.scrollLeft = original.scrollLeft;
    }
    // Tag names, not constructors: the copy may live in another realm's globals.
    const tag = original.tagName;
    if (tag === "INPUT") {
      (copy as HTMLInputElement).value = (original as HTMLInputElement).value;
      (copy as HTMLInputElement).checked = (original as HTMLInputElement).checked;
    } else if (tag === "TEXTAREA" || tag === "SELECT") {
      (copy as HTMLTextAreaElement).value = (original as HTMLTextAreaElement).value;
    } else if (tag === "CANVAS") {
      try {
        (copy as HTMLCanvasElement).getContext("2d")?.drawImage(original as HTMLCanvasElement, 0, 0);
      } catch {
        // A tainted or context-less canvas stays blank for the exit.
      }
    }
  }
}

/** Remove everything a copy must not do: load, play, be found or be reached. */
function neuter(ghost: HTMLElement): void {
  for (const media of ghost.querySelectorAll<HTMLElement>("iframe, video, audio, object, embed")) {
    // A placeholder of the same size keeps the layout without loading anything.
    const stand = ghost.ownerDocument.createElement("div");
    stand.className = media.className;
    stand.setAttribute("style", media.getAttribute("style") ?? "");
    const { width, height } = media.getBoundingClientRect();
    if (width > 0) stand.style.width = `${width}px`;
    if (height > 0) stand.style.height = `${height}px`;
    media.replaceWith(stand);
  }
  // Roles stay (styles select on them); what code looks up does not: an id
  // would answer `getElementById` once the original is gone, and a lingering
  // `aria-modal` would read as a modal still open over everything.
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("[id], [aria-modal], [autofocus]")]) {
    node.removeAttribute("id");
    node.removeAttribute("aria-modal");
    node.removeAttribute("autofocus");
  }
}

/**
 * Leave an exit ghost of `node` in its place. Call while `node` is still in
 * the document (a ref callback's detach, a layout cleanup); the owner then
 * removes the real surface as usual.
 */
export function leaveExitGhost(node: HTMLElement | null, spec: ExitGhostSpec): void {
  if (!node?.isConnected || !node.parentNode || motionIsReduced()) return;
  // Without the Web Animations API nothing could tell when the exit is over.
  if (typeof node.getAnimations !== "function") return;
  const doc = node.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  const ghost = node.cloneNode(true) as HTMLElement;
  for (const [name, value] of Object.entries(spec.vars ?? {})) ghost.style.setProperty(name, value);
  ghost.setAttribute("data-exit-ghost", spec.kind);
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  // Scroll offsets and values are copied before anything is replaced, so the
  // original and the copy still pair element for element.
  node.after(ghost);
  copyLiveState(node, ghost);
  neuter(ghost);

  const animations = ghost.getAnimations({ subtree: true });
  if (animations.length === 0) {
    ghost.remove();
    return;
  }
  let done = false;
  const remove = (): void => {
    if (done) return;
    done = true;
    win.clearTimeout(timer);
    ghost.remove();
  };
  let longest = 0;
  for (const animation of animations) {
    const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
    if (Number.isFinite(end)) longest = Math.max(longest, end);
  }
  const timer = win.setTimeout(remove, Math.min(GHOST_CEILING_MS, longest + GHOST_SLACK_MS));
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(remove);
}

/**
 * A stable ref callback for a surface's root that leaves an exit ghost when
 * React detaches it. `spec()` is read at that moment: return null when the
 * surface has already played its own exit (or must not leave one). Pass
 * `target` to keep an object ref pointing at the element too.
 */
export function useExitGhost<T extends HTMLElement>(
  spec: () => ExitGhostSpec | null,
  target?: MutableRefObject<T | null>,
): RefCallback<T> {
  const latest = useRef(spec);
  latest.current = spec;
  const targetRef = useRef(target);
  targetRef.current = target;
  const attached = useRef<T | null>(null);
  return useCallback((node: T | null) => {
    const previous = attached.current;
    attached.current = node;
    if (targetRef.current) targetRef.current.current = node;
    // React detaches a ref while the element is still in the document.
    if (node || !previous) return;
    const next = latest.current();
    if (next) leaveExitGhost(previous, next);
  }, []);
}
