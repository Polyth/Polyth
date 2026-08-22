// Per-project first-run contract: the setup panel is optional and the four
// progressive choices do not persist before Finish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const setupSrc = () =>
  readFile(new URL("../src/components/ProjectSetup.tsx", import.meta.url), "utf8");
const appSrc = () =>
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("App always renders the operational shell", async () => {
  const app = await appSrc();
  assert.ok(!app.includes("prefs.persona"), "the shell must not gate on a persona");
  assert.ok(!app.includes("return <Onboarding"), "the old onboarding gate is gone");
  assert.ok(app.includes("decideFirstRunSurface"), "first run is derived from the deterministic coordinator");
  assert.ok(app.includes('surface === "project-setup"'), "setup shows only after the coordinator admits it");
  assert.ok(app.includes("<Sidebar />"), "the shell mounts unconditionally");
});

test("guided setup is explicitly scoped to the active project", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("Set up this project"), "project-scoped setup heading");
  assert.ok(src.includes("Your project canvas"), "review is project-scoped");
  assert.ok(src.includes("You can change everything later."), "setup explains that choices are reversible");
  assert.ok(src.includes("Skip for now"), "skip remains explicit");
  assert.ok(src.includes('["Workflow", "Control", "Widgets", "Review"]'), "all four steps are named");
  for (const banned of ["Continue as", "persona", "Persona"]) {
    assert.ok(!src.includes(banned), `setup panel must not contain "${banned}"`);
  }
});

test("guided choices stay in one draft and persist only from Finish setup", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("useState<ProjectSetupDraft>"), "one draft owns the four setup steps");
  assert.ok(src.includes("applyProjectSetup(current, draft, widgets)"), "Finish uses the shared layout engine");
  assert.ok(src.includes("aria-pressed="), "choices expose programmatic selected state");
  assert.ok(src.includes(">Finish setup</button>"), "one named confirmation action persists the draft");
  assert.ok(src.includes("completeProjectSetup();"), "Finish records completion for the active project");
});

test("close, Escape, and Skip all record project completion", async () => {
  const src = await setupSrc();
  assert.ok(src.includes("completeProjectSetup()"), "dismiss marks setup completed");
  assert.ok(!src.includes("applyPreset"), "setup has no workspace preset behavior");
  assert.ok(src.includes("useModalSurface"), "the shared modal contract owns Escape dismissal");
  assert.ok(src.includes("resolveRestoreFocus"), "the shared modal contract restores the invoker");
  assert.ok(src.includes("focusComposer()"), "the composer remains the fallback focus target");
});
