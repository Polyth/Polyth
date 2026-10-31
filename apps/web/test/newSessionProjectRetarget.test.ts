import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

test("picking another project for an unsent chat moves the draft without opening a session", async () => {
  const dom = new Window({ url: "http://localhost:3000/" });
  Object.assign(globalThis, {
    window: dom as unknown as typeof globalThis & Window,
    document: dom.document as unknown as Document,
  });
  Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
  Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
    configurable: true,
  });

  const store = await import("../src/store.ts");
  const { addAttachment, pendingAttachments } = await import("../src/attachments.ts");
  const { loadScopedDraftRecord } = await import("../src/draftRecord.ts");
  const { getWorkbenchProfileSession } = await import("../src/workbench/store.ts");
  await import("../src/workbench/profileNavigation.ts");

  const row = (id: string, projectId: string) => ({
    id, projectId, title: id, status: "idle" as const, createdAt: 1, updatedAt: 1,
  });
  // The target project remembers an ordinary chat that a project switch restores.
  store.activateProject("p-target");
  store.setSessions("p-target", [row("t1", "p-target")]);
  store.activateSession("t1");
  assert.equal(getWorkbenchProfileSession("conversation"), "t1");

  store.activateProject("p-source");
  store.startNewSession("p-source", { draft: "hello" });
  addAttachment(null, { id: "link", name: "docs", mime: "text/uri-list", size: 0, kind: "url", url: "https://example.com" });
  addAttachment(null, { id: "file", name: "a.ts", mime: "text/plain", size: 1, kind: "file", path: "src/a.ts" });

  store.moveNewSessionDraftToProject("p-target", "hello world");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = store.getState();
  assert.equal(state.activeProjectId, "p-target");
  assert.equal(state.activeSessionId, null, "no session opens");
  assert.equal(state.openingSessionId, null, "no session starts loading");
  assert.equal(state.newSessionIntent?.projectId, "p-target");
  assert.equal(state.newSessionIntent?.draft, "hello world", "the live text moves, not the stale seed");
  assert.equal(loadScopedDraftRecord(null).text, "hello world");
  assert.deepEqual(pendingAttachments(null).map((ref) => ref.id), ["link"], "only project-independent attachments move");

  // Repository files stay with the project whose paths they name.
  store.startNewSession("p-source");
  assert.equal(loadScopedDraftRecord(null).text, "");
  assert.deepEqual(pendingAttachments(null).map((ref) => ref.id), ["file"]);
});
