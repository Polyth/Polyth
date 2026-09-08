import test from "node:test";
import assert from "node:assert/strict";
import { createChatWorkspaceService } from "../src/service.ts";
import { createProfileRegistry, createFakeProfileDriver, resetFakeProfileLocks } from "@polyth/browser";

test("setTabStream applies requested quality to an active screencast", async () => {
  resetFakeProfileLocks();
  const driver = createFakeProfileDriver();
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const service = createChatWorkspaceService(registry);
  const profileId = "profile-stream";
  await registry.openProfile({
    profileId,
    userDataDir: "/tmp/fake-profile-stream",
    allowedOrigins: ["http://127.0.0.1"],
    approvedOrigins: new Set(["http://127.0.0.1"]),
  });
  const tab = registry.registerTab("space:project", "tab-stream", profileId);
  await registry.ensureLive(tab.tabId, "http://127.0.0.1/");
  const page = registry.getPage(tab.tabId)!;
  service.setTabStream(tab.tabId, true, 60);
  await new Promise((resolve) => setTimeout(resolve, 20));
  let qualities: number[] = [];
  const original = page.startScreencast.bind(page);
  page.startScreencast = async (opts?: { quality: number; maxWidth: number; maxHeight: number }) => {
    if (opts) qualities.push(opts.quality);
    return original(opts ?? { quality: 60, maxWidth: 1280, maxHeight: 800 });
  };
  service.setTabStream(tab.tabId, true, 80);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(qualities.includes(80));
});
