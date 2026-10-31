// Mounted composer modes: a package mode entered by its trigger takes the draft
// instead of the session — even while the agent works — and the host's leave
// gestures, chip and session reset behave. Assertions compare strings/booleans.
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
globalThis.matchMedia = () => ({
  matches: false, media: "", onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const { activateProject, activateSession, seedSessionCache, setModels } = await import("../src/store.ts");
const { composerActiveMode, registerComposerMode, requestComposerMode } = await import("../src/composer/contributions.ts");

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("a trigger enters the mode; Enter submits to it and never to the session, even while the agent works", async () => {
  const projectId = "mode-project";
  const sessionId = "mode-session";
  const originalFetch = globalThis.fetch;
  const originalSendMessage = api.sendMessage;
  const originalSaveDraft = api.saveDraft;
  const agentSends: string[] = [];
  api.sendMessage = (async (_id, body) => { agentSends.push(body.text); return { turnId: "t" }; }) as typeof api.sendMessage;
  api.saveDraft = (async () => ({ draftUpdatedAt: 2 })) as typeof api.saveDraft;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return json(url.includes("/queue") || url.includes("/api/files/search") || url.includes("/mention-candidates") ? [] : {});
  }) as typeof fetch;

  const submitted: Array<{ sessionId: string | null; text: string }> = [];
  let available = true;
  const unregister = registerComposerMode({
    id: "side",
    label: "On the side",
    trigger: "/side",
    placeholder: "Ask on the side",
    submitLabel: "Ask",
    isAvailable: (context) => available && context.sessionId !== null,
    submit: (context, text) => { submitted.push({ sessionId: context.sessionId, text }); },
  });

  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  seedSessionCache({
    id: sessionId, projectId, title: "Working chat", status: "working" as const,
    createdAt: 1, updatedAt: 1, draft: "", draftUpdatedAt: 1,
  });
  activateSession(sessionId);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const input = () => host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
  const type = async (value: string) => act(async () => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = async (name: string) => act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  try {
    await act(async () => { root.render(createElement(Composer)); });
    assert.ok(host.querySelector(".composer-mode-chip") === null);

    await type("/side which file?");
    const chip = host.querySelector(".composer-mode-chip");
    assert.ok(chip, "the trigger enters the mode");
    assert.equal(host.querySelector(".composer-mode-chip-label")?.textContent, "On the side");
    assert.equal(input().value, "which file?", "the trigger is removed from the draft");
    assert.equal(input().getAttribute("placeholder"), "Ask on the side");
    assert.ok(host.querySelector(".composer-card.is-composer-mode[data-composer-mode='side']"));
    assert.equal(composerActiveMode(sessionId), "side");
    const modeSend = host.querySelector<HTMLButtonElement>("button.composer-mode-send");
    assert.ok(modeSend, "Send becomes the mode's labelled action");
    assert.equal(modeSend.getAttribute("aria-label"), "Ask");

    await key("Enter");
    assert.deepEqual(submitted, [{ sessionId, text: "which file?" }]);
    assert.deepEqual(agentSends, [], "the session never receives the side question");
    assert.equal(input().value, "", "the draft clears once the mode accepts it");
    assert.ok(host.querySelector(".composer-mode-chip"), "the mode stays on for a follow-up");

    await key("Backspace");
    assert.ok(host.querySelector(".composer-mode-chip") === null, "Backspace in an empty draft leaves");
    assert.equal(composerActiveMode(sessionId), null);

    await type("/side ");
    assert.ok(host.querySelector(".composer-mode-chip"));
    await type("x");
    await key("Escape");
    assert.ok(host.querySelector(".composer-mode-chip"), "Esc with text keeps the mode");
    await type("");
    await key("Escape");
    assert.ok(host.querySelector(".composer-mode-chip") === null, "Esc in an empty draft leaves");

    await act(async () => { assert.equal(requestComposerMode("side", { sessionId }), true); });
    assert.ok(host.querySelector(".composer-mode-chip"), "a package can enter the mode for this chat");
    await act(async () => { host.querySelector<HTMLButtonElement>(".composer-mode-chip-leave")!.click(); });
    assert.ok(host.querySelector(".composer-mode-chip") === null, "× leaves");
    assert.equal(requestComposerMode("side", { sessionId: "another-chat" }), false, "another chat's composer is not this one");

    // Losing availability leaves the mode for good; it does not resume.
    await act(async () => { requestComposerMode("side", { sessionId }); });
    assert.ok(host.querySelector(".composer-mode-chip"));
    const bumpRegistry = async () => act(async () => { registerComposerMode({ id: "zz-bump", label: "bump", submit() {} })(); });
    available = false;
    await bumpRegistry();
    assert.ok(host.querySelector(".composer-mode-chip") === null, "an unavailable mode is left");
    available = true;
    await bumpRegistry();
    assert.ok(host.querySelector(".composer-mode-chip") === null, "and stays off when availability returns");

    available = false;
    await act(async () => { assert.equal(requestComposerMode("side", { sessionId }), false); });
    await type("/side nope");
    assert.ok(host.querySelector(".composer-mode-chip") === null, "an unavailable mode never enters");
    assert.equal(input().value, "/side nope");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    unregister();
    globalThis.fetch = originalFetch;
    api.sendMessage = originalSendMessage;
    api.saveDraft = originalSaveDraft;
  }
});
