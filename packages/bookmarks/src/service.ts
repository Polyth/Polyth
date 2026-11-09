// One person's bookmarks in one Space, and the access rules around them.
//
//   <person storage>/spaces/<spaceId>/index.json        the list, without text
//   <person storage>/spaces/<spaceId>/bodies/<id>.md    each saved text
//
// The list stays small enough to send to a phone on every refresh; a saved text
// is read when it is opened. Chats are named through the caller's scoped session
// service, so a bookmark never reaches further than the person can.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import {
  BOOKMARK_LIMITS,
  bookmarkExportFileName,
  bookmarksMarkdown,
  compareBookmarks,
  conflict,
  emptyBookmarkDocument,
  extractBookmarkLinks,
  invalidInput,
  isBookmarkId,
  notFound,
  parseBookmarkDocument,
  parseBookmarkInput,
  parseBookmarkPatch,
  type Bookmark,
  type BookmarkDocument,
  type BookmarkView,
} from "./bookmarks.ts";

export interface BookmarksDeps {
  /** Escape-proof path inside the calling person's storage for this Space. */
  path(space: SpaceContext, relative: string): string;
  /** The caller's view of one chat; rejects a chat they cannot open. */
  session(space: SpaceContext, sessionId: string): Promise<SessionProjection>;
  /** Whether a chat still exists at all (unscoped): a chat that is gone differs
   *  from one the person may no longer open. */
  exists(sessionId: string): Promise<boolean>;
  /** The project's name when the caller can open it, else undefined. */
  projectName(space: SpaceContext, projectId: string): Promise<string | undefined>;
  now?(): number;
  newId?(): string;
}

export interface BookmarksSnapshot {
  revision: number;
  bookmarks: BookmarkView[];
}

export interface BookmarksScope {
  projectId?: string;
  sessionId?: string;
}

export interface BookmarksService {
  list(space: SpaceContext, scope?: BookmarksScope): Promise<BookmarksSnapshot>;
  body(space: SpaceContext, id: string): Promise<{ id: string; revision: number; body: string }>;
  create(space: SpaceContext, raw: unknown): Promise<BookmarkView>;
  update(space: SpaceContext, id: string, expectedRevision: unknown, raw: unknown): Promise<BookmarkView>;
  remove(space: SpaceContext, id: string): Promise<{ removed: BookmarkView; body: string }>;
  exportMarkdown(space: SpaceContext, scope: BookmarksScope): Promise<{ fileName: string; markdown: string }>;
}

const INDEX_FILE = "index.json";
const bodyFile = (id: string): string => join("bodies", `${id}.md`);

