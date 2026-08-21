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
    hasValidActiveProject: true,
    pickerOfferedThisDocument: false,
    presetSetup: "completed",
    ...over,
  });

test("first-run decision table distinguishes loading, failure, and ready-empty", () => {
  assert.equal(decide({ registryStatus: "loading", projectCount: 0 }), "project-loading");
  assert.equal(decide({ registryStatus: "failed", projectCount: 0 }), "project-failed");
  assert.equal(decide({
    projectCount: 0,
    hasValidActiveProject: false,
    pickerOfferedThisDocument: false,
  }), "project-picker");
  assert.equal(decide({
    projectCount: 0,
    hasValidActiveProject: false,
    pickerOfferedThisDocument: true,
  }), "workspace");
});

test("a usable project deterministically chooses optional setup or workspace", () => {
  assert.equal(decide({
    hasValidActiveProject: false,
    presetSetup: "unseen",
  }), "workspace");
  assert.equal(decide({ presetSetup: "unseen" }), "preset-setup");
  assert.equal(decide({ presetSetup: "completed" }), "workspace");
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
