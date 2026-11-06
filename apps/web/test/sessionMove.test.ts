// Moving a chat to another project: what is offered, what the confirmation
// says, the row's drag payload and the open chat's workspace following it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionMovePreview, SessionProjection } from "@polyth/contracts";

const mem = new Map<string, string>();
const memStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as { sessionStorage?: unknown }).sessionStorage = memStorage;
(globalThis as { localStorage?: unknown }).localStorage = memStorage;

const { canMoveSession, sessionMoveMessage, sessionMoveTargets } = await import("../src/sessionMove.ts");
const { getDragSessionMove, hasDragSession, SESSION_MIME, SESSION_MOVE_MIME, setDragSessionMove } = await import("../src/dnd.ts");
const store = await import("../src/store.ts");
const { emptyModel, reduceEvent } = await import("../src/reduce.ts");

const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, path: `/work/${id}`, name: id.toUpperCase(), createdAt: 1, ...extra });
const projects = [
  project("one"),
  project("two"),
  project("room", { parentProjectId: "one" }),
  project("remote", { remote: { kind: "ssh", connectionId: "c" } as Project["remote"] }),
];
const session = (extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id: "s1", projectId: "one", title: "Chat", status: "idle", createdAt: 1, updatedAt: 1, ...extra,
});
const sharing = (access: "view" | "collaborate" | "manage", inherited?: boolean) =>
  ({ visibility: "private", access, shared: false, ...(inherited === undefined ? {} : { inherited }) }) as SessionProjection["sharing"];

test("the targets are other projects on this machine, never a room", () => {
  assert.deepEqual(sessionMoveTargets(session(), projects).map((row) => row.id), ["two"]);
  assert.deepEqual(sessionMoveTargets(session({ projectId: "two" }), projects).map((row) => row.id), ["one"]);
});

test("a move is offered only where the server would allow one", () => {
  assert.equal(canMoveSession(session(), projects), true);
  assert.equal(canMoveSession(session({ sharing: sharing("manage") }), projects), true);
  const refused: Array<[string, SessionProjection]> = [
    ["someone else's chat", session({ sharing: sharing("collaborate") })],
    ["archived", session({ status: "archived" })],
    ["package-owned", session({ purpose: "conversation" })],
    ["started by an automation", session({ origin: { kind: "schedule" } as unknown as SessionProjection["origin"] })],
    ["a subagent", session({ parentId: "p", sharing: sharing("manage", true) })],
    ["a child with no sharing view to tell it from a fork", session({ parentId: "p" })],
    ["isolated, seen in full", session({ isolation: { kind: "git-worktree" } as SessionProjection["isolation"] })],
    ["isolated, seen as a summary", session({ isolationSummary: "git-worktree" })],
    ["in a private room", session({ projectId: "room" })],
    ["on another machine", session({ projectId: "remote" })],
    ["in a project the client doesn't know", session({ projectId: "gone" })],
  ];
  for (const [name, row] of refused) assert.equal(canMoveSession(row, projects), false, name);
  assert.equal(canMoveSession(session(), [project("one")]), false, "nowhere to go");
  assert.equal(canMoveSession(session({ parentId: "p", sharing: sharing("manage", false) }), projects), true, "a fork is its own chat");
});

const preview = (extra: Partial<SessionMovePreview> = {}): SessionMovePreview => ({
  sessionId: "s1", fromProjectId: "one", toProjectId: "two", sessionIds: ["s1"], restartsAgent: true, gains: [], loses: [], ...extra,
});

test("the confirmation says what can't be seen from the navigator", () => {
  const plain = sessionMoveMessage("Chat", "ONE", "TWO", preview());
  assert.match(plain, /Chat/);
  assert.match(plain, /Files stay in ONE/);
  assert.match(plain, /carries on in the folder of TWO/);
  assert.equal(/subagent|open it/i.test(plain), false, "no line about what doesn't apply");

  assert.match(sessionMoveMessage("C", "A", "B", preview({ sessionIds: ["s1", "c1"] })), /Its subagent moves too/);
  assert.match(sessionMoveMessage("C", "A", "B", preview({ sessionIds: ["s1", "c1", "c2", "c3"] })), /Its 3 subagents move too/);

  const atRest = sessionMoveMessage("C", "A", "B", preview({ restartsAgent: false }));
  assert.match(atRest, /Files stay in A/);
  assert.equal(atRest.includes("carries on"), false);

  const people = sessionMoveMessage("C", "A", "B", preview({
    gains: [{ userId: "u1", name: "Olena" }, { userId: "u2", name: "Bo" }],
    loses: [{ userId: "u3", name: "Max" }],
  }));
  assert.match(people, /Olena, Bo will be able to open it/);
  assert.match(people, /Max will no longer be able to open it/);
});

test("the row's move payload is its own type, so the split view doesn't take it", () => {
  const data = new Map<string, string>();
  const transfer = { setData: (type: string, value: string) => void data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
  setDragSessionMove(transfer, "s1");
  assert.deepEqual([...data.keys()], [SESSION_MOVE_MIME]);
  assert.equal(getDragSessionMove(transfer), "s1");
  assert.equal(hasDragSession({ types: [...data.keys()] }), false, "the open chat can move, not open beside itself");
  assert.notEqual(SESSION_MIME, SESSION_MOVE_MIME);
});

test("drag data is untrusted: only an id-shaped value names a chat", () => {
  for (const bad of ["", "  ", "../../etc/passwd", "a b", "x".repeat(129), "<img>"]) {
    assert.equal(getDragSessionMove({ getData: () => bad }), null, JSON.stringify(bad));
  }
});

test("the workspace follows the open chat to its new project, and nothing else moves it", () => {
  store.applyProjectAdded(projects[0]!);
  store.setSessions("one", [session(), session({ id: "s2" })]);
  store.activateSession("s1");
  assert.equal(store.getState().activeProjectId, "one");

  store.upsertSession(session({ id: "s2", projectId: "two" }));
  assert.equal(store.getState().activeProjectId, "one", "another chat moving moves nothing");

  store.upsertSession(session({ projectId: "two" }));
  assert.equal(store.getState().activeProjectId, "two");
  assert.equal(store.getState().activeSessionId, "s1", "the chat stays open");

  store.upsertSessions([session({ projectId: "one" })]);
  assert.equal(store.getState().activeProjectId, "one", "a batched projection frame follows too");

  // The person has already gone elsewhere: a late frame must not pull them back.
  store.activateProject("two");
  store.upsertSession(session({ projectId: "one" }));
  assert.equal(store.getState().activeProjectId, "two");
});

test("the marker renders as a notice, with names from the log", () => {
  const event = (data: Record<string, unknown>) => ({
    id: "e1", sessionId: "s1", seq: 1, time: 5, type: "session/project-moved", data, ignorable: true,
  }) as Parameters<typeof reduceEvent>[1];
  const named = reduceEvent(emptyModel(), event({ fromProjectName: "ONE", toProjectName: "TWO" }));
  assert.deepEqual(named.messages.map((row) => row.kind === "notice" && [row.topic, row.fromProject, row.toProject]), [["project-moved", "ONE", "TWO"]]);
  // A project with no name still gets a truthful line.
  const unnamed = reduceEvent(emptyModel(), event({}));
  assert.deepEqual(unnamed.messages.map((row) => row.kind === "notice" && [row.topic, row.fromProject]), [["project-moved", undefined]]);
});
