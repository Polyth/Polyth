// Labelled checkbox: native input (keyboard/AT semantics for free) with a
// token-styled visual box. Multi-select lists; Switch owns on/off settings.
import type { ReactNode } from "react";
import { CheckIcon } from "./icons.ts";
import Icon from "./Icon.tsx";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export default function Checkbox({ checked, onChange, label, description, disabled, className }: CheckboxProps) {
  return (
    <label className={`ui-checkbox${disabled ? " ui-checkbox--disabled" : ""}${className ? ` ${className}` : ""}`}>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        {checked && <Icon icon={CheckIcon} size="sm" />}
      </span>
      <span className="ui-checkbox-text">
        <span className="ui-checkbox-label">{label}</span>
        {description && <span className="ui-checkbox-desc">{description}</span>}
      </span>
    </label>
  );
}