export function createBookmarksService(deps: BookmarksDeps): BookmarksService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  // One writer per person and Space in this process.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(space: SpaceContext, run: () => Promise<T>): Promise<T> => {
    const key = `${space.userId}\n${space.spaceId}`;
    const result = (queues.get(key) ?? Promise.resolve()).then(run);
    const settled = result.catch(() => undefined);
    queues.set(key, settled);
    void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return result;
  };

  const readDocument = (space: SpaceContext): BookmarkDocument => {
    try {
      return parseBookmarkDocument(JSON.parse(readFileSync(deps.path(space, INDEX_FILE), "utf8")) as unknown);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyBookmarkDocument();
      throw cause;
    }
  };

  const writeFile = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteSync(path, text);
  };

  const writeDocument = (space: SpaceContext, document: BookmarkDocument): BookmarkDocument => {
    const next = { ...document, revision: document.revision + 1 };
    writeFile(deps.path(space, INDEX_FILE), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  };

  const readBody = (space: SpaceContext, id: string): string => {
    try {
      return readFileSync(deps.path(space, bodyFile(id)), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw cause;
    }
  };

  const writeBody = (space: SpaceContext, id: string, body: string): void => {
    writeFile(deps.path(space, bodyFile(id)), body);
  };

  const removeBody = (space: SpaceContext, id: string): void => {
    rmSync(deps.path(space, bodyFile(id)), { force: true });
  };

  const visible = async (space: SpaceContext, sessionId: string): Promise<SessionProjection | undefined> => {
    try {
      return await deps.session(space, sessionId);
    } catch {
      return undefined;
    }
  };

  /** What the person may see now. A chat they can open shows its place. A chat
   *  that is gone keeps the bookmark only if it was their own chat. A chat that
   *  exists but is closed to them hides the bookmark, which returns with access. */
  const viewOf = async (space: SpaceContext, document: BookmarkDocument): Promise<{ views: BookmarkView[]; gone: string[] }> => {
    const chats = new Map<string, Promise<SessionProjection | undefined>>();
    const states = new Map<string, Promise<boolean>>();
    const views: BookmarkView[] = [];
    const gone: string[] = [];
    for (const bookmark of document.bookmarks) {
      if (!bookmark.sessionId) {
        views.push({ ...bookmark, chat: "none" });
        continue;
      }
      const sessionId = bookmark.sessionId;
      if (!chats.has(sessionId)) chats.set(sessionId, visible(space, sessionId));
      const projection = await chats.get(sessionId)!;
      if (projection) {
        views.push({
          ...bookmark,
          projectId: projection.projectId,
          ...(projection.title ? { chatTitle: projection.title } : {}),
          chat: "open",
        });
        continue;
      }
      if (!states.has(sessionId)) states.set(sessionId, deps.exists(sessionId).catch(() => true));
      if (await states.get(sessionId)!) continue;
      if (bookmark.ownChat !== false) views.push({ ...bookmark, chat: "deleted" });
      else gone.push(bookmark.id);
    }
    return { views, gone };
  };

  const inScope = (view: BookmarkView, scope: BookmarksScope): boolean =>
    (scope.projectId === undefined || view.projectId === scope.projectId)
    && (scope.sessionId === undefined || view.sessionId === scope.sessionId);

  const snapshot = async (space: SpaceContext, scope: BookmarksScope = {}): Promise<BookmarksSnapshot> => {
    let document = readDocument(space);
    const { views, gone } = await viewOf(space, document);
    if (gone.length > 0) {
      const dropped = new Set(gone);
      document = writeDocument(space, { ...document, bookmarks: document.bookmarks.filter((bookmark) => !dropped.has(bookmark.id)) });
      for (const id of gone) removeBody(space, id);
    }
    return {
      revision: document.revision,
      bookmarks: views.filter((view) => inScope(view, scope)).sort(compareBookmarks),
    };
  };

  const viewById = async (space: SpaceContext, document: BookmarkDocument, id: string): Promise<BookmarkView> => {
    if (!isBookmarkId(id)) throw notFound();
    const { views } = await viewOf(space, document);
    const view = views.find((candidate) => candidate.id === id);
    if (!view) throw notFound();
    return view;
  };

  return {
    list: (space, scope) => serial(space, () => snapshot(space, scope)),

    body: (space, id) => serial(space, async () => {
      const view = await viewById(space, readDocument(space), id);
      return { id: view.id, revision: view.revision, body: readBody(space, view.id) };
    }),

    create: (space, raw) => serial(space, async () => {
      const input = parseBookmarkInput(raw);
      const document = readDocument(space);
      let placement: Pick<Bookmark, "projectId" | "sessionId" | "eventSeq" | "chatTitle" | "ownChat">;
      if (input.sessionId !== undefined) {
        // Trust the chat, not what the browser said about it: a foreign or
        // absent id gets the same answer.
        const projection = await visible(space, input.sessionId);
        if (!projection) throw notFound("Chat not found");
        placement = {
          projectId: projection.projectId,
          sessionId: input.sessionId,
          ...(input.eventSeq !== undefined ? { eventSeq: input.eventSeq } : {}),
          ...(projection.title ? { chatTitle: projection.title } : {}),
          ownChat: !projection.sharing?.owner,
        };
        // One answer or one section is one bookmark, whichever device saved it.
        const repeats = input.kind === "fragment" || input.kind === "note";
        const existing = repeats ? undefined : document.bookmarks.find((bookmark) =>
          bookmark.kind === input.kind
          && bookmark.sessionId === input.sessionId
          && bookmark.eventSeq === input.eventSeq
          && (input.kind === "answer" || bookmark.title === input.title));
        if (existing) return { ...existing, ...placement, chat: "open" };
      } else {
        if (await deps.projectName(space, input.projectId!) === undefined) throw notFound("Project not found");
        placement = { projectId: input.projectId! };
      }
      if (document.bookmarks.length >= BOOKMARK_LIMITS.count) {
        throw invalidInput(`You can keep up to ${BOOKMARK_LIMITS.count} bookmarks here`);
      }
      const at = now();
      const bookmark: Bookmark = {
        id: newId(),
        kind: input.kind,
        ...placement,
        title: input.title,
        ...(input.note ? { note: input.note } : {}),
        ...(input.quote ? { quote: input.quote } : {}),
        links: extractBookmarkLinks(`${input.body}\n${input.note ?? ""}`),
        edited: false,
        createdAt: input.createdAt ?? at,
        updatedAt: at,
        revision: 1,
      };
      writeBody(space, bookmark.id, input.body);
      writeDocument(space, { ...document, bookmarks: [...document.bookmarks, bookmark] });
      return { ...bookmark, chat: bookmark.sessionId ? "open" : "none" };
    }),

    update: (space, id, expectedRevision, raw) => serial(space, async () => {
      const patch = parseBookmarkPatch(raw);
      const document = readDocument(space);
      const view = await viewById(space, document, id);
      // Another device saved first: its text is not silently overwritten.
      if (expectedRevision !== view.revision) throw conflict("This bookmark changed on another device");
      const body = patch.body ?? readBody(space, id);
      const note = patch.note ?? view.note ?? "";
      const { chat: _chat, ...current } = view;
      const { note: _note, ...withoutNote } = current;
      const next: Bookmark = {
        ...withoutNote,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(note ? { note } : {}),
        links: extractBookmarkLinks(`${body}\n${note}`),
        edited: view.edited || patch.title !== undefined || patch.body !== undefined,
        updatedAt: now(),
        revision: view.revision + 1,
      };
      if (patch.body !== undefined) writeBody(space, id, patch.body);
      writeDocument(space, {
        ...document,
        bookmarks: document.bookmarks.map((bookmark) => (bookmark.id === id ? next : bookmark)),
      });
      return { ...next, chat: view.chat };
    }),

    remove: (space, id) => serial(space, async () => {
      const document = readDocument(space);
      const view = await viewById(space, document, id);
      const body = readBody(space, id);
      writeDocument(space, { ...document, bookmarks: document.bookmarks.filter((bookmark) => bookmark.id !== id) });
      removeBody(space, id);
      return { removed: view, body };
    }),

    exportMarkdown: (space, scope) => serial(space, async () => {
      if (!scope.projectId) throw invalidInput("Name the project to export");
      const name = await deps.projectName(space, scope.projectId);
      if (name === undefined) throw notFound("Project not found");
      const { bookmarks } = await snapshot(space, scope);
      let bytes = 0;
      const items = bookmarks.map((bookmark) => {
        const body = readBody(space, bookmark.id);
        bytes += Buffer.byteLength(body, "utf8");
        if (bytes > BOOKMARK_LIMITS.exportBytes) throw invalidInput("Too much to export at once; export one chat");
        return { bookmark, body };
      });
      const chatTitle = scope.sessionId ? bookmarks[0]?.chatTitle : undefined;
      const title = chatTitle ? `${name}: ${chatTitle}` : name;
      return { fileName: bookmarkExportFileName(title, now()), markdown: bookmarksMarkdown({ title, items }) };
    }),
  };
}
