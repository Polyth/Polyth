import type { ReactNode } from "react";
import {
  ChevronRightIcon,
  Icon,
} from "../../../apps/web/src/components/ui/index.ts";

/** Polyth row that keeps the native date/time/number picker under a calm label. */
export default function PlannerNativeField({
  label,
  display,
  type,
  value,
  disabled = false,
  min,
  max,
  onChange,
}: {
  label: string;
  display: ReactNode;
  type: "date" | "time" | "number";
  value: string;
  disabled?: boolean;
  min?: number | string;
  max?: number | string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`planner-native-row${disabled ? " is-disabled" : ""}`}>
      <span className="planner-native-k">{label}</span>
      <span className="planner-native-v">{display}</span>
      <Icon icon={ChevronRightIcon} size="sm" />
      <input
        type={type}
        value={value}
        disabled={disabled}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
