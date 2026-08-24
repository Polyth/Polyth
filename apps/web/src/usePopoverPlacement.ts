// Keep anchored menus close to their trigger. Desktop pickers prefer opening
// downward, but change direction when the rendered menu cannot fit below it.
import { useLayoutEffect, useState, type RefObject } from "react";

export type PopoverDirection = "up" | "down";

export function usePopoverPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
): PopoverDirection {
  const [direction, setDirection] = useState<PopoverDirection>("down");

  useLayoutEffect(() => {
    if (!open) {
      setDirection("down");
      return;
    }

    const update = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const triggerRect = trigger.getBoundingClientRect();
      const popoverHeight = popover.getBoundingClientRect().height;
      const below = window.innerHeight - triggerRect.bottom;
      const above = triggerRect.top;
      // A menu stays below whenever it fits there. If neither side can show
      // the whole thing, use the roomier side instead of clipping its start.
      setDirection(below >= popoverHeight + 6 || below >= above ? "down" : "up");
    };

    update();
    const frame = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(update);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [open, popoverRef, triggerRef]);

  return direction;
}
