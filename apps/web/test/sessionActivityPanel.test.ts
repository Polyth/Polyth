// The agent activity panel the status line above the composer opens, and the
// details inside it. Mounts the real components in happy-dom (no layout, its
// Web Animations removed: motion is off, as under reduced motion): the panel opens
// from the line as a non-modal dialog and closes on Escape or a press
// outside; the details reopen on the last tab; editing is the iOS kind — no
// edit button, holding a block or an empty spot enters it, the head's Close
// becomes Done — and arrow keys move a block and the order is kept. Geometry
// and motion in a real engine: sessionActivityPanelLayout.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: (elt: Element, pseudo?: string | null) =>
    (dom as unknown as { getComputedStyle(el: Element, pseudo?: string | null): CSSStyleDeclaration })
      .getComputedStyle(elt, pseudo),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
for (const name of ["HTMLElement", "Element", "Node"] as const) {
  Object.defineProperty(globalThis, name, { value: (dom as unknown as Record<string, unknown>)[name], configurable: true });
}
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });
// happy-dom implements Element.animate, and a cancelled animation rejects its
// `finished` promise. Without it the panel and the arrange code take their
// no-motion paths, which is what this file checks.
delete (dom.Element.prototype as { animate?: unknown }).animate;
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () =>
  ({ ok: true, status: 200, statusText: "OK", json: async () => [], text: async () => "[]" });

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SessionActivityDetails } = await import("../src/components/SessionActivityDetails.tsx");
const { ARRANGE_ACTIVATE_MS } = await import("../src/workspaceArrange.ts");
const { default: SessionActivityPanelHost, activityPanelGeometry } = await import("../src/components/SessionActivityPanel.tsx");
const { buildModel } = await import("../src/reduce.ts");
const layout = await import("../src/sessionActivityLayout.ts");
const popover = await import("../src/sessionStatusPopover.ts");
const store = await import("../src/store.ts");
const { setUiSettings } = await import("../src/uiPrefs.ts");
const { tr } = await import("../src/i18n/index.ts");

const PointerEventCtor = (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const shownBlocks = (root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>(".session-activity-blocks > [data-activity-block]")].map((element) => element.dataset.activityBlock);

const tasks = [
  { id: "1", text: "Collect sources", status: "done" as const },
  { id: "2", text: "Cross-check dates", status: "active" as const },
];
// Duration and messages are always known; this agent reports no tokens or cost.
const model = buildModel([
  { id: "e1", sessionId: "s1", seq: 1, time: 1_000, type: "user/message", data: { text: "When is the next model due?" }, v: 1 },
  { id: "e2", sessionId: "s1", seq: 2, time: 2_000, type: "assistant/message", data: { partId: "a1", text: "Looking." }, v: 1 },
] as never);

const SESSION = { id: "s1", projectId: "p1", title: "Release date theories", status: "working", createdAt: 1, updatedAt: 1, attention: { questions: 0, permissions: 0, unread: 0 } } as never;

async function mountDetails() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SessionActivityDetails, { tasks, session: SESSION, model, prompt: "When is the next model due?" }));
    await sleep(0);
  });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}

test("the panel stands on the status line, spans the composer and stops under the chrome", () => {
  const geometry = activityPanelGeometry({
    layerHeight: 932,
    line: { left: 16, top: 840, right: 414, bottom: 868 },
    frame: { left: 16, width: 398 },
    ceiling: 58,
    gap: 8,
  });
  assert.deepEqual(
    { left: geometry.left, width: geometry.width, bottom: geometry.bottom, maxHeight: geometry.maxHeight },
    { left: 16, width: 398, bottom: 932 - 840 + 8, maxHeight: 840 - 8 - (58 + 8) },
  );
  // A short window keeps a usable panel rather than a sliver.
  assert.equal(activityPanelGeometry({ layerHeight: 300, line: { left: 0, top: 120, right: 300, bottom: 150 }, frame: { left: 0, width: 300 }, ceiling: 80, gap: 8 }).maxHeight, 160);
});

