// A people-first conversation composer has no agent mode at all: no People /
// Agent toggle, model/effort/context row, carry toggle, shell or stop control,
// and Send posts a person message instead of an agent turn.
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
const { activateProject, activateSession, seedSessionCache } = await import("../src/store.ts");

test("conversation composer sends a person message and offers no agent controls", async () => {
  const projectId = "conversation-project";
  const sessionId = "conversation-session";
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  const originalSendMessage = api.sendMessage;
  const originalSaveDraft = api.saveDraft;
  const agentSends: string[] = [];
  api.sendMessage = (async (_id, body) => { agentSends.push(body.text); return { turnId: "t" }; }) as typeof api.sendMessage;
  api.saveDraft = (async () => ({ draftUpdatedAt: 2 })) as typeof api.saveDraft;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, method, body });
    const payload = url.includes("/person-messages")
      ? { seq: 9, mentions: [] }
      : url.includes("/mention-candidates")
        ? { items: [] }
        : url.includes("/queue") || url.includes("/api/files/search")
          ? []
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "Team room", status: "idle" as const,
    purpose: "conversation",
    createdAt: 1, updatedAt: 1, draft: "", draftUpdatedAt: 1,
    sharing: { access: "collaborate", shared: true } as never,
  });
  activateSession(sessionId);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Composer)); });
    assert.equal(host.querySelector(".composer-people-toggle"), null, "no People / Agent toggle");
    assert.equal(host.querySelector(".composer-config-row"), null, "no model/effort/context row");
    assert.equal(host.querySelector(".composer-people-carry"), null, "no carry toggle");
    assert.equal(host.querySelector(".composer-stop-primary"), null, "no stop control");
    const send = host.querySelector<HTMLButtonElement>("button.composer-people-send");
    assert.ok(send, "the people send action is present");
    assert.equal(send.getAttribute("aria-label"), "Send");

    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(input);
    await act(async () => {
      input.value = "Hello room";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      send.click();
      await new Promise((resolve) => setImmediate(resolve));
    });
    const personPosts = requests.filter((request) => request.url.includes("/person-messages"));
    assert.equal(personPosts.length, 1, "exactly one person-messages POST");
    assert.match(personPosts[0]!.body ?? "", /Hello room/);
    assert.deepEqual(agentSends, [], "no agent message was sent");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
    api.sendMessage = originalSendMessage;
    api.saveDraft = originalSaveDraft;
  }
});
