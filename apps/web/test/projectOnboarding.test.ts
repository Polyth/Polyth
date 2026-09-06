import test from "node:test";
import assert from "node:assert/strict";
import {
  decideFirstRunSurface,
  markAutoPickerOffered,
  resetAutoPickerEpisodeForTest,
  wasAutoPickerOffered,
  type FirstRunInput,
  type FirstRunSurface,
} from "../src/projectOnboarding.ts";

const decide = (over: Partial<FirstRunInput>): FirstRunSurface =>
  decideFirstRunSurface({
    registryStatus: "ready",
    projectCount: 1,
    pickerOfferedThisDocument: false,
    ...over,
  });

test("first-run decision table distinguishes loading, failure, and ready-empty", () => {
  assert.equal(decide({ registryStatus: "loading", projectCount: 0 }), "project-loading");
  assert.equal(decide({ registryStatus: "failed", projectCount: 0 }), "project-failed");
  assert.equal(decide({
    projectCount: 0,
    pickerOfferedThisDocument: false,
  }), "project-picker");
  assert.equal(decide({
    projectCount: 0,
    pickerOfferedThisDocument: true,
  }), "workspace");
});

test("a usable project opens the workspace immediately", () => {
  assert.equal(decide({ projectCount: 1 }), "workspace");
  assert.equal(decide({ projectCount: 4 }), "workspace");
});

test("the automatic picker episode is once per document and resettable only for tests", () => {
  resetAutoPickerEpisodeForTest();
  assert.equal(wasAutoPickerOffered(), false);

  markAutoPickerOffered();
  assert.equal(wasAutoPickerOffered(), true);
  markAutoPickerOffered();
  assert.equal(wasAutoPickerOffered(), true);

  resetAutoPickerEpisodeForTest();
  assert.equal(wasAutoPickerOffered(), false);
});
