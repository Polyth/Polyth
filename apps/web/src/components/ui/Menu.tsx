// Action menu with responsive presentation: an anchored menu surface on
// desktop (canonical useDismissibleMenu semantics: outside press, Escape,
// window blur, arrow navigation, focus restore) and a compact anchored popover on phones
// by default. Pass `phonePresentation="sheet"` only for long destination-like
// menus. Nested action menus stay anchored without duplicating their entry list
// or business logic.
//
// Entries can carry selection semantics: `kind: "radio"`/`"checkbox"` maps to
// menuitemradio/menuitemcheckbox with aria-checked and a leading check glyph
// rendered from `checked` (never a caller-passed icon). Checkbox entries keep
// the menu open so several can be toggled in one visit. `kind: "switch"` is an
// on/off mode toggle: menuitemcheckbox semantics with a trailing switch track
// instead of the leading check column, and it also keeps the menu open.
//
// An entry with `entries` is a drill-in row: it shows its current `value` and a
// chevron, and opens its own list in place of the menu (a Back row returns),
// so a setting with several choices costs the menu one row, not one per choice.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePackageWindowOwner } from "./PackageWindowContext.ts";
import { useDismissibleMenu } from "../a11y/Menu.ts";
import { focusUnlessKeyboardHeld } from "../../mobileViewport.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { tapFeedback } from "../../haptics.ts";
import Sheet from "../mobile/Sheet.tsx";
import Icon from "./Icon.tsx";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, type LucideIcon } from "./icons.ts";
import { useAnchoredPosition, type AnchoredAlign } from "./useAnchoredPosition.ts";
import { useExitGhost } from "../../exitGhost.ts";

export interface MenuAction {
  id: string;
  label: string;
  icon?: LucideIcon | (() => ReactNode);
  detail?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Selection semantics: plain action (default), one-of radio, checkbox, or
   *  an on/off switch rendered as a trailing track. */
  kind?: "action" | "radio" | "checkbox" | "switch";
  /** Selected state for radio/checkbox/switch entries. */
  checked?: boolean;
  /** Small color dot for label-style entries (a literal color is data). */
  swatch?: string;
  /** Optional catalog metadata for rich zone editors. */
  packageId?: string;
  packageLabel?: string;
  keywords?: readonly string[];
  /** Drill-in list opened in place of the menu; `onSelect` is not called. */
  entries?: readonly MenuEntry[];
  /** Current choice, shown at the trailing edge of a drill-in row. */
  value?: string;
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
  /** Phone menus default to a compact anchored popover. Use `"sheet"` only for
   *  long destination-like menus without a nearby trigger anchor. */
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
  /** Replace the flat entry list while keeping Menu's anchoring, dismissal, and
   *  focus behavior. Used by searchable catalog surfaces. */
  renderContent?: (context: { close: () => void; sheet: boolean }) => ReactNode;
}

function isHeading(entry: MenuEntry): entry is MenuHeading {
  return typeof entry === "object" && "heading" in entry;
}

function roleOf(action: MenuAction): "menuitem" | "menuitemradio" | "menuitemcheckbox" {
  if (action.kind === "radio") return "menuitemradio";
  if (action.kind === "checkbox" || action.kind === "switch") return "menuitemcheckbox";
  return "menuitem";
}

