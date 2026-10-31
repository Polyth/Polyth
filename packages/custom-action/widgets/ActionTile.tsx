// One action as a launcher tile (the window, panels) or a toolbar icon (bars).
// A press runs it; its menu — the ⋯ button, a right-click or a long press —
// holds everything else.
import { useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { setDragCapability } from "../../../apps/web/src/dnd.ts";
import {
  IconButton,
  Menu,
  MoreIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import type { CustomActionDto } from "../src/actionModel.ts";
import ActionGlyph from "./ActionGlyph.tsx";
import type { TileView } from "./tileState.ts";
import { stopwatch } from "./time.ts";

const LONG_PRESS_MS = 480;

const MODE_LABEL = {
  background: "customaction.mode.background",
  terminal: "customaction.mode.terminal",
  chat: "customaction.mode.chat",
} as const;

export function stateLabel(view: TileView, now: number): string | null {
  switch (view.state) {
    case "starting": return tr("customaction.status.starting");
    case "running": return view.run ? stopwatch(now - view.run.startedAt) : tr("customaction.status.running");
    case "chat": return tr("customaction.status.startingChat");
    case "done": return view.run?.chatSessionId ? tr("customaction.status.chatStarted") : tr("customaction.status.done");
    case "opened": return tr("customaction.status.opened");
    case "failed": return view.run?.status === "timed-out" ? tr("customaction.status.timedOut")
      : view.run?.status === "failed" ? tr("customaction.status.exitCode", { code: String(view.run.exitCode ?? "?") })
      : tr("customaction.status.error");
    default: return null;
  }
}

/** Accessible name: the action, how it runs, and what it is doing now. */
export function actionLabel(action: CustomActionDto, view: TileView, now: number): string {
  const state = stateLabel(view, now);
  const mode = tr(MODE_LABEL[action.mode]);
  return state ? `${action.name} — ${mode} — ${state}` : `${action.name} — ${mode}`;
}

export default function ActionTile({
  action,
  view,
  now,
  variant,
  disabled,
  disabledReason,
  menu,
  onPress,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  capabilityId: capabilityDragId,
  dropSide,
  detail,
  showName,
  editing,
  children,
}: {
  action: CustomActionDto;
  view: TileView;
  now: number;
  variant: "tile" | "row" | "icon";
  disabled?: boolean;
  disabledReason?: string;
  menu: readonly MenuEntry[];
  onPress: (anchor: HTMLElement) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  /** The capability this tile is a launcher of, so a drag out of the library
   *  onto any rail places it there (`railDrag.ts`). */
  capabilityId?: string;
  dropSide?: "before" | "after" | null;
  /** A second line under the name (rows only). */
  detail?: ReactNode;
  /** Toolbar icons: show the name beside the glyph. */
  showName?: boolean;
  /** The library is being rearranged: a press edits instead of running. */
  editing?: boolean;
  children?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pressRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const state = stateLabel(view, now);
  const label = actionLabel(action, view, now);

  const cancelLongPress = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "touch" || menu.length === 0) return;
    cancelLongPress();
    timer.current = setTimeout(() => {
      timer.current = null;
      suppressClick.current = true;
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };

  return (
    <div
      className="ca-item"
      data-variant={variant}
      data-state={view.state}
      data-mode={action.mode}
      data-drop={dropSide ?? undefined}
      data-editing={editing || undefined}
      draggable={draggable || undefined}
      onDragStart={(event) => {
        // One gesture, two destinations: the library reorders by its own drop
        // targets, and the host watches for this MIME so any rail outside the
        // window lights up as a place to put the action (dnd.ts).
        if (capabilityDragId) setDragCapability(event.dataTransfer, capabilityDragId);
        onDragStart?.(event);
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button
        ref={pressRef}
        type="button"
        className="ca-press"
        aria-label={editing ? tr("customaction.editNamed", { name: action.name }) : label}
        title={disabled && disabledReason ? disabledReason : variant === "icon" ? label : undefined}
        aria-disabled={disabled || undefined}
        aria-busy={view.state === "running" || view.state === "chat" || view.state === "starting" || undefined}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (disabled) return;
          onPress(event.currentTarget);
        }}
        onPointerDown={onPointerDown}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onContextMenu={(event) => {
          if (menu.length === 0) return;
          event.preventDefault();
          cancelLongPress();
          setMenuOpen(true);
        }}
      >
        <ActionGlyph icon={action.icon} color={action.color} size={variant === "tile" ? "lg" : variant === "row" ? "md" : "bare"} state={view.state} />
        {variant === "icon" && showName && <span className="ca-bar-label">{action.name}</span>}
        {variant !== "icon" && (
          <span className="ca-item-text">
            <span className="ca-item-name">{action.name}</span>
            {(state || variant === "row") && (
              <span className="ca-item-meta" data-live={state ? true : undefined}>
                {state ?? tr(MODE_LABEL[action.mode])}
              </span>
            )}
            {detail && <span className="ca-item-detail">{detail}</span>}
          </span>
        )}
      </button>
      {menu.length > 0 && (
        <Menu
          label={tr("customaction.menu.label", { name: action.name })}
          title={action.name}
          entries={menu}
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          returnFocusRef={pressRef}
        >
          {(trigger) => (
            <IconButton
              {...trigger}
              icon={MoreIcon}
              size="sm"
              variant="quiet"
              className="ca-more"
              label={tr("customaction.menu.label", { name: action.name })}
              title={tr("customaction.menu.more")}
            />
          )}
        </Menu>
      )}
      {children}
    </div>
  );
}
