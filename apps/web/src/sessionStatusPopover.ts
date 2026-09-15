import { useSyncExternalStore } from "react";

/** Host chrome: the session overview popover can open from the header chip
 * or from the above-composer agent status dock. */
export interface SessionStatusPopoverState {
  open: boolean;
  anchor: HTMLElement | null;
}

const CLOSED: SessionStatusPopoverState = { open: false, anchor: null };
let state: SessionStatusPopoverState = CLOSED;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openSessionStatusPopover(anchor?: HTMLElement | null): void {
  state = { open: true, anchor: anchor ?? null };
  emit();
}

export function closeSessionStatusPopover(): void {
  if (!state.open) return;
  state = CLOSED;
  emit();
}

export function toggleSessionStatusPopover(anchor?: HTMLElement | null): void {
  const nextAnchor = anchor ?? null;
  if (state.open && state.anchor === nextAnchor) {
    closeSessionStatusPopover();
    return;
  }
  openSessionStatusPopover(nextAnchor);
}

export function subscribeSessionStatusPopover(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSessionStatusPopover(): SessionStatusPopoverState {
  return state;
}

export function useSessionStatusPopover(): SessionStatusPopoverState {
  return useSyncExternalStore(subscribeSessionStatusPopover, getSessionStatusPopover, () => CLOSED);
}
