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
  KeyboardEvent: dom.KeyboardEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
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
  { id: "q3", sessionId: "s1", position: 2, text: "third", delivery: "queue", createdAt: 30, heldForReview: true },
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
const {
  default: QueuedMessageList,
  latestSteerableQueuedItem,
  moveQueuedItem,
} = await import("../src/components/QueuedMessageList.tsx");

const click = (element: HTMLElement) =>
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const drag = (element: HTMLElement, type: string) =>
  element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

test("late queue reads cannot resurrect a dispatched row", async () => {
  const originalFetch = globalThis.fetch;
  let release!: (value: ReturnType<typeof response>) => void;
  let reads = 0;
  globalThis.fetch = (async () => {
    if (++reads === 1) return new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; });
    return response([]);
  }) as unknown as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(QueuedMessageList, {
      sessionId: "s1", onItemsChange() {},
    })));
    await act(async () => root.render(createElement(QueuedMessageList, {
      sessionId: "s1", onItemsChange() {},
    })));
    await act(async () => { release(response(items)); });
    assert.equal(container.querySelectorAll(".queue-chip").length, 0);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("same-tick double clicks promote a queued row only once", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let calls = 0;
  let release!: () => void;
  try {
    await act(async () => root.render(createElement(QueuedMessageList, {
      sessionId: "s1",
      onSteer: async () => {
        calls++;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    })));
    const button = container.querySelector<HTMLElement>(".queue-steer")!;
    await act(async () => { click(button); click(button); });
    assert.equal(calls, 1);
    await act(async () => { release(); });
  } finally {
    await act(async () => root.unmount());
  }
});

