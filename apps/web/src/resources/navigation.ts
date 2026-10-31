import type { ResourceRef, OpenResourceOptions } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import { openSession } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { activateProject, activateSession, getState, openEditorFile, openWorkspacePane, setUiError, upsertSession } from "../store.ts";

let resourceOpenSequence = 0;
export function openResource(ref: ResourceRef, options: OpenResourceOptions = {}): void {
  const sequence = ++resourceOpenSequence;
  const initial = getState();
  const open = () => {
    if (sequence !== resourceOpenSequence) return;
    const current = getState();
    if (current.activeProjectId !== ref.projectId || current.activeSessionId !== (ref.sessionId ?? null)) return;
    showResource(ref, options);
  };
  if (initial.activeProjectId === ref.projectId && initial.activeSessionId === (ref.sessionId ?? null)) {
    open();
    return;
  }
  if (!ref.sessionId) {
    activateProject(ref.projectId);
    activateSession(null);
    open();
    return;
  }
  // Resolve ownership before navigating. A stale asynchronous link must never
  // open its locator in whichever workspace the user selected meanwhile.
  void (async () => {
    const session = initial.sessions.find((candidate) => candidate.id === ref.sessionId)
      ?? await api.getSession(ref.sessionId!);
    if (sequence !== resourceOpenSequence) return;
    const current = getState();
    if (current.activeProjectId !== initial.activeProjectId || current.activeSessionId !== initial.activeSessionId
      || current.newSessionIntent !== initial.newSessionIntent) return;
    if (session.projectId !== ref.projectId) throw new Error("Resource does not belong to this workspace.");
    upsertSession(session);
    await openSession(session.id, { showChat: false });
    open();
  })().catch((error) => {
    if (sequence === resourceOpenSequence) setUiError(friendlyError("Could not open resource.", error));
  });
}

function showResource(ref: ResourceRef, options: OpenResourceOptions): void {
  // View routing is deferred — files open through the legacy editor path until
  // ResourceView selection is wired end-to-end.
  if (ref.scheme === "file") {
    openEditorFile(ref.locator, options.selection ? {
      path: ref.locator,
      startLine: options.selection.startLine,
      endLine: options.selection.endLine,
      column: options.selection.column,
    } : undefined, { preview: options.preview, repositoryId: ref.repositoryId });
    return;
  }
  openWorkspacePane(ref.scheme, `${ref.scheme}:${ref.locator}`);
}
