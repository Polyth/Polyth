/**
 * When the client asks the server to start a session's native runtime.
 *
 * Opening a chat to read it does not start a process (`intent: "open"` wires
 * only pending work). The runtime is warmed for an imminent turn once the
 * chat has stayed open and visible for `dwellMs`, or as soon as the person
 * types into its composer. Repeated warms for one session are throttled; the
 * server counts each warm as runtime activity, so a person who keeps writing
 * keeps the warmed process alive while an abandoned one idles out.
 */
export const OPEN_WARM_DWELL_MS = 20_000;
export const WARM_THROTTLE_MS = 60_000;

export interface SessionRuntimeWarmDeps {
  activate(sessionId: string, intent: "open" | "warm"): Promise<unknown>;
  /** The session the person is looking at now. */
  activeSessionId(): string | null;
  /** False while the app is hidden or backgrounded. */
  visible(): boolean;
  onOpenError(sessionId: string, error: unknown): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  dwellMs?: number;
  throttleMs?: number;
}

export interface SessionRuntimeWarm {
  /** The person opened `sessionId`: run its lifecycle pass and arm the dwell warm. */
  opened(sessionId: string): void;
  /** The person is writing in `sessionId`'s composer. */
  typing(sessionId: string): void;
  dispose(): void;
}

export function createSessionRuntimeWarm(deps: SessionRuntimeWarmDeps): SessionRuntimeWarm {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    // A pending warm is optional work; it must not keep a Node test run alive.
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const dwellMs = deps.dwellMs ?? OPEN_WARM_DWELL_MS;
  const throttleMs = deps.throttleMs ?? WARM_THROTTLE_MS;
  let dwell: { sessionId: string; handle: unknown } | undefined;
  let lastWarm: { sessionId: string; at: number } | undefined;

  const cancelDwell = (): void => {
    if (dwell) clearTimer(dwell.handle);
    dwell = undefined;
  };
  const warm = (sessionId: string): void => {
    if (deps.activeSessionId() !== sessionId) return;
    const at = now();
    if (lastWarm?.sessionId === sessionId && at - lastWarm.at < throttleMs) return;
    lastWarm = { sessionId, at };
    cancelDwell();
    // A failed warm is not a person-facing error: the send path wires the
    // runtime again and reports its own failure. Allow the next keystroke to retry.
    void deps.activate(sessionId, "warm").catch(() => {
      if (lastWarm?.sessionId === sessionId && lastWarm.at === at) lastWarm = undefined;
    });
  };

  return {
    opened(sessionId) {
      if (deps.activeSessionId() !== sessionId) return;
      cancelDwell();
      void deps.activate(sessionId, "open").catch((error: unknown) => {
        if (deps.activeSessionId() === sessionId) deps.onOpenError(sessionId, error);
      });
      const handle = setTimer(() => {
        if (dwell?.handle !== handle) return;
        dwell = undefined;
        if (deps.visible()) warm(sessionId);
      }, dwellMs);
      dwell = { sessionId, handle };
    },
    typing(sessionId) {
      warm(sessionId);
    },
    dispose() {
      cancelDwell();
    },
  };
}
