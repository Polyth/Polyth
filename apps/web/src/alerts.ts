// App-owned confirmation and input dialogs. Browser `confirm`/`prompt` block
// the UI and ignore the active theme, so callers await these instead.
import { useSyncExternalStore } from "react";
import { tr } from "./i18n/index.ts";

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
  options: { title?: string; confirmLabel?: string; destructive?: boolean; keepKeyboard?: boolean } = {},
): Promise<boolean> {
  replaceCurrent();
  return new Promise<boolean>((resolve) => {
    current = {
      kind: "confirm",
      title: options.title ?? tr("alerts.pleaseConfirm"),
      message,
      confirmLabel: options.confirmLabel ?? tr("common.continue"),
      destructive: options.destructive ?? true,
      ...(options.keepKeyboard ? { keepKeyboard: true } : {}),
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
