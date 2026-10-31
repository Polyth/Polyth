// Work in isolation: the dialog closes at once, the project's spawn surface
// shows progress, the create request is sent once, and a failure returns to
// the previous chat with a notice.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  location: dom.location,
  history: dom.history,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { launchIsolatedSession } = await import("../src/isolatedSessionLaunch.ts");
const store = await import("../src/store.ts");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function seedChat(id: string, projectId: string): void {
  store.seedSessionCache({ id, projectId, title: "Source", status: "idle", createdAt: 1, updatedAt: 1 });
  store.activateProject(projectId);
  store.activateSession(id);
  store.openWorktreeSessionDialog(projectId);
}

test("the dialog closes and the spawn surface shows before the worktree exists", async () => {
  seedChat("iso-source", "iso-p");
  const reply = deferred<string>();
  const calls: Array<{ projectId: string; activate?: (id: string) => boolean }> = [];
  const launching = launchIsolatedSession(
    { projectId: "iso-p", options: { targetBranch: "main", sourceSessionId: "iso-source" } },
    (projectId, options) => {
      calls.push({ projectId, ...(options?.activate ? { activate: options.activate } : {}) });
      return reply.promise;
    },
  );
  const state = store.getState();
  assert.equal(state.overlay, null, "the dialog is gone at once");
  assert.equal(state.activeProjectId, "iso-p");
  assert.equal(state.activeSessionId, null);
  assert.equal(store.isActiveSessionSpawning(state), true, "the project's spawn surface shows progress");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.activate?.("iso-new"), true, "the new chat takes focus while the person waits");
  reply.resolve("iso-new");
  assert.equal(await launching, "iso-new");
  assert.equal(store.getState().sessionSpawn, null);
});

test("a refused create returns to the previous chat, reports, and is not resent", async () => {
  seedChat("iso-back", "iso-q");
  const reply = deferred<string>();
  let calls = 0;
  const launching = launchIsolatedSession(
    { projectId: "iso-q", options: { targetBranch: "main" } },
    () => { calls += 1; return reply.promise; },
  );
  assert.equal(store.getState().activeSessionId, null);
  reply.reject(Object.assign(new Error("branch is busy"), { code: "conflict", status: 409 }));
  assert.equal(await launching, null);
  const state = store.getState();
  assert.equal(calls, 1);
  assert.equal(state.activeSessionId, "iso-back", "the chat the person left comes back");
  assert.equal(state.sessionSpawn, null);
  assert.match(state.uiError ?? "", /branch is busy/);
  assert.ok(state.uiErrorAction, "a known refusal offers to reopen the dialog");
  await state.uiErrorAction!.run();
  assert.equal(store.getState().overlay, "worktree-session");
  store.setOverlay(null);
});

test("a person who moved elsewhere keeps their place, and an uncertain outcome offers no retry", async () => {
  seedChat("iso-stay", "iso-r");
  store.seedSessionCache({ id: "iso-other", projectId: "iso-r", title: "Other", status: "idle", createdAt: 1, updatedAt: 1 });
  const reply = deferred<string>();
  let activate: ((id: string) => boolean) | undefined;
  const launching = launchIsolatedSession(
    { projectId: "iso-r", options: { targetBranch: "main" } },
    (_projectId, options) => { activate = options?.activate; return reply.promise; },
  );
  store.activateSession("iso-other");
  assert.equal(activate?.("iso-late"), false, "a late chat is listed, not pulled into view");
  reply.reject(Object.assign(new Error("lost"), { code: "outcome-unknown" }));
  assert.equal(await launching, null);
  const state = store.getState();
  assert.equal(state.activeSessionId, "iso-other");
  assert.equal(state.uiErrorAction, null, "an uncertain create may exist; no reopen offer");
});
