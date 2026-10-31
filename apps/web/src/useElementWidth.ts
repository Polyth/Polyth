import { useLayoutEffect, useState } from "react";

/**
 * Tracks the rendered inline size of an element.
 *
 * The sidebar toolbar has to change what it *says* — not merely how it is
 * styled — once its column is too narrow for the full search placeholder, and
 * a string cannot be swapped from CSS. Measuring the real column keeps that
 * decision correct across every input that can change it: dragging the
 * separator, the project-rail size setting, mirroring, the compact drawer and
 * the automatic rail. Deriving the width arithmetically from the sidebar
 * setting would have to re-implement the shell's own flex math.
 *
 * Returns `null` until the first measurement, so callers can keep the
 * unmeasured (widest) presentation for the very first frame.
 */
export function useElementWidth<T extends HTMLElement>(
  ref: { current: T | null },
  /** Observe this element instead of `ref.current` (for `display: contents` wrappers). */
  target?: { current: HTMLElement | null },
): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = target?.current ?? ref.current;
      if (!el) return;
      const next = el.getBoundingClientRect().width;
      setWidth((current) => (current !== null && Math.abs(current - next) < 0.5 ? current : next));
    };
    measure();
    const el = target?.current ?? ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, target]);

  return width;
}
