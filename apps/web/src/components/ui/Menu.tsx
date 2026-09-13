// Action menu with responsive presentation: an anchored menu surface on
// desktop (canonical useDismissibleMenu semantics: outside press, Escape,
// arrow navigation, focus restore) and the shared bottom Sheet by default on
// phones. A nested phone action menu can remain anchored without duplicating
// its entry list or business logic.
//
// Entries can carry selection semantics: `kind: "radio"`/`"checkbox"` maps to
// menuitemradio/menuitemcheckbox with aria-checked and a leading check glyph
// rendered from `checked` (never a caller-passed icon). Checkbox entries keep
// the menu open so several can be toggled in one visit.
import { isValidElement, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePackageWindowOwner } from "./PackageWindowContext.ts";
import { useDismissibleMenu } from "../a11y/Menu.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { tapFeedback } from "../../haptics.ts";
import { Icon as ChatIcon } from "../../icons.tsx";
import Sheet from "../mobile/Sheet.tsx";
import Icon from "./Icon.tsx";
import { CheckIcon, type LucideIcon } from "./icons.ts";
import { useAnchoredPosition, type AnchoredAlign } from "./useAnchoredPosition.ts";

export interface MenuAction {
  id: string;
  label: string;
  icon?: LucideIcon | (() => ReactNode);
  detail?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Selection semantics: plain action (default), one-of radio, or checkbox. */
  kind?: "action" | "radio" | "checkbox";
  /** Selected state for radio/checkbox entries; renders the leading check. */
  checked?: boolean;
  /** Small color dot for label-style entries (a literal color is data). */
  swatch?: string;
  onSelect: () => void;
}

/** Non-interactive section heading inside the entry list. */
export interface MenuHeading {
  heading: string;
}

export type MenuEntry = MenuAction | MenuHeading | "separator";

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-haspopup": "menu" | "dialog";
  "aria-expanded": boolean;
}

export interface MenuProps {
  /** Accessible name of the menu; also the phone-sheet title unless `title`
   *  provides a more concise heading. */
  label: string;
  /** Optional short heading for the phone sheet. Labels often carry extra
   *  screen-reader context ("Sort sessions, currently Recent activity") that
   *  truncates badly as a visible one-line title. */
  title?: string;
  entries: readonly MenuEntry[];
  /** Render prop for the trigger; spread the props onto a button. */
  children: (trigger: MenuTriggerProps) => ReactNode;
  align?: AnchoredAlign;
  className?: string;
  /** Phone menus normally use a bottom sheet. Nested action menus may stay
   *  anchored when replacing their parent surface would obscure context. */
  phonePresentation?: "sheet" | "popover";
  /** Controlled open state for extra entry points (context menu, long-press,
   *  Shift+F10). Omit for the default trigger-toggled behavior. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Focus lands here on dismissal instead of the trigger — for menus opened
   *  from a different element than their anchored trigger. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Extra content after the entries (e.g. plugin slot contributions). */
  footer?: ReactNode;
}

function isHeading(entry: MenuEntry): entry is MenuHeading {
  return typeof entry === "object" && "heading" in entry;
}

function roleOf(action: MenuAction): "menuitem" | "menuitemradio" | "menuitemcheckbox" {
  if (action.kind === "radio") return "menuitemradio";
  if (action.kind === "checkbox") return "menuitemcheckbox";
  return "menuitem";
}

const RESPONSE_QUICK_ICON = {
  copy: ChatIcon.copy,
  image: ChatIcon.image,
  plan: ChatIcon.plan,
  pin: ChatIcon.bookmark,
  session: ChatIcon.newSession,
  multirun: ChatIcon.multirun,
} as const;

function isResponseFooterOverflowTrigger(node: ReactNode): boolean {
  if (!isValidElement<{ className?: string }>(node)) return false;
  return node.props.className?.split(/\s+/).includes("response-footer-more") === true;
}

