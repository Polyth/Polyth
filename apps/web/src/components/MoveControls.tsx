import { tr, type TranslationKey } from "../i18n/index.ts";

const MOVE_KEYS = {
  up: ["movecontrols.moveLabelUp", "movecontrols.moveUp"],
  down: ["movecontrols.moveLabelDown", "movecontrols.moveDown"],
  left: ["movecontrols.moveLabelLeft", "movecontrols.moveLeft"],
  right: ["movecontrols.moveLabelRight", "movecontrols.moveRight"],
} as const satisfies Record<string, readonly [TranslationKey, TranslationKey]>;

type MoveControlsProps = {
  label: string;
  index: number;
  count: number;
  onMove: (nextIndex: number) => void;
  axis?: "horizontal" | "vertical";
  previousLabel?: string;
  nextLabel?: string;
};

/** Explicit keyboard/touch alternative for every drag-reorder surface. */
export default function MoveControls({
  label,
  index,
  count,
  onMove,
  axis = "vertical",
  previousLabel,
  nextLabel,
}: MoveControlsProps) {
  const previous = axis === "horizontal" ? "left" : "up";
  const next = axis === "horizontal" ? "right" : "down";
  return (
    <span className="reorder-controls">
      <button
        type="button"
        className="reorder-control"
        aria-label={previousLabel ?? tr(MOVE_KEYS[previous][0], { label })}
        title={tr(MOVE_KEYS[previous][1])}
        disabled={index <= 0}
        onClick={(event) => {
          event.stopPropagation();
          onMove(index - 1);
        }}
      >
        <span aria-hidden="true">{axis === "horizontal" ? "←" : "↑"}</span>
      </button>
      <button
        type="button"
        className="reorder-control"
        aria-label={nextLabel ?? tr(MOVE_KEYS[next][0], { label })}
        title={tr(MOVE_KEYS[next][1])}
        disabled={index >= count - 1}
        onClick={(event) => {
          event.stopPropagation();
          onMove(index + 1);
        }}
      >
        <span aria-hidden="true">{axis === "horizontal" ? "→" : "↓"}</span>
      </button>
    </span>
  );
}
