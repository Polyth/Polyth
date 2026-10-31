// Semantic divider on the --surface-divider token. Purely decorative
// separators can stay plain CSS borders; use this between logical groups.
export interface SeparatorProps {
  orientation?: "horizontal" | "vertical";
  /** Decorative separators skip the separator role. */
  decorative?: boolean;
  className?: string;
}

export default function Separator({ orientation = "horizontal", decorative = false, className }: SeparatorProps) {
  return (
    <div
      className={`ui-separator ui-separator--${orientation}${className ? ` ${className}` : ""}`}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "separator", "aria-orientation": orientation })}
    />
  );
}
