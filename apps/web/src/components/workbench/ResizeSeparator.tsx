// Shared accessible resize separator for workbench regions: pointer drag plus
// keyboard (Arrow = 16px, Shift+Arrow = 64px, Home/End = bounds). The parent
// owns clamping and persistence; this component only reports intents.
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

export const RESIZE_STEP = 16;
export const RESIZE_STEP_LARGE = 64;

export interface ResizeSeparatorProps {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  label: string;
  /** +1 when dragging right/down grows the value, -1 when it shrinks it. */
  direction: 1 | -1;
  /** Live (uncommitted) value while dragging. */
  onPreview: (value: number) => void;
  /** Final value once the pointer is released or a key changed it. */
  onCommit: (value: number) => void;
  className?: string;
}

/** Pure keyboard step for the separator: exported for DOM-free tests. */
export function separatorKeyValue(
  key: string,
  shift: boolean,
  orientation: "vertical" | "horizontal",
  value: number,
  min: number,
  max: number,
  direction: 1 | -1,
  rtl = false,
): number | null {
  const step = shift ? RESIZE_STEP_LARGE : RESIZE_STEP;
  const grow = orientation === "vertical"
    ? key === (rtl ? "ArrowLeft" : "ArrowRight")
    : key === "ArrowDown";
  const shrink = orientation === "vertical"
    ? key === (rtl ? "ArrowRight" : "ArrowLeft")
    : key === "ArrowUp";
  let next: number | null = null;
  if (grow) next = value + direction * step;
  else if (shrink) next = value - direction * step;
  else if (key === "Home") next = min;
  else if (key === "End") next = max;
  if (next === null) return null;
  return Math.min(max, Math.max(min, Math.round(next)));
}

export default function ResizeSeparator({
  orientation, value, min, max, label, direction, onPreview, onCommit, className,
}: ResizeSeparatorProps) {
  const drag = useRef<{ start: number; value: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const coordinate = (pointer: { clientX: number; clientY: number }) =>
      orientation === "vertical" ? pointer.clientX : pointer.clientY;
    const rtl = document.documentElement.dir === "rtl";
    const sign = orientation === "vertical" && rtl ? -direction : direction;
    drag.current = { start: coordinate(event), value };
    document.documentElement.dataset.packageWindowResizing = "true";
    const compute = (pointer: PointerEvent) =>
      Math.min(max, Math.max(min, Math.round(drag.current!.value + sign * (coordinate(pointer) - drag.current!.start))));
    const move = (pointer: PointerEvent) => {
      if (!drag.current) return;
      onPreview(compute(pointer));
    };
    const up = (pointer: PointerEvent) => {
      const active = drag.current;
      drag.current = null;
      delete document.documentElement.dataset.packageWindowResizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!active) return;
      onCommit(compute(pointer));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up, { once: true });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = separatorKeyValue(
      event.key, event.shiftKey, orientation, value, min, max, direction,
      document.documentElement.dir === "rtl",
    );
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      className={`wb-separator wb-separator--${orientation}${className ? ` ${className}` : ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
