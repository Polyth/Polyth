// The GitHub tour travels with the github package: its strings live in this
// package's catalog and its web entry registers it through the host seam.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { githubTour } from "../widgets/onboardingTour.ts";

const identity = (key: string): string => key;

test("the github package owns its substantive onboarding tour", async () => {
  const tour = githubTour(identity);
  assert.equal(tour.packageId, "github");
  assert.deepEqual(tour.steps.map((step) => step.id), ["overview", "summary", "metrics"]);
  assert.deepEqual(tour.steps.map((step) => step.media?.pattern), ["branches", "tiles", "rays"]);
  assert.ok(tour.steps.every((step) => step.title.startsWith("packages.onboarding.tours.")));

  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(source, /host\.onboarding/);
  assert.match(source, /githubTour/);
});
