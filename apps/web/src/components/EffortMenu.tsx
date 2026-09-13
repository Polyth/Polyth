import { useEffect, useRef, useState } from "react";
import { thinkingVariantLabel } from "@polyth/models/model-presentation";
import { tr } from "../i18n/index.ts";

export interface EffortMenuProps {
  variants: readonly string[];
  value?: string;
  onPick: (thinking: string | undefined) => void;
  /** Fired once after a choice commits — phones re-open the keyboard here. */
  onCommit?: () => void;
}

const METER_BARS = 4;

function EffortGlyph({ level, auto = false }: { level: number; auto?: boolean }) {
  const bounded = Math.max(0, Math.min(METER_BARS, level));
  return (
    <span
      className={`composer-effort-meter${auto ? " auto" : ""}`}
      aria-hidden="true"
      data-level={bounded}
    >
      {Array.from({ length: METER_BARS }, (_, index) => (
        <i key={index} className={index < bounded ? "active" : ""} />
      ))}
    </span>
  );
}

/**
 * Quiet, configuration-shaped reasoning control. The visible glyph is a
 * static level meter (never a progress/loading ring) and opens a tiny icon-only
 * choice surface. Labels remain available through title/ARIA so the compact
 * presentation does not sacrifice accessibility.
 */
export default function EffortMenu({
  variants,
  value,
  onPick,
  onCommit,
}: EffortMenuProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const options = ["", ...new Set(variants)];
  const selected = Math.max(0, options.indexOf(value ?? ""));
  const selectedOption = options[selected] ?? "";
  const label = selectedOption ? thinkingVariantLabel(selectedOption) : tr("composer.auto");
  const explicitLevel = selectedOption ? Math.min(METER_BARS, Math.max(1, selected)) : 0;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>(".composer-effort-trigger")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const pick = (option: string) => {
    onPick(option || undefined);
    setOpen(false);
    setAdjusting(true);
    queueMicrotask(() => {
      setAdjusting(false);
      onCommit?.();
    });
  };

  return (
    <span ref={rootRef} className="composer-effort-control">
      <button
        type="button"
        className="composer-effort-trigger"
        title={tr("composer.thinkingEffortValue", { value: label })}
        aria-label={tr("composer.thinkingEffortValue", { value: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <EffortGlyph level={explicitLevel} auto={!selectedOption} />
      </button>

      {open && (
        <div className="composer-effort-menu" role="menu" aria-label={tr("composer.thinking")}>
          {options.map((option, index) => {
            const optionLabel = option ? thinkingVariantLabel(option) : tr("composer.auto");
            const active = option === selectedOption;
            return (
              <button
                key={option || "auto"}
                type="button"
                className={`composer-effort-option${active ? " selected" : ""}`}
                role="menuitemradio"
                aria-checked={active}
                aria-label={optionLabel}
                title={optionLabel}
                onClick={() => pick(option)}
              >
                <EffortGlyph
                  level={option ? Math.min(METER_BARS, Math.max(1, index)) : 0}
                  auto={!option}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Native discrete seam retained for automation/compatibility; the icon
          menu above is the only visible interaction. */}
      <input
        className="sr-only composer-effort-range-fallback"
        type="range"
        min={0}
        max={Math.max(0, options.length - 1)}
        step={1}
        value={selected}
        tabIndex={-1}
        aria-hidden="true"
        aria-label={tr("composer.thinking")}
        aria-valuetext={label}
        onChange={(event) => pick(options[Number(event.target.value)] ?? "")}
      />
      {adjusting && (
        <span className="sr-only" role="status">{label}</span>
      )}
    </span>
  );
}
