// Start-session dialog: participants are a one-time copy of the conversation
// sharing grants, editable before the exact POST payload is sent.
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
const { default: ConversationStartDialog } = await import("../src/components/ConversationStartDialog.tsx");

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 60 && !check(); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  return check();
};

test("start-session dialog posts the selected seqs and the copied participant list", async () => {
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, method, body });
    const payload = method === "GET" && url === "/api/sessions/conversation-1/sharing"
      ? {
          sessionId: "conversation-1", visibility: "restricted", inherited: false, access: "collaborate",
          grants: [
            { userId: "u-alice", name: "Alice", access: "collaborate" },
            { userId: "u-bob", name: "Bob", access: "view" },
          ],
          people: [], canShare: true, allowedVisibilities: ["private", "restricted"], maxGrant: "manage", revision: 1,
        }
      : method === "POST" && url === "/api/sessions/conversation-1/conversation/start"
        ? { sessionId: "agent-1", cardSeq: 12 }
        : url.includes("/api/sessions/agent-1/events/forward")
          ? { events: [], cursor: 0, highWater: 0, complete: true }
          : url.includes("/api/sessions/agent-1/events")
            ? []
            : url === "/api/sessions/agent-1"
              ? { id: "agent-1", projectId: "p1", title: "Plan", status: "idle", createdAt: 1, updatedAt: 1 }
              : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(ConversationStartDialog, {
        open: true, sessionId: "conversation-1", sourceSeqs: [12, 8, 15], defaultTitle: "Plan the fix", onClose: () => {},
      }));
    });
    assert.ok(await waitFor(() => document.querySelectorAll(".conversation-start-person").length === 2));
    const rows = [...document.querySelectorAll<HTMLLIElement>(".conversation-start-person")];
    assert.ok(rows.some((row) => row.textContent?.includes("Alice")));
    assert.ok(rows.some((row) => row.textContent?.includes("Bob")));
    const removeBob = rows.find((row) => row.textContent?.includes("Bob"))?.querySelector<HTMLButtonElement>(".conversation-start-remove");
    assert.ok(removeBob);
    await act(async () => { removeBob.click(); });

    const prompt = document.querySelector<HTMLTextAreaElement>(".conversation-field textarea");
    assert.ok(prompt);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(prompt, "Use these notes");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const start = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Start session"));
    assert.ok(start);
    assert.equal(start.disabled, false);
    await act(async () => { start.click(); });
    await waitFor(() => requests.some((request) => request.url.endsWith("/conversation/start")));

    const post = requests.find((request) => request.url.endsWith("/conversation/start"));
    assert.ok(post);
    const body = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(body.sourceSeqs, [12, 8, 15]);
    assert.equal(body.title, "Plan the fix");
    assert.equal(body.prompt, "Use these notes");
    assert.deepEqual(body.participants, [{ userId: "u-alice", access: "collaborate" }]);
    assert.equal(typeof body.clientOperationId, "string");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
