// On/off toggle. Reuses the canonical .switch visual so every switch in the
// app stays identical; this component is the single markup owner going
// forward (settings' Toggle delegates here).
export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name; required unless an external <label> is wired. */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
}

export default function Switch({ checked, onChange, label, labelledBy, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      className={`switch ui-switch${className ? ` ${className}` : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  );
}
