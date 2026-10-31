/** The suggestion source for one session: the harness's own guess wins unless
 * a package offer (Session Assist) is `preferred`. An offer counts only for the
 * session it was made for, and a preferred offer with no text yet holds the
 * chip empty instead of flashing the harness's guess before replacing it. */
export function composerPromptSuggestion(input: {
  sessionId: string | undefined;
  harness: string | undefined;
  offer: { sessionId: string; text: string; preferred?: boolean } | null;
}): string | undefined {
  const offer = input.sessionId && input.offer?.sessionId === input.sessionId ? input.offer : null;
  if (offer?.preferred) return offer.text.trim() ? offer.text : undefined;
  if (input.harness?.trim()) return input.harness;
  return offer?.text.trim() ? offer.text : undefined;
}

/** The harness's suggested next prompt is offered only to an idle, empty
 * composer that is not editing a queued message, running a shell command or
 * creating its session. A suggestion the person dismissed stays hidden until
 * the harness offers a different one. */
export function visiblePromptSuggestion(input: {
  suggestion: string | undefined;
  dismissed: string;
  text: string;
  working: boolean;
  blocked: boolean;
}): string {
  const suggestion = input.suggestion?.trim() ?? "";
  if (!suggestion || suggestion === input.dismissed) return "";
  if (input.working || input.blocked || input.text.trim()) return "";
  return suggestion;
}
