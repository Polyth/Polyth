import type { ReactNode } from "react";

export interface AgentStatusDockProps {
  icon: ReactNode;
  model: string;
  status: string;
  elapsed?: string | null;
  fileCount?: number;
  additions?: number;
  deletions?: number;
  branch?: string;
  label: string;
  onClick: () => void;
}

export default function AgentStatusDock({
  icon,
  model,
  status,
  elapsed,
  fileCount = 0,
  additions = 0,
  deletions = 0,
  branch,
  label,
  onClick,
}: AgentStatusDockProps) {
  return (
    <button
      type="button"
      className="ui-glass-dock ui-glass-dock--strong agent-status-dock"
      aria-label={label}
      aria-busy="true"
      onClick={onClick}
    >
      <span className="agent-status-dock-icon" aria-hidden="true">{icon}<i /></span>
      <span className="agent-status-dock-content">
        <span className="agent-status-dock-primary">
          <strong>{model}</strong>
          <span className="agent-status-dock-state" title={status} role="status" aria-live="polite">{status}</span>
        </span>
        <span className="agent-status-dock-secondary">
          {fileCount > 0 && <span>{fileCount} {fileCount === 1 ? "file" : "files"}</span>}
          {(additions > 0 || deletions > 0) && (
            <span className="agent-status-dock-diff" aria-label={`${additions} additions, ${deletions} deletions`}>
              {additions > 0 && <span className="positive">+{additions}</span>}
              {deletions > 0 && <span className="negative">−{deletions}</span>}
            </span>
          )}
          {branch && <span className="agent-status-dock-branch" title={branch}>{branch}</span>}
        </span>
      </span>
      {elapsed && <time className="agent-status-dock-time" aria-hidden="true">{elapsed}</time>}
    </button>
  );
}
