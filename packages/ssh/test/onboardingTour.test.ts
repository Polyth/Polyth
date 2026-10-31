// The SSH Remotes tour travels with the ssh package: its strings live in this
// package's catalog and its web entry registers it through the host seam.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sshTour } from "../widgets/onboardingTour.ts";

const identity = (key: string): string => key;

test("the ssh package owns its substantive onboarding tour", async () => {
  const tour = sshTour(identity);
  assert.equal(tour.packageId, "ssh");
  assert.deepEqual(tour.steps.map((step) => step.id), ["overview", "add", "test", "remote-projects"]);
  assert.deepEqual(tour.steps.map((step) => step.media?.pattern), ["branches", "tiles", "orbit", "rays"]);
  assert.ok(tour.steps.every((step) => step.title.startsWith("packages.onboarding.tours.")));

  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(source, /host\.onboarding/);
  assert.match(source, /sshTour/);
});
