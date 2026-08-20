// UX-PERSONAS capability-registry gates: pure metadata invariants, plain
// disclosure grouping, registry replace/dispose semantics, resolution
// stability across presets, and the built-in registration (navigation only,
// never a filter).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_CAPABILITY_META, GROUP_ORDER, TECHNICAL_GROUP_LABEL,
  capabilityGroup, getCapability, listCapabilities, registerCapability,
  resolveCapabilities, subscribeCapabilities,
  type CapabilityDescriptor,
} from "../src/capabilities.ts";
import { WORKSPACE_PRESETS, type WorkspacePresetId } from "../src/workspacePresets.ts";
import {
  PANEL_OF_CAPABILITY, VIEW_OF_CAPABILITY,
} from "../src/builtinCapabilities.ts";

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

test("legacy searchable names survive as keywords so existing users are not stranded", () => {
  const byId = new Map(BUILTIN_CAPABILITY_META.map((m) => [m.id, m]));
  assert.ok(byId.get("multirun")!.keywords.some((k) => k.includes("multi-run")));
  assert.ok(byId.get("fusion")!.keywords.includes("fusion"));
  assert.ok(byId.get("git")!.keywords.includes("git"));
  assert.ok(byId.get("voice")!.keywords.includes("dictation"));
  assert.ok(byId.get("diagnostics")!.keywords.includes("plugin"));
});

test("plain-language labels: primary-tier copy avoids jargon; technical names live in technicalLabel", () => {
  const jargon = ["multi-run", "fusion", "cron", "stt", "tts"];
  for (const m of BUILTIN_CAPABILITY_META) {
    const label = m.label.toLowerCase();
    for (const term of jargon) assert.ok(!label.includes(term), `${m.id} label avoids "${term}"`);
  }
  const multirun = BUILTIN_CAPABILITY_META.find((m) => m.id === "multirun")!;
  assert.equal(multirun.label, "Compare responses");
  assert.equal(multirun.technicalLabel, "Multi-Run");
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
    for (const presetId of [null, ...WORKSPACE_PRESETS.map((p) => p.id)] as Array<WorkspacePresetId | null>) {
      const resolved = resolveCapabilities(listCapabilities(), presetId);
      const entry = resolved.find((r) => r.descriptor.id === "late-ext");
      assert.ok(entry, `late-ext resolved under ${presetId ?? "standard"}`);
      assert.equal(entry.tier, "more", "unknown-to-presets capability keeps its standard tier");
    }
  } finally {
    dispose();
  }
});

// ---- resolution stability across presets --------------------------------------

test("presets re-place capabilities but never add or remove them", () => {
  const caps = listCapabilities();
  const standardIds = resolveCapabilities(caps, null).map((r) => r.descriptor.id).sort();
  for (const preset of WORKSPACE_PRESETS) {
    const ids = resolveCapabilities(caps, preset.id).map((r) => r.descriptor.id).sort();
    assert.deepEqual(ids, standardIds, `${preset.id} exposes exactly the same capability set`);
  }
});

test("availability is a runtime property, independent of preset selection", () => {
  const caps = listCapabilities();
  for (const preset of WORKSPACE_PRESETS) {
    for (const r of resolveCapabilities(caps, preset.id)) {
      // available() takes no preset input; calling it under any preset returns
      // the same runtime answer and never throws.
      assert.equal(typeof r.descriptor.available(), "boolean");
    }
  }
});

test("resolution honors explicit overrides over presets and is deterministically ordered", () => {
  const caps = listCapabilities();
  const resolved = resolveCapabilities(caps, "plan-coordinate", {
    terminal: { tier: "primary", rank: 0.5 },
  });
  const primary = resolved.filter((r) => r.tier === "primary").map((r) => r.descriptor.id);
  assert.ok(primary.includes("terminal"), "explicit promotion wins over the preset");
  const again = resolveCapabilities(caps, "plan-coordinate", {
    terminal: { tier: "primary", rank: 0.5 },
  });
  assert.deepEqual(
    again.map((r) => `${r.descriptor.id}:${r.tier}:${r.rank}`),
    resolved.map((r) => `${r.descriptor.id}:${r.tier}:${r.rank}`),
    "same inputs, same order",
  );
});

// ---- built-in registration ----------------------------------------------------

test("all built-in metadata is registered with open + available attached", async () => {
  await import("../src/builtinCapabilities.ts");
  for (const m of BUILTIN_CAPABILITY_META) {
    const d = getCapability(m.id);
    assert.ok(d, `${m.id} registered`);
    assert.equal(typeof d.open, "function");
    assert.equal(typeof d.available, "function");
    assert.equal(d.label, m.label);
  }
});

test("every built-in capability opens something concrete: a view, a panel, or a settings page", () => {
  for (const m of BUILTIN_CAPABILITY_META) {
    const hasView = m.id in VIEW_OF_CAPABILITY;
    const hasPanel = m.id in PANEL_OF_CAPABILITY;
    const isSettings = ["models-agents", "diagnostics", "voice"].includes(m.id);
    assert.ok(hasView || hasPanel || isSettings, `${m.id} has a concrete destination`);
    assert.ok(!(hasView && hasPanel), `${m.id} has exactly one destination kind`);
  }
});
