// Token-sized icon wrapper: UI action glyphs render at the canonical icon
// scale (--icon-sm/md/lg/xl) instead of per-context pixel overrides.
import type { LucideIcon } from "./icons.ts";

export type IconSize = "sm" | "md" | "lg" | "xl";

export interface IconProps {
  icon: LucideIcon;
  /** Token size step; defaults to the 18px standard control glyph. */
  size?: IconSize;
  /** Accessible name. Omit for decorative icons (they become aria-hidden). */
  label?: string;
  className?: string;
}

export default function Icon({ icon: Glyph, size = "md", label, className }: IconProps) {
  return (
    <Glyph
      className={`ui-icon ui-icon--${size}${className ? ` ${className}` : ""}`}
      strokeWidth={1.75}
      aria-hidden={label ? undefined : true}
      {...(label ? { "aria-label": label, role: "img" } : {})}
    />
  );
}
