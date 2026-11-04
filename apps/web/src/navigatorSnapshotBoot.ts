// Boot side of the remembered navigator (navigatorSnapshot.ts): paint it into
// the store while the boot reads are out, retire its rows the server no longer
// names, and keep it in step with what the navigator shows afterwards.
import type { SessionProjection } from "@polyth/contracts";
import * as store from "./store.ts";
import { parseAppUrl } from "./router.ts";
import { clientAccountPersistenceScope, clientPersistenceScope } from "./reliabilityContext.ts";
import { encodeNavigatorSnapshot, readNavigatorSnapshot, snapshotRows, writeNavigatorSnapshot } from "./navigatorSnapshot.ts";

/** Rows painted from the snapshot, as painted. One still identical to this
 *  object when its project's first list answer lands was named by nothing the
 *  server sent since: it is gone (deleted, archived, shared away) and retires. */
const provisionalRows = new Map<string, SessionProjection>();
/** Set once the server's own project list published in this document. */
let projectListAnswered = false;
/** The remembered branch label, until the first git read of its checkout or
 *  shortly after boot, whichever comes first: later it could only be stale. */
let rememberedBranch: { projectId: string; scope: string; label: string; until: number } | null = null;
const BRANCH_MEMORY_MS = 10_000;

/** Whose label `store.gitBranch` is, as told by the git reads that set it. */
export type BranchLabelOwner = () => { projectId: string; scope: string } | null;

/** The label the last launch showed for this checkout, until its first git
 *  answer (forgetRememberedBranch) or shortly after boot. Another checkout
 *  does not borrow it. */
export function rememberedBranchLabel(projectId: string, scope: string): string | null {
  const remembered = rememberedBranch;
  if (remembered === null) return null;
  if (Date.now() > remembered.until) {
    rememberedBranch = null;
    return null;
  }
  return remembered.projectId === projectId && remembered.scope === scope ? remembered.label : null;
}

/** A git read answered for this checkout: from now on it owns the label. */
export function forgetRememberedBranch(projectId: string, scope: string): void {
  if (rememberedBranch?.projectId === projectId && rememberedBranch.scope === scope) rememberedBranch = null;
}

export function markProjectListAnswered(): void {
  projectListAnswered = true;
}

/** Paint the navigator the last launch showed while the boot reads are out.
 *  A link to something the snapshot does not know waits for the server. */
export async function paintNavigatorSnapshot(): Promise<boolean> {
  const snapshot = await readNavigatorSnapshot(clientAccountPersistenceScope());
  if (!snapshot) return false;
  const knownSpace = clientPersistenceScope().spaceId;
  if (knownSpace && knownSpace !== "default" && knownSpace !== snapshot.spaceId) return false;
  const fromUrl = parseAppUrl(location.pathname, location.search);
  if (fromUrl.projectId && !snapshot.projects.some((project) => project.id === fromUrl.projectId)) return false;
  if (fromUrl.sessionId && !snapshot.sessions.some((row) => row.id === fromUrl.sessionId)) return false;
  const registry = store.getState().projectRegistry;
  if (registry.status !== "loading" || registry.requestId === 0) return false;
  // Rows and the branch label go in before the list: adopting it can activate
  // the saved project at once, and that project's reads must already find
  // them on screen (no veil hold, no second label).
  if (snapshot.branch && snapshot.projectId) {
    rememberedBranch = { projectId: snapshot.projectId, ...snapshot.branch, until: Date.now() + BRANCH_MEMORY_MS };
  }
  const known = new Set(store.getState().sessions.map((session) => session.id));
  const rows = snapshot.sessions.filter((row) => !known.has(row.id));
  store.upsertSessions(rows);
  const painted = new Set(rows.map((row) => row.id));
  for (const session of store.getState().sessions) {
    if (painted.has(session.id)) provisionalRows.set(session.id, session);
  }
  return store.adoptProvisionalProjectList(snapshot.projects);
}

/** `listed`: every row of the project's first complete answer (recency page
 *  and pinned rows). Painted rows it did not name, and nothing else updated,
 *  leave the navigator; the open chat is never pulled from under the person. */
export function retireProvisionalRows(projectId: string, listed: ReadonlySet<string>): void {
  if (provisionalRows.size === 0) return;
  const current = new Map(store.getState().sessions.map((session) => [session.id, session]));
  const active = store.getState().activeSessionId;
  for (const [id, painted] of provisionalRows) {
    if (painted.projectId !== projectId) continue;
    provisionalRows.delete(id);
    if (!listed.has(id) && id !== active && current.get(id) === painted) store.removeSession(id);
  }
}

const SAVE_DELAY_MS = 2_500;
let watched = false;

/** Keep the snapshot in step with what the navigator shows, a few seconds
 *  behind (a streaming turn changes its row often) and at once when the page
 *  is left. Only after the server answered the list: a launch must never
 *  re-save its own remembered copy as if it were current. The branch label is
 *  kept only with the checkout its git read named (`labelOwner`). */
export function watchNavigatorSnapshot(labelOwner: BranchLabelOwner = () => null): void {
  if (watched) return;
  watched = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastContent = "";
  let lastRegistry: unknown = null;
  let lastSessions: unknown = null;
  let lastProject: string | null = null;
  let lastBranch = "";
  const write = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const state = store.getState();
    if (!projectListAnswered || state.projectRegistry.status !== "ready") return;
    const projectId = store.workspaceProjectId(state) ?? state.activeProjectId;
    const owner = labelOwner();
    const content = {
      spaceId: clientPersistenceScope().spaceId ?? "default",
      projects: state.projectRegistry.projects,
      projectId,
      sessions: snapshotRows(state.sessions, projectId),
      branch: projectId && owner?.projectId === projectId && state.gitBranch
        ? { scope: owner.scope, label: state.gitBranch }
        : null,
    };
    const key = JSON.stringify(content);
    if (key === lastContent) return;
    const encoded = encodeNavigatorSnapshot({ savedAt: Date.now(), ...content });
    if (encoded === null) return;
    lastContent = key;
    writeNavigatorSnapshot(clientAccountPersistenceScope(), encoded);
  };
  store.subscribeStore(() => {
    const state = store.getState();
    const projectId = store.workspaceProjectId(state) ?? state.activeProjectId;
    if (state.projectRegistry === lastRegistry && state.sessions === lastSessions
      && projectId === lastProject && state.gitBranch === lastBranch) return;
    lastRegistry = state.projectRegistry;
    lastSessions = state.sessions;
    lastProject = projectId;
    lastBranch = state.gitBranch;
    timer ??= setTimeout(write, SAVE_DELAY_MS);
  });
  window.addEventListener("pagehide", write);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") write();
  });
}

/** Test seam: forget this document's painted rows and answer. */
export function resetNavigatorSnapshotBootForTest(): void {
  provisionalRows.clear();
  projectListAnswered = false;
  rememberedBranch = null;
}
