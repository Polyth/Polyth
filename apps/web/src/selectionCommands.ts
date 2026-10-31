// Transcript-selection commands shared by the desktop floating toolbar and the
// touch selection dock, so both surfaces quote and bootstrap identically.
import { quoteForReply, selectionTitle } from "./selectionActions.ts";
import { requestComposerInsert } from "./composerInsert.ts";
import { startNewSession } from "./store.ts";

/** Markdown-quote the selection into the composer draft. */
export function quoteSelectionInComposer(text: string): void {
  requestComposerInsert(quoteForReply(text));
}

/** Same bootstrap pattern as GithubView "+ session": the context lands as the
 *  new session's draft (saved before it opens) — nothing is sent. */
export function startSessionFromSelection(projectId: string, text: string): void {
  startNewSession(projectId, {
    title: selectionTitle(text),
    draft: quoteForReply(text),
  });
}
