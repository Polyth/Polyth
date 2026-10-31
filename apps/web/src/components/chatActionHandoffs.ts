// Message text handed to another surface. Shared by user-message and answer
// quick actions so both roles start a session the same way.
import { startNewSession } from "../store.ts";

/** Open a new session in `projectId` with `text` as its unsent draft. */
export function startSessionFromText(projectId: string | null | undefined, text: string): boolean {
  if (!projectId) return false;
  startNewSession(projectId, { draft: text });
  return true;
}
