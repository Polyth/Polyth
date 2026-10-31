// A page reload must bring back the unsent new-chat prompt.
//
// Boot activates the restored project before it restores that project's
// unsent chat (init.ts restoreSelectionAfterReady), so the Composer first
// mounts with no new-chat intent and an empty input. Seeding that empty input
// is a restore, not an edit: if it reached onTextChange it was persisted as
// the new chat's text and replaced the saved prompt before the boot restore
// could read it.
//
// Mounts the real Composer, like composerIsolationDraft.test.ts.
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
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { matchMedia: typeof globalThis.matchMedia }).matchMedia = () => ({
  matches: false,
  media: "",
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
});
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const {
  activateProject,
  applyProjectUpsert,
  getState,
  hydrateNewSessionDraft,
  saveNewSessionDraftText,
  setModels,
  startNewSession,
} = await import("../src/store.ts");
const { loadScopedDraftRecord } = await import("../src/draftRecord.ts");

const settle = () => act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });

test("a reload restores the unsent new-chat prompt instead of saving the empty boot input over it", async () => {
  const projectId = "reload-new-chat-project";
  applyProjectUpsert({ id: projectId, path: `/projects/${projectId}`, name: projectId, createdAt: 0 });
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);

  // Before the reload: the prompt typed into the new chat is in its record.
  activateProject(projectId);
  startNewSession(projectId, { draft: "" });
  saveNewSessionDraftText(projectId, "unsent new chat prompt");
  assert.equal(loadScopedDraftRecord(null).text, "unsent new chat prompt");

  // After the reload: the project is active, its unsent chat not restored yet.
  activateProject(null);
  activateProject(projectId);
  assert.equal(getState().newSessionIntent, null);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Composer)); });
    await settle();
    const input = () => {
      const found = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
      assert.ok(found, "the new-chat composer renders its input");
      return found;
    };

    assert.equal(
      loadScopedDraftRecord(null).text,
      "unsent new chat prompt",
      "mounting the composer does not persist its empty input as the new chat's text",
    );

    // The boot restore (restoreSelectionAfterReady) then finds the prompt.
    const restored = await hydrateNewSessionDraft(projectId);
    assert.equal(restored?.draft, "unsent new chat prompt");
    await act(async () => { startNewSession(projectId, restored!); });
    await settle();
    assert.equal(input().value, "unsent new chat prompt", "the restored prompt is back in the input");
    assert.equal(loadScopedDraftRecord(null).text, "unsent new chat prompt");

    // Typing afterwards is still saved as the new chat's text.
    await act(async () => {
      input().value = "unsent new chat prompt, edited";
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(loadScopedDraftRecord(null).text, "unsent new chat prompt, edited");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
