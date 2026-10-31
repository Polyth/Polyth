// Package notes on a request (`session.permission.notes`): the mounted card
// hands each request's identity to the host slot, just above its decisions,
// and the Judgment second opinion keeps its chance from the canonical event.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PermissionBanner } = await import("../widgets/PermissionBanner.tsx");
const { buildModel } = await import("../../../apps/web/src/reduce.ts");
const { setSessions } = await import("../../../apps/web/src/store.ts");

setSessions("p1", [
  { id: "parent", projectId: "p1", title: "Parent", status: "waiting", createdAt: 1, updatedAt: 1 },
  { id: "child", projectId: "p1", title: "Tests", status: "waiting", createdAt: 1, updatedAt: 1, parentId: "parent" },
] as never);

const event = (seq: number, type: string, data: Record<string, unknown>) =>
  ({ id: `e${seq}`, sessionId: "parent", seq, time: seq, type, v: 1, data }) as never;

async function mount(element: ReturnType<typeof createElement>) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(element));
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("each request hands its identity to the notes slot, between its explanation and its decisions", async () => {
  const model = buildModel([
    event(1, "permission/requested", { requestId: "own", permission: "bash", patterns: ["npm test"], preview: { title: "bash", lines: ["npm test"] } }),
    event(2, "permission/requested", { requestId: "mirrored", permission: "edit", patterns: ["src/a.ts"], sourceSessionId: "child",
      preview: { title: "edit", lines: ["src/a.ts"] } }),
  ]);
  const seen: Array<{ slot: string; context?: Record<string, unknown> }> = [];
  const Slot = (props: { slot: string; context?: Record<string, unknown> }) => {
    seen.push(props);
    return createElement("p", { className: "test-note" }, String(props.context?.requestId));
  };
  const view = await mount(createElement(PermissionBanner, { permissions: model.permissions, Slot } as never));
  try {
    assert.deepEqual(seen.map((entry) => entry.slot), ["session.permission.notes", "session.permission.notes"]);
    assert.deepEqual(seen.map((entry) => entry.context), [
      { sessionId: "parent", requestId: "own" },
      { sessionId: "parent", requestId: "mirrored", sourceSessionId: "child" },
    ]);
    for (const row of view.container.querySelectorAll(".permission-request")) {
      const children = [...row.children].map((child) => child.className);
      const note = children.indexOf("test-note");
      assert.ok(note > children.indexOf("permission-request-body"), "below the scrolling explanation");
      assert.equal(children[note + 1], "perm-actions", "directly above the decisions");
    }
  } finally { await view.unmount(); }

  // A host without the slot renderer still shows the card.
  const bare = await mount(createElement(PermissionBanner, { permissions: model.permissions } as never));
  try { assert.equal(bare.container.querySelectorAll(".permission-request .perm-actions").length, 2); }
  finally { await bare.unmount(); }
});

test("a held request keeps its second opinion's chance from the canonical preview", async () => {
  const model = buildModel([event(1, "permission/requested", { requestId: "held", permission: "bash", patterns: ["curl example.com"],
    preview: { title: "bash", lines: ["curl example.com"], risk: "low", reasons: ["outside-task"], scopeCheck: { probability: 0.86 } } })]);
  assert.deepEqual(model.permissions[0]!.preview?.scopeCheck, { probability: 0.86 });
  const malformed = buildModel([event(1, "permission/requested", { requestId: "x", permission: "bash", patterns: [],
    preview: { title: "bash", lines: [], reasons: ["outside-task"], scopeCheck: { probability: 7 } } })]);
  assert.equal(malformed.permissions[0]!.preview?.scopeCheck, undefined, "an impossible chance is dropped");
  const view = await mount(createElement(PermissionBanner, { permissions: model.permissions } as never));
  try { assert.equal(view.container.querySelector(".permission-outside-task")?.textContent, "Outside the task · 86%"); }
  finally { await view.unmount(); }
});
