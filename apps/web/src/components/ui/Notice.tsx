import type { ComponentProps, ReactNode } from "react";
import Icon from "./Icon.tsx";
import { ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "./icons.ts";

export type NoticeTone = "error" | "warning" | "success" | "info";

export interface NoticeProps extends Omit<ComponentProps<"div">, "children"> {
  tone?: NoticeTone;
  heading?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** Optional slot rendered first (e.g. a close control on a transient toast). */
  leading?: ReactNode;
  /** Overrides the tone glyph; use for a contextual category icon. */
  icon?: ReactNode;
  /** Renders the tone/override glyph after the copy instead of before it. */
  iconPosition?: "leading" | "trailing";
}

const toneIcon = {
  error: ErrorIcon,
  warning: WarningIcon,
  success: SuccessIcon,
  info: InfoIcon,
} as const;

/** A compact, action-capable status surface for product feedback. */
export default function Notice({
  tone = "info",
  heading,
  children,
  actions,
  leading,
  icon,
  iconPosition = "leading",
  className,
  ...rest
}: NoticeProps) {
  const glyph = icon ?? <Icon className="ui-notice-icon" icon={toneIcon[tone]} size="md" aria-hidden="true" />;
  return (
    <div className={["ui-notice", `ui-notice--${tone}`, className ?? ""].filter(Boolean).join(" ")} {...rest}>
      {leading}
      {iconPosition === "leading" && glyph}
      <div className="ui-notice-copy">
        {heading && <strong className="ui-notice-heading">{heading}</strong>}
        <div className="ui-notice-body">{children}</div>
      </div>
      {actions && <div className="ui-notice-actions">{actions}</div>}
      {iconPosition === "trailing" && glyph}
    </div>
  );
}
