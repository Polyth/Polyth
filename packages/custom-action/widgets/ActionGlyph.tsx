// An action's identity mark: its glyph on a tile washed in its colour, with
// the live run state drawn around it (a travelling ring while it runs, a
// check or an alert mark when it ends).
import { Icon } from "../../../apps/web/src/components/ui/index.ts";
import type { ActionColor } from "../src/actionModel.ts";
import { glyphFor } from "./icons.ts";
import type { TileState } from "./tileState.ts";

export type GlyphSize = "bare" | "sm" | "md" | "lg" | "xl";

const ICON_SIZE = { bare: "md", sm: "sm", md: "md", lg: "xl", xl: "xl" } as const;

export default function ActionGlyph({
  icon,
  color,
  size = "md",
  state = "idle",
  className,
}: {
  icon: string;
  color: ActionColor;
  size?: GlyphSize;
  state?: TileState;
  className?: string;
}) {
  const busy = state === "running" || state === "chat" || state === "starting";
  return (
    <span
      className={`ca-glyph${className ? ` ${className}` : ""}`}
      data-color={color}
      data-size={size}
      data-state={state}
      aria-hidden="true"
    >
      <Icon icon={glyphFor(icon)} size={ICON_SIZE[size]} />
      {busy && <span className="ca-glyph-ring" />}
      {(state === "done" || state === "opened") && <span className="ca-glyph-badge" data-tone="success" />}
      {state === "failed" && <span className="ca-glyph-badge" data-tone="danger" />}
    </span>
  );
}