test("tabs reopen on the last one, and the plan's progress rides on its tab", async () => {
  setUiSettings({ sessionActivityDetails: "tabs" });
  layout.setActivityTab("stats");
  const first = await mountDetails();
  try {
    assert.deepEqual(shownBlocks(), ["context", "duration", "messages"], "only figures this agent reports");
    assert.match(first.container.querySelector(".session-activity-footnote")?.textContent ?? "", new RegExp(`${tr("chatmetrics.tokens")}.*${tr("timeline.cost")}`));
    const planTab = first.container.querySelectorAll<HTMLButtonElement>("[role='tab']")[1]!;
    assert.match(planTab.textContent ?? "", /1\/2/);
    await act(async () => { planTab.click(); await sleep(0); });
    assert.deepEqual(shownBlocks(), ["request", "plan"]);
  } finally {
    await first.close();
  }
  const second = await mountDetails();
  try {
    assert.equal(second.container.querySelector("[role='tab'][aria-selected='true']")?.textContent?.startsWith(tr("sessionActivity.contentTab")), true);
    assert.equal(layout.getActivityLayout().tab, "content");
  } finally {
    await second.close();
    layout.setActivityTab("stats");
  }
});

test("holding a block enters the edit mode and lifts it; every block shows, Escape leaves it", async () => {
  setUiSettings({ sessionActivityDetails: "tabs" });
  layout.setActivityTab("stats");
  layout.resetActivityOrder();
  const view = await mountDetails();
  try {
    const details = view.container.querySelector<HTMLElement>(".session-activity-details")!;
    assert.equal(view.container.querySelector(".session-activity-edit-dock") === null, true, "no edit chrome until a hold");
    const block = view.container.querySelector<HTMLElement>("[data-activity-block='duration']")!;
    await act(async () => {
      block.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 }));
      await sleep(ARRANGE_ACTIVATE_MS / 2);
    });
    assert.equal(block.dataset.arrangePressing, "activate", "the block sinks while the hold builds up");
    assert.equal(details.dataset.editing, undefined);
    await act(async () => { await sleep(ARRANGE_ACTIVATE_MS / 2 + 80); });
    assert.equal(details.dataset.editing, "true");
    assert.equal(details.dataset.arrangeDragging, "true", "the same press now carries the block");
    assert.ok(details.querySelector(".workspace-arrange-ghost"), "a lifted copy follows the finger");
    assert.deepEqual(shownBlocks(), activityBlocksOfStats(), "unreported figures show while arranging");
    assert.equal(view.container.querySelector(".session-activity-footnote") === null, true);
    const dock = view.container.querySelector<HTMLElement>(".session-activity-edit-dock")!;
    assert.equal(dock.querySelector(".session-activity-edit-hint")?.textContent, tr("sessionActivity.arrangeHint"));
    assert.ok(dock.querySelector(".session-activity-done"), "standing alone, the dock offers Done");
    // Letting go sets the block down; the click that ends the press presses nothing.
    await act(async () => {
      block.dispatchEvent(new PointerEventCtor("pointerup", { bubbles: true, pointerType: "touch", pointerId: 1 }));
      await sleep(0);
      block.click();
      await sleep(0);
    });
    assert.equal(details.dataset.arrangeDragging, undefined);
    assert.equal(details.querySelector(".workspace-arrange-ghost") === null, true);
    assert.equal(details.dataset.editing, "true");
    await act(async () => {
      window.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true }));
      await sleep(0);
    });
    assert.equal(details.dataset.editing, undefined);
    assert.equal(view.container.querySelector(".session-activity-edit-dock") === null, true);
    // Without layout every box is empty, so where the drop landed is not
    // asserted here (the real engine: sessionActivityPanelLayout.test.ts).
    assert.deepEqual(shownBlocks().sort(), ["context", "duration", "messages"]);
  } finally {
    await view.close();
    layout.resetActivityOrder();
  }
});

