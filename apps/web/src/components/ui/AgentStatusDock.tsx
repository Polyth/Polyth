import type { ReactNode } from "react";

export interface AgentStatusDockProps {
  icon: ReactNode;
  model: string;
  status: string;
  elapsed?: string | null;
  /** Localized changed-file count copy; the primitive owns no copy. */
  files?: string | null;
  additions?: number;
  deletions?: number;
  branch?: string;
  /** Localized accessible name for the dock. */
  label: string;
  /** Localized accessible name for the added/removed line counts. */
  diffLabel?: string;
  /** Opens active-run details when present. Without it the dock is a passive,
   * live status surface (used while a new agent is being spawned). */
  onClick?: () => void;
}

export default function AgentStatusDock({
  icon,
  model,
  status,
  elapsed,
  files,
  additions = 0,
  deletions = 0,
  branch,
  label,
  diffLabel,
  onClick,
}: AgentStatusDockProps) {
  const content = (
    <>
      <span className="agent-status-dock-icon" aria-hidden="true">{icon}<i /></span>
      <span className="agent-status-dock-content">
        <span className="agent-status-dock-primary">
          <strong>{model}</strong>
          <span
            className="agent-status-dock-state"
            title={status}
            {...(onClick ? { role: "status", "aria-live": "polite" as const } : {})}
          >{status}</span>
        </span>
        <span className="agent-status-dock-secondary">
          {files && <span>{files}</span>}
          {(additions > 0 || deletions > 0) && (
            <span className="agent-status-dock-diff" aria-label={diffLabel}>
              {additions > 0 && <span className="positive">+{additions}</span>}
              {deletions > 0 && <span className="negative">−{deletions}</span>}
            </span>
          )}
          {branch && <span className="agent-status-dock-branch" title={branch}>{branch}</span>}
        </span>
      </span>
      {elapsed && <time className="agent-status-dock-time" aria-hidden="true">{elapsed}</time>}
    </>
  );
  if (!onClick) {
    return (
      <div
        className="ui-glass-dock ui-glass-dock--strong agent-status-dock agent-status-dock--status"
        role="status"
        aria-live="polite"
        aria-label={label}
        aria-busy="true"
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ui-glass-dock ui-glass-dock--strong agent-status-dock"
      aria-label={label}
      aria-busy="true"
      onClick={onClick}
    >
      {content}
    </button>
  );
}
