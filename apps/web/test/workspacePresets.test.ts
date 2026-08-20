// UX-PERSONAS pure gates: defensive persistence parsing, one-time legacy
// migration, preset/override resolution, schema-generated copy, and the
// prohibited-vocabulary rules for Plan & coordinate and Design & explore.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_PERSONA_PLUGINS, MAX_OVERRIDE_ENTRIES, NO_PRESET_CARD, OPTIONAL_SETUP_COPY,
  PRESET_STORE_KEY, PRESENTATION_STORE_KEY, STANDARD_STARTER_IDS, STARTER_LABELS,
  SUMMARY_FOOTER, WORKSPACE_PRESETS,
  applyPreset, clearPreset, completePresetSetup, effectiveComposerDetail,
  formatPresetSummary, getPresentation, getPresetState, migrateLegacyPrefs,
  parsePresentationRecord, parsePresetRecord, presetById, presetSummary,
  reloadPresetStateForTest, resetDisclosureChoices, resetWorkspaceOrder,
  resolvePlacements, setComposerDetail, setMoreToolsOpen, setPlacementOverride,
  setStarterOrder, starterIdsFor, starterLabelsFor,
  type CapabilityPlacementInput, type WorkspacePresetId,
} from "../src/workspacePresets.ts";
import { BUILTIN_CAPABILITY_META } from "../src/capabilities.ts";

const CAPS: CapabilityPlacementInput[] = BUILTIN_CAPABILITY_META.map((m) => ({
  id: m.id, standardTier: m.standardTier, standardRank: m.standardRank,
}));

const SUMMARY_CAPS = BUILTIN_CAPABILITY_META.map((m) => ({
  id: m.id, standardTier: m.standardTier, standardRank: m.standardRank,
  label: m.label, available: true,
}));

// ---- gate 1: defensive persistence parsing ---------------------------------

test("parsePresetRecord round-trips a valid record", () => {
  const rec = parsePresetRecord(JSON.stringify({
    version: 1, setup: "completed", presetId: "plan-coordinate", composerDetail: null, moreToolsOpen: false,
  }));
  assert.deepEqual(rec, {
    version: 1, setup: "completed", presetId: "plan-coordinate", composerDetail: null, moreToolsOpen: false,
  });
});

test("parsePresetRecord rejects malformed, unknown-value, future-version, and oversized data without throwing", () => {
  const fallback = { version: 1, setup: "unseen", presetId: null, composerDetail: null, moreToolsOpen: false };
  assert.deepEqual(parsePresetRecord(null), fallback);
  assert.deepEqual(parsePresetRecord("not-json"), fallback);
  assert.deepEqual(parsePresetRecord("[1,2,3]"), fallback);
  assert.deepEqual(parsePresetRecord(JSON.stringify({ version: 2, setup: "completed", presetId: "build-debug" })), fallback);
  assert.deepEqual(parsePresetRecord(JSON.stringify({ version: 1, setup: "weird", presetId: null })), fallback);
  assert.deepEqual(parsePresetRecord(JSON.stringify({ version: 1, setup: "completed", presetId: "hacker-preset" })), fallback);
  // Unknown detail values reset to null; unknown fields are dropped.
  const noisy = parsePresetRecord(JSON.stringify({
    version: 1, setup: "completed", presetId: "build-debug", composerDetail: "loud", extra: "x".repeat(100_000),
  }));
  assert.equal(noisy.composerDetail, null);
  assert.equal(noisy.presetId, "build-debug");
  assert.ok(!("extra" in noisy));
  // Oversized: a huge record still parses in bounded form.
  const big = JSON.stringify({ version: 1, setup: "unseen", presetId: null, junk: "y".repeat(1_000_000) });
  assert.equal(parsePresetRecord(big).setup, "unseen");
});

test("parsePresentationRecord caps override maps at 128 entries and drops garbage", () => {
  const placements: Record<string, unknown> = {};
  for (let i = 0; i < 300; i++) placements[`cap-${i}`] = { tier: "more", rank: i };
  placements.bad1 = { tier: "hidden", rank: 1 };
  placements.bad2 = { tier: "more", rank: "NaN" };
  const rec = parsePresentationRecord(JSON.stringify({ version: 1, placements, starterOrder: ["explore-code", 42] }));
  assert.ok(Object.keys(rec.placements).length <= MAX_OVERRIDE_ENTRIES);
  assert.ok(!("bad1" in rec.placements));
  assert.ok(!("bad2" in rec.placements));
  assert.deepEqual(rec.starterOrder, ["explore-code"]);
  assert.deepEqual(parsePresentationRecord("junk"), { version: 1, placements: {}, starterOrder: null });
  assert.deepEqual(parsePresentationRecord(JSON.stringify({ version: 9 })), { version: 1, placements: {}, starterOrder: null });
});

