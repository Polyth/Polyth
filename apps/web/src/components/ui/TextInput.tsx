// Single-line text field on the control tokens. Font floor is --font-input
// (16px) so focusing never zooms mobile Safari. A password field always gets
// an eye button that reveals what was typed.
import { useState, type ComponentProps } from "react";
import IconButton from "./IconButton.tsx";
import { HideIcon, ShowIcon } from "./icons.ts";
import { tr } from "../../i18n/index.ts";

export interface TextInputProps extends ComponentProps<"input"> {
  /** Visual + a11y invalid state (aria-invalid). */
  invalid?: boolean;
  uiSize?: "sm" | "md";
  /** Password fields only: controls the eye button from outside. */
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}

export default function TextInput({ invalid, uiSize = "md", className, type, revealed, onRevealedChange, ...rest }: TextInputProps) {
  const [ownShown, setOwnShown] = useState(false);
  const shown = revealed ?? ownShown;
  const password = type === "password";
  const input = (
    <input
      type={password && shown ? "text" : type ?? "text"}
      className={[
        "ui-input",
        `ui-input--${uiSize}`,
        invalid ? "ui-input--invalid" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
  if (!password) return input;
  return (
    <span className="ui-input-reveal">
      {input}
      <IconButton
        icon={shown ? HideIcon : ShowIcon}
        size={uiSize}
        label={tr(shown ? "setup.account.hidePassword" : "setup.account.showPassword")}
        disabled={rest.disabled}
        onClick={() => { setOwnShown(!shown); onRevealedChange?.(!shown); }}
      />
    </span>
  );
}
