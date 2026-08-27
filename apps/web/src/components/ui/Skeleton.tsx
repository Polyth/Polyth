// Loading placeholder. Shimmer pauses under prefers-reduced-motion (CSS).
// Wrap a group of skeletons in an element with aria-busy and a status label;
// individual blocks are decorative.
import type { CSSProperties } from "react";

export interface SkeletonProps {
  shape?: "text" | "block" | "circle";
  /** Explicit dimensions when the container does not size the placeholder. */
  width?: string | number;
  height?: string | number;
  className?: string;
}

export default function Skeleton({ shape = "text", width, height, className }: SkeletonProps) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return (
    <span
      className={`ui-skeleton ui-skeleton--${shape}${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    />
  );
}