test("holding an empty spot enters the edit mode; a tap beside the blocks or Done leaves it", async () => {
  setUiSettings({ sessionActivityDetails: "tabs" });
  layout.setActivityTab("stats");
  layout.resetActivityOrder();
  const view = await mountDetails();
  try {
    const details = view.container.querySelector<HTMLElement>(".session-activity-details")!;
    const grid = view.container.querySelector<HTMLElement>(".session-activity-blocks")!;
    // A press that moves is a scroll, not a hold.
    await act(async () => {
      grid.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 2, clientX: 10, clientY: 10 }));
      grid.dispatchEvent(new PointerEventCtor("pointermove", { bubbles: true, pointerType: "touch", pointerId: 2, clientX: 10, clientY: 40 }));
      await sleep(ARRANGE_ACTIVATE_MS + 80);
    });
    assert.equal(details.dataset.editing, undefined);
    await act(async () => {
      grid.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 3, clientX: 10, clientY: 10 }));
      await sleep(ARRANGE_ACTIVATE_MS + 80);
    });
    assert.equal(details.dataset.editing, "true");
    // The click that ends that hold is not a tap beside the blocks.
    await act(async () => {
      grid.dispatchEvent(new PointerEventCtor("pointerup", { bubbles: true, pointerType: "touch", pointerId: 3 }));
      grid.click();
      await sleep(0);
    });
    assert.equal(details.dataset.editing, "true");
    // A tap on a block does nothing; one beside the blocks is Done.
    await act(async () => {
      details.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 4 }));
      view.container.querySelector<HTMLElement>("[data-activity-block='messages']")!.click();
      await sleep(0);
    });
    assert.equal(details.dataset.editing, "true");
    await act(async () => { grid.click(); await sleep(0); });
    assert.equal(details.dataset.editing, undefined);
    // The keyboard's way in, then Done in the dock.
    const entry = view.container.querySelector<HTMLButtonElement>(".session-activity-arrange-entry")!;
    assert.equal(entry.textContent, tr("sessionActivity.arrange"));
    await act(async () => { entry.click(); await sleep(0); });
    assert.equal(details.dataset.editing, "true");
    assert.equal(document.activeElement?.getAttribute("data-activity-block"), "context", "focus lands on the first block to move");
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".session-activity-done")!.click(); await sleep(0); });
    assert.equal(details.dataset.editing, undefined);
  } finally {
    await view.close();
  }
});

