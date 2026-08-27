// Shared empty state: centered mark, heading, description, optional CTA.
import type { ReactNode } from "react";

export default function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  mark,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  mark?: ReactNode;
}) {
  return (
    <div className="empty-state empty-state--page">
      <span className="empty-state-mark" aria-hidden>
        {mark ?? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4l2.5 2.5" />
          </svg>
        )}
      </span>
      <h2 className="empty-state-title">{title}</h2>
      {description && <p className="empty-state-desc">{description}</p>}
      {actionLabel && onAction && (
        <button className="primary-btn empty-state-action" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}
