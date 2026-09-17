// Click-coordinate menu triggers must live on `document.body`.
// `.rail-dynamic` applies `transform: translate(...)`, which makes nested
// `position: fixed` resolve against the package window instead of the viewport
// and sends host Menu surfaces to the wrong place.
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { MenuTriggerProps } from "../../../../apps/web/src/components/ui/index.ts";

export function ContextMenuAnchor({
  trigger,
  className,
  hidden,
  x,
  y,
}: {
  trigger: MenuTriggerProps;
  className: string;
  hidden: boolean;
  x: number;
  y: number;
}) {
  if (typeof document === "undefined") return null;
  const style: CSSProperties = {
    position: "fixed",
    left: x,
    top: y,
    width: 1,
    height: 1,
    padding: 0,
    margin: 0,
    overflow: "hidden",
    opacity: 0,
    pointerEvents: "none",
    border: 0,
    background: "transparent",
  };
  return createPortal(
    <button
      {...trigger}
      type="button"
      className={className}
      tabIndex={-1}
      aria-hidden={hidden}
      style={style}
    />,
    document.body,
  );
}
