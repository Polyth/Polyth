// Shared empty state: centered mark, heading, description, optional CTA.
// One primitive, three container variants (see docs/dev/styles.md):
//   page    — primary full-page first-run or error state (default);
//   panel   — bounded state for a rail, card, or docked panel;
//   compact — inline prerequisite or no-results message.
import type { ReactNode } from "react";
import Button from "./ui/Button.tsx";

export type EmptyStateVariant = "page" | "panel" | "compact";

export default function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  mark,
  variant = "page",
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  mark?: ReactNode;
  variant?: EmptyStateVariant;
}) {
  return (
    <div className={`empty-state empty-state--${variant}`}>
      <span className="empty-state-mark" aria-hidden>
        {mark ?? (
          <svg className="ui-icon ui-icon--xl" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4l2.5 2.5" />
          </svg>
        )}
      </span>
      <h2 className="empty-state-title">{title}</h2>
      {description && <p className="empty-state-desc">{description}</p>}
      {actionLabel && onAction && (
        <Button variant="primary" className="empty-state-action" onClick={onAction}>{actionLabel}</Button>
      )}
    </div>
  );
}
