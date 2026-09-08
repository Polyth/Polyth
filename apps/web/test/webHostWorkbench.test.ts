import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activateWorkbenchProfile, resetWorkbenchForTest, setWorkbenchProject } from "../src/workbench/store.ts";
import { CONVERSATION_PROFILE_ID, registerWorkbenchProfile, resetWorkbenchProfilesForTest } from "../src/workbench/profiles.ts";
import { resetWorkbenchPrefsCache } from "../src/workbench/prefs.ts";

test("webHost gates public workbench profile while WorkbenchHost is not live", async () => {
  const source = await readFile(new URL("../src/packages/webHost.ts", import.meta.url), "utf8");
  assert.match(source, /workbenchProfile: publicWorkbenchProfileId\(\)/);
  assert.match(source, /getActiveProfile: publicWorkbenchProfileSummary/);
  assert.match(source, /getSnapshot: publicWorkbenchSnapshot/);
  assert.match(source, /WORKBENCH_HOST_LIVE \? activateWorkbenchProfile/);
  assert.match(source, /WORKBENCH_HOST_LIVE \? getActiveProfileId\(\) : CONVERSATION_PROFILE_ID/);
});

test("internal workbench profile can change while public host contract stays on conversation", () => {
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
