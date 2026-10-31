import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROJECT_DIRECTIONS,
  parseProjectAffinity,
  projectPackageDecision,
} from "@polyth/contracts/project-composition";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  polyth: { descriptor: { enabled: boolean; projectAffinity: unknown } };
};
const descriptor = manifest.polyth.descriptor;

// Planner is useful in any project: a direction list here would hide it (and
// its rail launcher) from every project of another direction, which is how it
// went missing from engineering projects.
test("Planner is enabled and recommended for every project direction", () => {
  assert.equal(descriptor.enabled, true);
  const projectAffinity = parseProjectAffinity(descriptor.projectAffinity);
  const pkg = { id: "planner", enabled: true, projectAffinity };
  for (const direction of PROJECT_DIRECTIONS) {
    const decision = projectPackageDecision({ version: 1, directions: [direction], packageOverrides: {} }, pkg);
    assert.equal(decision.relevant, true, direction);
    assert.equal(decision.recommended, true, direction);
  }
  assert.equal(projectPackageDecision(undefined, pkg).relevant, true);
});

// A person's Personal project (no setup, chat first) keeps a short right rail.
test("Planner starts on a Personal project's right rail", () => {
  const source = readFileSync(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  const registration = source.split("capabilities.register(").find((chunk) => chunk.slice(0, 200).includes("id: PLANNER_PACKAGE_ID"));
  assert.match(/defaultRails: (\{[^}]*\})/.exec(registration ?? "")?.[1] ?? "", /personal: "right"/);
});
