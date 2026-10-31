import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether a scroll region has content below its visible end. The card fades
 * that edge instead of cutting a row in half, and the fade clears at the end.
 * Scroll and size driven, never animated, so it holds under reduced motion.
 */
export function useMoreBelow<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [more, setMore] = useState(false);
  const frame = useRef(0);
  const ref = useCallback((next: T | null) => setNode(next), []);
  useEffect(() => {
    if (!node) return;
    const measure = () => {
      frame.current = 0;
      setMore(node.scrollHeight - node.scrollTop - node.clientHeight > 1);
    };
    const schedule = () => {
      if (frame.current) return;
      if (typeof requestAnimationFrame !== "function") return measure();
      frame.current = requestAnimationFrame(measure);
    };
    measure();
    node.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return () => {
      node.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame.current && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [node]);
  return [ref, more];
}
