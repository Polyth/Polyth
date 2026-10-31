// Icon-only action button. The accessible name is mandatory, and on coarse
// pointers a transparent ::after box extends the hit area to --tap without
// enlarging the visual control (see the .ui-icon-btn CSS).
import type { ComponentProps } from "react";
import type { LucideIcon } from "./icons.ts";
import Icon from "./Icon.tsx";
import Spinner from "./Spinner.tsx";

export type IconButtonVariant = "quiet" | "ghost" | "danger";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
  icon: LucideIcon;
  /** Required accessible name; also used as the default title tooltip. */
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  busy?: boolean;
  /** Marks a toggled state (aria-pressed + pressed styling). */
  pressed?: boolean;
}

const ICON_FOR_SIZE = { sm: "sm", md: "md", lg: "lg" } as const;

export default function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  busy = false,
  pressed,
  disabled,
  className,
  title,
  type,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={[
        "ui-icon-btn",
        `ui-icon-btn--${variant}`,
        `ui-icon-btn--${size}`,
        className ?? "",
      ].filter(Boolean).join(" ")}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <Spinner size="sm" /> : <Icon icon={icon} size={ICON_FOR_SIZE[size]} />}
    </button>
  );
}
