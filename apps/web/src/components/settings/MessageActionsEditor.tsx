// Settings editor for one role's quick actions. User messages and agent
// replies open this same body, so both are configured identically: a master
// switch, how the bar reveals on a computer and on touch, and three lanes (the
// bar, the More menu, hidden) a button is dragged between. Lanes are views of
// one ordered list, so a hidden button keeps its slot; package buttons sit in
// them too. The chat preview beside the page shows the result.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { tr } from "../../i18n/index.ts";
import {
  ASSISTANT_MESSAGE_ACTIONS_DEFAULT,
  cloneMessageActionLayout,
  isPackageMessageActionId,
  placeMessageAction,
  resolveMessageActions,
  sameMessageActionLayout,
  USER_MESSAGE_ACTIONS_DEFAULT,
  withPackageMessageActions,
  type MessageActionId,
  type MessageActionItem,
  type MessageActionLayout,
  type MessageActionPlacement,
  type MessageActionReveal,
  type MessageActionRole,
  type MessageActionTouchReveal,
  type ResolvedMessageActions,
  type WithPackageActions,
} from "../../messageActionLayout.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { MESSAGE_ACTION_ICONS, messageActionDescription, messageActionName } from "../messageActionCatalog.ts";
import { useMessageActionContributions, type MessageActionContribution } from "../messageActionContributions.ts";
import { DragHandleIcon, Icon, Menu, PluginIcon, type LucideIcon, type MenuEntry, type MenuTriggerProps } from "../ui/index.ts";
import { ResetLink, Row, Seg, Toggle } from "./parts.tsx";
import "./MessageActionsEditor.css";

export type ActionKey = WithPackageActions<MessageActionId>;

/** How one button reads: built-in actions from the catalog, package buttons
 *  from their contribution (or their id while the package is off). */
export interface RowInfo {
  name: string;
  icon: LucideIcon;
  description: string;
  /** Its package is off or gone: it keeps its slot but shows nothing. */
  unavailable: boolean;
  /** Bar-only package buttons offer no "Menu" placement. */
  menu: boolean;
}

function rowInfo(
  role: MessageActionRole,
  id: ActionKey,
  contributions: ReadonlyMap<string, MessageActionContribution>,
): RowInfo {
  if (!isPackageMessageActionId(id)) {
    return {
      name: messageActionName(id),
      icon: MESSAGE_ACTION_ICONS[id],
      description: messageActionDescription(role, id),
      unavailable: false,
      menu: true,
    };
  }
  const entry = contributions.get(id);
  const fallback = id.slice("pkg:".length).split(/[._:-]+/).filter(Boolean).join(" ");
  return {
    name: entry?.label ?? fallback,
    icon: entry?.icon ?? PluginIcon,
    description: entry?.description ?? tr("settings.quickActions.packageAction"),
    unavailable: !entry,
    menu: entry?.menu === true,
  };
}

function roleState(role: MessageActionRole, ui: ReturnType<typeof useUiSettings>) {
  return role === "user"
    ? {
      show: ui.showMessageActions,
      layout: ui.userMessageActions as MessageActionLayout<ActionKey>,
      defaults: USER_MESSAGE_ACTIONS_DEFAULT as MessageActionLayout<ActionKey>,
    }
    : {
      show: ui.showAnswerQuickActions,
      layout: ui.assistantMessageActions as MessageActionLayout<ActionKey>,
      defaults: ASSISTANT_MESSAGE_ACTIONS_DEFAULT as MessageActionLayout<ActionKey>,
    };
}

function writeRole(role: MessageActionRole, patch: { show?: boolean; layout?: MessageActionLayout<ActionKey> }): void {
  if (role === "user") {
    setUiSettings({
      ...(patch.show !== undefined ? { showMessageActions: patch.show } : {}),
      ...(patch.layout ? { userMessageActions: patch.layout as typeof USER_MESSAGE_ACTIONS_DEFAULT } : {}),
    });
    return;
  }
  setUiSettings({
    ...(patch.show !== undefined ? { showAnswerQuickActions: patch.show } : {}),
    ...(patch.layout ? { assistantMessageActions: patch.layout as typeof ASSISTANT_MESSAGE_ACTIONS_DEFAULT } : {}),
  });
}

/** The role's stored settings joined with the package buttons on offer, for
 *  the editor, the preview and the row's summary alike. */
