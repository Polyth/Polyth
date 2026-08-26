// Capability-registry gates: metadata invariants, disclosure grouping,
// registry semantics, per-project placement resolution, and built-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_CAPABILITY_META, GROUP_ORDER, TECHNICAL_GROUP_LABEL,
  capabilityGroup, getCapability, listCapabilities, registerCapability,
  resolveCapabilities, subscribeCapabilities,
  type CapabilityDescriptor,
} from "../src/capabilities.ts";
import {
  PANEL_OF_CAPABILITY, PANE_OF_CAPABILITY, VIEW_OF_CAPABILITY,
} from "../src/builtinCapabilities.ts";
import { closeWorkspacePane, getState, openWorkspacePane, setActiveView, setSidebarOpen } from "../src/store.ts";
import { registerSurface } from "../src/surfaces.ts";
import { getWorkspaceMode, setWorkspaceMode } from "../src/widgets/workspaceMode.ts";

function fakeDescriptor(id: string, over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id,
    label: `Fake ${id}`,
    plainDescription: `Does ${id}.`,
    keywords: [id],
    standardTier: "more",
    standardRank: 99,
    open: () => {},
    available: () => true,
    ...over,
  };
}

// ---- pure metadata invariants -------------------------------------------------

test("built-in metadata: unique ids, non-empty labels/descriptions, keywords for search", () => {
  const ids = new Set<string>();
  for (const m of BUILTIN_CAPABILITY_META) {
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    assert.ok(m.label.trim().length > 0, `${m.id} has a visible label`);
    assert.ok(m.plainDescription.trim().length > 0, `${m.id} has a plain description`);
    assert.ok(m.keywords.length > 0, `${m.id} is searchable`);
    assert.ok(["primary", "more", "technical"].includes(m.standardTier));
    assert.ok(Number.isFinite(m.standardRank));
  }
});

test("shell-owned labels avoid feature jargon", () => {
  const jargon = ["multi-run", "fusion", "cron", "stt", "tts"];
  for (const m of BUILTIN_CAPABILITY_META) {
    const label = m.label.toLowerCase();
    for (const term of jargon) assert.ok(!label.includes(term), `${m.id} label avoids "${term}"`);
  }
});

// ---- disclosure grouping -----------------------------------------------------

test("every built-in capability belongs to a named group; groups are ordered; unknown ids default to More tools", () => {
  for (const m of BUILTIN_CAPABILITY_META) {
    const group = capabilityGroup(m.id);
    assert.ok(GROUP_ORDER.includes(group), `${m.id} group "${group}" is a known group`);
  }
  assert.equal(capabilityGroup("some-new-extension"), "More tools");
  assert.equal(GROUP_ORDER[GROUP_ORDER.length - 1], TECHNICAL_GROUP_LABEL, "technical group comes last");
});

test("technical capabilities group under Technical options", () => {
  for (const id of ["git", "terminal", "models-agents", "events", "diagnostics"]) {
    assert.equal(capabilityGroup(id), TECHNICAL_GROUP_LABEL, id);
  }
});

test("Terminal retains its technical disclosure group when package-registered", () => {
  assert.equal(capabilityGroup("terminal"), TECHNICAL_GROUP_LABEL);
});

// ---- registry semantics ------------------------------------------------------

test("register/replace/dispose: replace by id, dispose by identity, listeners fire", async () => {
  await import("../src/builtinCapabilities.ts"); // built-ins registered on import
  const before = listCapabilities().length;
  let fired = 0;
  const unsub = subscribeCapabilities(() => { fired++; });

  const a = fakeDescriptor("test-ext");
  const disposeA = registerCapability(a);
  assert.equal(listCapabilities().length, before + 1);
  assert.equal(getCapability("test-ext"), a);
  assert.ok(fired >= 1, "registration notifies subscribers");

  // Replacing by id: the newer descriptor wins; the stale dispose is a no-op.
  const b = fakeDescriptor("test-ext", { label: "Fake v2" });
  const disposeB = registerCapability(b);
  assert.equal(getCapability("test-ext"), b);
  disposeA();
  assert.equal(getCapability("test-ext"), b, "stale dispose must not remove the replacement");

  disposeB();
  assert.equal(getCapability("test-ext"), null);
  assert.equal(listCapabilities().length, before);
  unsub();
});

