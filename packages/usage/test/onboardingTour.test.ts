// The Usage tour travels with the usage package: its strings live in this
// package's catalog and its web entry registers it through the host seam.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { usageTour } from "../widgets/onboardingTour.ts";

const identity = (key: string): string => key;

test("the usage package owns its substantive onboarding tour", async () => {
  const tour = usageTour(identity);
  assert.equal(tour.packageId, "usage");
  assert.deepEqual(tour.steps.map((step) => step.id), ["overview", "range", "providers"]);
  assert.deepEqual(tour.steps.map((step) => step.media?.pattern), ["waveform", "rays", "orbit"]);
  assert.ok(tour.steps.every((step) => step.title.startsWith("packages.onboarding.tours.")));

  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(source, /host\.onboarding/);
  assert.match(source, /usageTour/);
});
