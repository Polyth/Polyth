// Early-abort latch for turn preparation.
//
// Stop pressed 1–2 s after submit is not a race against the model stream; it is
// a race against turn *preparation*. Admission expands commands, validates the
// model, reads workspace instructions, runs memory recall and appends durable
// intent under the per-session lock, before any runtime request exists. A Stop
// that waits for that lock arrives after the request is already in flight.
//
// The latch is set synchronously by `abort()` before it takes the lock, and
// admission checks it at its pre-dispatch gates. It carries no signals: once the
// request is dispatched, Stop is the ordinary provider abort.
//
// Erasable TypeScript only.

export interface TurnLatch {
  requestEarlyAbort(): void;
  earlyAbortRequested(): boolean;
}

export interface TurnPhaseRegistry {
  /** A fresh latch for a turn entering preparation; replaces any previous one. */
  open(sessionId: string): TurnLatch;
  get(sessionId: string): TurnLatch | undefined;
  /** Drop a latch once its turn left preparation (dispatched or failed). Only
   *  that exact latch is removed, so a late release never clears a newer turn. */
  release(sessionId: string, latch: TurnLatch): void;
}

export function createTurnPhaseRegistry(): TurnPhaseRegistry {
  const latches = new Map<string, TurnLatch>();
  return {
    open(sessionId) {
      let requested = false;
      const latch: TurnLatch = {
        requestEarlyAbort: () => { requested = true; },
        earlyAbortRequested: () => requested,
      };
      latches.set(sessionId, latch);
      return latch;
    },
    get: (sessionId) => latches.get(sessionId),
    release(sessionId, latch) {
      if (latches.get(sessionId) === latch) latches.delete(sessionId);
    },
  };
}
