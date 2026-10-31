import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getWorkbenchNavigationProfileId,
  listWorkbenchNavigationProfiles,
} from "../src/workbench/profileNavigation.ts";
import { registerWorkbenchProfile, resetWorkbenchProfilesForTest } from "../src/workbench/profiles.ts";

test("profile navigation exposes only available primary-navigation profiles in stable order", () => {
  resetWorkbenchProfilesForTest();
  const offInternal = registerWorkbenchProfile({
    id: "internal", label: "Internal", description: "", order: 1,
    defaultLayout: { surfaces: [] }, presentation: { navigation: "internal" },
  });
  const offLater = registerWorkbenchProfile({
    id: "z-primary", label: "Z", description: "", order: 20,
    defaultLayout: { surfaces: [] }, presentation: { navigation: "primary" },
  });
  const offEarlier = registerWorkbenchProfile({
    id: "a-primary", label: "A", description: "", order: 10,
    defaultLayout: { surfaces: [] }, presentation: { navigation: "primary" },
  });
  assert.deepEqual(listWorkbenchNavigationProfiles().map((profile) => profile.id), ["a-primary", "z-primary"]);
  assert.equal(getWorkbenchNavigationProfileId("internal"), "conversation");
  offEarlier();
  offLater();
  offInternal();
  resetWorkbenchProfilesForTest();
});

test("stale remembered sessions fall back to a fresh chat only for the current navigation", async () => {
  const source = await readFile(new URL("../src/workbench/profileNavigation.ts", import.meta.url), "utf8");
  assert.match(source, /rememberWorkbenchProfileSession\(targetProfileId, null\)/);
  assert.match(source, /if \(projectId !== null\) startNewSession\(projectId\)/);
  assert.match(source, /generation !== navigationGeneration \|\| navigationProfileId\(getActiveProfileId\(\)\) !== targetProfileId/);
});

test("session lane tracking is project-guarded and suppressed during profile switches", async () => {
  const source = await readFile(new URL("../src/workbench/profileNavigation.ts", import.meta.url), "utf8");
  assert.match(source, /subscribeStore\(\(\) =>/);
  assert.match(source, /if \(suppressLaneCapture\) return/);
  assert.match(source, /getWorkbenchProjectId\(\) !== workspaceProjectId\(state\)/);
  assert.match(source, /suppressLaneCapture = true/);
  assert.match(source, /rememberWorkbenchProfileSession\(targetProfileId, null\)/);
  assert.match(source, /suppressLaneCapture = false/);
});

test("profile lifecycle reconciliation restores the incoming lane after disable", async () => {
  const source = await readFile(new URL("../src/workbench/profileNavigation.ts", import.meta.url), "utf8");
  assert.match(source, /subscribeWorkbench\(\(\) =>/);
  assert.match(source, /observedNavigationProfileId/);
  assert.match(source, /outgoingNavigationId/);
  assert.match(source, /restoreProfileAfterTransition\(/);
  assert.match(source, /projectChanged \? undefined : outgoingNavigationId/);
  assert.match(source, /getWorkbenchProjectId\(\) !== workspaceProjectId\(state\)/);
});
