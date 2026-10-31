// Approving a walkthrough step shows at once and moves on; a refused decision
// puts the step back to pending and reports instead of failing silently.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response("{}", { status: 404 });

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const store = await import("../../../apps/web/src/store.ts");
const { default: WalkthroughView } = await import("../widgets/WalkthroughView.tsx");

type Steps = Awaited<ReturnType<typeof api.getWalkthrough>>["steps"];

test("an approval shows at once, moves on, and returns to pending when the server refuses", async () => {
  const steps = [
    { file: "a.ts", diff: "+a", explanation: "first", status: "pending" },
    { file: "b.ts", diff: "+b", explanation: "second", status: "pending" },
  ] as unknown as Steps;
  const originals = { get: api.getWalkthrough, decide: api.walkthroughDecide };
  const decisions: Array<[number, string]> = [];
  let refuse!: (error: Error) => void;
  api.getWalkthrough = (async () => ({ steps: steps.map((step) => ({ ...step })) })) as typeof api.getWalkthrough;
  api.walkthroughDecide = ((_session: string, index: number, decision: string) => {
    decisions.push([index, decision]);
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as typeof api.walkthroughDecide;
  store.seedSessionCache({ id: "wt-s", projectId: "wt-p", title: "", status: "idle", createdAt: 1, updatedAt: 1 });
  store.activateSession("wt-s");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const dots = () => [...container.querySelectorAll(".step-dot")].map((dot) => dot.className.replace(/\s+/g, " ").trim());
  try {
    await act(async () => { root.render(createElement(WalkthroughView)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const approve = container.querySelector<HTMLButtonElement>(".wt-approve")!;
    await act(async () => { approve.click(); });
    assert.deepEqual(dots(), ["step-dot approved", "step-dot current pending"], "approved and moved on at once");
    assert.match(container.querySelector(".wt-file")?.textContent ?? "", /b\.ts/);

    await act(async () => { refuse(new Error("history unavailable")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(decisions, [[0, "approve"]], "sent once");
    assert.deepEqual(dots(), ["step-dot pending", "step-dot current pending"], "the step is pending again");
    assert.match(store.getState().uiError ?? "", /history unavailable/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.getWalkthrough = originals.get;
    api.walkthroughDecide = originals.decide;
  }
});
