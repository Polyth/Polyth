// UX-MOBILE-01 §22: how a sheet trigger fires on a phone.
//
// Tapping the model / mode / project control while the keyboard is up starts
// two things at once: the keyboard dismissal (the browser blurs the input on
// pointer-down) and the reflow that follows it. The control moves out from
// under the finger before pointer-up, so the CLICK is delivered somewhere else
// — or nowhere. That is exactly the "the keyboard just closes and no picker
// opens" bug. Touch therefore activates on pointer-down, while keyboard and
// assistive activation keep arriving as a click.
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

export interface SheetTriggerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick: () => void;
}

/** How long after a pointer activation a click is treated as its echo. */
export const POINTER_ACTIVATION_WINDOW = 600;

export function useSheetTrigger(enabled: boolean, activate: () => void): SheetTriggerHandlers {
  const activatedAt = useRef(0);
  return {
    onPointerDown: (event) => {
      // Primary button / first touch only; never a secondary or extra pointer.
      if (!enabled || event.button > 0 || !event.isPrimary) return;
      activatedAt.current = Date.now();
      activate();
    },
    onClick: () => {
      // Ignore the click that belongs to a pointer activation — whether it
      // arrives on the trigger, somewhere else, or not at all. A time window
      // (not a one-shot flag) keeps a never-delivered click from swallowing
      // the NEXT activation, including Enter from the keyboard.
      if (Date.now() - activatedAt.current < POINTER_ACTIVATION_WINDOW) return;
      activate();
    },
  };
}
