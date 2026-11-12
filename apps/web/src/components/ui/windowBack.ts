// One Back per package window. On a phone the host `ModuleView` draws the
// window's Back; content with its own inner level (a list and one item) lends
// that level to this Back instead of drawing a second arrow under it. The
// public seam is `host.ui.useWindowBack` (packages/web-sdk).
import { createContext, useContext, useEffect, useRef } from "react";

export interface WindowBackSeam {
  /** True when the window shows its own Back (the phone layer). */
  readonly drawsBack: boolean;
  /** Hand the window's Back to the content; returns the release. */
  claim(handler: () => void): () => void;
}

export const WindowBackContext = createContext<WindowBackSeam | null>(null);

/**
 * Lend an inner "back" step to the window. While `handler` is non-null and
 * the window draws its own Back, that Back runs the handler instead of
 * leaving the window. Returns true exactly then: the content hides its own
 * back control. Outside a window, or on a wide layout, it returns false and
 * the content keeps its control.
 */
export function useWindowBack(handler: (() => void) | null): boolean {
  const seam = useContext(WindowBackContext);
  const latest = useRef(handler);
  latest.current = handler;
  const active = handler !== null;
  useEffect(() => {
    if (!seam || !active) return;
    return seam.claim(() => latest.current?.());
  }, [seam, active]);
  return active && seam?.drawsBack === true;
}
