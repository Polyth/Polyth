import test from "node:test";
import assert from "node:assert/strict";
import { createProfileRegistry, createFakeProfileDriver, resetFakeProfileLocks } from "../src/index.ts";

test("popup screencast frames pause when workspace stream is hidden", async () => {
  resetFakeProfileLocks();
  const driver = createFakeProfileDriver();
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "profile-popup-visibility";
  await registry.openProfile({
    profileId,
    userDataDir: "/tmp/fake-profile-popup-visibility",
    allowedOrigins: ["http://127.0.0.1"],
    approvedOrigins: new Set(["http://127.0.0.1"]),
  });
  const tab = registry.registerTab("space:project", "tab-popup-vis", profileId);
  const popupFrames: string[] = [];
  registry.onFrame((frame) => {
    if (frame.tabId === tab.tabId && frame.popupId) popupFrames.push(frame.popupId);
  });

  await registry.ensureLive(tab.tabId, "http://127.0.0.1/");
  const page = registry.getPage(tab.tabId);
  assert.ok(page);
  page.setStreamVisible(false);
  await page.goto("http://127.0.0.1/polyth-test-popup");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(popupFrames.length, 0, "hidden workspace must not emit popup frames");

  page.setStreamVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(popupFrames.length > 0, "visible workspace resumes popup frames");
});

test("fake popup-closed is emitted once for close and hibernate", async () => {
  resetFakeProfileLocks();
  const driver = createFakeProfileDriver();
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "profile-popup-once";
  await registry.openProfile({
    profileId,
    userDataDir: "/tmp/fake-profile-popup-once",
    allowedOrigins: ["http://127.0.0.1"],
    approvedOrigins: new Set(["http://127.0.0.1"]),
  });
  const tab = registry.registerTab("space:project", "tab-popup-once", profileId);
  const closed: string[] = [];
  registry.onEvent((ev) => {
    if (ev.kind === "popup-closed" && ev.popupId) closed.push(ev.popupId);
  });
  await registry.ensureLive(tab.tabId, "http://127.0.0.1/polyth-test-popup");
  await registry.closePopup(tab.tabId, "test-popup");
  assert.equal(closed.filter((id) => id === "test-popup").length, 1);

  const page = registry.getPage(tab.tabId);
  assert.ok(page);
  await page.goto("http://127.0.0.1/polyth-test-popup");
  await registry.hibernateTab(tab.tabId);
  assert.equal(closed.filter((id) => id === "test-popup").length, 2);
});
