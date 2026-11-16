// Mounted check: a delegated child's header leads with Back to its parent
// chat; a chat with no parent offers the `session.header.back` slot, where a
// package (Agents) draws its own Back with the same host control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  history: dom.history,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Opening the parent reads its history; an empty one is enough here.
globalThis.fetch = (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SessionBack } = await import("../src/components/SessionBack.tsx");
const { default: SessionBackButton } = await import("../src/components/ui/SessionBackButton.tsx");
const { registerSlot } = await import("../src/slots.ts");
const { activateProject, activateSession, getState, setSessions } = await import("../src/store.ts");

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return {
    host,
    async unmount() {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

test("a subagent's header goes Back to its parent chat; others offer the package slot", async () => {
  await act(async () => {
    activateProject("p1");
    setSessions("p1", [
      { id: "parent", projectId: "p1", title: "Release checklist", titleSource: "manual", status: "idle", createdAt: 1, updatedAt: 1 },
      { id: "child", projectId: "p1", parentId: "parent", title: "Run the smoke tests", titleSource: "manual", status: "idle", createdAt: 2, updatedAt: 2 },
      { id: "agent-run", projectId: "p1", purpose: "agent", title: "Watcher", titleSource: "manual", status: "idle", createdAt: 3, updatedAt: 3 },
    ]);
    activateSession("child");
  });

  const child = await mount(createElement(SessionBack, { sessionId: "child", presentation: "bar" }));
  const back = child.host.querySelector<HTMLButtonElement>(".session-back--bar");
  assert.ok(back !== null, "the child leads with Back");
  assert.equal(back!.getAttribute("aria-label"), "Back to Release checklist");
  assert.equal(back!.querySelector(".session-back-label")?.textContent, "Release checklist");
  await act(async () => { back!.click(); await Promise.resolve(); });
  assert.equal(getState().activeSessionId, "parent", "Back opens the parent chat");
  await child.unmount();

  const phone = await mount(createElement(SessionBack, { sessionId: "child", presentation: "island" }));
  assert.equal(phone.host.querySelector(".session-back--island")?.getAttribute("aria-label"), "Back to Release checklist");
  await phone.unmount();

  // No parent: the host draws nothing of its own and mounts the slot.
  const ordinary = await mount(createElement(SessionBack, { sessionId: "parent", presentation: "bar" }));
  assert.equal(ordinary.host.innerHTML, "");
  await ordinary.unmount();

  const seen: unknown[] = [];
  const dispose = registerSlot("session.header.back", "test.agent-back", (context) => {
    seen.push(context);
    return createElement(SessionBackButton, { label: "Watcher", presentation: context.presentation as "bar", onBack: () => {} });
  });
  const agent = await mount(createElement(SessionBack, { sessionId: "agent-run", presentation: "bar" }));
  assert.equal(agent.host.querySelector(".session-back--bar")?.getAttribute("aria-label"), "Back to Watcher");
  assert.deepEqual(seen.at(-1), { sessionId: "agent-run", presentation: "bar" });
  await agent.unmount();
  dispose();
});

test("bare shell layout keeps the back control interactive", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/shellLayout.css", import.meta.url), "utf8");
  assert.match(
    css,
    /body\[data-shell-layout="bare"\]\s+\.app\s*>\s*\.header\s+:is\([^)]*\.session-back[^)]*\)\s*\{\s*pointer-events:\s*auto;/s,
    "bare header enables pointer-events for the session-back control",
  );
});
