import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test, type TestContext } from "node:test";
import type { RouteRequest, SessionProjection, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage, { BOOKMARKS_REMOTE_ACCESS } from "../src/serverEntry.ts";
import type { BookmarkView } from "../src/bookmarks.ts";

const ctx = (spaceId: string, userId: string, role: SpaceContext["role"] = "member") =>
  ({ spaceId, userId, role, spaceSlug: spaceId, storageDir: "" }) as unknown as SpaceContext;

const projection = (id: string, spaceId: string, title: string, extra: Partial<SessionProjection> = {}): SessionProjection =>
  ({ id, projectId: `${spaceId}-project`, spaceId, title, status: "idle", createdAt: 1, updatedAt: 1, ...extra }) as SessionProjection;

interface Reply {
  status: number;
  body: {
    bookmark: BookmarkView;
    bookmarks: BookmarkView[];
    removed: BookmarkView;
    body: string;
    fileName: string;
    markdown: string;
    error?: string;
    revision: number;
  };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bookmarks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projections = new Map<string, SessionProjection>([
    ["mine", projection("mine", "space", "Backups")],
    ["second", projection("second", "space", "Docs")],
    ["shared", projection("shared", "space", "Bob's chat", { sharing: { visibility: "space", access: "read", owner: { userId: "bob" }, shared: true } } as never)],
    ["foreign", projection("foreign", "other", "Someone else's")],
  ]);
  const closedTo = new Set<string>();
  const canOpen = (space: SpaceContext, id: string) => {
    const row = projections.get(id);
    return Boolean(row && row.spaceId === space.spaceId && !closedTo.has(`${space.userId}:${id}`));
  };
  const host = {
    people: {
      storage: (userId: string, packageId: string) => {
        const base = resolve(root, "people", userId, "packages", packageId);
        mkdirSync(base, { recursive: true });
        return {
          root: base,
          path: (relative: string) => {
            const target = resolve(base, relative);
            if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("escape");
            return target;
          },
        };
      },
    },
    forSpace: (space: SpaceContext) => ({
      sessions: {
        snapshot: async (id: string) => {
          if (!canOpen(space, id)) throw Object.assign(new Error("session not found"), { code: "not-found" });
          return { ...projections.get(id)! };
        },
      },
      projects: {
        get: async (id: string) => (id === `${space.spaceId}-project` ? { id, name: "Project One" } : undefined),
      },
    }),
    store: { projection: async (id: string) => projections.get(id) },
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  const call = async (space: SpaceContext, method: string, path: string, body: Record<string, unknown> = {}): Promise<Reply> => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://localhost${path}`);
    const handled = await pkg.routes!({
      method,
      path: url.pathname,
      url,
      space,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest);
    assert.equal(handled, true);
    return { status, body: payload as Reply["body"] };
  };
  const stored = (userId: string, spaceId: string, ...parts: string[]) =>
    join(root, "people", userId, "packages", "bookmarks", "spaces", spaceId, ...parts);
  return { call, projections, closedTo, stored };
}

const alice = ctx("space", "alice");
const bob = ctx("space", "bob");
const save = (sessionId: string, eventSeq: number, body: string, kind = "answer") => ({ kind, sessionId, eventSeq, body });
const LIST = "/api/bookmarks?projectId=space-project";

test("a saved answer keeps its text and links and takes its place from the chat", async (t) => {
  const { call, stored } = fixture(t);
  const created = await call(alice, "POST", "/api/bookmarks", {
    ...save("mine", 7, "## Що обрати\n[restic](https://restic.net)"),
    projectId: "someone-elses-project",
  });
  assert.equal(created.status, 200);
  const bookmark = created.body.bookmark;
  assert.equal(bookmark.projectId, "space-project", "the chat names the project, not the browser");
  assert.equal(bookmark.title, "Що обрати");
  assert.equal(bookmark.chatTitle, "Backups");
  assert.equal(bookmark.chat, "open");
  assert.deepEqual(bookmark.links, [{ url: "https://restic.net/", label: "restic" }]);

  const list = await call(alice, "GET", LIST);
  assert.deepEqual(list.body.bookmarks.map((entry) => entry.id), [bookmark.id]);
  assert.equal(JSON.stringify(list.body).includes("Що обрати\n"), false, "the list carries no saved text");

  const body = await call(alice, "GET", `/api/bookmarks/body?id=${bookmark.id}`);
  assert.equal(body.body.body, "## Що обрати\n[restic](https://restic.net)");
  assert.equal(existsSync(stored("alice", "space", "bodies", `${bookmark.id}.md`)), true);
});

test("one answer is one bookmark whichever device saved it; fragments may repeat", async (t) => {
  const { call } = fixture(t);
  const first = await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Text"));
  const again = await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Text"));
  assert.equal(again.body.bookmark.id, first.body.bookmark.id);
  await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Part", "fragment"));
  await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Part", "fragment"));
  assert.equal((await call(alice, "GET", LIST)).body.bookmarks.length, 3);
});

test("bookmarks are personal: another member never sees or reaches them", async (t) => {
  const { call, stored } = fixture(t);
  const { bookmark } = (await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Private text"))).body;
  assert.deepEqual((await call(bob, "GET", LIST)).body.bookmarks, []);
  assert.equal((await call(bob, "GET", `/api/bookmarks/body?id=${bookmark.id}`)).status, 404);
  assert.equal((await call(bob, "POST", "/api/bookmarks/delete", { id: bookmark.id })).status, 404);
  assert.equal(existsSync(stored("bob", "space", "bodies", `${bookmark.id}.md`)), false);
  assert.equal(existsSync(stored("alice", "space", "bodies", `${bookmark.id}.md`)), true);
});

test("a known-valid chat of another Space gets the same answer as an absent one", async (t) => {
  const { call } = fixture(t);
  const foreign = await call(alice, "POST", "/api/bookmarks", save("foreign", 1, "Probe"));
  const absent = await call(alice, "POST", "/api/bookmarks", save("no-such-chat", 1, "Probe"));
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign, absent);
  const note = await call(alice, "POST", "/api/bookmarks", { kind: "note", projectId: "other-project", note: "x" });
  assert.equal(note.status, 404);
});

test("the same person keeps separate bookmarks in each Space", async (t) => {
  const { call, projections } = fixture(t);
  await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Here"));
  projections.set("there", projection("there", "other", "There"));
  const elsewhere = ctx("other", "alice");
  assert.deepEqual((await call(elsewhere, "GET", "/api/bookmarks?projectId=other-project")).body.bookmarks, []);
  assert.deepEqual((await call(elsewhere, "GET", "/api/bookmarks")).body.bookmarks, []);
});

test("a bookmark of the person's own deleted chat stays, without a place to go", async (t) => {
  const { call, projections } = fixture(t);
  const { bookmark } = (await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Keep this"))).body;
  projections.delete("mine");
  const list = await call(alice, "GET", LIST);
  assert.equal(list.body.bookmarks[0]!.id, bookmark.id);
  assert.equal(list.body.bookmarks[0]!.chat, "deleted");
  assert.equal(list.body.bookmarks[0]!.chatTitle, "Backups");
  assert.equal((await call(alice, "GET", `/api/bookmarks/body?id=${bookmark.id}`)).body.body, "Keep this");
});

test("a bookmark of someone else's chat goes with the chat and hides without access", async (t) => {
  const { call, projections, closedTo, stored } = fixture(t);
  const { bookmark } = (await call(alice, "POST", "/api/bookmarks", save("shared", 3, "Bob's words"))).body;
  assert.equal(bookmark.ownChat, false);

  closedTo.add("alice:shared");
  assert.deepEqual((await call(alice, "GET", LIST)).body.bookmarks, [], "hidden while access is withdrawn");
  assert.equal((await call(alice, "GET", `/api/bookmarks/body?id=${bookmark.id}`)).status, 404);
  closedTo.delete("alice:shared");
  assert.equal((await call(alice, "GET", LIST)).body.bookmarks.length, 1, "back with access");

  projections.delete("shared");
  assert.deepEqual((await call(alice, "GET", LIST)).body.bookmarks, []);
  assert.equal(existsSync(stored("alice", "space", "bodies", `${bookmark.id}.md`)), false, "the copy is erased");
});

test("an edit from a stale device is refused, not silently merged", async (t) => {
  const { call } = fixture(t);
  const { bookmark } = (await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Original https://a.example"))).body;
  const edited = await call(alice, "POST", "/api/bookmarks/update", {
    id: bookmark.id, revision: bookmark.revision, body: "Edited https://b.example", note: "Mine", title: "Renamed",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.bookmark.edited, true);
  assert.equal(edited.body.bookmark.revision, 2);
  assert.equal(edited.body.bookmark.title, "Renamed");
  assert.deepEqual(edited.body.bookmark.links.map((link) => link.url), ["https://b.example/"]);

  const stale = await call(alice, "POST", "/api/bookmarks/update", { id: bookmark.id, revision: 1, body: "Other" });
  assert.equal(stale.status, 409);
  assert.equal((await call(alice, "GET", `/api/bookmarks/body?id=${bookmark.id}`)).body.body, "Edited https://b.example");

  const cleared = await call(alice, "POST", "/api/bookmarks/update", { id: bookmark.id, revision: 2, note: "" });
  assert.equal(cleared.body.bookmark.note, undefined);
  assert.equal(cleared.body.bookmark.edited, true);
});

test("removing returns what is needed to undo it", async (t) => {
  const { call } = fixture(t);
  const { bookmark } = (await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Text"))).body;
  const removed = await call(alice, "POST", "/api/bookmarks/delete", { id: bookmark.id });
  assert.equal(removed.body.body, "Text");
  assert.deepEqual((await call(alice, "GET", LIST)).body.bookmarks, []);
  const restored = await call(alice, "POST", "/api/bookmarks", {
    kind: removed.body.removed.kind,
    sessionId: removed.body.removed.sessionId,
    eventSeq: removed.body.removed.eventSeq,
    title: removed.body.removed.title,
    createdAt: removed.body.removed.createdAt,
    body: removed.body.body,
  });
  assert.equal(restored.body.bookmark.createdAt, bookmark.createdAt);
});

test("a note can stay in one chat's list, after its messages, and has no place to go", async (t) => {
  const { call, projections } = fixture(t);
  const note = await call(alice, "POST", "/api/bookmarks", { kind: "note", sessionId: "mine", title: "Idea", body: "Text" });
  assert.equal(note.status, 200);
  assert.equal(note.body.bookmark.sessionId, "mine");
  assert.equal(note.body.bookmark.eventSeq, undefined);
  assert.equal(note.body.bookmark.projectId, "space-project");
  await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Answer"));
  const list = await call(alice, "GET", `${LIST}&sessionId=mine`);
  assert.deepEqual(list.body.bookmarks.map((entry) => entry.kind), ["answer", "note"]);
  // Two notes are two notes, and the stored note survives a reload.
  await call(alice, "POST", "/api/bookmarks", { kind: "note", sessionId: "mine", title: "Idea", body: "Text" });
  assert.equal((await call(alice, "GET", `${LIST}&sessionId=mine`)).body.bookmarks.length, 3);
  projections.delete("mine");
  const kept = await call(alice, "GET", LIST);
  assert.ok(kept.body.bookmarks.every((entry) => entry.chat === "deleted"), "the person's own chat keeps its notes");
});

test("a note in another Space's chat gets the same answer as a chat that does not exist", async (t) => {
  const { call } = fixture(t);
  const foreign = await call(alice, "POST", "/api/bookmarks", { kind: "note", sessionId: "foreign", title: "Probe", body: "Text" });
  const absent = await call(alice, "POST", "/api/bookmarks", { kind: "note", sessionId: "no-such-chat", title: "Probe", body: "Text" });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign, absent);
  assert.deepEqual((await call(alice, "GET", LIST)).body.bookmarks, []);
});

test("free notes need a project the person can open", async (t) => {
  const { call } = fixture(t);
  const note = await call(alice, "POST", "/api/bookmarks", { kind: "note", projectId: "space-project", title: "Idea", body: "Text" });
  assert.equal(note.body.bookmark.chat, "none");
  assert.equal(note.body.bookmark.sessionId, undefined);
  assert.equal((await call(alice, "GET", `${LIST}&sessionId=mine`)).body.bookmarks.length, 0);
  assert.equal((await call(alice, "GET", LIST)).body.bookmarks.length, 1);
});

test("export is one Markdown file for a chat or a project and never reads another's", async (t) => {
  const { call } = fixture(t);
  await call(alice, "POST", "/api/bookmarks", save("mine", 2, "First text"));
  await call(alice, "POST", "/api/bookmarks", save("second", 3, "Second text"));
  const chat = await call(alice, "GET", "/api/bookmarks/export?projectId=space-project&sessionId=mine");
  assert.match(chat.body.fileName, /^bookmarks-project-one-backups-\d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(chat.body.markdown.includes("First text"));
  assert.equal(chat.body.markdown.includes("Second text"), false);
  const project = await call(alice, "GET", "/api/bookmarks/export?projectId=space-project");
  assert.ok(project.body.markdown.includes("Second text"));
  assert.equal((await call(bob, "GET", "/api/bookmarks/export?projectId=space-project")).body.markdown.includes("text"), false);
  assert.equal((await call(alice, "GET", "/api/bookmarks/export?projectId=other-project")).status, 404);
});

test("ids and paths cannot leave the person's folder", async (t) => {
  const { call, stored } = fixture(t);
  await call(alice, "POST", "/api/bookmarks", save("mine", 7, "Text"));
  for (const id of ["../index", "..%2findex", "a/b", ".", ""]) {
    assert.equal((await call(alice, "GET", `/api/bookmarks/body?id=${encodeURIComponent(id)}`)).status, 404, id);
  }
  assert.ok(readFileSync(stored("alice", "space", "index.json"), "utf8").includes("\"revision\""));
});

test("system work has no bookmarks", async (t) => {
  const { call } = fixture(t);
  assert.equal((await call(ctx("space", "system:polyth-runtime"), "GET", LIST)).status, 403);
  const authority = { ...ctx("space", "alice"), authority: { kind: "system" } } as unknown as SpaceContext;
  assert.equal((await call(authority, "POST", "/api/bookmarks", save("mine", 1, "x"))).status, 403);
});

test("remote access: reads need the read grant, every change the control grant", () => {
  const rules = BOOKMARKS_REMOTE_ACCESS.http;
  assert.ok(rules.every((rule) => rule.path.startsWith("/api/bookmarks")));
  assert.ok(rules.filter((rule) => rule.methods.includes("GET")).every((rule) => rule.mutation === false));
  assert.ok(rules.filter((rule) => rule.methods.includes("POST")).every((rule) => rule.mutation === true && (rule.maxBodyBytes ?? 0) > 512 * 1024));
});
