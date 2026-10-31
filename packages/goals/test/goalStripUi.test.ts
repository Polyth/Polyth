// Goal strip controls reflect at once and roll back when the server refuses.
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
const { GoalStrip } = await import("../widgets/GoalStrip.tsx");

type Goal = Awaited<ReturnType<typeof api.goalGet>>;

test("pausing a goal shows Paused at once and restores Active when the server refuses", async () => {
  const goal = {
    objective: "Ship the release",
    status: "active",
    continuations: 0,
    maxContinuations: 12,
    tokensUsed: 0,
    budgetTokens: 0,
  } as unknown as Goal;
  const originals = { goalGet: api.goalGet, goalPause: api.goalPause };
  let refuse!: (error: Error) => void;
  let pauses = 0;
  api.goalGet = (async () => goal) as typeof api.goalGet;
  api.goalPause = (() => {
    pauses += 1;
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as typeof api.goalPause;
  store.seedSessionCache({ id: "goal-s", projectId: "goal-p", title: "", status: "idle", createdAt: 1, updatedAt: 1 });
  store.activateSession("goal-s");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const pill = () => container.querySelector(".goal-pill")?.textContent;
  try {
    await act(async () => { root.render(createElement(GoalStrip)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(pill(), "active");
    const pause = [...container.querySelectorAll("button")].find((item) => item.textContent === "Pause")!;
    await act(async () => { pause.click(); });
    assert.equal(pill(), "paused", "the pill changes before the server answers");
    await act(async () => { refuse(new Error("goal busy")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(pauses, 1, "the request is sent once");
    assert.equal(pill(), "active");
    assert.match(store.getState().uiError ?? "", /goal busy/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.assign(api, originals);
  }
});
