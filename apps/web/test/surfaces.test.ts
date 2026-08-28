// F17 right-pane surface host: registry ordering/replacement, plugin gating +
// content-driven visibility, the workspace.right.tabs slot bridge, and
// polyth.railPrefs parsing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  listSurfaces, registerSurface, slotSurfaces, visibleSurfaces,
  type RailSurface, type RailSurfaceContext,
} from "../src/surfaces.ts";
import { registerSlot } from "../src/slots.ts";
import { RAIL_WIDTH_DEFAULT, clampRailWidth, parseRailPrefs } from "../src/railPrefs.ts";

const surface = (id: string, order: number, extra: Partial<RailSurface> = {}): RailSurface => ({
  id, title: id.toUpperCase(), order, component: () => null, ...extra,
});

const ctx = (over: Partial<RailSurfaceContext> = {}): RailSurfaceContext => ({
  changeCount: 0, eventCount: 0, totalTokens: 0, hasSession: false, ...over,
});

test("registry orders by order then id, replaces by id, unregisters", () => {
  registerSurface(surface("b-two", 20));
  registerSurface(surface("a-one", 10));
  registerSurface(surface("c-tie", 20));
  assert.deepEqual(listSurfaces().map((s) => s.id), ["a-one", "b-two", "c-tie"]);

  // re-registering the same id replaces the entry (new order applies)
  const offA = registerSurface(surface("a-one", 30));
  assert.deepEqual(listSurfaces().map((s) => s.id), ["b-two", "c-tie", "a-one"]);

  // an off() from a superseded registration must not remove the replacement
  const offB = registerSurface(surface("b-two", 20));
  registerSurface(surface("b-two", 5)); // replaces again
  offB();
  assert.ok(listSurfaces().some((s) => s.id === "b-two" && s.order === 5));

  offA();
  registerSurface(surface("b-two", 5))();
  registerSurface(surface("c-tie", 20))();
  assert.deepEqual(listSurfaces(), []);
});

test("visibleSurfaces gates on content-driven visibility only — no plugin allow-list (UX-PERSONAS)", () => {
  const list: RailSurface[] = [
    surface("always", 1),
    surface("capability", 2, { capabilityId: "git" }),
    surface("content", 3, { visible: (c) => c.totalTokens > 0 }),
  ];
  // A capability id is placement metadata, never an availability gate.
  assert.deepEqual(visibleSurfaces(list, ctx()).map((s) => s.id), ["always", "capability"]);
  assert.deepEqual(
    visibleSurfaces(list, ctx({ totalTokens: 5 })).map((s) => s.id),
    ["always", "capability", "content"],
  );
});

test("workspace.right.tabs slot items become surfaces without registry edits", () => {
  const PluginIcon = () => null;
  const off = registerSlot("workspace.right.tabs", "my-plugin", () => null, 2, {
    title: "My plugin",
    capabilityId: "my-capability",
    icon: PluginIcon,
  });
  const off2 = registerSlot("workspace.right.tabs", "bare", () => null, 1);
  try {
    const bridged = slotSurfaces(ctx());
    assert.deepEqual(bridged.map((s) => s.id), ["slot:bare", "slot:my-plugin"]);
    assert.equal(bridged[1]!.title, "My plugin");
    assert.equal(bridged[1]!.capabilityId, "my-capability");
    assert.equal(bridged[1]!.icon, PluginIcon);
    assert.equal(bridged[0]!.title, "bare"); // falls back to the slot id
    assert.equal(bridged[0]!.capabilityId, undefined);
    assert.equal(bridged[0]!.icon, undefined);
    assert.ok(bridged.every((s) => s.order >= 100)); // plugins sort after built-ins
  } finally {
    off();
    off2();
  }
  assert.equal(slotSurfaces(ctx()).length, 0);
});

// EXT-SEAMS-V2 regression: the bridge must hand every bridged renderer the
// host's already-derived RailSurfaceContext — not {} — so contributed panels
// consume shared counts instead of creating independent fetchers.
test("slotSurfaces threads the shared RailSurfaceContext to bridged renderers", () => {
  let seen: Record<string, unknown> | null = null;
  const off = registerSlot("workspace.right.tabs", "ctx-probe", (props) => { seen = props; return null; });
  try {
    const shared = ctx({ changeCount: 3, eventCount: 41, totalTokens: 1234, hasSession: true });
    slotSurfaces(shared)[0]!.component();
    assert.deepEqual(seen, { changeCount: 3, eventCount: 41, totalTokens: 1234, hasSession: true });

    // The context is re-derived per render: a later invocation with fresh
    // counts must reach the renderer, not a stale captured snapshot.
    slotSurfaces(ctx({ changeCount: 0, eventCount: 42, totalTokens: 1300, hasSession: true }))[0]!.component();
    assert.deepEqual(seen, { changeCount: 0, eventCount: 42, totalTokens: 1300, hasSession: true });
  } finally {
    off();
  }
});

test("parseRailPrefs round-trips, clamps widths, survives garbage", () => {
  const prefs = parseRailPrefs(JSON.stringify({ lastOpen: "files", widths: { files: 400, changes: 9999, bogus: "x" } }));
  assert.equal(prefs.lastOpen, "files");
  assert.equal(prefs.widths.files, 400);
  assert.equal(prefs.widths.changes, clampRailWidth(9999)); // clamped to max
  assert.equal(prefs.widths.bogus, undefined);
  assert.deepEqual(parseRailPrefs(null), { lastOpen: null, widths: {} });
  assert.deepEqual(parseRailPrefs("junk"), { lastOpen: null, widths: {} });
  assert.equal(parseRailPrefs(JSON.stringify({ lastOpen: "" })).lastOpen, null);
  assert.equal(clampRailWidth(10), 240);
  assert.equal(clampRailWidth(10_000), 640);
  assert.equal(RAIL_WIDTH_DEFAULT, 300);
});

test("the Usage package owns its rail surface", async () => {
  const source = await readFile(
    new URL("../../../packages/usage/widgets/index.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('host.surfaces.register'));
  assert.ok(source.includes('id: "usage"'));
  assert.ok(source.includes("component: UsageDashboard"));
  assert.ok(!source.includes("visible:"), "zero tokens never hide the Usage command");
});
