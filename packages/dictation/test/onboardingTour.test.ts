// The Voice tour travels with the dictation package: its strings live in this
// package's catalog and its web entry registers it through the host seam.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { voiceTour } from "../widgets/onboardingTour.ts";

const identity = (key: string): string => key;

test("the dictation package owns the canonical voice onboarding tour", async () => {
  const tour = voiceTour(identity);
  assert.equal(tour.packageId, "voice");
  assert.equal(tour.title, "packages.onboarding.tours.voice.voice");
  assert.deepEqual(tour.steps.map((step) => step.id), ["overview", "dictation", "read-aloud"]);
  assert.deepEqual(tour.steps.map((step) => step.media?.pattern), ["waveform", "orbit", "rays"]);
  assert.ok(tour.steps.every((step) => step.title.startsWith("packages.onboarding.tours.voice.")));

  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(source, /host\.onboarding/);
  assert.match(source, /voiceTour/);
});
