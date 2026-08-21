// UX-PERSONAS first-run contract: the shell never gates on a preset, the
// setup panel is optional (Skip/Escape/close all lead to the full workspace),
// no card is selected initially, and the exact plain-language copy ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const setupSrc = () =>
  readFile(new URL("../src/components/PresetSetup.tsx", import.meta.url), "utf8");
const appSrc = () =>
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("App always renders the operational shell — no persona early return", async () => {
  const app = await appSrc();
  assert.ok(!app.includes("prefs.persona"), "the shell must not gate on a persona");
  assert.ok(!app.includes("return <Onboarding"), "the old onboarding gate is gone");
  assert.ok(app.includes("decideFirstRunSurface"), "first run is derived from the deterministic coordinator");
  assert.ok(app.includes('surface === "preset-setup"'), "setup shows only after the coordinator admits it");
  assert.ok(app.includes("<Sidebar />"), "the shell mounts unconditionally");
});

test("preset setup ships the exact optional-setup copy", async () => {
  const src = await setupSrc();
  const presets = await readFile(new URL("../src/workspacePresets.ts", import.meta.url), "utf8");
  assert.ok(presets.includes("What should Polyth put within easy reach?"), "exact heading");
  assert.ok(presets.includes("Skip for now"), "exact skip label");
  assert.ok(presets.includes("Saved on this device. Change it in Settings → Workspace preset."), "persistence note");
  assert.ok(src.includes("OPTIONAL_SETUP_COPY.skip"), "skip renders from the schema copy");
  for (const banned of ["Continue as", "persona", "Persona"]) {
    assert.ok(!src.includes(banned), `setup panel must not contain "${banned}"`);
  }
});

test("no card is selected initially and a click is only a draft choice", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("useState<DraftChoice>(null)"), "initial draft selection is null");
  assert.ok(src.includes("applyPreset"), "persistence happens only via the confirmation action");
  assert.ok(src.includes("aria-pressed={selected}"), "cards expose programmatic selected state");
  assert.ok(src.includes("aria-describedby"), "cards reference their supporting copy");
});

test("close, Escape, and Skip all record completion without writing a preset", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("completePresetSetup()"), "dismiss marks setup completed");
  assert.ok(!src.includes("applyPreset(null);\n    setOverlay(null);\n    restoreFocus"),
    "dismiss must not write a disguised default preset");
  assert.ok(src.includes('e.key === "Escape"'), "Escape dismisses the panel");
  assert.ok(src.includes("restoreFocus"), "focus returns to the invoker or composer");
});
