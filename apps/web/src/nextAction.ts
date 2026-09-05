/** Guard data captured when a manual next-action request begins. */
export interface NextActionRequest {
  sessionId: string | null;
  projectId?: string | null;
  atSeq: number;
  draftRevision: number;
  draft: string;
}

export interface PromptRewrite {
  scopeId: string;
  original: string;
  generated: string;
}

/** The response may only touch the composer if neither conversation nor draft moved. */
export function canApplyNextAction(
  request: NextActionRequest,
  current: { activeSessionId: string | null; activeProjectId?: string | null; latestSeq: number; draftRevision: number },
  response: { atSeq: number },
): boolean {
  return current.activeSessionId === request.sessionId
    && (request.projectId === undefined || current.activeProjectId === request.projectId)
    && current.latestSeq === request.atSeq
    && response.atSeq === request.atSeq
    && current.draftRevision === request.draftRevision;
}

/** Suggestions and rewrites are complete prompts, never text to append. */
export function nextActionInsertMode(suggestion: string): "replace" | null {
  if (!suggestion.trim()) return null;
  return "replace";
}

/** Repeated magic-button presses regenerate from the user's original words,
 * not from an increasingly model-edited copy. */
export function promptRewriteSource(scopeId: string, draft: string, rewrite: PromptRewrite | null): string {
  return rewrite?.scopeId === scopeId && rewrite.generated === draft ? rewrite.original : draft;
}

export function canRevertPromptRewrite(scopeId: string, draft: string, rewrite: PromptRewrite | null): boolean {
  return rewrite?.scopeId === scopeId && rewrite.generated === draft;
}
