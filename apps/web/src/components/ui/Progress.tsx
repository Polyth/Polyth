// Determinate progress bar. For unknown durations use Spinner or Skeleton.
export interface ProgressProps {
  /** 0..1 fraction of completion. */
  value: number;
  /** Accessible name for what is progressing. */
  label: string;
  className?: string;
}

export default function Progress({ value, label, className }: ProgressProps) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      className={`ui-progress${className ? ` ${className}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <div className="ui-progress-fill" style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}
