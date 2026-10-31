// New-conversation dialog: Space members excluding the reader, then the exact
// POST /api/conversations payload with a stable client operation id.
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
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
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
const { default: ConversationCreateDialog } = await import("../src/components/ConversationCreateDialog.tsx");

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 60 && !check(); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  return check();
};

test("create-conversation dialog posts the picked people, title and first message", async () => {
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, method, body });
    const payload = method === "GET" && url === "/api/spaces"
      ? {
          user: { id: "me", name: "Me", createdAt: 1 },
          spaces: [{ id: "s1", name: "Studio", slug: "studio", createdAt: 1, updatedAt: 1, isDefault: true, role: "member", memberCount: 2 }],
          activeSpaceId: "s1",
          deployment: "local",
          canCreate: false,
        }
      : method === "GET" && url === "/api/spaces/s1/members"
        ? [
            { userId: "me", spaceId: "s1", role: "member", createdAt: 1 },
            { userId: "u-alice", spaceId: "s1", role: "member", createdAt: 1 },
          ]
        : method === "GET" && url === "/api/auth/accounts"
          ? { currentAccountId: "me", canManage: false, accounts: [{ id: "me", name: "Me" }, { id: "u-alice", name: "Alice" }] }
          : method === "POST" && url === "/api/conversations"
            ? { id: "conversation-1" }
            : url.includes("/api/sessions/conversation-1/events/forward")
              ? { events: [], cursor: 0, highWater: 0, complete: true }
              : url.includes("/api/sessions/conversation-1/events")
                ? []
              : url === "/api/sessions/conversation-1"
                ? { id: "conversation-1", projectId: "p1", title: "Design review", status: "idle", createdAt: 1, updatedAt: 1 }
                : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(ConversationCreateDialog, { open: true, projectId: "p1", onClose: () => {} }));
    });
    assert.ok(await waitFor(() => !!document.querySelector(".conversation-person")), "people loaded");
    assert.equal(document.body.textContent?.includes("Me"), false, "the reader is not offered as a participant");

    const alice = [...document.querySelectorAll<HTMLButtonElement>(".conversation-person")]
      .find((button) => button.textContent?.includes("Alice"));
    assert.ok(alice);
    await act(async () => { alice.click(); });
    assert.equal(alice?.getAttribute("aria-checked"), "true", "Alice is checked in the list");

    const title = document.querySelector<HTMLInputElement>(".conversation-field .ui-input:not([type=search])");
    assert.ok(title);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(title, "Design review");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const text = document.querySelector<HTMLTextAreaElement>(".conversation-field textarea");
    assert.ok(text);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(text, "Let’s look at the new layout");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(text.value, "Let’s look at the new layout");
    const create = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Create conversation"));
    assert.ok(create);
    assert.equal(create.disabled, false, `create stays disabled after picking a person and writing a message (${create.textContent})`);
    await act(async () => { create.click(); });
    await waitFor(() => requests.some((request) => request.method === "POST" && request.url === "/api/conversations"));

    const post = requests.find((request) => request.method === "POST" && request.url === "/api/conversations");
    assert.ok(post);
    const body = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
    assert.equal(body.projectId, "p1");
    assert.deepEqual(body.participants, ["u-alice"]);
    assert.equal(body.title, "Design review");
    assert.equal(body.text, "Let’s look at the new layout");
    assert.equal(typeof body.clientOperationId, "string");
    assert.ok((body.clientOperationId as string).length > 0);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
