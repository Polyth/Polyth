// Adaptive screencast pacing for chat-workspace tabs: activity in the last
// ~2s caps at ~15 fps; otherwise ≤4 fps. Idle pages emit nothing naturally.

export interface ScreencastPacingState {
  lastFrameAt: number;
  lastActivityAt: number;
  visible: boolean;
}

export function createScreencastPacing(now: () => number = Date.now): ScreencastPacingState {
  const t = now();
  return { lastFrameAt: 0, lastActivityAt: t, visible: true };
}

export function noteScreencastActivity(state: ScreencastPacingState, at = Date.now()): void {
  state.lastActivityAt = at;
}

export function setScreencastVisible(state: ScreencastPacingState, visible: boolean): void {
  state.visible = visible;
}

/** Minimum interval between emitted frames in ms. Returns null when paused. */
export function screencastMinIntervalMs(state: ScreencastPacingState, at = Date.now()): number | null {
  if (!state.visible) return null;
  const active = at - state.lastActivityAt <= 2000;
  return active ? Math.ceil(1000 / 15) : Math.ceil(1000 / 4);
}

/** Whether a frame arriving at `at` should be delivered to clients. */
export function shouldEmitScreencastFrame(state: ScreencastPacingState, at = Date.now()): boolean {
  const min = screencastMinIntervalMs(state, at);
  if (min === null) return false;
  if (state.lastFrameAt === 0) return true;
  return at - state.lastFrameAt >= min;
}

export function markScreencastFrameEmitted(state: ScreencastPacingState, at = Date.now()): void {
  state.lastFrameAt = at;
}