// ---- gate 2: one-time legacy migration ---------------------------------------

test("migrateLegacyPrefs maps all four legacy ids and absent/invalid data", () => {
  const cases: Array<[string | null, WorkspacePresetId | null, "completed" | "unseen"]> = [
    [JSON.stringify({ persona: "engineer", plugins: [] }), "build-debug", "completed"],
    [JSON.stringify({ persona: "manager", plugins: [] }), "plan-coordinate", "completed"],
    [JSON.stringify({ persona: "creator", plugins: [] }), "design-explore", "completed"],
    [JSON.stringify({ persona: "blank", plugins: [] }), null, "completed"],
    [null, null, "unseen"],
    ["not-json", null, "unseen"],
    [JSON.stringify({ persona: "wizard" }), null, "unseen"],
  ];
  for (const [raw, presetId, setup] of cases) {
    const { record } = migrateLegacyPrefs(raw);
    assert.equal(record.presetId, presetId, `presetId for ${raw}`);
    assert.equal(record.setup, setup, `setup for ${raw}`);
    assert.equal(record.composerDetail, null);
  }
});

test("migration discards unchanged persona-default membership (it was preset-owned filtering)", () => {
  for (const persona of Object.keys(LEGACY_PERSONA_PLUGINS)) {
    const exact = migrateLegacyPrefs(JSON.stringify({ persona, plugins: LEGACY_PERSONA_PLUGINS[persona] }));
    assert.deepEqual(exact.presentation.placements, {}, `${persona} exact defaults produce no overrides`);
    const empty = migrateLegacyPrefs(JSON.stringify({ persona, plugins: [] }));
    assert.deepEqual(empty.presentation.placements, {}, `${persona} empty list means defaults`);
  }
});

test("migration converts added ids to promotions and removed ids to More tools placements — never hidden", () => {
  // creator defaults: session, preview, files. User added git; removed preview.
  const { presentation } = migrateLegacyPrefs(JSON.stringify({
    persona: "creator", plugins: ["session", "files", "git"],
  }));
  assert.equal(presentation.placements.git?.tier, "primary", "user-added id is promoted");
  assert.equal(presentation.placements.preview?.tier, "more", "user-removed default lands in More tools, not hidden");
  // dictation maps to the voice capability
  const withVoice = migrateLegacyPrefs(JSON.stringify({
    persona: "creator", plugins: ["session", "preview", "files", "dictation"],
  }));
  assert.equal(withVoice.presentation.placements.voice?.tier, "primary");
  // No migrated capability may become hidden: every override has a real tier.
  for (const p of Object.values(presentation.placements)) {
    assert.ok(["primary", "more", "technical"].includes(p.tier));
  }
});

// ---- gate 3: resolution tables, override precedence, stable order --------------

test("standard resolution: primary order is Chat; Project files; Preview; Goals & progress", () => {
  const primary = resolvePlacements(CAPS, null).filter((p) => p.tier === "primary").map((p) => p.id);
  assert.deepEqual(primary, ["session", "files", "preview", "goals"]);
});

test("preset resolutions match the required arrangements and never drop a capability", () => {
  const expected: Record<WorkspacePresetId, string[]> = {
    "build-debug": ["session", "files", "git", "terminal", "preview"],
    "plan-coordinate": ["session", "goals", "usage", "schedule", "walkthrough"],
    "design-explore": ["session", "preview", "files", "voice"],
  };
  for (const preset of WORKSPACE_PRESETS) {
    const resolved = resolvePlacements(CAPS, preset.id);
    const primary = resolved.filter((p) => p.tier === "primary").map((p) => p.id);
    assert.deepEqual(primary, expected[preset.id], preset.id);
    // Presets change tier/rank only: every capability remains placed.
    assert.equal(resolved.length, CAPS.length, `${preset.id} keeps every capability`);
    for (const p of resolved) assert.ok(["primary", "more", "technical"].includes(p.tier));
  }
});

