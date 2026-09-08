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

test("hibernate and restore cycles reuse the same tab page without conflict", async () => {
  resetFakeProfileLocks();
  const registry = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const profileId = "profile-cycle";
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-profile-cycle-"));
  await registry.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: ["http://127.0.0.1:5173"],
  });
  const tabId = newChatTabId();
  registry.registerTab("space-a:proj", tabId, profileId);
  await registry.ensureLive(tabId, "http://127.0.0.1:5173/one");
  const firstPage = registry.getPage(tabId);
  assert.ok(firstPage);

  for (let i = 0; i < 3; i++) {
    await registry.hibernateTab(tabId);
    assert.equal(registry.getTab(tabId)?.hibernated, true);
    assert.equal(registry.getPage(tabId), null);
    const restored = await registry.restoreTab(tabId, `http://127.0.0.1:5173/cycle-${i}`);
    assert.equal(restored.hibernated, false);
    assert.equal(restored.url, `http://127.0.0.1:5173/cycle-${i}`);
    assert.ok(registry.getPage(tabId));
    await registry.getPage(tabId)!.mouse({ kind: "click", x: 1, y: 1 });
  }
  assert.equal(registry.getPage(tabId), firstPage);
});

test("releaseTabPage closes the underlying page and removes it from the profile", async () => {
  resetFakeProfileLocks();
  const registry = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const profileId = "profile-close";
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-profile-close-"));
  await registry.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: ["http://127.0.0.1:5173"],
  });
  const tabId = newChatTabId();
  registry.registerTab("space-a:proj", tabId, profileId);
  await registry.ensureLive(tabId, "http://127.0.0.1:5173/");
  assert.ok(registry.getPage(tabId));

  await registry.releaseTabPage(tabId);
  assert.equal(registry.getPage(tabId), null);

  await registry.ensureLive(tabId, "http://127.0.0.1:5173/two");
  assert.ok(registry.getPage(tabId));
});

test("active tab protection is scoped per space", async () => {
  resetFakeProfileLocks();
  const registry = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 1 });
  registry.setLiveTabLimit("space-a", 1);
  registry.setLiveTabLimit("space-b", 1);
  registry.setHibernateDelayMs("space-a", 60_000);
  registry.setHibernateDelayMs("space-b", 60_000);
  const profileId = "profile-space-active";
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-profile-space-active-"));
  await registry.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: ["http://127.0.0.1:5173"],
  });

  const tabA = newChatTabId();
  const tabB = newChatTabId();
  registry.registerTab("space-a:proj", tabA, profileId);
  registry.registerTab("space-b:proj", tabB, profileId);
  await registry.ensureLive(tabA, "http://127.0.0.1:5173/a");
  registry.setActiveTab(tabA);
  await registry.ensureLive(tabB, "http://127.0.0.1:5173/b");
  registry.setActiveTab(tabB);

  const tabC = newChatTabId();
  registry.registerTab("space-a:proj", tabC, profileId);
  await registry.ensureLive(tabC, "http://127.0.0.1:5173/c");

  assert.equal(registry.getTab(tabA)?.hibernated, false, "space A active tab stays live");
  assert.equal(registry.getTab(tabB)?.hibernated, false, "space B active tab stays live");
});
