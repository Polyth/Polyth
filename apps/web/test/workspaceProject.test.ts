import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });

const {
  activateProject,
  activateSession,
  getState,
  upsertSession,
  workspaceProjectId,
} = await import("../src/store.ts");

const session = (id: string, projectId: string) => ({
  id,
  projectId,
  title: "Chat",
  status: "idle" as const,
  createdAt: 1,
  updatedAt: 1,
});

test("workspace panes follow the open session when client project id is missing", () => {
  assert.equal(workspaceProjectId({
    activeProjectId: null,
    activeSessionId: "s1",
    sessions: [session("s1", "p1")],
  }), "p1");
  assert.equal(workspaceProjectId({
    activeProjectId: "p2",
    activeSessionId: "s1",
    sessions: [session("s1", "p1")],
  }), "p2");
  assert.equal(workspaceProjectId({
    activeProjectId: null,
    activeSessionId: "s1",
    sessions: [session("other", "p1")],
  }), null);
});

test("activating a known session restores its project without dropping the chat", () => {
  upsertSession(session("s-open", "p-open"));
  activateProject(null);
  assert.equal(getState().activeSessionId, null);
  assert.equal(getState().activeProjectId, null);

  activateSession("s-open");
  assert.equal(getState().activeSessionId, "s-open");
  assert.equal(getState().activeProjectId, "p-open");
  assert.equal(workspaceProjectId(getState()), "p-open");
  assert.equal(localStorage.getItem("polyth.activeProjectId"), "p-open");

  activateSession(null);
  activateProject(null);
});

test("a session projection heals a missing project after the chat is already open", () => {
  activateProject(null);
  activateSession("s-late");
  assert.equal(getState().activeSessionId, "s-late");
  assert.equal(getState().activeProjectId, null);

  upsertSession(session("s-late", "p-late"));
  assert.equal(getState().activeSessionId, "s-late");
  assert.equal(getState().activeProjectId, "p-late");

  activateSession(null);
  activateProject(null);
});
