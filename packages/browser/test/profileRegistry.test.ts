import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeProfileDriver,
  createProfileRegistry,
  newChatTabId,
  resetFakeProfileLocks,
} from "../src/index.ts";

test("profile registry tracks chat tab ids and hibernates LRU tabs", async () => {
  resetFakeProfileLocks();
  const driver = createFakeProfileDriver();
  const registry = createProfileRegistry({ driver, liveTabLimit: 2 });
  const profileId = "p1";
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-profile-"));
  await registry.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: ["http://127.0.0.1:5173"],
  });
  const tabs = [newChatTabId(), newChatTabId(), newChatTabId()];
  for (const tabId of tabs) {
    registry.registerTab("space:proj", tabId, profileId);
    await registry.ensureLive(tabId, "http://127.0.0.1:5173/");
  }
  assert.equal(registry.listChatTabIds().length, 3);
  const hibernated = registry.getTab(tabs[0]!);
  assert.ok(hibernated?.hibernated, "oldest tab should hibernate when limit exceeded");
  assert.ok(registry.getPage(tabs[2]!), "newest tab stays live");
});

test("manual-only policy is attached to tab records", async () => {
  resetFakeProfileLocks();
  const registry = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const tabId = newChatTabId();
  registry.registerTab("s:p", tabId, "prof");
  const tab = registry.getTab(tabId);
  assert.equal(tab?.contentAccess.contentAccess, "manual-only");
  assert.equal(tab?.contentAccess.agentControl, false);
});
