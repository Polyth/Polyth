// UX-PERSONAS first-run contract: the shell never gates on a preset, the
// setup panel is optional (Skip/Escape/close all lead to the full workspace)
// and the four progressive setup choices do not persist before Apply.
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

test("guided setup ships friendly optional copy and four named steps", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("Choose a setup"), "friendly setup heading");
  assert.ok(src.includes("You can change everything later."), "setup explains that choices are reversible");
  assert.ok(src.includes("Skip for now"), "skip remains explicit");
  assert.ok(src.includes('["Workflow", "Control", "Widgets", "Review"]'), "all four steps are named");
  for (const banned of ["Continue as", "persona", "Persona"]) {
    assert.ok(!src.includes(banned), `setup panel must not contain "${banned}"`);
  }
});

test("guided choices stay in one draft and persist only from Apply setup", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("useState<WorkspaceSetupDraft>"), "one draft owns the four setup steps");
  assert.ok(src.includes("applyWorkspaceSetup(current, draft, widgets)"), "Apply uses the shared layout engine");
  assert.ok(src.includes("aria-pressed="), "choices expose programmatic selected state");
  assert.ok(src.includes(">Apply setup</button>"), "one named confirmation action persists the draft");
});

test("close, Escape, and Skip all record completion without writing a preset", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("completePresetSetup()"), "dismiss marks setup completed");
  assert.ok(!src.includes("applyPreset(null);\n    setOverlay(null);\n    restoreFocus"),
    "dismiss must not write a disguised default preset");
  assert.ok(src.includes("useModalSurface"), "the shared modal contract owns Escape dismissal");
  assert.ok(src.includes("resolveRestoreFocus"), "the shared modal contract restores the invoker");
  assert.ok(src.includes("focusComposer()"), "the composer remains the fallback focus target");
});
