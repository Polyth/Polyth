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
        aria-label={previousLabel ?? `Move ${label} ${previous}`}
        title={`Move ${previous}`}
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
        aria-label={nextLabel ?? `Move ${label} ${next}`}
        title={`Move ${next}`}
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
