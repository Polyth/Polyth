// Durable-journal policy for streamed assistant deltas (PERF: stream
// checkpoints). Backends emit one `assistant/chunk`/`assistant/reasoning-chunk`
// per provider token; on a real workspace that made streamed deltas ~82% of
// every durable row and the dominant growth term of `sessions.db`.
//
// The journal stores *checkpoints*, not tokens. Consecutive deltas of the same
// part merge into one event whose text is their concatenation, written at most
// once per checkpoint window. Replay is unchanged: the reducer appends part
// text, and the turn's canonical `assistant/message` — which carries the
// complete text and reasoning — still finalizes the part. What changes is the
// granularity of the durable progress record; a crash can lose at most one
// window of a *partially* streamed part, never a completed one.

/** Durable (and therefore live) checkpoint cadence for streamed deltas. */
export const STREAM_CHECKPOINT_MS = 250;
/** A pending run flushes early once it holds this many characters, so a burst
 *  never waits out the window and memory stays bounded. */
export const STREAM_CHECKPOINT_MAX_CHARS = 4096;

export type StreamChunkType = "assistant/chunk" | "assistant/reasoning-chunk";

export interface StreamChunk {
  type: StreamChunkType;
  partId: string;
  text: string;
}

export interface StreamCheckpointState {
  /** Merged runs, in arrival order. */
  checkpoints: StreamChunk[];
  /** Raw deltas absorbed since the last take, for the caller's own bound. */
  deltas: number;
}

export const emptyStreamCheckpoints = (): StreamCheckpointState => ({ checkpoints: [], deltas: 0 });

export const isStreamChunk = (event: { type: string }): event is StreamChunk =>
  event.type === "assistant/chunk" || event.type === "assistant/reasoning-chunk";

/** Remaining time in the current checkpoint window. A delta arriving near
 *  the end must not start a fresh full window and double visible latency. */
export function streamCheckpointDelay(lastFlushAt: number, now: number): number {
  if (!Number.isFinite(lastFlushAt) || !Number.isFinite(now)) return STREAM_CHECKPOINT_MS;
  return Math.max(0, STREAM_CHECKPOINT_MS - Math.max(0, now - lastFlushAt));
}

/**
 * Merge one delta into the pending runs.
 *
 * Only *adjacent* same-part runs merge, so the order in which the journal
 * introduces each part into the transcript is exactly the raw delta order;
 * merging non-adjacent runs could move text across an interleaved part.
 *
 * Returns true when the caller must take and persist the runs now.
 */
export function pushStreamDelta(
  state: StreamCheckpointState,
  delta: StreamChunk,
  maxChars = STREAM_CHECKPOINT_MAX_CHARS,
): boolean {
  state.deltas += 1;
  const last = state.checkpoints[state.checkpoints.length - 1];
  if (last && last.type === delta.type && last.partId === delta.partId) {
    last.text += delta.text;
    return last.text.length >= maxChars;
  }
  state.checkpoints.push({ type: delta.type, partId: delta.partId, text: delta.text });
  return delta.text.length >= maxChars;
}

/** Take the merged runs and reset the pending state. */
export function takeStreamCheckpoints(state: StreamCheckpointState): StreamChunk[] {
  const checkpoints = state.checkpoints;
  state.checkpoints = [];
  state.deltas = 0;
  return checkpoints;
}