test("the technical group keeps Source control, Terminal, Models & agents, Event log, and diagnostics reachable from every preset", () => {
  for (const presetId of [null, ...WORKSPACE_PRESETS.map((p) => p.id)] as Array<WorkspacePresetId | null>) {
    const resolved = resolvePlacements(CAPS, presetId);
    for (const id of ["models-agents", "events", "diagnostics"]) {
      assert.ok(resolved.some((p) => p.id === id), `${id} placed under ${presetId ?? "standard"}`);
    }
  }
});

test("explicit overrides win over preset suggestions; ordering is stable", () => {
  const resolved = resolvePlacements(CAPS, "build-debug", {
    terminal: { tier: "more", rank: 1 },
    goals: { tier: "primary", rank: 2.5 },
  });
  const primary = resolved.filter((p) => p.tier === "primary").map((p) => p.id);
  assert.ok(!primary.includes("terminal"), "override demotes terminal despite the preset");
  assert.ok(primary.includes("goals"), "override promotes goals despite the preset");
  assert.deepEqual(primary, ["session", "files", "git", "goals", "preview"]);
  // Deterministic tie-break on equal ranks: id order.
  const tied = resolvePlacements(
    [
      { id: "b", standardTier: "more", standardRank: 1 },
      { id: "a", standardTier: "more", standardRank: 1 },
    ],
    null,
  );
  assert.deepEqual(tied.map((p) => p.id), ["a", "b"]);
  // Unknown override ids are ignored, not resurrected.
  const ghost = resolvePlacements(CAPS, null, { "not-a-capability": { tier: "primary", rank: 0 } });
  assert.equal(ghost.length, CAPS.length);
});

// ---- gate 6: schema-generated copy and prohibited vocabulary --------------------

test("cards, confirmation labels, and starter order come from the schema", () => {
  assert.equal(WORKSPACE_PRESETS.length, 3);
  for (const p of WORKSPACE_PRESETS) {
    assert.ok(p.label.length > 0 && p.description.length > 0);
    assert.equal(p.confirmationLabel, `Use ${p.label} preset`);
    assert.equal(p.starterIds.length, 5);
    for (const id of p.starterIds) assert.ok(id in STARTER_LABELS, `starter ${id} has a label`);
  }
  assert.equal(NO_PRESET_CARD.confirmationLabel, "Continue without a preset");
  assert.deepEqual(starterIdsFor(null), STANDARD_STARTER_IDS);
  assert.deepEqual(
    starterLabelsFor(null),
    ["Explore this project", "Explain what’s here", "Plan a next step", "Review recent work", "Help me get started"],
  );
  assert.deepEqual(
    starterLabelsFor("plan-coordinate"),
    ["Catch me up", "Turn this into a plan", "Summarize progress", "Identify risks", "Suggest the next action"],
  );
  // Explicit starter override wins; unknown ids are dropped.
  assert.deepEqual(starterIdsFor("build-debug", ["catch-me-up", "bogus"]), ["catch-me-up"]);
});

test("Plan and Design primary copy avoids the prohibited technical vocabulary", () => {
  const prohibited = ["diff", "git", "terminal", "model", "agent", "profile", "plugin", "!", "/", "#", "@"];
  for (const id of ["plan-coordinate", "design-explore"] as const) {
    const p = presetById(id)!;
    const copy = [p.label, p.description, p.confirmationLabel, ...p.starterIds.map((s) => STARTER_LABELS[s]!)]
      .join(" ")
      .toLowerCase();
    for (const term of prohibited) {
      assert.ok(!copy.includes(term), `${id} copy must not contain "${term}"`);
    }
  }
});

test("optional-setup copy is exact and names only implemented effects", () => {
  assert.equal(OPTIONAL_SETUP_COPY.kicker, "Optional setup");
  assert.equal(OPTIONAL_SETUP_COPY.heading, "What should Polyth put within easy reach?");
  assert.ok(!OPTIONAL_SETUP_COPY.description.includes("shortcut"), "no shortcut promise until the schema drives shortcuts");
  assert.ok(OPTIONAL_SETUP_COPY.description.includes("won’t hide tools"));
  for (const term of ["persona", "role", "profile", "learn", "adapt"]) {
    assert.ok(!OPTIONAL_SETUP_COPY.description.toLowerCase().includes(term), `copy must not use "${term}"`);
  }
});

