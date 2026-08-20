// First visit must always continue from the persona picker into the folder
// picker (file manager). Skipping when the server already has projects was
// the returning-visit path leaking onto a fresh browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = () =>
  readFile(new URL("../src/components/Onboarding.tsx", import.meta.url), "utf8");

test("first-run persona pick always opens the project folder picker", async () => {
  const onboarding = await src();
  assert.ok(onboarding.includes("const firstRun = !persona"), "first visit is no stored persona");
  assert.ok(
    onboarding.includes('setOverlay(firstRun ? "project-picker" : null)'),
    "first visit must show the folder picker even when projects already exist",
  );
  assert.ok(
    !onboarding.includes("projects.length === 0"),
    "do not gate the first-run picker on an existing server-side project list",
  );
});
