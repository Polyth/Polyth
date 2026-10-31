// Where a live cumulative transcript lands inside the draft.
//
// A run owns one contiguous span at the end of the draft. Providers send the
// *cumulative* transcript, so every update rewrites that span instead of
// appending — re-punctuation and dropped interim words correct themselves.
// The draft can also change underneath a run (Send clears it, a session draft
// is restored, the user types); the span then re-anchors onto whatever is
// there now and only newly spoken words are added, so sent text is never
// resurrected and typed text is never clobbered.

export interface TranscriptSpan {
  readonly runId: string;
  /** Draft text the span is appended to. */
  base: string;
  /** Full draft this run last wrote; a mismatch means someone else edited. */
  written: string;
  /** Cumulative transcript this run last applied. */
  delivered: string;
  /** Transcript prefix already folded into `base` by a re-anchor. */
  anchored: string;
}

export function beginTranscriptSpan(runId: string, draft: string): TranscriptSpan {
  return { runId, base: draft, written: draft, delivered: "", anchored: "" };
}

const joined = (base: string, tail: string): string => {
  if (!tail) return base;
  if (!base) return tail;
  return /\s$/.test(base) ? `${base}${tail}` : `${base} ${tail}`;
};

/**
 * Fold the cumulative `transcript` into `span` against the draft as it is
 * *right now* and return the text the composer should show. Mutates the span
 * so the next update measures against this write.
 */
export function applyTranscriptSpan(
  span: TranscriptSpan,
  draft: string,
  transcript: string,
): string {
  if (draft !== span.written) {
    // The draft moved without us. Adopt it and treat everything transcribed so
    // far as accounted for, so only words spoken from here on are added.
    span.base = draft;
    span.anchored = span.delivered;
  }
  const tail = span.anchored && transcript.startsWith(span.anchored)
    ? transcript.slice(span.anchored.length)
    : transcript;
  const next = joined(span.base, tail.replace(/^\s+/, ""));
  span.delivered = transcript;
  span.written = next;
  return next;
}
