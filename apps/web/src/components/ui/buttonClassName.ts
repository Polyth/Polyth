export type ButtonVariant = "primary" | "quiet" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonClassNameOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
}

/** Shared class contract for the Button component and createElement-only
 * boundaries that Node's erasable-TypeScript loader must import without JSX. */
export function buttonClassName({
  variant = "quiet",
  size = "md",
  block = false,
  className,
}: ButtonClassNameOptions = {}): string {
  return [
    "ui-btn",
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    block ? "ui-btn--block" : "",
    className ?? "",
  ].filter(Boolean).join(" ");
}