export default function Menu({
  label, title, entries, children, align = "start", className,
  phonePresentation = "sheet", open: controlledOpen, onOpenChange, returnFocusRef, footer,
}: MenuProps) {
  const packageWindowOwner = usePackageWindowOwner();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const asSheet = useShellMode() === "phone" && phonePresentation === "sheet";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(open && !asSheet, triggerRef, surfaceRef, { align });
  const onMenuKeyDown = useDismissibleMenu({
    open: open && !asSheet,
    menuRef: surfaceRef,
    triggerRef,
    restoreRef: returnFocusRef,
    onClose: () => setOpen(false),
  });

  // Selection reserves a leading check column only when the list carries
  // selectable entries, so plain action menus stay tight.
  const checkable = entries.some((entry) =>
    typeof entry === "object" && !isHeading(entry) && (entry.kind === "radio" || entry.kind === "checkbox"));

  const select = (action: MenuAction) => {
    if (action.disabled) return;
    if (asSheet) tapFeedback();
    // Checkbox entries stay open for multi-toggle; everything else closes.
    if (action.kind !== "checkbox") {
      setOpen(false);
      if (!asSheet) {
        requestAnimationFrame(() => (returnFocusRef?.current ?? triggerRef.current)?.focus());
      }
    }
    action.onSelect();
  };

  const trigger = children({
    ref: triggerRef,
    onClick: () => setOpen(!open),
    "aria-haspopup": asSheet ? "dialog" : "menu",
    "aria-expanded": open,
  });

  // Timeline historically put secondary response actions behind one more-menu
  // even though the footer already is an action strip. Flatten that legacy
  // invocation here while preserving the persisted action ordering and each
  // entry's existing command. The footer can then wrap naturally on phones
  // instead of hiding functionality behind a second interaction model.
  if (isResponseFooterOverflowTrigger(trigger)) {
    return (
      <>
        {entries.map((entry, index) => {
          if (entry === "separator" || isHeading(entry)) return null;
          const Glyph = RESPONSE_QUICK_ICON[entry.id as keyof typeof RESPONSE_QUICK_ICON];
          if (!Glyph) return null;
          return (
            <button
              key={`${entry.id}-${index}`}
              type="button"
              className="response-footer-inline-action"
              aria-label={entry.label}
              title={entry.label}
              data-tooltip={entry.label}
              disabled={entry.disabled}
              onClick={() => select(entry)}
            >
              <Glyph />
            </button>
          );
        })}
      </>
    );
  }

  const itemContent = (entry: MenuAction, iconSize: "sm" | "lg") => (
    <>
      {checkable && (
        <span className="ui-menu-item-check" aria-hidden="true">
          {entry.checked ? <Icon icon={CheckIcon} size={iconSize} /> : null}
        </span>
      )}
      {entry.swatch && <span className="ui-menu-item-swatch" style={{ background: entry.swatch }} aria-hidden="true" />}
      {entry.icon && <Icon icon={entry.icon as LucideIcon} size={iconSize} />}
      <span className="ui-menu-item-copy">
        <span className="ui-menu-item-label">{entry.label}</span>
        {entry.detail && <span className="ui-menu-item-detail">{entry.detail}</span>}
      </span>
    </>
  );

  const renderEntry = (entry: MenuEntry, index: number, sheet: boolean) => {
    if (entry === "separator") {
      return sheet
        ? <div key={`separator-${index}`} className="ui-separator ui-separator--horizontal" aria-hidden="true" />
        : <div key={`separator-${index}`} className="ui-separator ui-separator--horizontal" role="separator" />;
    }
    if (isHeading(entry)) {
      return <div key={`heading-${index}`} className="ui-menu-heading" aria-hidden="true">{entry.heading}</div>;
    }
    const role = roleOf(entry);
    return (
      <button
        key={entry.id}
        type="button"
        role={sheet ? undefined : role}
        aria-checked={!sheet && role !== "menuitem" ? entry.checked === true : undefined}
        aria-pressed={sheet && role !== "menuitem" ? entry.checked === true : undefined}
        className={`${sheet ? "ui-menu-sheet-item" : "ui-menu-item"}${entry.danger ? " ui-menu-item--danger" : ""}${entry.checked ? " ui-menu-item--checked" : ""}`}
        disabled={entry.disabled}
        onClick={() => select(entry)}
      >
        {itemContent(entry, sheet ? "lg" : "sm")}
      </button>
    );
  };

  return (
    <>
      {trigger}
      {open && asSheet && (
        <Sheet title={title ?? label} onClose={() => setOpen(false)} className="ui-menu-sheet">
          <div className="ui-menu-sheet-list">
            {entries.map((entry, index) => renderEntry(entry, index, true))}
            {footer}
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
            maxHeight: position.ready ? position.maxHeight : undefined,
            maxWidth: position.ready ? position.maxWidth : undefined,
            visibility: position.ready ? undefined : "hidden",
          }}
          data-side={position.side}
          data-package-window-owner={packageWindowOwner ?? undefined}
          onKeyDown={onMenuKeyDown}
        >
          {entries.map((entry, index) => renderEntry(entry, index, false))}
          {footer}
        </div>,
        document.body,
      )}
    </>
  );
}
