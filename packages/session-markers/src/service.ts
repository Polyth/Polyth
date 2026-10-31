// One Space's markers on disk, and the access rules around them. Every read and
// write names chats through the caller's scoped session service, so a person
// (or the agent acting for them) sees and marks only chats they can open.
import { readFileSync } from "node:fs";
import type { SessionProjection, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import {
  allDefinitions,
  applyMarkerChange,
  defineMarker,
  emptyMarkerDocument,
  invalidInput,
  parseMarkerDocument,
  removeMarkerDefinition,
  updateMarker,
  SESSION_MARKERS_PACKAGE_ID,
  type MarkerActor,
  type MarkerChange,
  type MarkerDefinition,
  type MarkerDefinitionInput,
  type MarkerDocument,
  type MarkedSession,
  type MarkersSnapshot,
} from "./markers.ts";

export type { MarkedSession, MarkersSnapshot };

const DOCUMENT_FILE = "markers.json";
/** Bound one request's fan-out. */
export const MARKER_CHANGE_SESSIONS_MAX = 200;

export interface SessionMarkersDeps {
  storage(space: SpaceContext): SpaceStorage;
  /** The caller's view of one chat; rejects a chat they cannot open. */
  session(space: SpaceContext, sessionId: string): Promise<SessionProjection>;
  /** Whether a chat still exists at all (unscoped), to drop markers of deleted chats. */
  exists(sessionId: string): Promise<boolean>;
  now?(): number;
}

export interface SessionMarkersService {
  snapshot(space: SpaceContext): Promise<MarkersSnapshot>;
  apply(space: SpaceContext, change: MarkerChange, by: MarkerActor): Promise<MarkersSnapshot>;
  define(space: SpaceContext, input: MarkerDefinitionInput): Promise<{ marker: MarkerDefinition; snapshot: MarkersSnapshot }>;
  update(space: SpaceContext, id: string, input: MarkerDefinitionInput): Promise<MarkersSnapshot>;
  remove(space: SpaceContext, id: string): Promise<MarkersSnapshot>;
}

const notFound = (): Error => Object.assign(new Error("Chat not found"), { code: "not-found" });

export function createSessionMarkersService(deps: SessionMarkersDeps): SessionMarkersService {
  const now = deps.now ?? Date.now;
  // One writer per Space in this process; read-modify-write never interleaves.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(space: SpaceContext, run: () => Promise<T>): Promise<T> => {
    const result = (queues.get(space.spaceId) ?? Promise.resolve()).then(run);
    const settled = result.catch(() => undefined);
    queues.set(space.spaceId, settled);
    void settled.then(() => { if (queues.get(space.spaceId) === settled) queues.delete(space.spaceId); });
    return result;
  };

  const pathFor = (space: SpaceContext): string => {
    const storage = deps.storage(space);
    storage.packageDir(SESSION_MARKERS_PACKAGE_ID);
    return storage.path(`packages/${SESSION_MARKERS_PACKAGE_ID}/${DOCUMENT_FILE}`);
  };

  const read = (space: SpaceContext): MarkerDocument => {
    try {
      return parseMarkerDocument(JSON.parse(readFileSync(pathFor(space), "utf8")) as unknown);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyMarkerDocument();
      throw cause;
    }
  };

  const write = (space: SpaceContext, document: MarkerDocument): MarkerDocument => {
    const next = { ...document, revision: document.revision + 1 };
    atomicWriteSync(pathFor(space), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  };

  const visible = async (space: SpaceContext, sessionId: string): Promise<SessionProjection | undefined> => {
    try {
      return await deps.session(space, sessionId);
    } catch {
      return undefined;
    }
  };

  // The caller's view: chats they cannot open are left out, never reported. A
  // chat that no longer exists anywhere loses its markers.
  const view = async (space: SpaceContext, document: MarkerDocument): Promise<MarkersSnapshot> => {
    const sessions: MarkedSession[] = [];
    const gone: string[] = [];
    for (const [sessionId, markers] of Object.entries(document.sessions)) {
      const projection = await visible(space, sessionId);
      if (!projection) {
        if (!await deps.exists(sessionId).catch(() => true)) gone.push(sessionId);
        continue;
      }
      sessions.push({
        sessionId,
        projectId: projection.projectId,
        title: projection.title,
        archived: projection.status === "archived",
        updatedAt: projection.updatedAt,
        markers,
      });
    }
    let current = document;
    if (gone.length) {
      const remaining = { ...document.sessions };
      for (const sessionId of gone) delete remaining[sessionId];
      current = write(space, { ...document, sessions: remaining });
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    return { revision: current.revision, definitions: allDefinitions(current), sessions };
  };

  return {
    snapshot: (space) => serial(space, () => view(space, read(space))),
    apply: (space, change, by) => serial(space, async () => {
      const sessionIds = [...new Set(change.sessionIds)];
      if (sessionIds.length === 0) throw invalidInput("Choose at least one chat");
      if (sessionIds.length > MARKER_CHANGE_SESSIONS_MAX) throw invalidInput(`At most ${MARKER_CHANGE_SESSIONS_MAX} chats at once`);
      // Every named chat must be the caller's before anything is written; a
      // foreign or absent id gets the same answer.
      for (const sessionId of sessionIds) {
        if (typeof sessionId !== "string" || !sessionId || !await visible(space, sessionId)) throw notFound();
      }
      const { document } = applyMarkerChange(read(space), { ...change, sessionIds }, by, now());
      return view(space, write(space, document));
    }),
    define: (space, input) => serial(space, async () => {
      const result = defineMarker(read(space), input);
      const document = result.created ? write(space, result.document) : result.document;
      return { marker: result.marker, snapshot: await view(space, document) };
    }),
    update: (space, id, input) => serial(space, async () => view(space, write(space, updateMarker(read(space), id, input)))),
    remove: (space, id) => serial(space, async () => view(space, write(space, removeMarkerDefinition(read(space), id)))),
  };
}
