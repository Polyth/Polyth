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
  beginProjectListRequest,
  getState,
  publishProjectList,
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

test("workspace panes keep project scope during new-chat and first-send transitions", () => {
  assert.equal(workspaceProjectId({
    activeProjectId: null,
    activeSessionId: null,
    sessions: [],
    newSessionIntent: { projectId: "p-new", draft: "" },
  }), "p-new");
  assert.equal(workspaceProjectId({
    activeProjectId: null,
    activeSessionId: null,
    sessions: [],
    sessionSpawn: { requestId: 1, projectId: "p-spawn", sessionId: null },
  }), "p-spawn");
});

test("ready registry restores the project from the route before async navigation hydration", () => {
  activateSession(null);
  activateProject(null);
  localStorage.removeItem("polyth.activeProjectId");
  dom.history.replaceState({}, "", "/p/p-route");

  const ticket = beginProjectListRequest();
  assert.equal(publishProjectList(ticket, [
    { id: "p-first", path: "/work/p-first", name: "First", createdAt: 1 },
    { id: "p-route", path: "/work/p-route", name: "Route", createdAt: 2 },
  ]), "published");

  assert.equal(workspaceProjectId(getState()), "p-route");
  assert.equal(getState().activeProjectId, "p-route");

  dom.history.replaceState({}, "", "/");
  activateProject(null);
});

test("ready registry never leaves workspace panes project-less when projects exist", () => {
  activateSession(null);
  activateProject(null);
  localStorage.removeItem("polyth.activeProjectId");
  dom.history.replaceState({}, "", "/");

  const ticket = beginProjectListRequest();
  assert.equal(publishProjectList(ticket, [
    { id: "p-first", path: "/work/p-first", name: "First", createdAt: 1 },
    { id: "p-second", path: "/work/p-second", name: "Second", createdAt: 2 },
  ]), "published");

  assert.equal(workspaceProjectId(getState()), "p-first");
  assert.equal(getState().activeProjectId, "p-first");

  activateProject(null);
});

test("ready project hydration restores the persisted project synchronously", () => {
  activateSession(null);
  activateProject(null);
  localStorage.setItem("polyth.activeProjectId", "p-restored");

  const ticket = beginProjectListRequest();
  assert.equal(publishProjectList(ticket, [{
    id: "p-restored",
    path: "/work/p-restored",
    name: "Restored",
    createdAt: 1,
  }]), "published");

  assert.equal(workspaceProjectId(getState()), "p-restored");
  assert.equal(getState().activeProjectId, "p-restored");

  activateProject(null);
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

test("a malformed live projection cannot detach a known session from its project", () => {
  activateSession(null);
  activateProject(null);
  upsertSession(session("s-owned", "p-owned"));
  activateSession("s-owned");

  upsertSession({
    ...session("s-owned", ""),
    title: "Updated title",
    updatedAt: 2,
  });

  const current = getState().sessions.find((item) => item.id === "s-owned");
  assert.equal(current?.projectId, "p-owned");
  assert.equal(workspaceProjectId(getState()), "p-owned");

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
