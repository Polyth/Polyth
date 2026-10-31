// Indeterminate activity indicator. With a label it announces as a status
// region; without one it is decorative (the surrounding control owns the
// state, e.g. Button's aria-busy).
export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Accessible status text (e.g. "Loading sessions"). */
  label?: string;
  className?: string;
}

export default function Spinner({ size = "md", label, className }: SpinnerProps) {
  return (
    <span
      className={`ui-spinner ui-spinner--${size}${className ? ` ${className}` : ""}`}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
