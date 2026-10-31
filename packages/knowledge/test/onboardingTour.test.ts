// The Knowledge tour travels with the knowledge package: its strings live in
// this package's catalog and its web entry registers it through the host seam.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { knowledgeTour } from "../widgets/onboardingTour.ts";

const identity = (key: string): string => key;

test("the knowledge package owns its substantive onboarding tour", async () => {
  const tour = knowledgeTour(identity);
  assert.equal(tour.packageId, "knowledge");
  assert.deepEqual(tour.steps.map((step) => step.id), ["overview", "tracks", "notes"]);
  assert.deepEqual(tour.steps.map((step) => step.media?.pattern), ["tiles", "branches", "orbit"]);
  assert.ok(tour.steps.every((step) => step.title.startsWith("packages.onboarding.tours.")));

  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(source, /host\.onboarding/);
  assert.match(source, /knowledgeTour/);
});
