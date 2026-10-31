import type { ReactNode } from "react";
import { Icon } from "../../icons.tsx";
import { Tooltip } from "../ui/index.ts";
import "./SessionHoverCard.css";
import { tr } from "../../i18n/index.ts";

export interface SessionHoverCardProps {
  title: string;
  projectName?: string;
  branch?: string | null;
  path?: string | null;
  isolated?: boolean;
  /** Current row state, spelled out (the row itself shows only a mark). */
  status?: { label: string; tone: string };
  children: ReactNode;
}

function cleanBranch(branch?: string | null): string {
  return branch?.replace(/^refs\/heads\//, "").trim() ?? "";
}

export default function SessionHoverCard({
  title,
  projectName,
  branch,
  path,
  isolated = false,
  status,
  children,
}: SessionHoverCardProps) {
  const project = projectName?.trim() ?? "";
  const branchName = cleanBranch(branch);
  const checkoutPath = path?.trim() ?? "";
  const hasDetails = Boolean(project || branchName || checkoutPath);

  if (!hasDetails) return <>{children}</>;

  return (
    <Tooltip
      side="right"
      className="session-hover-card-tooltip"
      content={(
        <div className="session-hover-card">
          <div className="session-hover-card-head">
            <strong className="session-hover-card-title">{title}</strong>
            {isolated && <span className="session-hover-card-chip">{tr("sidebar.hoverIsolated")}</span>}
          </div>
          {status && <div className="session-hover-card-status" data-tone={status.tone}>{status.label}</div>}
          <div className="session-hover-card-meta">
            {project && (
              <div className="session-hover-card-row">
                <span className="session-hover-card-icon"><Icon.package /></span>
                <span className="session-hover-card-value">{project}</span>
              </div>
            )}
            {branchName && (
              <div className="session-hover-card-row">
                <span className="session-hover-card-icon"><Icon.branch /></span>
                <span className="session-hover-card-value session-hover-card-technical">{branchName}</span>
              </div>
            )}
            {checkoutPath && (
              <div className="session-hover-card-row session-hover-card-path-row">
                <span className="session-hover-card-icon"><Icon.files /></span>
                <span className="session-hover-card-value session-hover-card-path">{checkoutPath}</span>
              </div>
            )}
          </div>
        </div>
      )}
    >
      {children}
    </Tooltip>
  );
}
