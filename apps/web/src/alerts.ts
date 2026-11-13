// App-owned confirmation and input dialogs. Browser `confirm`/`prompt` block
// the UI and ignore the active theme, so callers await these instead.
import { useSyncExternalStore } from "react";
import { tr } from "./i18n/index.ts";

/** Viewport rect of the control a confirmation was asked from (a menu row, a
 *  swipe-tray button). On a phone the confirmation then opens as a card at
 *  that spot, grown out of it, instead of a bottom sheet. */
export interface AlertOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type AlertRequest =
  | {
    kind: "confirm";
    title: string;
    message: string;
    confirmLabel: string;
    destructive: boolean;
    /** Keep a composer-held software keyboard open across the confirmation
     *  (the full-access prompt). See ModalSurfaceOptions.keepKeyboard. */
    keepKeyboard?: boolean;
    origin?: AlertOrigin;
    resolve: (value: boolean) => void;
  }
  | {
    kind: "prompt";
    title: string;
    message: string;
    placeholder?: string;
    initialValue?: string;
    confirmLabel: string;
    secret?: boolean;
    resolve: (value: string | null) => void;
  };

let current: AlertRequest | null = null;
const listeners = new Set<() => void>();

const emit = (): void => { for (const listener of listeners) listener(); };

function replaceCurrent(): void {
  // A second alert is never allowed to orphan the first caller. This normally
  // cannot happen because destructive controls disable while their request is
  // in flight; declining the displaced dialog is the safest fallback.
  if (!current) return;
  const displaced = current;
  current = null;
  if (displaced.kind === "confirm") displaced.resolve(false);
  else displaced.resolve(null);
}

export function confirmAlert(
  message: string,
  options: { title?: string; confirmLabel?: string; destructive?: boolean; keepKeyboard?: boolean; origin?: AlertOrigin } = {},
): Promise<boolean> {
  replaceCurrent();
  const origin = options.origin;
  return new Promise<boolean>((resolve) => {
    current = {
      kind: "confirm",
      title: options.title ?? tr("alerts.pleaseConfirm"),
      message,
      confirmLabel: options.confirmLabel ?? tr("common.continue"),
      destructive: options.destructive ?? true,
      ...(options.keepKeyboard ? { keepKeyboard: true } : {}),
      // A plain copy: a DOMRect's fields are getters on its prototype.
      ...(origin ? { origin: { left: origin.left, top: origin.top, width: origin.width, height: origin.height } } : {}),
      resolve,
    };
    emit();
  });
}

export function promptAlert(
  message: string,
  options: { title?: string; confirmLabel?: string; placeholder?: string; initialValue?: string; secret?: boolean } = {},
): Promise<string | null> {
  replaceCurrent();
  return new Promise<string | null>((resolve) => {
    current = {
      kind: "prompt",
      title: options.title ?? tr("alerts.enterValue"),
      message,
      confirmLabel: options.confirmLabel ?? tr("common.continue"),
      ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
      ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
      ...(options.secret ? { secret: true } : {}),
      resolve,
    };
    emit();
  });
}

export interface AnchoredAlertPlacement {
  /** Card offsets inside the backdrop band, in px. */
  left: number;
  top: number;
  /** Where the origin's centre falls on the card: its transform-origin. */
  originX: number;
  originY: number;
}

/**
 * Place an anchored confirmation card over the control it was asked from:
 * centred on that control's centre, then kept inside the band (the backdrop
 * box, already limited to the visible viewport) less its safe insets. The
 * transform-origin follows the control, so the card grows out of the spot the
 * finger just lifted from even when the clamp moves it away.
 */
export function placeAnchoredAlert(input: {
  origin: AlertOrigin;
  card: { width: number; height: number };
  band: { left: number; top: number; width: number; height: number };
  insets: { top: number; right: number; bottom: number; left: number };
}): AnchoredAlertPlacement {
  const { origin, card, band, insets } = input;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), value));
  const centreX = origin.left + origin.width / 2 - band.left;
  const centreY = origin.top + origin.height / 2 - band.top;
  const left = clamp(centreX - card.width / 2, insets.left, band.width - insets.right - card.width);
  const top = clamp(centreY - card.height / 2, insets.top, band.height - insets.bottom - card.height);
  return { left, top, originX: centreX - left, originY: centreY - top };
}

export function resolveAlert(value: boolean | string | null): void {
  const request = current;
  if (!request) return;
  current = null;
  if (request.kind === "confirm") request.resolve(value === true);
  else request.resolve(typeof value === "string" ? value : null);
  emit();
}

export function useAlert(): AlertRequest | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => null,
  );
}