test("presetSummary reports only effective differences and omits unavailable capabilities", () => {
  const summary = presetSummary({
    presetId: "build-debug", currentPresetId: null, caps: SUMMARY_CAPS,
  });
  assert.equal(summary.label, "Build & debug");
  assert.deepEqual(summary.primaryOrder, ["Chat", "Project files", "Source control", "Terminal", "Preview"]);
  assert.equal(summary.composerDetail, "technical");
  assert.ok(summary.bullets.some((b) => b.includes("Project files, Source control, Terminal, and Preview")));
  assert.ok(summary.bullets.some((b) => b === "start Technical options open"));
  assert.equal(summary.footer, SUMMARY_FOOTER);
  const text = formatPresetSummary(summary);
  assert.ok(text.startsWith("Build & debug will:\n• "));
  assert.ok(text.endsWith(SUMMARY_FOOTER));

  // Same selection = no promised changes.
  const same = presetSummary({ presetId: null, currentPresetId: null, caps: SUMMARY_CAPS });
  assert.deepEqual(same.bullets, []);
  assert.ok(formatPresetSummary(same).includes("matches your current arrangement"));

  // Unavailable capabilities never appear as promised changes.
  const noVoice = SUMMARY_CAPS.map((c) => (c.id === "voice" ? { ...c, available: false } : c));
  const design = presetSummary({ presetId: "design-explore", currentPresetId: null, caps: noVoice });
  assert.ok(!design.primaryOrder.includes("Voice input"));
  assert.ok(design.bullets.every((b) => !b.includes("Voice input")));

  // Explicit overrides are reported as masking preset suggestions.
  const masked = presetSummary({
    presetId: "build-debug", currentPresetId: null, caps: SUMMARY_CAPS,
    overrides: { terminal: { tier: "more", rank: 5 } },
  });
  assert.deepEqual(masked.maskedByOverrides, ["terminal"]);
  // The explicit composer choice wins over the preset seed.
  const explicit = presetSummary({
    presetId: "build-debug", currentPresetId: null, caps: SUMMARY_CAPS, explicitComposerDetail: "plain",
  });
  assert.equal(explicit.composerDetail, "plain");
  assert.ok(!explicit.bullets.includes("start Technical options open"));
});

// ---- gate 8: persistence через the live store (memory-backed in Node) -----------

test("apply, skip, switch, clear, and reset persist exactly and never touch unrelated records", () => {
  // Node has no localStorage: the store falls back to its in-memory map, so
  // this exercises the same code paths the browser uses.
  reloadPresetStateForTest();
  assert.equal(getPresetState().setup, "unseen");
  assert.equal(getPresetState().presetId, null);

  completePresetSetup(); // Skip for now
  assert.equal(getPresetState().setup, "completed");
  assert.equal(getPresetState().presetId, null, "skip writes no disguised default");

  applyPreset("design-explore");
  assert.equal(getPresetState().presetId, "design-explore");

  setComposerDetail("technical");
  setMoreToolsOpen(true);
  setPlacementOverride("terminal", { tier: "primary", rank: 9 });
  setStarterOrder(["catch-me-up"]);

  applyPreset("plan-coordinate"); // switching preserves explicit overrides
  assert.equal(getPresetState().presetId, "plan-coordinate");
  assert.equal(getPresetState().composerDetail, "technical", "explicit detail survives switching");
  assert.deepEqual(getPresentation().placements.terminal, { tier: "primary", rank: 9 });
  assert.deepEqual(getPresentation().starterOrder, ["catch-me-up"]);
  assert.equal(effectiveComposerDetail(), "technical", "explicit choice wins over the preset seed");

  clearPreset(); // standard baseline; overrides and disclosure survive
  assert.equal(getPresetState().presetId, null);
  assert.equal(getPresetState().setup, "completed");
  assert.deepEqual(getPresentation().placements.terminal, { tier: "primary", rank: 9 });

  resetWorkspaceOrder(); // clears placement + starter overrides only
  assert.deepEqual(getPresentation().placements, {});
  assert.equal(getPresentation().starterOrder, null);
  assert.equal(getPresetState().composerDetail, "technical", "disclosure choices untouched");

  resetDisclosureChoices();
  assert.equal(getPresetState().composerDetail, null);
  assert.equal(getPresetState().moreToolsOpen, false);
  assert.equal(effectiveComposerDetail(), "plain");
});

test("persistence keys are the specified names", () => {
  assert.equal(PRESET_STORE_KEY, "polyth.workspacePreset.v1");
  assert.equal(PRESENTATION_STORE_KEY, "polyth.workspacePresentation.v1");
});
