// EXTENSION-SEAMS slice 1: reactive slot registry + SlotHost contract.
// Covers deterministic ordering, replacement by id, disposal, late
// registration notifications, stable contribution keys, lazy rendering, and
// one-contribution failure isolation via the per-item error boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement } from "react";
import {
  listSlots, registerSlot, renderSlot, slotVersion, subscribeSlots,
} from "../src/slots.ts";
import {
  SlotBoundary, SlotItemView, placedWidgetItems, slotHostChildren,
} from "../src/components/slots/SlotHost.ts";
import { UI_SLOTS, isUiSlot } from "@polyth/contracts";
import type { WidgetDef } from "../src/widgets/catalog.ts";
import { createDefaultWidgetLayout, moveWidgetToSlot } from "../src/widgets/widgetLayout.ts";

test("listSlots orders by order then id, deterministically", () => {
  const offs = [
    registerSlot("app.nav", "z-late", () => null, 1),
    registerSlot("app.nav", "a-tie", () => null, 5),
    registerSlot("app.nav", "b-tie", () => null, 5),
    registerSlot("app.nav", "first", () => null, 0),
  ];
  try {
    assert.deepEqual(listSlots("app.nav").map((i) => i.id), ["first", "z-late", "a-tie", "b-tie"]);
  } finally {
    for (const off of offs) off();
  }
  assert.deepEqual(listSlots("app.nav"), []);
});

test("re-registering an id replaces the item; a superseded off() is a no-op", () => {
  const offOld = registerSlot("session.header.actions", "dup", () => "old", 10);
  const offNew = registerSlot("session.header.actions", "dup", () => "new", 2);
  try {
    const items = listSlots("session.header.actions");
    assert.equal(items.length, 1);
    assert.equal(items[0]!.order, 2);
    assert.deepEqual(renderSlot("session.header.actions", {}), ["new"]);

    offOld(); // superseded registration must not remove the replacement
    assert.equal(listSlots("session.header.actions").length, 1);
  } finally {
    offNew();
  }
  assert.deepEqual(listSlots("session.header.actions"), []);
});

test("late registration and disposal notify subscribers and bump the version", () => {
  let notified = 0;
  const unsubscribe = subscribeSlots(() => { notified++; });
  const before = slotVersion();

  const off = registerSlot("workStatus.sections", "late", () => null);
  assert.equal(notified, 1);
  assert.equal(slotVersion(), before + 1);

  off();
  assert.equal(notified, 2);
  assert.equal(slotVersion(), before + 2);

  off(); // second dispose is a no-op — no phantom version bumps
  assert.equal(notified, 2);

  unsubscribe();
  const off2 = registerSlot("workStatus.sections", "after-unsub", () => null);
  off2();
  assert.equal(notified, 2);
});

test("slotHostChildren keys each contribution by stable id and defers rendering", () => {
  let invoked = 0;
  const off1 = registerSlot("session.timeline.before", "beta", () => { invoked++; return "b"; }, 2);
  const off2 = registerSlot("session.timeline.before", "alpha", () => { invoked++; return "a"; }, 1);
  try {
    const ctx = { sessionId: "s1" };
    const children = slotHostChildren("session.timeline.before", ctx) as ReactElement[];
    assert.equal(children.length, 2);
    assert.deepEqual(children.map((c) => c.key), ["alpha", "beta"]);
    for (const child of children) {
      assert.ok(isValidElement(child));
      assert.equal(child.type, SlotBoundary);
      const props = child.props as { item: { id: string }; context: unknown };
      assert.equal(props.context, ctx); // host-owned context flows through
    }
    // Element creation must not invoke contributions — only React render does.
    assert.equal(invoked, 0);
  } finally {
    off1();
    off2();
  }
});

test("SlotItemView invokes the contribution with the host context", () => {
  let seen: unknown = null;
  const item = { id: "probe", order: 0, render: (props: Record<string, unknown>) => { seen = props; return "ok"; } };
  const el = SlotItemView({ item, context: { sessionId: "s9" } }) as ReactElement;
  assert.deepEqual(seen, { sessionId: "s9" });
  assert.equal((el.props as { children: unknown }).children, "ok");
});

