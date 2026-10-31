/** Guard data captured when a draft rewrite begins. */
export interface PromptRewriteRequest {
  sessionId: string | null;
  projectId?: string | null;
  draftRevision: number;
  draft: string;
}

export interface PromptRewrite {
  scopeId: string;
  original: string;
  generated: string;
}

/** A rewrite may only touch the composer if it is still the same composer
 * target and the person has not typed since. It depends on the draft alone, so
 * conversation movement does not make it stale. */
export function canApplyPromptRewrite(
  request: PromptRewriteRequest,
  current: { activeSessionId: string | null; activeProjectId?: string | null; draftRevision: number },
): boolean {
  return current.activeSessionId === request.sessionId
    && (request.projectId === undefined || current.activeProjectId === request.projectId)
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
