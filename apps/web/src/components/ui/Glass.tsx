import type { ComponentProps } from "react";

export type GlassStrength = "chrome" | "medium" | "strong";

// ComponentProps carries `ref` (React 19), so a caller can anchor to the surface.
export interface GlassProps extends ComponentProps<"div"> {
  strength?: GlassStrength;
}

function glassClass(base: string, strength: GlassStrength, className?: string): string {
  return `${base} ${base}--${strength}${className ? ` ${className}` : ""}`;
}

export function GlassIsland({ strength = "chrome", className, ...props }: GlassProps) {
  return <div className={glassClass("ui-glass-island", strength, className)} {...props} />;
}

export function GlassDock({ strength = "strong", className, ...props }: GlassProps) {
  return <div className={glassClass("ui-glass-dock", strength, className)} {...props} />;
}
