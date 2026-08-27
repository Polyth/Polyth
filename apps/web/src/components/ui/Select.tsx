// Simple single-value select on top of the canonical searchable Picker
// (desktop popover, phone bottom sheet). Use Picker directly for
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
  /** Visible chip label + accessible name. */
  label: string;
  value?: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Bottom sheet on phones (default true — the touch-first behavior). */
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
  mobileSheet = true,
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
      items={items}
      onPick={onChange}
      disabled={disabled}
      mobileSheet={mobileSheet}
      {...(value !== undefined ? { value } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(className !== undefined ? { className } : {})}
      {...(ariaLabel !== undefined ? { ariaLabel } : {})}
    />
  );
}
