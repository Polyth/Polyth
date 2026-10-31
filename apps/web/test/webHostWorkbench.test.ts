import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activateWorkbenchProfile, resetWorkbenchForTest, setWorkbenchProject } from "../src/workbench/store.ts";
import { CONVERSATION_PROFILE_ID, registerWorkbenchProfile, resetWorkbenchProfilesForTest } from "../src/workbench/profiles.ts";
import { resetWorkbenchPrefsCache } from "../src/workbench/prefs.ts";

test("webHost exposes the live compatibility workbench and package handoff APIs", async () => {
  const source = await readFile(new URL("../src/packages/webHost.ts", import.meta.url), "utf8");
  assert.match(source, /workbenchProfile/);
  assert.match(source, /getActiveProfile: publicWorkbenchProfileSummary/);
  assert.match(source, /getSnapshot: publicWorkbenchSnapshot/);
  assert.match(source, /activateWorkbenchNavigationProfile/);
  assert.match(source, /getProfileSession/);
  assert.match(source, /send: sendToConversation/);
  assert.doesNotMatch(source, /WORKBENCH_HOST_LIVE/);
});

test("internal workbench profiles remain activatable without becoming primary navigation", () => {
  resetWorkbenchPrefsCache();
  resetWorkbenchProfilesForTest();
  resetWorkbenchForTest();
  setWorkbenchProject("p1");
  const off = registerWorkbenchProfile({
    id: "authoring",
    label: "Writing",
    description: "",
    order: 10,
    defaultLayout: { surfaces: [{ surface: "session", region: "start" }] },
  });
  assert.equal(activateWorkbenchProfile("authoring"), true);
  assert.notEqual(activateWorkbenchProfile("authoring"), CONVERSATION_PROFILE_ID);
  off();
  resetWorkbenchProfilesForTest();
});
