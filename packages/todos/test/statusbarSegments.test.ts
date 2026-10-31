// The package's status-bar segments, mounted with a fake host: todo progress
// (count, current step, the popover list) and background work (running
// sub-agents, queued messages read from queue events).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, getComputedStyle: dom.getComputedStyle,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
after(async () => { await dom.happyDOM.close(); });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BackgroundWorkSegment, TodoProgressSegment } = await import("../widgets/StatusbarSegments.tsx");
const { queuedMessageIds } = await import("../src/background.ts");

const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
let seq = 0;
const ev = (sessionId: string, type: string, data: Record<string, unknown>) =>
  ({ id: `e${++seq}`, sessionId, seq, time: NOW + seq, type, data, v: 1 }) as SessionEvent;

const events = new Map<string, SessionEvent[]>([
  ["plan", [ev("plan", "task/snapshot", { listId: "todo", revision: 1, items: [
    { id: "a", text: "Capture the annotated screenshot", status: "in_progress" },
    { id: "b", text: "Write the post", status: "pending" },
    { id: "c", text: "Document the provider header order", status: "completed" },
    { id: "d", text: "Drop the unused tag", status: "completed" },
    { id: "e", text: "Publish the package", status: "pending" },
  ] })]],
  ["busy", [
    ev("busy", "subagent/snapshot", { revision: 1, agents: [
      { sessionId: "k1", label: "Reviewer", status: "running" },
      { sessionId: "k2", label: "Tester", status: "running" },
      { sessionId: "k3", label: "Explorer", status: "completed" },
    ] }),
    ev("busy", "queue/enqueued", { queueId: "q1", text: "next", delivery: "queue" }),
  ]],
  ["quiet", [ev("quiet", "subagent/snapshot", { revision: 1, agents: [{ sessionId: "k3", label: "Explorer", status: "completed" }] })]],
]);
const projections = new Map<string, Partial<SessionProjection>>([
  ["k1", { status: "working" }],
  ["k2", { status: "working" }],
  ["k3", { status: "finished" }],
]);
const host = {
  ui: { locale: { get: () => "en", translate: (key: string) => key } },
  sessions: {
    subscribe: () => () => {},
    events: (id: string) => events.get(id) ?? [],
    get: (id: string) => projections.get(id) as SessionProjection | undefined,
  },
  conversation: { openSession: async () => {} },
} as never;

async function mount(component: typeof TodoProgressSegment, sessionId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(component, { host, sessionId })));
  return { container, dispose: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("the queue is enqueued rows that were neither dispatched, removed nor admitted", () => {
  const q = (type: string, data: JsonObject = {}) => ({ type, data });
  assert.deepEqual(queuedMessageIds([
    q("queue/enqueued", { queueId: "a" }),
    q("queue/enqueued", { queueId: "b" }),
    q("queue/enqueued", { queueId: "c" }),
    q("queue/removed", { queueId: "a" }),
  ]), ["b", "c"]);
  assert.deepEqual(queuedMessageIds([
    q("queue/enqueued", { queueId: "b" }),
    q("user/message", { queueId: "b" }),
  ]), [], "an admitted row is already in the chat");
  assert.deepEqual(queuedMessageIds([
    q("queue/enqueued", { queueId: "b" }),
    q("user/message", { queueId: "b" }),
    q("turn/stopped"),
  ]), ["b"], "a turn that ended without dispatch puts the row back");
  assert.deepEqual(queuedMessageIds([
    q("queue/enqueued", { queueId: "b" }),
    q("queue/dispatched", { queueId: "b" }),
  ]), []);
});

test("todo progress shows done/total and the step in progress, and lists every step on click", async () => {
  const view = await mount(TodoProgressSegment, "plan");
  try {
    const button = view.container.querySelector<HTMLButtonElement>(".todos-sb-progress")!;
    assert.ok(button);
    assert.equal(button.querySelector(".todos-sb-count")?.textContent, "2/5");
    assert.equal(button.querySelector(".todos-sb-current")?.textContent, "Capture the annotated screenshot");
    assert.equal(button.dataset.settled, "false");
    await act(async () => button.click());
    const items = [...document.body.querySelectorAll<HTMLElement>(".todos-sb-list li")];
    assert.deepEqual(items.map((item) => item.dataset.status), ["active", "pending", "done", "done", "pending"]);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    await act(async () => button.click());
    assert.equal(document.body.querySelector(".todos-sb-list"), null);
  } finally {
    await view.dispose();
  }
});

test("background work counts running sub-agents and queued messages; the popover lists the agents", async () => {
  const view = await mount(BackgroundWorkSegment, "busy");
  try {
    const button = view.container.querySelector<HTMLButtonElement>(".todos-sb-background")!;
    assert.ok(button);
    assert.equal(button.textContent, "2 running · 1 queued");
    await act(async () => button.click());
    const labels = [...document.body.querySelectorAll(".todos-agents__label")].map((node) => node.textContent);
    assert.deepEqual(labels, ["Reviewer", "Tester", "Explorer"]);
    assert.match(document.body.querySelector(".todos-sb-queue")?.textContent ?? "", /Messages waiting in the queue: 1/);
    await act(async () => button.click());
  } finally {
    await view.dispose();
  }
});

test("without a todo list or background work the segments take no room", async () => {
  for (const [component, sessionId] of [
    [TodoProgressSegment, null], [TodoProgressSegment, "quiet"],
    [BackgroundWorkSegment, null], [BackgroundWorkSegment, "quiet"],
  ] as const) {
    const view = await mount(component, sessionId);
    try {
      assert.equal(view.container.innerHTML, "", `${component.name} for ${sessionId ?? "no session"}`);
    } finally {
      await view.dispose();
    }
  }
});
