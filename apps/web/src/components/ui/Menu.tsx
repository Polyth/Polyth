// Action menu with responsive presentation: an anchored menu surface on
// desktop (canonical useDismissibleMenu semantics: outside press, Escape,
// arrow navigation, focus restore) and the shared bottom Sheet on phones —
// one entry list, zero duplicated business logic.
import { useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismissibleMenu } from "../a11y/Menu.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { tapFeedback } from "../../haptics.ts";
import Sheet from "../mobile/Sheet.tsx";
import Icon from "./Icon.tsx";
import type { LucideIcon } from "./icons.ts";
import { useAnchoredPosition, type AnchoredAlign } from "./useAnchoredPosition.ts";

export interface MenuAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  detail?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuAction | "separator";

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-haspopup": "menu" | "dialog";
  "aria-expanded": boolean;
}

export interface MenuProps {
  /** Accessible name of the menu and title of the phone sheet. */
  label: string;
  entries: readonly MenuEntry[];
  /** Render prop for the trigger; spread the props onto a button. */
  children: (trigger: MenuTriggerProps) => ReactNode;
  align?: AnchoredAlign;
  className?: string;
}

export default function Menu({ label, entries, children, align = "start", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const asSheet = useShellMode() === "phone";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(open && !asSheet, triggerRef, surfaceRef, { align });
  const onMenuKeyDown = useDismissibleMenu({
    open: open && !asSheet,
    menuRef: surfaceRef,
    triggerRef,
    onClose: () => setOpen(false),
  });

  const select = (action: MenuAction) => {
    if (action.disabled) return;
    if (asSheet) tapFeedback();
    setOpen(false);
    if (!asSheet) requestAnimationFrame(() => triggerRef.current?.focus());
    action.onSelect();
  };

  const trigger = children({
    ref: triggerRef,
    onClick: () => setOpen((value) => !value),
    "aria-haspopup": asSheet ? "dialog" : "menu",
    "aria-expanded": open,
  });

  return (
    <>
      {trigger}
      {open && asSheet && (
        <Sheet title={label} onClose={() => setOpen(false)} className="ui-menu-sheet">
          <div className="ui-menu-sheet-list">
            {entries.map((entry, index) =>
              entry === "separator"
                ? <div key={`separator-${index}`} className="ui-separator ui-separator--horizontal" aria-hidden="true" />
                : (
                  <button
                    key={entry.id}
                    type="button"
                    className={`ui-menu-sheet-item${entry.danger ? " ui-menu-item--danger" : ""}`}
                    disabled={entry.disabled}
                    onClick={() => select(entry)}
                  >
                    {entry.icon && <Icon icon={entry.icon} size="lg" />}
                    <span className="ui-menu-item-copy">
                      <span className="ui-menu-item-label">{entry.label}</span>
                      {entry.detail && <span className="ui-menu-item-detail">{entry.detail}</span>}
                    </span>
                  </button>
                ))}
          </div>
        </Sheet>
      )}
      {open && !asSheet && typeof document !== "undefined" && createPortal(
        <div
          ref={surfaceRef}
          role="menu"
          aria-label={label}
          className={`ui-popover ui-menu${className ? ` ${className}` : ""}`}
          style={{
            top: position.top,
            left: position.left,
            maxHeight: position.maxHeight || undefined,
            visibility: position.ready ? undefined : "hidden",
          }}
          data-side={position.side}
          onKeyDown={onMenuKeyDown}
        >
          {entries.map((entry, index) =>
            entry === "separator"
              ? <div key={`separator-${index}`} className="ui-separator ui-separator--horizontal" role="separator" />
              : (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitem"
                  className={`ui-menu-item${entry.danger ? " ui-menu-item--danger" : ""}`}
                  disabled={entry.disabled}
                  onClick={() => select(entry)}
                >
                  {entry.icon && <Icon icon={entry.icon} size="sm" />}
                  <span className="ui-menu-item-copy">
                    <span className="ui-menu-item-label">{entry.label}</span>
                    {entry.detail && <span className="ui-menu-item-detail">{entry.detail}</span>}
                  </span>
                </button>
              ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Anchor ref type helper for callers that need the trigger element. */
export type MenuAnchor = RefObject<HTMLButtonElement | null>;
