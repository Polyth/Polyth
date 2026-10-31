// Multi-line text field. `autoGrow` tracks content height between minRows
// and maxRows — the primitive for simple compose surfaces. The chat composer
// keeps its dedicated IME-safe input (components/input/AdaptiveTextInput).
import { useLayoutEffect, useRef, type ComponentProps, type Ref } from "react";

export interface TextareaProps extends ComponentProps<"textarea"> {
  invalid?: boolean;
  /** Grow with content instead of scrolling. */
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else ref.current = node;
    }
  };
}

export default function Textarea({
  invalid,
  autoGrow = false,
  minRows = 2,
  maxRows = 12,
  className,
  ref,
  value,
  ...rest
}: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !autoGrow) return;
    const computed = typeof getComputedStyle === "function" ? getComputedStyle(el) : undefined;
    const lineHeight = parseFloat(computed?.lineHeight ?? "") || 20;
    el.style.height = "auto";
    const min = minRows * lineHeight;
    const max = maxRows * lineHeight;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [autoGrow, minRows, maxRows, value]);

  return (
    <textarea
      ref={mergeRefs(inner, ref)}
      rows={minRows}
      className={[
        "ui-textarea",
        invalid ? "ui-input--invalid" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      value={value}
      {...rest}
    />
  );
}