test("arrow keys move a block while arranging; the order is kept and resets", async () => {
  setUiSettings({ sessionActivityDetails: "tabs" });
  layout.setActivityTab("stats");
  layout.resetActivityOrder();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (editing: boolean) => act(async () => {
    root.render(createElement(SessionActivityDetails, { tasks, session: SESSION, model, editing, onEditingChange: () => {} }));
    await sleep(0);
  });
  try {
    await render(true);
    const cost = container.querySelector<HTMLElement>("[data-activity-block='cost']")!;
    assert.equal(cost.getAttribute("aria-label"), tr("workspace.panel.moveValue", { value: tr("timeline.cost") }));
    await act(async () => {
      cost.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Home", bubbles: true }));
      await sleep(0);
    });
    assert.equal(shownBlocks()[0], "cost");
    assert.equal(layout.getActivityLayout().order[0], "cost");
    assert.equal(layout.isDefaultActivityOrder(layout.getActivityLayout().order), false);
    const reset = () => [...container.querySelectorAll<HTMLButtonElement>(".session-activity-edit-dock button")]
      .find((button) => button.textContent === tr("workspace.panel.reset"))!;
    assert.equal(reset().disabled, false);
    // Controlled, Done is the owner's (the panel's head), not the dock's.
    assert.equal(container.querySelector(".session-activity-edit-dock .session-activity-done") === null, true);
    await act(async () => { reset().click(); await sleep(0); });
    assert.deepEqual(layout.getActivityLayout().order, [...layout.DEFAULT_ACTIVITY_ORDER]);
    assert.equal(reset().disabled, true, "nothing left to reset");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

function activityBlocksOfStats() {
  return layout.activityBlocksOf(layout.getActivityLayout().order, "stats");
}

test("the status line opens the panel as a non-modal dialog that Escape and an outside press close", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "p1", path: "/repo", name: "Repo", createdAt: 0 }]);
  store.activateProject("p1");
  store.setSessions("p1", [{
    id: "s1", projectId: "p1", title: "Release date theories", titleSource: "native", status: "working",
    createdAt: 1, updatedAt: 1, lastTurnAt: 1, attention: { questions: 0, permissions: 0, unread: 0 },
  } as never]);
  const conversation = document.createElement("div");
  conversation.className = "focus-conversation";
  conversation.innerHTML = `<div class="conversation-composer-dock"><button type="button" class="agent-status-dock">Working</button><div class="host"></div><div class="composer-card"><textarea></textarea></div></div>`;
  document.body.append(conversation);
  const dockLine = conversation.querySelector<HTMLButtonElement>(".agent-status-dock")!;
  const root = createRoot(conversation.querySelector(".host")!);
  try {
    await act(async () => {
      root.render(createElement(SessionActivityPanelHost, { sessionId: "s1", model }));
      await sleep(0);
    });
    assert.equal(document.querySelector(".session-activity-panel") === null, true, "closed until the line is pressed");

    await act(async () => { popover.toggleSessionStatusPopover(dockLine, "dock"); await sleep(0); });
    const panel = document.querySelector<HTMLElement>(".session-activity-panel")!;
    assert.ok(panel, "the panel opens");
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(panel.getAttribute("aria-modal"), null, "the composer stays usable");
    assert.ok(panel.classList.contains("ui-glass-dock"), "the canonical glass dock material");
    assert.equal(panel.parentElement?.parentElement === document.body, true, "portalled out of the composer's containing blocks");
    assert.equal(document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent, "Release date theories");
    assert.equal(document.activeElement === panel, true, "focus moves into the panel");
    const headButtons = () => [...panel.querySelectorAll<HTMLButtonElement>(".session-activity-panel-actions button")];
    assert.deepEqual(headButtons().map((button) => button.getAttribute("aria-label")), [tr("common.close")], "no edit button: only Close");

    // Holding an empty spot arranges the blocks; the head's Close becomes Done.
    const grid = panel.querySelector<HTMLElement>(".session-activity-blocks")!;
    await act(async () => {
      grid.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 5, clientX: 10, clientY: 10 }));
      await sleep(ARRANGE_ACTIVATE_MS + 80);
      grid.dispatchEvent(new PointerEventCtor("pointerup", { bubbles: true, pointerType: "touch", pointerId: 5 }));
    });
    assert.equal(panel.querySelector<HTMLElement>(".session-activity-details")?.dataset.editing, "true");
    assert.deepEqual(headButtons().map((button) => button.textContent), [tr("common.done")]);
    assert.equal(panel.querySelector(".session-activity-edit-dock .session-activity-done") === null, true, "one Done, in the head");
    assert.equal(panel.querySelector(".session-activity-panel-head")?.hasAttribute("data-switched"), true, "the swap pops in");
    // Escape leaves the mode first and keeps the panel open.
    await act(async () => {
      window.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true }));
      await sleep(0);
    });
    assert.equal(panel.querySelector<HTMLElement>(".session-activity-details")?.dataset.editing, undefined);
    assert.ok(document.querySelector(".session-activity-panel"), "still open");
    await act(async () => {
      grid.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 6, clientX: 10, clientY: 10 }));
      await sleep(ARRANGE_ACTIVATE_MS + 80);
      grid.dispatchEvent(new PointerEventCtor("pointerup", { bubbles: true, pointerType: "touch", pointerId: 6 }));
    });
    await act(async () => { headButtons()[0]!.click(); await sleep(0); });
    assert.equal(panel.querySelector<HTMLElement>(".session-activity-details")?.dataset.editing, undefined, "Done leaves it");
    assert.equal(document.activeElement?.getAttribute("aria-label"), tr("common.close"), "focus moves on to Close");

    await act(async () => {
      window.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true }));
      await sleep(0);
    });
    assert.equal(document.querySelector(".session-activity-panel") === null, true, "Escape closes it");
    assert.equal(popover.getSessionStatusPopover().open, false);
    assert.equal(document.activeElement === dockLine, true, "focus returns to the status line");

    await act(async () => { popover.toggleSessionStatusPopover(dockLine, "dock"); await sleep(0); });
    assert.ok(document.querySelector(".session-activity-panel"));
    // A press on the line itself is the line's own toggle, not an outside press.
    await act(async () => {
      dockLine.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true }));
      await sleep(0);
    });
    assert.ok(document.querySelector(".session-activity-panel"));
    // The composer is outside: pressing it closes the panel and goes on to it.
    await act(async () => {
      conversation.querySelector("textarea")!.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true }));
      await sleep(0);
    });
    assert.equal(document.querySelector(".session-activity-panel") === null, true);
  } finally {
    popover.closeSessionStatusPopover();
    await act(async () => root.unmount());
    conversation.remove();
  }
});