test("one failing contribution is isolated by its own boundary", () => {
  const boom = { id: "boom", order: 0, render: () => { throw new Error("broken contribution"); } };
  const fine = { id: "fine", order: 1, render: () => "fine" };
  const context = {};

  // Each contribution gets its own boundary instance, so a throw in one
  // subtree cannot unmount the sibling.
  const failing = new SlotBoundary({ slot: "composer.leading", item: boom, context });
  const healthy = new SlotBoundary({ slot: "composer.leading", item: fine, context });

  // The renderer throws inside the boundary's subtree (SlotItemView) …
  assert.throws(() => SlotItemView({ item: boom, context }), /broken contribution/);
  // … React then applies getDerivedStateFromError and the boundary fails closed.
  const derived = SlotBoundary.getDerivedStateFromError();
  assert.deepEqual(derived, { failed: true });
  Object.assign(failing.state, derived);
  assert.equal(failing.render(), null);

  // The sibling boundary still renders its contribution view.
  const el = healthy.render() as ReactElement;
  assert.ok(isValidElement(el));
  assert.equal(el.type, SlotItemView);
  assert.equal((el.props as { item: { id: string } }).item.id, "fine");
});

test("placed mini-widgets render through ordinary UI slot hosts", () => {
  const widget: WidgetDef = {
    id: "sample.action",
    pluginId: "sample",
    title: "Sample action",
    description: "A placeable action",
    kind: "mini-widget",
    defaultSlot: "app.header.actions",
    supportedSlots: ["app.header.actions", "composer.trailing"],
    defaultVisible: true,
    render: ({ sessionId }) => `action:${sessionId ?? "none"}`,
  };
  let layout = createDefaultWidgetLayout([widget]);
  let items = placedWidgetItems("app.header.actions", { sessionId: "s1" }, [widget], layout);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, "widget:sample.action");
  assert.ok(isValidElement(items[0]?.render({ sessionId: "s1" })));

  layout = moveWidgetToSlot(layout, widget.id, "composer.trailing", 0, widget);
  assert.equal(placedWidgetItems("app.header.actions", {}, [widget], layout).length, 0);
  items = placedWidgetItems("composer.trailing", {}, [widget], layout);
  assert.equal(items.length, 1);
});

// EXT-SEAMS-V1 (pure half; the mounted proof lives in slotHostMounted.test.ts):
// the boundary keys by contribution id, so a same-id registration replacement
// must reset a failed boundary while an unchanged registration stays closed.
test("SlotBoundary resets on item replacement but stays failed for the same item", () => {
  const broken = { id: "flaky", order: 0, render: () => { throw new Error("broken"); } };
  const fixed = { id: "flaky", order: 0, render: () => "recovered" };
  const props = { slot: "composer.leading" as const, item: broken, context: {} };

  // Mount: derived state adopts the registration, boundary is open.
  let state = { failed: false, item: null as unknown };
  Object.assign(state, SlotBoundary.getDerivedStateFromProps(props, state as never));
  assert.deepEqual(state, { failed: false, item: broken });

  // Throw: fails closed; a re-render with the *same* registration keeps it closed.
  Object.assign(state, SlotBoundary.getDerivedStateFromError());
  assert.equal(state.failed, true);
  assert.equal(SlotBoundary.getDerivedStateFromProps(props, state as never), null);

  // Same-id replacement (new SlotItem): the boundary reopens for the fix.
  const replaced = SlotBoundary.getDerivedStateFromProps({ ...props, item: fixed }, state as never);
  assert.deepEqual(replaced, { failed: false, item: fixed });
});

test("contracts expose the runtime slot vocabulary used for validation", () => {
  assert.ok(UI_SLOTS.length >= 19);
  assert.ok(isUiSlot("composer.leading"));
  assert.ok(isUiSlot("session.timeline.after"));
  assert.ok(isUiSlot("widget.catalog"));
  assert.ok(isUiSlot("widget.settings"));
  assert.ok(isUiSlot("workspace.canvas"));
  assert.ok(isUiSlot("workspace.main"));
  assert.ok(isUiSlot("app.header.actions"));
  assert.ok(!isUiSlot("not.a.slot"));
});
