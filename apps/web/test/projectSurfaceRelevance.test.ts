import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSurfaceRegistration,
  isSurfaceProjectRelevant,
  listSurfaces,
  registerSurface,
} from "../src/surfaces.ts";
import { listSlots, registerSlot } from "../src/slots.ts";
import {
  replaceProjectPackageCatalog,
  resetProjectRelevanceForTest,
  setProjectCompositionContext,
} from "../src/packages/projectRelevance.ts";

const packages = [
  { id: "git", name: "Git", description: "", core: false, enabled: true, hasSettings: false, category: "engineering", projectAffinity: { directions: ["engineering"] } },
  { id: "coach", name: "Coach", description: "", core: false, enabled: true, hasSettings: false, category: "wellbeing", projectAffinity: { directions: ["wellbeing"] } },
] as const;

const engineering = { version: 1, directions: ["engineering"], packageOverrides: {} } as const;
const wellbeing = { version: 1, directions: ["wellbeing"], packageOverrides: {} } as const;

test.afterEach(resetProjectRelevanceForTest);

test("registered surface remains known when a project switch makes it irrelevant", () => {
  replaceProjectPackageCatalog(packages as never);
  const off = registerSurface({
    id: "git-probe",
    ownerPackageId: "git",
    title: "Git probe",
    order: 1,
    component: () => null,
  });
  try {
    setProjectCompositionContext("engineering", engineering as never);
    assert.equal(hasSurfaceRegistration("git-probe"), true);
    assert.equal(isSurfaceProjectRelevant("git-probe"), true);
    assert.equal(listSurfaces().some((surface) => surface.id === "git-probe"), true);

    setProjectCompositionContext("wellbeing", wellbeing as never);
    assert.equal(hasSurfaceRegistration("git-probe"), true, "registration truth survives relevance filtering");
    assert.equal(isSurfaceProjectRelevant("git-probe"), false);
    assert.equal(listSurfaces().some((surface) => surface.id === "git-probe"), false);
  } finally {
    off();
  }
});

test("slot-backed surfaces expose the same raw registration versus relevance split", () => {
  replaceProjectPackageCatalog(packages as never);
  const off = registerSlot("workspace.right.tabs", "coach-probe", () => null, 0, undefined, "coach");
  try {
    setProjectCompositionContext("engineering", engineering as never);
    assert.equal(hasSurfaceRegistration("slot:coach-probe"), true);
    assert.equal(isSurfaceProjectRelevant("slot:coach-probe"), false);
    assert.equal(listSlots("workspace.right.tabs").some((item) => item.id === "coach-probe"), false);

    setProjectCompositionContext("wellbeing", wellbeing as never);
    assert.equal(hasSurfaceRegistration("slot:coach-probe"), true);
    assert.equal(isSurfaceProjectRelevant("slot:coach-probe"), true);
    assert.equal(listSlots("workspace.right.tabs").some((item) => item.id === "coach-probe"), true);
  } finally {
    off();
  }
});

test("truly unknown surface ids remain distinguishable for late package loading", () => {
  replaceProjectPackageCatalog(packages as never);
  setProjectCompositionContext("engineering", engineering as never);
  assert.equal(hasSurfaceRegistration("future-package-surface"), false);
  assert.equal(isSurfaceProjectRelevant("future-package-surface"), false);
});
