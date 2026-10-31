// `kind: "command"` capabilities (one per custom action, for example): a
// press acts without touching the open pane, each is its own launcher rather
// than sharing its package's rail slot, the right rail can draw it without a
// pane, and its own mark replaces the package mark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerCapability, type CapabilityDescriptor } from "../src/capabilities.ts";
import { isCapabilityActive, toggleCapability } from "../src/builtinCapabilities.ts";
import { uniquePackageLaunchers } from "../src/packageLaunchers.ts";
import { railDestinationIds } from "../src/railPlacement.ts";
import { railIconFor } from "../src/railIcons.ts";
import { getState, setRailPlugin } from "../src/store.ts";

function command(id: string, over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id,
    ownerPackageId: "custom-action",
    kind: "command",
    label: id,
    plainDescription: id,
    keywords: [],
    standardTier: "more",
    standardRank: 24,
    open: () => {},
    available: () => true,
    ...over,
  };
}

test("a command press runs without closing the open pane and is never active", () => {
  let pressed = 0;
  const dispose = registerCapability(command("custom-action.run.a", { open: () => { pressed += 1; } }));
  setRailPlugin("events");
  try {
    toggleCapability("custom-action.run.a", () => { pressed += 1; });
    toggleCapability("custom-action.run.a", () => { pressed += 1; });
    assert.equal(pressed, 2, "every press acts; a command is not a toggle");
    assert.equal(getState().railPlugin, "events", "the open pane stays open");
    assert.equal(isCapabilityActive("custom-action.run.a"), false);
  } finally {
    setRailPlugin(null);
    dispose();
  }
});

test("command launchers are each their own rail entry; destinations still group by package", () => {
  const entries = [
    { id: "custom-action", ownerPackageId: "custom-action" },
    { id: "custom-action.run.a", ownerPackageId: "custom-action", kind: "command" as const },
    { id: "custom-action.run.b", ownerPackageId: "custom-action", kind: "command" as const },
    { id: "markets.overview", ownerPackageId: "markets" },
    { id: "markets.portfolio", ownerPackageId: "markets" },
  ];
  assert.deepEqual(uniquePackageLaunchers(entries, (entry) => entry).map((entry) => entry.id),
    ["custom-action", "custom-action.run.a", "custom-action.run.b", "markets.overview"]);
});

test("the right rail can draw a command launcher without a pane", () => {
  const dispose = registerCapability(command("custom-action.run.b"));
  try {
    assert.equal(railDestinationIds().has("custom-action.run.b"), true);
  } finally {
    dispose();
  }
  assert.equal(railDestinationIds().has("custom-action.run.b"), false);
});

test("a capability's own mark wins over its package mark, with the rail's size", () => {
  const Mark = (props: { size?: number; strokeWidth?: number }) =>
    createElement("svg", { "data-mark": "own", "data-size": props.size, "data-stroke": props.strokeWidth });
  const packageMark = renderToStaticMarkup(createElement(railIconFor("custom-action.run.c")));
  const dispose = registerCapability(command("custom-action.run.c", { icon: Mark }));
  try {
    const first = railIconFor("custom-action.run.c");
    assert.equal(railIconFor("custom-action.run.c"), first, "stable identity: no remount per render");
    const html = renderToStaticMarkup(createElement(first));
    assert.match(html, /data-mark="own"/);
    assert.match(html, /data-size="15"/);
    assert.match(html, /data-stroke="1.8"/);
  } finally {
    dispose();
  }
  assert.equal(renderToStaticMarkup(createElement(railIconFor("custom-action.run.c"))), packageMark,
    "after disposal the package mark returns");
});
