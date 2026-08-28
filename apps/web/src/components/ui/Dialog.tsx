// Standard modal dialog chrome over the canonical a11y engine
// (components/a11y/Dialog.tsx owns focus trap, Escape, scroll lock, focus
// restore). This wrapper adds the shared header (title + close), scrolling
// body, and footer so feature dialogs stop hand-rolling that structure.
import type { ReactNode } from "react";
import A11yDialog, { type DialogProps as A11yDialogProps } from "../a11y/Dialog.tsx";
import IconButton from "./IconButton.tsx";
import { CloseIcon } from "./icons.ts";
import { tr } from "../../i18n/index.ts";

export type DialogSize = "sm" | "md" | "lg" | "full";

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Action row pinned under the body (Buttons, usually end-aligned). */
  footer?: ReactNode;
  size?: DialogSize;
  className?: string;
  initialFocus?: string;
  /** Hide the visible header when the content owns its heading. */
  hideHeader?: boolean;
  resolveRestoreFocus?: A11yDialogProps["resolveRestoreFocus"];
  ariaDescribedBy?: string;
}

export default function Dialog({
  title,
  onClose,
  children,
  footer,
  size = "md",
  className,
  initialFocus,
  hideHeader = false,
  resolveRestoreFocus,
  ariaDescribedBy,
}: DialogProps) {
  return (
    <A11yDialog
      title={title}
      onClose={onClose}
      size={size === "sm" ? "md" : size}
      className={`ui-dialog${size === "sm" ? " ui-dialog--sm" : ""}${className ? ` ${className}` : ""}`}
      {...(initialFocus !== undefined ? { initialFocus } : {})}
      {...(resolveRestoreFocus !== undefined ? { resolveRestoreFocus } : {})}
      {...(ariaDescribedBy !== undefined ? { ariaDescribedBy } : {})}
    >
      {!hideHeader && (
        <header className="ui-dialog-head">
          <h2 className="ui-dialog-title">{title}</h2>
          <IconButton icon={CloseIcon} label={tr("common.close")} onClick={onClose} />
        </header>
      )}
      <div className="ui-dialog-body">{children}</div>
      {footer && <footer className="ui-dialog-foot">{footer}</footer>}
    </A11yDialog>
  );
}