export function useMessageActionRows(role: MessageActionRole) {
  const ui = useUiSettings();
  const contributions = useMessageActionContributions(role);
  const { show, layout: stored, defaults } = roleState(role, ui);
  const byPackage = new Map<string, MessageActionContribution>(contributions.map((entry) => [entry.id, entry]));
  const info = (id: ActionKey) => rowInfo(role, id, byPackage);
  return {
    show,
    stored,
    defaults,
    layout: withPackageMessageActions(stored, contributions),
    info,
    resolve: (touch: boolean): ResolvedMessageActions<ActionKey> => resolveMessageActions(
      withPackageMessageActions(stored, contributions),
      (id) => !info(id).unavailable,
      touch,
      (id) => info(id).menu,
    ),
  };
}

export default function MessageActionsEditor({ role, itemId, onDevice }: {
  role: MessageActionRole;
  itemId: string;
  /** A reveal change is about one kind of device: the preview follows it. */
  onDevice?: (device: "computer" | "phone") => void;
}) {
  const { show, stored, defaults, layout, info } = useMessageActionRows(role);
  const setLayout = (next: MessageActionLayout<ActionKey>) => writeRole(role, { layout: next });
  const isDefault = show && sameMessageActionLayout(stored, defaults);

  return (
    <>
      <Row label={tr("settings.quickActions.show")} itemId={itemId}>
        <Toggle on={show} onChange={(next) => writeRole(role, { show: next })} label={tr("settings.quickActions.show")} />
      </Row>
      <Row label={tr("settings.quickActions.computer")} disabled={!show}>
        <Seg<MessageActionReveal>
          label={tr("settings.quickActions.computer")}
          value={layout.reveal}
          disabled={!show}
          options={[
            ["always", tr("settings.quickActions.always")],
            ["hover", tr("settings.quickActions.hover")],
            ["menu", tr("settings.quickActions.menuOnly")],
          ]}
          onChange={(reveal) => {
            onDevice?.("computer");
            setLayout({ ...layout, reveal });
          }}
        />
      </Row>
      <Row label={tr("settings.quickActions.touch")} disabled={!show}>
        <Seg<MessageActionTouchReveal>
          label={tr("settings.quickActions.touch")}
          value={layout.touch}
          disabled={!show}
          options={[
            ["always", tr("settings.quickActions.always")],
            ["menu", tr("settings.quickActions.menuOnly")],
          ]}
          onChange={(touch) => {
            onDevice?.("phone");
            setLayout({ ...layout, touch });
          }}
        />
      </Row>
      <ActionLanes layout={layout} disabled={!show} info={info} onChange={setLayout} />
      <div className="mqa-foot">
        <p className="mqa-foot-hint">{tr("settings.quickActions.lanesHint")}</p>
        <ResetLink
          disabled={isDefault}
          onClick={() => writeRole(role, { show: true, layout: cloneMessageActionLayout(defaults) })}
        />
      </div>
    </>
  );
}

const LANES: readonly MessageActionPlacement[] = ["bar", "menu", "off"];

const laneName = (lane: MessageActionPlacement): string => lane === "bar"
  ? tr("settings.quickActions.placeBar")
  : lane === "menu"
    ? tr("settings.quickActions.laneMenu")
    : tr("settings.quickActions.laneHidden");

const laneEmpty = (lane: MessageActionPlacement): string => lane === "bar"
  ? tr("settings.quickActions.laneEmptyBar")
  : lane === "menu"
    ? tr("settings.quickActions.laneEmptyMenu")
    : tr("settings.quickActions.laneEmptyHidden");

const DRAG_THRESHOLD = 4;

