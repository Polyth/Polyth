// Mounted people-mode send: picking a person from the @ picker sends through
// POST /person-messages and never through the agent message route. Assertions
// compare strings/booleans only.
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

test("picking a person sends a person message and never an agent turn", async () => {
  const projectId = "people-project";
  const sessionId = "people-session";
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
    if (url.includes("/mention-candidates")) {
      return new Response(JSON.stringify({ items: [{ userId: "u-alice", name: "Alice", access: "collaborate" }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/person-messages")) {
      return new Response(JSON.stringify({ seq: 9, mentions: ["u-alice"] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/queue")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/files/search")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  seedSessionCache({
    id: sessionId, projectId, title: "People chat", status: "idle" as const,
    createdAt: 1, updatedAt: 1, draft: "", draftUpdatedAt: 1,
    sharing: { access: "collaborate", shared: true } as never,
  });
  activateSession(sessionId);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Composer)); });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(input);
    await act(async () => {
      input.value = "@";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const personOption = await (async () => {
      for (let i = 0; i < 20 && !host.querySelector('.ac-item[data-kind="person"]'); i += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      }
      return host.querySelector<HTMLElement>('.ac-item[data-kind="person"]');
    })();
    assert.ok(personOption, "the People group renders for the @ token");
    await act(async () => {
      personOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    const send = host.querySelector<HTMLButtonElement>("button.composer-people-send");
    assert.ok(send, "the composer switches to people mode and shows the people send button");
    await act(async () => {
      send.click();
      await new Promise((resolve) => setImmediate(resolve));
    });
    const personPosts = requests.filter((request) => request.url.includes("/person-messages"));
    assert.equal(personPosts.length, 1, "exactly one person-messages POST");
    assert.match(personPosts[0]!.body ?? "", /u-alice/);
    assert.deepEqual(agentSends, [], "no agent message was sent");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
    api.sendMessage = originalSendMessage;
    api.saveDraft = originalSaveDraft;
  }
});

// A private chat has no mention candidates; the empty @ list explains why and
// offers sharing only when the Space has someone to share with.
async function privateHintFor(sessionId: string, spacePeople: number): Promise<{ hint: boolean; share: boolean }> {
  const projectId = "people-project";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.includes("/mention-candidates") ? { items: [] }
      : url.includes("/sharing") ? { sessionId, visibility: "private", inherited: false, access: "manage", grants: [],
        people: Array.from({ length: spacePeople }, (_, i) => ({ userId: `u-${i}`, name: `P${i}` })) }
      : url.includes("/queue") || url.includes("/api/files/search") ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "Private chat", status: "idle" as const,
    createdAt: 1, updatedAt: 1, draft: "", draftUpdatedAt: 1,
    sharing: { visibility: "private", access: "manage", shared: false } as never,
  });
  activateSession(sessionId);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Composer)); });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(input);
    await act(async () => {
      input.value = "@";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const hint = host.querySelector(".ac-private-hint");
    return { hint: hint !== null, share: Boolean(hint?.querySelector("button")) };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
  }
}

test("a private chat's empty @ list offers sharing when the Space has other people", async () => {
  assert.deepEqual(await privateHintFor("private-with-people", 2), { hint: true, share: true });
  assert.deepEqual(await privateHintFor("private-alone", 0), { hint: false, share: false });
});
