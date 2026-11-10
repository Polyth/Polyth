// Progress bar. Determinate by default; `indeterminate` slides for work whose
// duration is unknown. For work with no visible length use Spinner or Skeleton.
export interface ProgressProps {
  /** 0..1 fraction of completion (ignored when `indeterminate`). */
  value: number;
  /** Accessible name for what is progressing. */
  label: string;
  className?: string;
  /** Unknown completion: a sliding segment, and no `aria-valuenow`. */
  indeterminate?: boolean;
}

export default function Progress({ value, label, className, indeterminate = false }: ProgressProps) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      className={`ui-progress${indeterminate ? " ui-progress--indeterminate" : ""}${className ? ` ${className}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? {} : { "aria-valuenow": Math.round(clamped * 100) })}
    >
      <div className="ui-progress-fill" style={indeterminate ? undefined : { width: `${clamped * 100}%` }} />
    </div>
  );
}