function ActionLanes({ layout, disabled, info, onChange }: {
  layout: MessageActionLayout<ActionKey>;
  disabled: boolean;
  info: (id: ActionKey) => RowInfo;
  onChange: (next: MessageActionLayout<ActionKey>) => void;
}) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const keyboardHintId = useId();
  const [dragging, setDragging] = useState<ActionKey | null>(null);
  const [status, setStatus] = useState("");
  // Latest layout for pointer moves that land between renders.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const pressRef = useRef<{ id: ActionKey; x: number; y: number; moved: boolean } | null>(null);
  // The click ending a drag must not open the chip's menu. A finger's drag ends
  // with no click, so the next press or key clears this as well.
  const justDraggedRef = useRef(false);

  /** A bar-only button reads its stored "menu" placement as the bar, where it
   *  actually renders. */
  const laneOf = (item: MessageActionItem<ActionKey>): MessageActionPlacement =>
    !info(item.id).menu && item.placement === "menu" ? "bar" : item.placement;
  const inLane = (current: MessageActionLayout<ActionKey>, lane: MessageActionPlacement) =>
    current.items.filter((item) => laneOf(item) === lane);

  const announce = (id: ActionKey) => {
    const lane = layoutRef.current.items.find((item) => item.id === id);
    if (!lane) return;
    const items = inLane(layoutRef.current, laneOf(lane));
    setStatus(tr("settings.quickActions.movedToLane", {
      action: info(id).name,
      lane: laneName(laneOf(lane)),
      position: items.findIndex((item) => item.id === id) + 1,
      total: items.length,
    }));
  };

  const moveTo = (id: ActionKey, lane: MessageActionPlacement, index: number): boolean => {
    if (lane === "menu" && !info(id).menu) return false;
    const current = layoutRef.current;
    const next = placeMessageAction(current, id, lane, index, laneOf);
    if (sameMessageActionLayout(next, current)) return false;
    layoutRef.current = next;
    onChange(next);
    return true;
  };

  const refocus = (id: ActionKey) => {
    // The chip re-renders at its new place; keep focus on it.
    requestAnimationFrame(() => {
      lanesRef.current?.querySelector<HTMLButtonElement>(`[data-action-chip="${id}"]`)?.focus();
    });
  };

  /** Up and down change lane; a bar-only button skips the menu it cannot join. */
  const neighbourLane = (id: ActionKey, lane: MessageActionPlacement, step: -1 | 1): MessageActionPlacement | null => {
    const lanes = LANES.filter((candidate) => candidate !== "menu" || info(id).menu);
    return lanes[lanes.indexOf(lane) + step] ?? null;
  };

  const shift = (id: ActionKey, lane: MessageActionPlacement, step: -1 | 1) => {
    const items = inLane(layoutRef.current, lane).filter((item) => item.id !== id);
    const index = inLane(layoutRef.current, lane).findIndex((item) => item.id === id);
    const target = index + step;
    if (target < 0 || target > items.length) return;
    if (moveTo(id, lane, target)) announce(id);
  };

  const onChipKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: ActionKey, lane: MessageActionPlacement) => {
    justDraggedRef.current = false;
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    if (event.key === forward || event.key === backward) {
      shift(id, lane, event.key === forward ? 1 : -1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const next = neighbourLane(id, lane, event.key === "ArrowDown" ? 1 : -1);
      if (next && moveTo(id, next, inLane(layoutRef.current, next).length)) announce(id);
    } else {
      return;
    }
    event.preventDefault();
    refocus(id);
  };

  const onChipPointerDown = (event: PointerEvent<HTMLButtonElement>, id: ActionKey) => {
    justDraggedRef.current = false;
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    // A finger on the chip scrolls the page or taps it; only its grip drags.
    if (event.pointerType !== "mouse" && !(event.target as Element).closest(".mqa-chip-grip")) return;
    pressRef.current = { id, x: event.clientX, y: event.clientY, moved: false };
  };

  // Track the drag on the window: moving a chip moves its DOM node, which would
  // drop a pointer capture held by the chip mid-gesture.
  useEffect(() => {
    const laneAt = (y: number) => {
      const lanes = Array.from(lanesRef.current?.querySelectorAll<HTMLElement>("[data-lane]") ?? []);
      let nearest: HTMLElement | null = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const lane of lanes) {
        const rect = lane.getBoundingClientRect();
        const away = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
        if (away < distance) {
          distance = away;
          nearest = lane;
        }
      }
      return nearest;
    };
    const onMove = (event: globalThis.PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.moved) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
        press.moved = true;
        setDragging(press.id);
      }
      const lane = laneAt(event.clientY);
      if (!lane) return;
      // Target = how many other chips in that lane come before the pointer:
      // the rows above it, then those on its own row toward the line's start.
      const rtl = getComputedStyle(lane).direction === "rtl";
      const index = Array.from(lane.querySelectorAll<HTMLElement>("[data-action-chip]"))
        .filter((chip) => chip.dataset.actionChip !== press.id)
        .filter((chip) => {
          const rect = chip.getBoundingClientRect();
          if (rect.bottom < event.clientY) return true;
          if (rect.top > event.clientY) return false;
          const middle = rect.left + rect.width / 2;
          return rtl ? middle > event.clientX : middle < event.clientX;
        }).length;
      moveTo(press.id, lane.dataset.lane as MessageActionPlacement, index);
    };
    const onEnd = () => {
      const press = pressRef.current;
      pressRef.current = null;
      if (!press?.moved) return;
      justDraggedRef.current = true;
      setDragging(null);
      announce(press.id);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  // moveTo and announce read the latest layout through layoutRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div ref={lanesRef} className="mqa-lanes" data-dragging={dragging ? "true" : undefined} data-disabled={disabled ? "true" : undefined}>
        {LANES.map((lane) => {
          const items = inLane(layout, lane);
          return (
            <div key={lane} className="mqa-lane" data-lane={lane} role="group" aria-label={laneName(lane)}>
              <span className="mqa-lane-name" aria-hidden="true">{laneName(lane)}</span>
              <div className="mqa-chips" data-empty={items.length === 0 ? "true" : undefined}>
                {items.map((item, index) => (
                  <ActionChip
                    key={item.id}
                    id={item.id}
                    lane={lane}
                    row={info(item.id)}
                    first={index === 0}
                    last={index === items.length - 1}
                    disabled={disabled}
                    dragging={dragging === item.id}
                    keyboardHintId={keyboardHintId}
                    justDragged={justDraggedRef}
                    onPlace={(next) => {
                      if (moveTo(item.id, next, inLane(layoutRef.current, next).length)) announce(item.id);
                    }}
                    onShift={(step) => shift(item.id, lane, step)}
                    onKeyDown={(event) => onChipKeyDown(event, item.id, lane)}
                    onPointerDown={(event) => onChipPointerDown(event, item.id)}
                  />
                ))}
                {items.length === 0 && <span className="mqa-lane-empty">{laneEmpty(lane)}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <span id={keyboardHintId} className="sr-only">{tr("settings.quickActions.lanesKeyboardHint")}</span>
      <span className="mqa-status" role="status">{status}</span>
    </>
  );
}

/** One button in a lane. A click (or Enter) opens its menu, which says what the
 *  button does and moves it without a drag; a finger drags it by its grip. */
function ActionChip({
  id, lane, row, first, last, disabled, dragging, keyboardHintId, justDragged, onPlace, onShift, onKeyDown, onPointerDown,
}: {
  id: ActionKey;
  lane: MessageActionPlacement;
  row: RowInfo;
  first: boolean;
  last: boolean;
  disabled: boolean;
  dragging: boolean;
  keyboardHintId: string;
  justDragged: { current: boolean };
  onPlace: (lane: MessageActionPlacement) => void;
  onShift: (step: -1 | 1) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const detail = row.unavailable
    ? tr("settings.quickActions.packageOff")
    : row.menu
      ? row.description
      : `${row.description} ${tr("settings.quickActions.barOnly")}`;
  const placementEntry = (target: MessageActionPlacement): MenuEntry => ({
    id: target,
    label: laneName(target),
    kind: "radio",
    checked: lane === target,
    onSelect: () => onPlace(target),
  });
  const entries: MenuEntry[] = [
    placementEntry("bar"),
    ...(row.menu ? [placementEntry("menu")] : []),
    placementEntry("off"),
    "separator",
    { id: "earlier", label: tr("settings.quickActions.moveEarlier"), disabled: first, onSelect: () => onShift(-1) },
    { id: "later", label: tr("settings.quickActions.moveLater"), disabled: last, onSelect: () => onShift(1) },
  ];
  return (
    <Menu
      label={row.name}
      title={row.name}
      entries={entries}
      header={<p className="mqa-chip-detail">{detail}</p>}
    >
      {(trigger: MenuTriggerProps) => (
        <button
          ref={trigger.ref}
          type="button"
          className="mqa-chip"
          data-action-chip={id}
          data-placement={lane}
          data-dragging={dragging ? "true" : undefined}
          data-unavailable={row.unavailable ? "true" : undefined}
          aria-haspopup={trigger["aria-haspopup"]}
          aria-expanded={trigger["aria-expanded"]}
          aria-describedby={keyboardHintId}
          title={detail}
          disabled={disabled}
          onClick={() => {
            if (justDragged.current) {
              justDragged.current = false;
              return;
            }
            trigger.onClick();
          }}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
        >
          <span className="mqa-chip-grip" aria-hidden="true"><Icon icon={DragHandleIcon} size="sm" /></span>
          <span className="mqa-chip-glyph" aria-hidden="true"><Icon icon={row.icon} size="sm" /></span>
          <span className="mqa-chip-name">{row.name}</span>
        </button>
      )}
    </Menu>
  );
}
