/** Guard data captured when a manual next-action request begins. */
export interface NextActionRequest {
  sessionId: string;
  atSeq: number;
  draftRevision: number;
  draft: string;
}

/** The response may only touch the composer if neither conversation nor draft moved. */
export function canApplyNextAction(
  request: NextActionRequest,
  current: { activeSessionId: string | null; latestSeq: number; draftRevision: number },
  response: { atSeq: number },
): boolean {
  return current.activeSessionId === request.sessionId
    && current.latestSeq === request.atSeq
    && response.atSeq === request.atSeq
    && current.draftRevision === request.draftRevision;
}

/** Keep an existing, unchanged draft; an empty composer receives a whole-prompt replacement. */
export function nextActionInsertMode(request: NextActionRequest, suggestion: string): "replace" | "insert" | null {
  if (!suggestion.trim()) return null;
  return request.draft.trim() ? "insert" : "replace";
}
