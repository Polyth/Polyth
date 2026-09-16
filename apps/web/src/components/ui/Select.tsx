// Simple single-value select on top of the canonical searchable Picker
// (compact anchored popover on every form factor). Use Picker directly for
// multi-select, trailing actions, or footer actions.
import Picker from "../Picker.tsx";
import type { PickerItem } from "../../picker.ts";

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  detail?: string;
}

export interface SelectProps {
  /** Accessible name/context; the selected option is the visible trigger text. */
  label: string;
  value?: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Rare opt-in: bottom sheet on phones instead of the default compact popover. */
  mobileSheet?: boolean;
}

export default function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
  className,
  ariaLabel,
  mobileSheet,
}: SelectProps) {
  const items: PickerItem[] = options.map((option) => ({
    id: option.value,
    label: option.label,
    group: option.group ?? "",
    ...(option.detail !== undefined ? { detail: option.detail } : {}),
  }));
  return (
    <Picker
      label={label}
      className={`picker-select${className ? ` ${className}` : ""}`}
      items={items}
      onPick={onChange}
      disabled={disabled}
      {...(mobileSheet !== undefined ? { mobileSheet } : {})}
      {...(value !== undefined ? { value } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(ariaLabel !== undefined ? { ariaLabel } : {})}
    />
  );
}
