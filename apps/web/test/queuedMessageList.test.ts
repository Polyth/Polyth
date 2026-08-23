import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { QueueItemDto } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let items: QueueItemDto[] = [
  {
    id: "q1",
    sessionId: "s1",
    position: 0,
    text: "first",
    delivery: "steer",
    createdAt: 10,
    attachments: [{ id: "a1", name: "one.txt", mime: "text/plain", size: 3, path: "one.txt" }],
  },
  { id: "q2", sessionId: "s1", position: 1, text: "second", delivery: "queue", createdAt: 20 },
  { id: "q3", sessionId: "s1", position: 2, text: "third", delivery: "queue", createdAt: 30 },
];
const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];

const response = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
  text: async () => JSON.stringify(body),
});

(globalThis as { fetch?: unknown }).fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const path = String(input);
  const method = init?.method ?? "GET";
  if (method === "GET" && path === "/api/sessions/s1/queue") return response(items);
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  mutations.push({ path, body });
  if (method === "PATCH" && path === "/api/sessions/s1/queue/order") {
    const ids = body.ids as string[];
    items = ids.map((id, position) => ({ ...items.find((item) => item.id === id)!, position }));
    return response(items);
  }
  if (method === "PATCH" && path === "/api/sessions/s1/queue/q1") {
    items = items.map((item) => item.id === "q1" ? { ...item, text: String(body.text) } : item);
    return response(items.find((item) => item.id === "q1"));
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: QueuedMessageList, moveQueuedItem } = await import("../src/components/QueuedMessageList.tsx");

const click = (element: HTMLElement) =>
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const drag = (element: HTMLElement, type: string) =>
  element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

test("moveQueuedItem preserves metadata while assigning the new positions", () => {
  const reordered = moveQueuedItem(items, "q1", "q3");
  assert.deepEqual(reordered.map((item) => item.id), ["q2", "q3", "q1"]);
  assert.equal(reordered[2]?.delivery, "steer");
  assert.equal(reordered[2]?.createdAt, 10);
  assert.deepEqual(reordered[2]?.attachments, items[0]?.attachments);
  assert.deepEqual(reordered.map((item) => item.position), [0, 1, 2]);
});

test("queued messages can be edited and drag-reordered through the persisted APIs", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(QueuedMessageList, { sessionId: "s1" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelectorAll(".queue-chip").length, 3);

    const edit = container.querySelector<HTMLElement>('button[aria-label="Edit queued message 1"]');
    assert.ok(edit);
    await act(async () => { click(edit); });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit queued message 1"]');
    assert.ok(textarea);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")?.set;
      assert.ok(setter);
      setter.call(textarea, "first edited");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = container.querySelector<HTMLElement>('button[aria-label="Save queued message 1"]');
    assert.ok(save);
    await act(async () => {
      click(save);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(mutations.at(-1), {
      path: "/api/sessions/s1/queue/q1",
      body: { text: "first edited" },
    });
    assert.equal(container.querySelector(".queue-text")?.textContent, "first edited");

    const chips = [...container.querySelectorAll<HTMLElement>(".queue-chip")];
    await act(async () => { drag(chips[0]!, "dragstart"); });
    await act(async () => { drag(chips[2]!, "dragover"); });
    await act(async () => {
      drag(chips[2]!, "drop");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(mutations.at(-1), {
      path: "/api/sessions/s1/queue/order",
      body: { ids: ["q2", "q3", "q1"] },
    });
    assert.deepEqual(
      [...container.querySelectorAll(".queue-text")].map((element) => element.textContent),
      ["second", "third", "first edited"],
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
