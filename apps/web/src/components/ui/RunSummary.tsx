import type { ReactNode } from "react";
import Icon from "./Icon.tsx";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  ErrorIcon,
  StopIcon,
  SuccessIcon,
} from "./icons.ts";
import Spinner from "./Spinner.tsx";

export type RunSummaryState = "active" | "completed" | "failed" | "waiting" | "cancelled";

export interface RunSummaryProps {
  title: string;
  meta?: ReactNode;
  state: RunSummaryState;
  expanded: boolean;
  onToggle: () => void;
  additions?: number;
  deletions?: number;
  label?: string;
  className?: string;
}

function StateMark({ state }: { state: RunSummaryState }) {
  if (state === "active") return <Spinner size="sm" />;
  const Glyph = state === "completed" ? SuccessIcon
    : state === "failed" ? ErrorIcon
      : state === "cancelled" ? StopIcon
        : ClockIcon;
  return <Icon icon={Glyph} size="sm" />;
}

export default function RunSummary({
  title,
  meta,
  state,
  expanded,
  onToggle,
  additions = 0,
  deletions = 0,
  label,
  className,
}: RunSummaryProps) {
  const Chevron = expanded ? ChevronUpIcon : ChevronDownIcon;
  return (
    <button
      type="button"
      className={`ui-run-summary${className ? ` ${className}` : ""}`}
      data-state={state}
      aria-label={label ?? `${expanded ? "Collapse" : "Expand"} ${title}`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="ui-run-summary-mark" aria-hidden="true"><StateMark state={state} /></span>
      <span className="ui-run-summary-copy">
        <strong>{title}</strong>
        {meta && <small>{meta}</small>}
      </span>
      {(additions > 0 || deletions > 0) && (
        <span className="ui-run-summary-diff" aria-label={`${additions} additions, ${deletions} deletions`}>
          {additions > 0 && <span className="positive">+{additions}</span>}
          {deletions > 0 && <span className="negative">−{deletions}</span>}
        </span>
      )}
      <Icon icon={Chevron} size="sm" className="ui-run-summary-chevron" />
    </button>
  );
}
