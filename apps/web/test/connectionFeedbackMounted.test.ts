// Mounted contract for connection feedback: errors the system is still healing
// stay out of sight and vanish once the screen is confirmed current; anything
// else (and anything after the grace) shows exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ErrorBanner, UI_ERROR_NOTIFICATION_ID } = await import("../src/components/ConnectionFeedback.tsx");
const { getNotifications, resetNotifications } = await import("../src/notify/store.ts");
const { default: SyncCatchUpIndicator } = await import("../src/components/SyncCatchUpIndicator.tsx");
const store = await import("../src/store.ts");
const { tr } = await import("../src/i18n/index.ts");

type View = { fresh: boolean; indicator: "hidden" | "updating" | "reconnecting"; holdNetworkErrors: boolean };
const healing: View = { fresh: false, indicator: "reconnecting", holdNetworkErrors: true };
const current: View = { fresh: true, indicator: "hidden", holdNetworkErrors: false };
const overdue: View = { fresh: false, indicator: "reconnecting", holdNetworkErrors: false };

async function mountBanner(initial: View) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (view: View) => { await act(async () => { root.render(createElement(ErrorBanner, { catchUp: view })); }); };
  await render(initial);
  return {
    render,
    shown: () => getNotifications().items.some((item) => item.id === UI_ERROR_NOTIFICATION_ID),
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); resetNotifications(); },
  };
}

const connectionLost = `Open session: ${tr("settings.polythConnectionLost")}`;

test("a connection-loss error raised while healing stays hidden and is dropped once current", async () => {
  const view = await mountBanner(healing);
  try {
    await act(async () => { store.setUiError(connectionLost); });
    assert.equal(view.shown(), false);
    await view.render(current);
    assert.equal(view.shown(), false);
    assert.equal(store.getState().uiError, null, "the healed error is cleared, not merely hidden");
  } finally {
    await act(async () => { store.clearUiError(); });
    await view.unmount();
  }
});

test("a held error surfaces once healing runs past its grace", async () => {
  const view = await mountBanner(healing);
  try {
    await act(async () => { store.setUiError(connectionLost); });
    assert.equal(view.shown(), false);
    await view.render(overdue);
    assert.equal(view.shown(), true);
  } finally {
    await act(async () => { store.clearUiError(); });
    await view.unmount();
  }
});

test("an unknown write outcome and ordinary errors are never held", async () => {
  const view = await mountBanner(healing);
  try {
    await act(async () => { store.setUiError(`Send message: ${tr("settings.mutationOutcomeUnknown")}`); });
    assert.equal(view.shown(), true);
    await act(async () => { store.setUiError("Rename project: name already exists"); });
    assert.equal(view.shown(), true);
    await view.render(current);
    assert.equal(store.getState().uiError, "Rename project: name already exists", "only held errors are dropped");
  } finally {
    await act(async () => { store.clearUiError(); });
    await view.unmount();
  }
});

test("the catch-up pill is a polite, non-interactive status that fades out", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SyncCatchUpIndicator, { indicator: "hidden" })); });
    assert.equal(container.querySelector(".sync-catch-up"), null);
    await act(async () => { root.render(createElement(SyncCatchUpIndicator, { indicator: "updating" })); });
    const pill = container.querySelector(".sync-catch-up")!;
    assert.equal(pill.getAttribute("role"), "status");
    assert.equal(pill.getAttribute("aria-live"), "polite");
    assert.equal(pill.textContent, tr("app.syncUpdating"));
    await act(async () => { root.render(createElement(SyncCatchUpIndicator, { indicator: "hidden" })); });
    assert.equal(container.querySelector(".sync-catch-up")?.getAttribute("data-state"), "leaving");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.equal(container.querySelector(".sync-catch-up"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
