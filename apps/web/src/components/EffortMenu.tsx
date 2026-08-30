import { useState } from "react";
import { thinkingVariantLabel } from "@polyth/models/model-presentation";
import { tr } from "../i18n/index.ts";

export interface EffortMenuProps {
  variants: readonly string[];
  value?: string;
  onPick: (thinking: string | undefined) => void;
  /** Fired once when the tap/drag ends — phones re-open the keyboard here. */
  onCommit?: () => void;
}

/**
 * Discrete reasoning effort with one native range stop per backend variant.
 * One draggable track serves every layout; on touch the drag selects the
 * nearest stop while the tooltip names the live value. "Auto" stays a real
 * reset choice instead of pretending the model default is another variant.
 */
export default function EffortMenu({
  variants,
  value,
  onPick,
  onCommit,
}: EffortMenuProps) {
  const [adjusting, setAdjusting] = useState(false);
  const options = ["", ...new Set(variants)];
  const selected = Math.max(0, options.indexOf(value ?? ""));
  const selectedOption = options[selected] ?? "";
  const label = selectedOption ? thinkingVariantLabel(selectedOption) : tr("composer.auto");
  const endAdjust = () => {
    setAdjusting(false);
    onCommit?.();
  };

  return (
    <label
      className="composer-effort-control"
      title={tr("composer.thinkingEffortValue", { value: label })}
    >
      <span className="composer-effort-label">
        <span>{tr("composer.thinking")}</span>
        <output>{label}</output>
      </span>
      <span className="composer-effort-track">
        <input
          type="range"
          min={0}
          max={options.length - 1}
          step={1}
          value={selected}
          aria-label={tr("composer.thinkingEffortValue", { value: label })}
          aria-valuetext={label}
          onChange={(event) => onPick(options[Number(event.target.value)] || undefined)}
          onPointerDown={() => setAdjusting(true)}
          onPointerUp={endAdjust}
          onPointerCancel={endAdjust}
          onBlur={() => setAdjusting(false)}
        />
        <span className="composer-effort-stops" aria-hidden="true">
          {options.map((option, index) => (
            <i key={option || "auto"} className={index <= selected ? "active" : ""} />
          ))}
        </span>
        {adjusting && (
          <span className="composer-effort-tooltip" role="tooltip">
            {tr("composer.thinkingValue", { value: label })}
          </span>
        )}
      </span>
    </label>
  );
}