test("dynamically registered capability appears in resolution immediately with its default tier", () => {
  const dispose = registerCapability(fakeDescriptor("late-ext", { standardTier: "more", standardRank: 50 }));
  try {
    const resolved = resolveCapabilities(listCapabilities());
    const entry = resolved.find((r) => r.descriptor.id === "late-ext");
    assert.ok(entry);
    assert.equal(entry.tier, "more");
  } finally {
    dispose();
  }
});

// ---- per-project placement resolution ----------------------------------------

test("placement overrides never add or remove capabilities", () => {
  const caps = listCapabilities();
  const standardIds = resolveCapabilities(caps).map((r) => r.descriptor.id).sort();
  const movedIds = resolveCapabilities(caps, {
    terminal: { tier: "primary", rank: 0.5 },
  }).map((r) => r.descriptor.id).sort();
  assert.deepEqual(movedIds, standardIds);
});

test("availability is a runtime property, independent of placement", () => {
  const caps = listCapabilities();
  for (const r of resolveCapabilities(caps)) {
    assert.equal(typeof r.descriptor.available(), "boolean");
  }
});

test("resolution honors explicit overrides and is deterministically ordered", () => {
  const dispose = registerCapability(fakeDescriptor("terminal"));
  try {
    const caps = listCapabilities();
    const resolved = resolveCapabilities(caps, {
      terminal: { tier: "primary", rank: 0.5 },
    });
    const primary = resolved.filter((r) => r.tier === "primary").map((r) => r.descriptor.id);
    assert.ok(primary.includes("terminal"), "explicit promotion wins over the preset");
    const again = resolveCapabilities(caps, {
      terminal: { tier: "primary", rank: 0.5 },
    });
    assert.deepEqual(
      again.map((r) => `${r.descriptor.id}:${r.tier}:${r.rank}`),
      resolved.map((r) => `${r.descriptor.id}:${r.tier}:${r.rank}`),
      "same inputs, same order",
    );
  } finally {
    dispose();
  }
});

// ---- built-in registration ----------------------------------------------------

test("shell-owned capabilities register immediately", async () => {
  await import("../src/builtinCapabilities.ts");
  for (const m of BUILTIN_CAPABILITY_META) {
    const d = getCapability(m.id);
    assert.ok(d, `${m.id} registered`);
    assert.equal(typeof d.open, "function");
    assert.equal(typeof d.available, "function");
    assert.equal(d.label, m.label);
  }
});

test("every built-in capability opens one concrete destination", () => {
  for (const m of BUILTIN_CAPABILITY_META) {
    const hasView = m.id in VIEW_OF_CAPABILITY;
    const hasPanel = m.id in PANEL_OF_CAPABILITY;
    const hasPane = m.id in PANE_OF_CAPABILITY;
    const isSettings = ["models-agents", "diagnostics", "voice"].includes(m.id);
    const destinationKinds = [hasView, hasPanel, hasPane, isSettings].filter(Boolean);
    assert.ok(destinationKinds.length > 0, `${m.id} has a concrete destination`);
    assert.equal(destinationKinds.length, 1, `${m.id} has exactly one destination kind`);
  }
});

test("a dynamically registered primary capability can reveal its destination", () => {
  const dispose = registerSurface({
    id: "test-covering-pane",
    title: "Covering pane",
    order: 999,
    component: () => null,
    presentation: {
      kind: "workspace",
      defaultRatio: 0.5,
      minWidth: 320,
      preferredMaxWidth: 720,
      keepAlive: true,
      escape: "close",
    },
  });
  try {
    setActiveView("session");
    assert.equal(openWorkspacePane("test-covering-pane"), true);
    setSidebarOpen(true);
    setWorkspaceMode("widgets");

    const unregister = registerCapability(fakeDescriptor("github", {
      open: () => {
        closeWorkspacePane();
        setActiveView("github");
        setSidebarOpen(false);
        setWorkspaceMode("chat");
      },
    }));
    getCapability("github")!.open();
    unregister();

    assert.equal(getState().activeView, "github");
    assert.equal(getState().railPlugin, null, "the covering pane is closed");
    assert.equal(getState().sidebarOpen, false, "the compact drawer is closed");
    assert.equal(getWorkspaceMode(), "chat", "the primary workspace is visible");
  } finally {
    setSidebarOpen(false);
    setActiveView("session");
    setWorkspaceMode("chat");
    dispose();
  }
});
