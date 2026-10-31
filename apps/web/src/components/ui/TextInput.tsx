// Single-line text field on the control tokens. Font floor is --font-input
// (16px) so focusing never zooms mobile Safari.
import type { ComponentProps } from "react";

export interface TextInputProps extends ComponentProps<"input"> {
  /** Visual + a11y invalid state (aria-invalid). */
  invalid?: boolean;
  uiSize?: "sm" | "md";
}

export default function TextInput({ invalid, uiSize = "md", className, type, ...rest }: TextInputProps) {
  return (
    <input
      type={type ?? "text"}
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
}
