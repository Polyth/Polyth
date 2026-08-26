import type { ReactNode } from "react";

interface WorkflowButtonContentProps {
  busy: boolean;
  idleLabel: string;
  busyLabel: string;
  idleIcon?: ReactNode;
  idleTrailingIcon?: ReactNode;
}

/** Both states share one grid cell, so async copy never changes button width. */
export default function WorkflowButtonContent({
  busy,
  idleLabel,
  busyLabel,
  idleIcon,
  idleTrailingIcon,
}: WorkflowButtonContentProps) {
  return (
    <span className="workflow-button-content">
      <span className={busy ? "is-measuring" : undefined} aria-hidden={busy}>
        {idleIcon}{idleLabel}{idleTrailingIcon}
      </span>
      <span className={busy ? undefined : "is-measuring"} aria-hidden={!busy}>
        <span className="workflow-button-spinner" aria-hidden />{busyLabel}
      </span>
    </span>
  );
}
