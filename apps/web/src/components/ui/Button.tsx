// Core text button: one geometry (control tokens), four calm variants.
// Replaces the .primary-btn/.small-btn/.danger-btn one-off classes as core
// and package UI migrates (Phase 1b/1c adoption).
import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "./icons.ts";
import Icon from "./Icon.tsx";
import Spinner from "./Spinner.tsx";
import {
  buttonClassName,
  type ButtonSize,
  type ButtonVariant,
} from "./buttonClassName.ts";

export type { ButtonSize, ButtonVariant } from "./buttonClassName.ts";

export interface ButtonProps extends ComponentProps<"button"> {
  /** `quiet` is the default bordered neutral action. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconStart?: LucideIcon;
  iconEnd?: LucideIcon;
  /** Shows a spinner, sets aria-busy, and blocks activation. */
  busy?: boolean;
  /** Stretch to the container width (mobile forms, dialog footers). */
  block?: boolean;
  children?: ReactNode;
}

const ICON_FOR_SIZE = { sm: "sm", md: "sm", lg: "md" } as const;

export default function Button({
  variant = "quiet",
  size = "md",
  iconStart,
  iconEnd,
  busy = false,
  block = false,
  disabled,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  const iconSize = ICON_FOR_SIZE[size];
  return (
    <button
      type={type ?? "button"}
      className={buttonClassName({ variant, size, block, className })}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy
        ? <Spinner size={iconSize === "sm" ? "sm" : "md"} />
        : iconStart && <Icon icon={iconStart} size={iconSize} />}
      {children != null && <span className="ui-btn-label">{children}</span>}
      {iconEnd && <Icon icon={iconEnd} size={iconSize} />}
    </button>
  );
}
