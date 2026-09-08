import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { createFakeProfileDriver, createProfileRegistry, newChatTabId } from "@polyth/browser";
import { createChatWorkspaceService } from "../src/service.ts";
import { loadWorkspace } from "../src/storage.ts";

const ctx = (spaceId: string, userId: string, storageDir: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role: "owner",
  deployment: "local-trusted",
  storageDir,
});

test("changeProfile rebinds live tab to new profile and restores url", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-change-profile-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service = createChatWorkspaceService(profiles);

  const profileA = await service.createProfile(space, storage, {
    providerId: "custom",
    name: "A",
    customUrl: "http://127.0.0.1:8765/",
  });
  const profileB = await service.createProfile(space, storage, {
    providerId: "custom",
    name: "B",
    customUrl: "http://127.0.0.1:8766/",
  });
  const tab = await service.createTab({
    ctx: space,
    storage,
    projectId: "proj-a",
    profileId: profileA.id,
    url: "http://127.0.0.1:8765/docs",
  });
  assert.ok(profiles.getPage(tab.id), "tab starts live on profile A");

  const workspace = await service.changeProfile(space, storage, "proj-a", tab.id, profileB.id);
  const updated = workspace.tabs.find((t) => t.id === tab.id);
  assert.equal(updated?.profileId, profileB.id);
  assert.equal(updated?.url, "http://127.0.0.1:8766/");
  assert.equal(profiles.getTab(tab.id)?.profileId, profileB.id);
  assert.ok(profiles.getPage(tab.id), "tab stays live on profile B");
});

test("pinned tab survives liveTabLimit eviction in same space", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-pin-lru-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 1 });
  const service = createChatWorkspaceService(profiles);
  await service.putSettings(space, storage, {
    ...(await service.getSettings(storage)),
    liveTabLimit: 1,
    hibernateDelayMs: 300_000,
  });

  const profile = await service.createProfile(space, storage, { providerId: "chatgpt" });
  const tabA = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  await service.pinTab(space, storage, "proj-a", tabA.id, true);
  assert.equal(profiles.getTab(tabA.id)?.pinned, true);

  const tabB = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  assert.equal(profiles.getTab(tabA.id)?.hibernated, false, "pinned tab A stays live");
  assert.ok(profiles.getPage(tabB.id), "new tab B is live");
});

test("unpinned tab hibernates when liveTabLimit exceeded in same space", async () => {
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 1 });
  profiles.setLiveTabLimit("space-1", 1);
  const profileId = "profile-lru";
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-cw-unpin-lru-"));
  await profiles.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: ["https://chatgpt.com"],
  });
  const tabA = newChatTabId();
  const tabB = newChatTabId();
  profiles.registerTab("space-1:proj-a", tabA, profileId);
  await profiles.ensureLive(tabA, "https://chatgpt.com/");
  profiles.registerTab("space-1:proj-a", tabB, profileId);
  await profiles.ensureLive(tabB, "https://chatgpt.com/");
  assert.equal(profiles.getTab(tabA)?.hibernated, true, "unpinned tab A hibernates for tab B");
  assert.ok(profiles.getPage(tabB), "new tab B is live");
});

test("activateTab persists activeTabId", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-active-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(space, storage, { providerId: "chatgpt" });
  const tabA = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const tabB = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });

  const activated = await service.activateTab(space, storage, "proj-a", tabA.id);
  assert.equal(activated.activeTabId, tabA.id);

  const reloaded = await loadWorkspace(storage, "proj-a");
  assert.equal(reloaded.activeTabId, tabA.id);
  assert.notEqual(tabB.id, tabA.id);
});

test("closeOthers removes runtime tabs and persistence", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-close-others-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(space, storage, { providerId: "chatgpt" });
  const keep = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const drop = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });

  const workspace = await service.closeOthers(space, storage, "proj-a", keep.id);
  assert.equal(workspace.tabs.length, 1);
  assert.equal(workspace.tabs[0]!.id, keep.id);
  assert.equal(profiles.getTab(drop.id), null);
});

test("pinTab prevents pinned flag clearing in workspace", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-pin-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(space, storage, { providerId: "chatgpt" });
  const tab = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const pinned = await service.pinTab(space, storage, "proj-a", tab.id, true);
  assert.equal(pinned.tabs.find((t) => t.id === tab.id)?.pinned, true);
  assert.equal(profiles.getTab(tab.id)?.pinned, true);
});

test("cross-space tab mutation returns not-found", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-xspace-"));
  const workRoot = mkdtempSync(join(tmpdir(), "polyth-cw-xspace-work-"));
  const homeStorage = createSpaceStorage(homeRoot);
  const workStorage = createSpaceStorage(workRoot);
  const home = ctx("home-space", "user-1", homeRoot);
  const work = ctx("work-space", "user-1", workRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(home, homeStorage, { providerId: "chatgpt" });
  const tab = await service.createTab({ ctx: home, storage: homeStorage, projectId: "proj-a", profileId: profile.id });

  await assert.rejects(
    () => service.closeTab(work, workStorage, "proj-a", tab.id),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
});

test("per-space liveTabLimit isolation", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-policy-"));
  const workRoot = mkdtempSync(join(tmpdir(), "polyth-cw-policy-work-"));
  const homeStorage = createSpaceStorage(homeRoot);
  const workStorage = createSpaceStorage(workRoot);
  const home = ctx("home-space", "user-1", homeRoot);
  const work = ctx("work-space", "user-1", workRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 2 });
  const service = createChatWorkspaceService(profiles);

  await service.putSettings(home, homeStorage, {
    ...(await service.getSettings(homeStorage)),
    liveTabLimit: 2,
    hibernateDelayMs: 300_000,
  });
  await service.putSettings(work, workStorage, {
    ...(await service.getSettings(workStorage)),
    liveTabLimit: 5,
    hibernateDelayMs: 300_000,
  });

  const homeProfile = await service.createProfile(home, homeStorage, { providerId: "chatgpt" });
  const workProfile = await service.createProfile(work, workStorage, { providerId: "chatgpt" });
  await service.createTab({ ctx: home, storage: homeStorage, projectId: "proj-a", profileId: homeProfile.id });
  await service.createTab({ ctx: home, storage: homeStorage, projectId: "proj-a", profileId: homeProfile.id });
  const workTab = await service.createTab({ ctx: work, storage: workStorage, projectId: "proj-b", profileId: workProfile.id });

  assert.ok(profiles.getTab(workTab.id));
});