test("the panel stays open when its status line leaves as the turn ends", async () => {
  const conversation = document.createElement("div");
  conversation.className = "focus-conversation";
  conversation.innerHTML = `<div class="conversation-composer-dock"><button type="button" class="agent-status-dock">Working</button><div class="host"></div><div class="composer-card"></div></div>`;
  document.body.append(conversation);
  const dockLine = conversation.querySelector<HTMLButtonElement>(".agent-status-dock")!;
  const root = createRoot(conversation.querySelector(".host")!);
  const render = () => act(async () => {
    root.render(createElement(SessionActivityPanelHost, { sessionId: "s1", model }));
    await sleep(0);
  });
  try {
    await render();
    await act(async () => { popover.toggleSessionStatusPopover(dockLine, "dock"); await sleep(0); });
    assert.ok(document.querySelector(".session-activity-panel"));
    dockLine.remove();
    await render();
    assert.ok(document.querySelector(".session-activity-panel"), "still open where the line was");
    // The next turn's line takes it over rather than opening a second one.
    const next = document.createElement("button");
    next.className = "agent-status-dock";
    conversation.querySelector(".conversation-composer-dock")!.prepend(next);
    await act(async () => { popover.toggleSessionStatusPopover(next, "dock"); await sleep(0); });
    assert.equal(document.querySelectorAll(".session-activity-panel").length, 1);
    await act(async () => { popover.toggleSessionStatusPopover(next, "dock"); await sleep(0); });
    assert.equal(document.querySelector(".session-activity-panel") === null, true, "and toggles it closed");
  } finally {
    popover.closeSessionStatusPopover();
    await act(async () => root.unmount());
    conversation.remove();
  }
});

test("a panel closed while arranging opens again outside the edit mode", async () => {
  const conversation = document.createElement("div");
  conversation.className = "focus-conversation";
  conversation.innerHTML = `<div class="conversation-composer-dock"><button type="button" class="agent-status-dock">Working</button><div class="host"></div><div class="composer-card"><textarea></textarea></div></div>`;
  document.body.append(conversation);
  const dockLine = conversation.querySelector<HTMLButtonElement>(".agent-status-dock")!;
  const root = createRoot(conversation.querySelector(".host")!);
  try {
    await act(async () => {
      root.render(createElement(SessionActivityPanelHost, { sessionId: "s1", model }));
      await sleep(0);
    });
    await act(async () => { popover.toggleSessionStatusPopover(dockLine, "dock"); await sleep(0); });
    const grid = document.querySelector<HTMLElement>(".session-activity-panel .session-activity-blocks")!;
    await act(async () => {
      grid.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 7, clientX: 10, clientY: 10 }));
      await sleep(ARRANGE_ACTIVATE_MS + 80);
      grid.dispatchEvent(new PointerEventCtor("pointerup", { bubbles: true, pointerType: "touch", pointerId: 7 }));
    });
    assert.equal(document.querySelector<HTMLElement>(".session-activity-details")?.dataset.editing, "true");
    await act(async () => {
      conversation.querySelector("textarea")!.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true }));
      await sleep(0);
    });
    assert.equal(document.querySelector(".session-activity-panel") === null, true, "an outside press closes it, arranging or not");
    await act(async () => { popover.toggleSessionStatusPopover(dockLine, "dock"); await sleep(0); });
    assert.equal(document.querySelector<HTMLElement>(".session-activity-details")?.dataset.editing, undefined);
    assert.deepEqual([...document.querySelectorAll(".session-activity-panel-actions button")].map((button) => button.getAttribute("aria-label")), [tr("common.close")]);
  } finally {
    popover.closeSessionStatusPopover();
    await act(async () => root.unmount());
    conversation.remove();
  }
});

test("a header-opened overview is not the panel", async () => {
  const conversation = document.createElement("div");
  conversation.className = "focus-conversation";
  conversation.innerHTML = `<div class="conversation-composer-dock"><div class="host"></div></div>`;
  document.body.append(conversation);
  const root = createRoot(conversation.querySelector(".host")!);
  const header = document.createElement("button");
  document.body.append(header);
  try {
    await act(async () => {
      root.render(createElement(SessionActivityPanelHost, { sessionId: "s1", model }));
      popover.toggleSessionStatusPopover(header, "header");
      await sleep(0);
    });
    assert.equal(document.querySelector(".session-activity-panel") === null, true);
  } finally {
    popover.closeSessionStatusPopover();
    await act(async () => root.unmount());
    conversation.remove();
    header.remove();
  }
});