test("delete of an already dispatched row resyncs without an unhandled error", async () => {
  const originalFetch = globalThis.fetch;
  let removed = false;
  let deletes = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "DELETE") {
      deletes++;
      removed = true;
      return { ...response({ error: "not-found", message: "queue item not found" }), ok: false, status: 404 };
    }
    return response(removed ? [] : items);
  }) as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(QueuedMessageList, { sessionId: "s1" })));
    const button = container.querySelector<HTMLElement>(".queue-remove")!;
    await act(async () => { click(button); click(button); });
    assert.equal(deletes, 1);
    assert.equal(container.querySelectorAll(".queue-chip").length, 0);
    assert.equal(container.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("moveQueuedItem preserves metadata while assigning the new positions", () => {
  const reordered = moveQueuedItem(items, "q1", "q3");
  assert.deepEqual(reordered.map((item) => item.id), ["q2", "q3", "q1"]);
  assert.equal(reordered[2]?.delivery, "steer");
  assert.equal(reordered[2]?.createdAt, 10);
  assert.deepEqual(reordered[2]?.attachments, items[0]?.attachments);
  assert.deepEqual(reordered.map((item) => item.position), [0, 1, 2]);
});

test("empty composer steering selects the newest ordinary queued message", () => {
  assert.equal(latestSteerableQueuedItem(items)?.id, "q2");
  assert.equal(latestSteerableQueuedItem(items.filter((item) => item.heldForReview)), null);
  assert.equal(latestSteerableQueuedItem([
    ...items,
    { id: "q4", sessionId: "s1", position: 3, text: "hidden retry", delivery: "queue", createdAt: 40, hiddenUserMessage: true },
  ])?.id, "q2");
});

test("hidden queued retries do not duplicate prompt text in chat", async () => {
  const originalFetch = globalThis.fetch;
  const hiddenItems: QueueItemDto[] = [
    { id: "h1", sessionId: "s1", position: 0, text: "repeat me", delivery: "queue", createdAt: 1, hiddenUserMessage: true },
    { id: "h2", sessionId: "s1", position: 1, text: "sensitive repeated prompt", delivery: "queue", createdAt: 2, hiddenUserMessage: true, heldForReview: true },
  ];
  globalThis.fetch = (async () => response(hiddenItems)) as unknown as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  let observed: QueueItemDto[] = [];
  try {
    await act(async () => root.render(createElement(QueuedMessageList, {
      sessionId: "s1",
      onItemsChange: (_sessionId: string, next: QueueItemDto[]) => { observed = next; },
    })));
    assert.equal(observed.length, 2, "hidden retries remain durable queue items");
    assert.equal(container.querySelectorAll(".queue-chip").length, 1, "ordinary hidden retry has no chat chip");
    assert.equal(container.textContent?.includes("repeat me"), false);
    assert.equal(container.textContent?.includes("sensitive repeated prompt"), false);
    assert.match(container.textContent ?? "", /Held for review/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("queued messages hand editing to the composer and drag-reorder through the persisted API", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let editing: QueueItemDto | undefined;
  let observed: QueueItemDto[] = [];
  try {
    await act(async () => {
      root.render(createElement(QueuedMessageList, {
        sessionId: "s1",
        onEdit: (item: QueueItemDto) => { editing = item; },
        onItemsChange: (_sessionId: string, next: QueueItemDto[]) => { observed = next; },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelectorAll(".queue-chip").length, 3);
    assert.deepEqual(observed.map((item) => item.id), ["q1", "q2", "q3"]);

    const steer = container.querySelector<HTMLElement>(".queue-steer");
    assert.ok(steer, "steer is an icon control on the row");
    assert.equal(steer.getAttribute("aria-label"), "steer");
    assert.equal(steer.textContent?.trim(), "", "steer has no visible label");
    assert.equal(container.querySelector(".queue-delivery"), null);

    const grip = container.querySelector<HTMLElement>(".queue-grip");
    assert.ok(grip, "the leading control is a drag handle");
    assert.equal(grip.tagName, "SPAN");
    assert.equal(grip.getAttribute("draggable"), "true");
    assert.equal(container.querySelector(".queue-chip")?.getAttribute("draggable"), null);
    const reorder = container.querySelector<HTMLButtonElement>(".queue-reorder");
    assert.ok(reorder, "a named menu provides non-drag queue ordering");
    assert.equal(reorder.getAttribute("aria-label"), "Reorder queued message 1");

    const edit = container.querySelector<HTMLElement>(".queue-edit");
    assert.ok(edit, "edit is a pencil on the row");
    assert.equal(edit.getAttribute("aria-label"), "Edit queued message 1");
    await act(async () => { click(edit); });
    assert.equal(editing?.id, "q1", "the parent composer owns the edit buffer");
    assert.equal(container.querySelector("textarea"), null, "queue rows never render an inline editor");
    assert.equal(container.querySelectorAll(".reorder-control").length, 0, "reorder stays in the shared action menu");
    await act(async () => {
      root.render(createElement(QueuedMessageList, {
        sessionId: "s1",
        editingId: "q1",
        onEdit: (item: QueueItemDto) => { editing = item; },
      }));
    });
    assert.equal(container.querySelectorAll(".queue-chip").length, 2, "the active edit leaves the queue list");
    assert.equal(container.textContent?.includes("first"), false, "the queued text lives only in the composer while editing");
    await act(async () => {
      root.render(createElement(QueuedMessageList, {
        sessionId: "s1",
        onEdit: (item: QueueItemDto) => { editing = item; },
      }));
    });

    const reorderAfterEditing = container.querySelector<HTMLButtonElement>(".queue-reorder");
    assert.ok(reorderAfterEditing);
    await act(async () => { click(reorderAfterEditing); });
    const moveDown = [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")]
      .find((element) => element.textContent?.includes("Move queued message 1 down"));
    assert.ok(moveDown, "the reorder menu exposes a move-down action");
    await act(async () => {
      click(moveDown);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(mutations.at(-1), {
      path: "/api/sessions/s1/queue/order",
      body: { ids: ["q2", "q1", "q3"] },
    });

    const chips = [...container.querySelectorAll<HTMLElement>(".queue-chip")];
    const sourceGrip = chips[0]!.querySelector<HTMLElement>(".queue-grip");
    assert.ok(sourceGrip);
    await act(async () => { drag(sourceGrip, "dragstart"); });
    await act(async () => { drag(chips[2]!, "dragover"); });
    await act(async () => {
      drag(chips[2]!, "drop");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(mutations.at(-1), {
      path: "/api/sessions/s1/queue/order",
      body: { ids: ["q1", "q3", "q2"] },
    });
    assert.deepEqual(
      [...container.querySelectorAll(".queue-text")].map((element) => element.textContent),
      ["first", "third", "second"],
    );
    const held = [...container.querySelectorAll<HTMLElement>(".queue-chip")]
      .find((chip) => chip.textContent?.includes("third"));
    assert.ok(held);
    assert.equal(held.querySelector(".queue-grip")?.getAttribute("draggable"), "false");
    assert.match(held.textContent ?? "", /Held for review/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
