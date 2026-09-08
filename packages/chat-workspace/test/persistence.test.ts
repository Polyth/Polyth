import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { createFakeProfileDriver, createProfileRegistry } from "@polyth/browser";
import { createChatWorkspaceService } from "../src/service.ts";
import { loadProfile, profileRoot } from "../src/storage.ts";

const ctx = (spaceId: string, userId: string, storageDir: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role: "owner",
  deployment: "local-trusted",
  storageDir,
});

test("profile and tab metadata survive service dispose and recreate", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-persist-"));
  const storage = createSpaceStorage(homeRoot);
  const userId = "user-1";
  const projectId = "proj-a";
  const space = ctx("space-1", userId, homeRoot);

  const profiles1 = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service1 = createChatWorkspaceService(profiles1);
  const profile = await service1.createProfile(space, storage, { providerId: "custom", name: "Test", customUrl: "http://127.0.0.1:8765/" });
  const tab = await service1.createTab({
    ctx: space,
    storage,
    projectId,
    profileId: profile.id,
    url: "http://127.0.0.1:8765/",
  });
  const userDataDir = join(profileRoot(storage, userId, profile.id), "chromium");

  const profiles2 = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service2 = createChatWorkspaceService(profiles2);
  const reloaded = await loadProfile(storage, userId, profile.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.id, profile.id);
  assert.equal(reloaded!.name, "Test");
  const workspace = await service2.getWorkspace(storage, projectId);
  assert.equal(workspace.tabs.length, 1);
  assert.equal(workspace.tabs[0]!.id, tab.id);
  assert.equal(workspace.tabs[0]!.url, tab.url);
  assert.ok(userDataDir.includes(profile.id));
});

test("same profile is visible across projects but tabs are project-scoped", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-cross-"));
  const storage = createSpaceStorage(homeRoot);
  const userId = "user-1";
  const space = ctx("space-1", userId, homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(space, storage, { providerId: "chatgpt" });
  const tabA = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const tabB = await service.createTab({ ctx: space, storage, projectId: "proj-b", profileId: profile.id });

  const listed = await service.listProfiles(space, storage);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, profile.id);

  const wsA = await service.getWorkspace(storage, "proj-a");
  const wsB = await service.getWorkspace(storage, "proj-b");
  assert.equal(wsA.tabs.length, 1);
  assert.equal(wsB.tabs.length, 1);
  assert.equal(wsA.tabs[0]!.id, tabA.id);
  assert.equal(wsB.tabs[0]!.id, tabB.id);
  assert.notEqual(tabA.id, tabB.id);
});
