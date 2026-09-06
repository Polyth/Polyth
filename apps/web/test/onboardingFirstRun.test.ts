import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSrc = () =>
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const folderSrc = () =>
  readFile(new URL("../src/components/ProjectFolderDialog.tsx", import.meta.url), "utf8");

test("App always renders the operational shell", async () => {
  const app = await appSrc();
  assert.ok(!app.includes("prefs.persona"), "the shell must not gate on a persona");
  assert.ok(!app.includes("return <Onboarding"), "the old onboarding gate is gone");
  assert.ok(app.includes("decideFirstRunSurface"), "first run is derived from the deterministic coordinator");
  assert.ok(!app.includes("project-setup"), "a valid project is not blocked by setup");
  assert.ok(!app.includes("ProjectSetup"), "the four-step project wizard is gone");
  assert.ok(app.includes("<Sidebar />"), "the shell mounts unconditionally");
});

test("opening a project hands focus to the composer", async () => {
  const src = await folderSrc();
  assert.ok(src.includes("focusComposer()"), "successful activation focuses the composer");
  assert.ok(!src.includes(".project-setup"), "focus does not wait for a setup surface");
  assert.ok(!src.includes("projectType"), "opening a folder does not classify the project");
  assert.ok(!src.includes("knownProjectIds"), "open does not infer creation from a client cache");
});