export default function Menu({
  label, title, entries, children, align = "start", className,
  phonePresentation = "popover", open: controlledOpen, onOpenChange, returnFocusRef, footer,
  renderContent,
}: MenuProps) {
  const packageWindowOwner = usePackageWindowOwner();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const shellMode = useShellMode();
  const asSheet = shellMode === "phone" && phonePresentation === "sheet";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // The drill-in row whose list is shown; every opening starts at the top.
  const [drillId, setDrillId] = useState<string | null>(null);
  const returnToRef = useRef<string | null>(null);
  useEffect(() => { if (!open) setDrillId(null); }, [open]);
  const drill = drillId === null ? undefined : entries.find((entry): entry is MenuAction =>
    typeof entry === "object" && !isHeading(entry) && entry.id === drillId && !!entry.entries);
  const shownEntries = drill?.entries ?? entries;
  useEffect(() => {
    if (!open || asSheet) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const target = drill
      ? surface.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]')
        ?? surface.querySelectorAll<HTMLElement>('[role^="menuitem"]')[1]
      : returnToRef.current
        ? [...surface.querySelectorAll<HTMLElement>("[data-menu-entry]")]
          .find((row) => row.dataset.menuEntry === returnToRef.current) ?? null
        : null;
    returnToRef.current = null;
    if (target) requestAnimationFrame(() => focusUnlessKeyboardHeld(target));
  }, [drillId]);
  const back = () => {
    returnToRef.current = drillId;
    setDrillId(null);
  };
  // The anchored menu unmounts the moment it closes; it still fades out.
  const surfaceGhostRef = useExitGhost<HTMLDivElement>(() => ({ kind: "popover" }), surfaceRef);
  const position = useAnchoredPosition(open && !asSheet, triggerRef, surfaceRef, {
    align,
    compact: !asSheet && shellMode === "phone",
  });
  const onDismissibleKeyDown = useDismissibleMenu({
    open: open && !asSheet,
    menuRef: surfaceRef,
    triggerRef,
    restoreRef: returnFocusRef,
    onClose: () => setOpen(false),
  });
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      onDismissibleKeyDown(event);
      return;
    }
    const rtl = event.currentTarget.ownerDocument.documentElement.dir === "rtl";
    const inward = rtl ? "ArrowLeft" : "ArrowRight";
    const outward = rtl ? "ArrowRight" : "ArrowLeft";
    if (drill && event.key === outward) {
      event.preventDefault();
      back();
      return;
    }
    const row = (event.target as Element | null)?.closest?.("[data-menu-entry]");
    if (!drill && event.key === inward && row?.getAttribute("aria-haspopup") === "menu") {
      event.preventDefault();
      setDrillId(row.getAttribute("data-menu-entry"));
      return;
    }
    onDismissibleKeyDown(event);
  };

  // Selection reserves a leading check column only when the list carries
  // selectable entries, so plain action menus stay tight.
  const checkable = shownEntries.some((entry) =>
    typeof entry === "object" && !isHeading(entry) && (entry.kind === "radio" || entry.kind === "checkbox"));

  const select = (action: MenuAction) => {
    if (action.disabled) return;
    if (asSheet) tapFeedback();
    if (action.entries) {
      setDrillId(action.id);
      return;
    }
    // Checkbox/switch entries stay open for multi-toggle; everything else closes.
    if (action.kind !== "checkbox" && action.kind !== "switch") {
      setOpen(false);
      if (!asSheet) {
        requestAnimationFrame(() => focusUnlessKeyboardHeld(returnFocusRef?.current ?? triggerRef.current));
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
  const close = () => {
    setOpen(false);
    if (!asSheet) {
      requestAnimationFrame(() => focusUnlessKeyboardHeld(returnFocusRef?.current ?? triggerRef.current));
    }
  };

  const itemContent = (entry: MenuAction, iconSize: "sm" | "lg") => (
    <>
      {checkable && (
        <span className="ui-menu-item-check" aria-hidden="true">
          {/* A switch shows its state in its trailing track; beside radio or
              checkbox rows it keeps the column, so labels stay aligned. */}
          {entry.checked && entry.kind !== "switch" ? <Icon icon={CheckIcon} size={iconSize} /> : null}
        </span>
      )}
      {entry.swatch && <span className="ui-menu-item-swatch" style={{ background: entry.swatch }} aria-hidden="true" />}
      {entry.icon && <Icon icon={entry.icon as LucideIcon} size={iconSize} />}
      <span className="ui-menu-item-copy">
        <span className="ui-menu-item-label">{entry.label}</span>
        {entry.detail && <span className="ui-menu-item-detail">{entry.detail}</span>}
      </span>
      {entry.entries && (
        <>
          {entry.value && <span className="ui-menu-item-value">{entry.value}</span>}
          <Icon icon={ChevronRightIcon} size={iconSize} className="ui-menu-item-chevron" />
        </>
      )}
      {entry.kind === "switch" && (
        <span className="switch ui-menu-item-switch" data-checked={entry.checked === true} aria-hidden="true">
          <span className="switch-track"><i /></span>
        </span>
      )}
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
        aria-haspopup={!sheet && entry.entries ? "menu" : undefined}
        data-menu-entry={entry.id}
        className={`${sheet ? "ui-menu-sheet-item" : "ui-menu-item"}${entry.danger ? " ui-menu-item--danger" : ""}${entry.checked && entry.kind !== "switch" ? " ui-menu-item--checked" : ""}`}
        disabled={entry.disabled}
        onClick={() => select(entry)}
      >
        {itemContent(entry, sheet ? "lg" : "sm")}
      </button>
    );
  };

  const backRow = (sheet: boolean) => drill && (
    <button
      key="menu-back"
      type="button"
      role={sheet ? undefined : "menuitem"}
      className={`${sheet ? "ui-menu-sheet-item" : "ui-menu-item"} ui-menu-back`}
      onClick={back}
    >
      <Icon icon={ChevronLeftIcon} size={sheet ? "lg" : "sm"} className="ui-menu-back-icon" />
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{drill.label}</span></span>
    </button>
  );
  const list = (sheet: boolean) => (
    <>
      {backRow(sheet)}
      {drill && <div className="ui-separator ui-separator--horizontal" aria-hidden="true" />}
      {shownEntries.map((entry, index) => renderEntry(entry, index, sheet))}
      {/* The footer belongs to the top level, not to a drilled-in list. */}
      {!drill && footer}
    </>
  );

  return (
    <>
      {trigger}
      {open && asSheet && (
        <Sheet
          title={title ?? label}
          onClose={close}
          className={`ui-menu-sheet${renderContent ? " ui-menu-sheet-custom" : ""}`}
        >
          <div className="ui-menu-sheet-list">
            {renderContent
              ? <>{renderContent({ close, sheet: true })}{footer}</>
              : list(true)}
          </div>
        </Sheet>
      )}
      {open && !asSheet && typeof document !== "undefined" && createPortal(
        <div
          ref={surfaceGhostRef}
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
          {...(!asSheet && shellMode === "phone" ? { "data-compact": "true" } : {})}
          data-package-window-owner={packageWindowOwner ?? undefined}
          onKeyDown={onMenuKeyDown}
        >
          {renderContent
            ? <>{renderContent({ close, sheet: false })}{footer}</>
            : list(false)}
        </div>,
        document.body,
      )}
    </>
  );
}
