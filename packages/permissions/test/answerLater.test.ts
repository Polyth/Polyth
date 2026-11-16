// Answer later on approvals (docs/dev/ui.md "Answer later"): the chat's own
// banner folds by Later or Esc and folds itself when a request arrives under a
// draft; every other placement (the session row's popover) keeps showing the
// request, so an approval stays answerable from everywhere.
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
  Node: dom.Node,
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

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PermissionBanner } = await import("../widgets/PermissionBanner.tsx");
const { default: AnswerLaterLine } = await import("../../../apps/web/src/components/AnswerLaterLine.tsx");
const later = await import("@polyth/web-sdk/answer-later");
const { setSessions } = await import("../../../apps/web/src/store.ts");

setSessions("p1", [{ id: "s1", projectId: "p1", title: "Chat", status: "running", createdAt: 1, updatedAt: 1 }] as never);

const request = (requestId: string, command = "npm test") => ({
  sessionId: "s1", requestId, permission: "bash", patterns: [command], status: "pending", time: 1,
  preview: { title: "bash", lines: [command], risk: "low", reasons: [] },
});

/** The chat's banner, the waiting line and the session-row popover's banner. */
async function mount(requests: ReturnType<typeof request>[]) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const render = (next: ReturnType<typeof request>[]) => act(async () => root.render(h("div", null,
    h("div", { className: "chat" }, h(PermissionBanner, { permissions: next, deferrable: true } as never)),
    h(AnswerLaterLine, { sessionId: "s1", model: { questions: [], permissions: next } as never }),
    h("div", { className: "popover" }, h(PermissionBanner, { permissions: next } as never)),
  )));
  await render(requests);
  const q = (selector: string) => container.querySelector(selector) as unknown as HTMLElement | null;
  return {
    q,
    render,
    settle: () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test.beforeEach(() => later.resetAnswerLater());

test("Later folds the chat's approval; the popover still offers it; Answer restores it with focus", async () => {
  const view = await mount([request("r1")]);
  try {
    assert.equal(view.q(".popover .permission-later"), null, "the popover offers no Later");
    await act(async () => view.q(".chat .permission-later")!.click());
    assert.equal(view.q(".chat .perm-banner"), null, "the chat's banner folds");
    assert.ok(view.q(".popover .permission-allow"), "still answerable from the session row");
    assert.equal(view.q(".answer-later-count")?.textContent, "1 approval waiting");

    await act(async () => view.q(".answer-later-open")!.click());
    await view.settle();
    assert.ok(view.q(".chat .perm-banner"));
    assert.equal(dom.document.activeElement, view.q(".chat .perm-actions button"), "focus on the first decision");
  } finally {
    await view.unmount();
  }
});

test("Esc inside the banner folds it and Answer takes the keyboard", async () => {
  const view = await mount([request("r1")]);
  try {
    const allow = view.q(".chat .permission-allow")!;
    allow.focus();
    await act(async () => {
      allow.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await view.settle();
    assert.equal(view.q(".chat .perm-banner"), null);
    assert.equal(dom.document.activeElement, view.q(".answer-later-open"));
  } finally {
    await view.unmount();
  }
});

test("an approval that arrives under a draft arrives folded and opens when the draft is cleared", async () => {
  const view = await mount([]);
  try {
    later.reportComposerDraft("s1", true);
    await view.render([request("r1")]);
    await view.settle();
    assert.equal(view.q(".chat .perm-banner"), null, "nothing paints under the caret");
    assert.ok(view.q(".popover .permission-allow"), "the popover shows it at once");
    assert.equal(view.q(".answer-later-count")?.textContent, "1 approval waiting");
    await act(async () => later.reportComposerDraft("s1", false));
    assert.ok(view.q(".chat .perm-banner"));
    assert.equal(view.q(".answer-later"), null);
  } finally {
    await view.unmount();
  }
});
