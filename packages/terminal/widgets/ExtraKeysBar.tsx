// Termux-style extra-keys rows for touch terminals. Keys act on pointer
// release so a key can also be swiped up for its popup alternate, held to
// repeat (navigation/delete keys) or to lock a modifier, and the whole bar can
// be swiped sideways to open the text-input row. Pointer-down is cancelled so
// the hidden terminal input keeps focus and the software keyboard stays open.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { ExtraKey, ExtraKeyAction, ExtraKeysLayout, ModifierName, Modifiers, SpokenKey } from "./terminal/extraKeys.ts";

/** Upward travel (px) that selects a key's popup alternate. */
export const POPUP_SWIPE_PX = 22;
/** Sideways travel (px) that turns a key press into a bar swipe. */
export const BAR_SWIPE_PX = 56;
export const HOLD_MS = 420;
export const REPEAT_MS = 60;
const DOUBLE_TAP_MS = 320;

interface Press {
  pointerId: number;
  row: number;
  col: number;
  x: number;
  y: number;
  popup: boolean;
  swiped: boolean;
  /** A hold already acted (repeat fired or modifier locked). */
  held: boolean;
  timer?: ReturnType<typeof setTimeout>;
  interval?: ReturnType<typeof setInterval>;
}

export interface ExtraKeysBarProps {
  layout: ExtraKeysLayout;
  modifiers: Modifiers;
  label: string;
  onKey: (action: ExtraKeyAction) => void;
  onModifier: (modifier: ModifierName, lock: boolean) => void;
  onSwipe: () => void;
  spoken: (key: SpokenKey) => string;
  popupHint: (label: string) => string;
  lockedHint: (label: string) => string;
  /** Fixed controls after the configurable keys (menu, keyboard toggle). */
  trailing?: ReactNode;
}

export default function ExtraKeysBar(props: ExtraKeysBarProps) {
  const { layout, modifiers } = props;
  const press = useRef<Press | null>(null);
  const pointerActivated = useRef(false);
  const lastModifierTap = useRef<{ modifier: ModifierName; at: number } | null>(null);
  const [pressed, setPressed] = useState<{ row: number; col: number; popup: boolean } | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const stopTimers = (p: Press | null) => {
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    if (p.interval) clearInterval(p.interval);
    p.timer = undefined;
    p.interval = undefined;
  };

  useEffect(() => () => stopTimers(press.current), []);

  const keyAt = (row: number, col: number): ExtraKey | undefined => latest.current.layout[row]?.[col];

  const activate = (k: ExtraKey, usePopup: boolean) => {
    const action = usePopup && k.popup ? k.popup.action : k.action;
    if (action.kind === "modifier") {
      const now = Date.now();
      const last = lastModifierTap.current;
      const doubleTap = last !== null && last.modifier === action.modifier && now - last.at < DOUBLE_TAP_MS;
      lastModifierTap.current = doubleTap ? null : { modifier: action.modifier, at: now };
      latest.current.onModifier(action.modifier, doubleTap);
      return;
    }
    lastModifierTap.current = null;
    latest.current.onKey(action);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, row: number, col: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    stopTimers(press.current);
    const k = keyAt(row, col);
    if (!k) return;
    const p: Press = { pointerId: event.pointerId, row, col, x: event.clientX, y: event.clientY, popup: false, swiped: false, held: false };
    press.current = p;
    setPressed({ row, col, popup: false });
    if (k.action.kind === "modifier") {
      const modifier = k.action.modifier;
      p.timer = setTimeout(() => {
        p.held = true;
        lastModifierTap.current = null;
        latest.current.onModifier(modifier, true);
      }, HOLD_MS);
    } else if (k.repeat) {
      p.timer = setTimeout(() => {
        p.held = true;
        activate(k, false);
        p.interval = setInterval(() => activate(k, false), REPEAT_MS);
      }, HOLD_MS);
    } else if (k.popup) {
      // Termux shows the alternate on a long press too; release sends it.
      p.timer = setTimeout(() => {
        p.popup = true;
        setPressed({ row, col, popup: true });
      }, HOLD_MS);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.pointerId !== event.pointerId || p.swiped) return;
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    if (Math.abs(dx) > BAR_SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 2 && !p.held) {
      p.swiped = true;
      stopTimers(p);
      setPressed(null);
      return;
    }
    const k = keyAt(p.row, p.col);
    const wantsPopup = Boolean(k?.popup) && dy < -POPUP_SWIPE_PX;
    if (wantsPopup !== p.popup && !p.held) {
      p.popup = wantsPopup;
      if (wantsPopup) stopTimers(p);
      setPressed({ row: p.row, col: p.col, popup: wantsPopup });
    }
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.pointerId !== event.pointerId) return;
    stopTimers(p);
    press.current = null;
    setPressed(null);
    if (cancelled) return;
    pointerActivated.current = true;
    if (p.swiped) { latest.current.onSwipe(); return; }
    if (p.held) return;
    const k = keyAt(p.row, p.col);
    if (k) activate(k, p.popup);
  };

  return (
    <div className="term-extra-keys" role="toolbar" aria-label={props.label}>
      <div className="term-extra-keys-grid">
        {layout.map((row, r) => (
          <div key={r} className="term-extra-keys-row" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>
            {row.map((k, c) => {
              const level = k.action.kind === "modifier" ? modifiers[k.action.modifier] : 0;
              const name = k.spoken ? props.spoken(k.spoken) : k.label;
              const isPressed = pressed?.row === r && pressed.col === c;
              return (
                <button
                  key={c}
                  type="button"
                  className="term-extra-key"
                  data-level={level || undefined}
                  data-glyph={Array.from(k.label).length === 1 || undefined}
                  data-pressed={isPressed || undefined}
                  aria-label={level === 2 ? props.lockedHint(name) : name}
                  aria-pressed={k.action.kind === "modifier" ? level !== 0 : undefined}
                  aria-description={k.popup ? props.popupHint(k.popup.label) : undefined}
                  tabIndex={-1}
                  onPointerDown={(event) => onPointerDown(event, r, c)}
                  onPointerMove={onPointerMove}
                  onPointerUp={(event) => finish(event, false)}
                  onPointerCancel={(event) => finish(event, true)}
                  onContextMenu={(event) => event.preventDefault()}
                  onClick={() => {
                    // Pointer presses already acted on release; assistive tech
                    // and keyboard activation arrive as a bare click.
                    if (pointerActivated.current) { pointerActivated.current = false; return; }
                    activate(k, false);
                  }}
                >
                  <span className="term-extra-key-label">{k.label}</span>
                  {k.popup && <span className="term-extra-key-alt" aria-hidden="true">{k.popup.label}</span>}
                  {isPressed && pressed.popup && k.popup && (
                    <span className="term-extra-key-popup" aria-hidden="true">{k.popup.label}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {props.trailing && <div className="term-extra-keys-trailing">{props.trailing}</div>}
    </div>
  );
}
