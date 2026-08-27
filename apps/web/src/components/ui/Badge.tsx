// Status badge: quiet wash surfaces with accessible on-wash ink. Meaningful
// state must also be conveyed by the text, never by color alone.
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** Leading status dot. */
  dot?: boolean;
  className?: string;
}

export default function Badge({ tone = "neutral", children, dot = false, className }: BadgeProps) {
  return (
    <span className={`ui-badge ui-badge--${tone}${className ? ` ${className}` : ""}`}>
      {dot && <i className="ui-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
