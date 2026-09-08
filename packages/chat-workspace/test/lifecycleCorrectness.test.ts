import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { createFakeProfileDriver, createProfileRegistry, resetFakeProfileLocks } from "@polyth/browser";
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

test("closeTab and closeOthers release live browser pages", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-close-page-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(space, storage, { providerId: "chatgpt" });
  const keep = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const drop = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  assert.ok(profiles.getPage(keep.id));
  assert.ok(profiles.getPage(drop.id));

  await service.closeTab(space, storage, "proj-a", drop.id);
  assert.equal(profiles.getTab(drop.id), null);
  assert.equal(profiles.getPage(drop.id), null);
  assert.ok(profiles.getPage(keep.id));

  const extra = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  await service.closeOthers(space, storage, "proj-a", keep.id);
  assert.equal(profiles.getTab(extra.id), null);
  assert.equal(profiles.getPage(extra.id), null);
  assert.ok(profiles.getPage(keep.id));
});

test("navigation url survives semantic pin mutation", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-nav-pin-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);
  const profile = await service.createProfile(space, storage, { providerId: "custom", customUrl: "http://127.0.0.1:8765/" });
  const tab = await service.createTab({
    ctx: space,
    storage,
    projectId: "proj-a",
    profileId: profile.id,
    url: "http://127.0.0.1:8765/start",
  });

  const page = profiles.getPage(tab.id)!;
  await page.goto("http://127.0.0.1:8765/after-nav");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await service.pinTab(space, storage, "proj-a", tab.id, true);

  const reloaded = await loadWorkspace(storage, "proj-a");
  const saved = reloaded.tabs.find((t) => t.id === tab.id);
  assert.equal(saved?.url, "http://127.0.0.1:8765/after-nav");
});

test("changeProfile releases old profile page ownership", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-profile-owner-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
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
  const pageBefore = profiles.getPage(tab.id);
  assert.ok(pageBefore);

  await service.changeProfile(space, storage, "proj-a", tab.id, profileB.id);
  const pageAfter = profiles.getPage(tab.id);
  assert.ok(pageAfter);
  assert.notEqual(pageBefore, pageAfter);
  assert.equal(profiles.getTab(tab.id)?.profileId, profileB.id);
});
