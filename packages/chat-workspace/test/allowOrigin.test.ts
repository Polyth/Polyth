import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import {
  checkUrl,
  createProfileRegistry,
  createFakeProfileDriver,
  resetFakeProfileLocks,
  type Resolver,
} from "@polyth/browser";
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

const ORIGIN = "https://example.com";
const publicDns: Resolver = async () => ["93.184.216.34"];

test("approveOrigin once does not require persist callback data on restart", async () => {
  resetFakeProfileLocks();
  const driver = createFakeProfileDriver();
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "profile-1";
  await registry.openProfile({
    profileId,
    userDataDir: "/tmp/fake-profile-once",
    allowedOrigins: [ORIGIN],
    approvedOrigins: new Set(),
  });
  let persisted: string[] | null = null;
  await registry.approveOrigin(profileId, ORIGIN, "once", async (origins) => {
    persisted = origins;
  });
  assert.equal(persisted, null);
});

test("approveOrigin always persists approved origins", async () => {
  resetFakeProfileLocks();
  const driver = createFakeProfileDriver();
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "profile-2";
  await registry.openProfile({
    profileId,
    userDataDir: "/tmp/fake-profile-always",
    allowedOrigins: [ORIGIN],
    approvedOrigins: new Set(),
  });
  let persisted: string[] = [];
  await registry.approveOrigin(profileId, ORIGIN, "always", async (origins) => {
    persisted = origins;
  });
  assert.deepEqual(persisted, [ORIGIN]);
});

test("allow-once approval is not restored after profile reload", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-allow-once-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(space, storage, {
    providerId: "custom",
    name: "Once",
    customUrl: "http://127.0.0.1:8765/",
  });
  const userDataDir = join(profileRoot(storage, space.userId, profile.id), "chromium");
  await profiles.openProfile({
    profileId: profile.id,
    userDataDir,
    allowedOrigins: [],
    approvedOrigins: new Set(profile.approvedOrigins),
  });

  await profiles.approveOrigin(profile.id, ORIGIN, "once", async (origins) => {
    await service.patchProfile(space, storage, profile.id, { approvedOrigins: origins });
  });

  const onDisk = await loadProfile(storage, space.userId, profile.id);
  assert.deepEqual(onDisk?.approvedOrigins, []);

  resetFakeProfileLocks();
  const reloaded = await loadProfile(storage, space.userId, profile.id);
  const reloadDir = join(profileRoot(storage, space.userId, profile.id), "chromium");
  const restarted = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  await restarted.openProfile({
    profileId: profile.id,
    userDataDir: reloadDir,
    allowedOrigins: [],
    approvedOrigins: new Set(reloaded?.approvedOrigins ?? []),
  });

  const decision = await checkUrl(`${ORIGIN}/page`, {
    approvedOrigins: new Set(reloaded?.approvedOrigins ?? []),
    resolve: publicDns,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.code, "approval-required");
});

test("allow-always approval survives profile reload", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-allow-always-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);

  const profile = await service.createProfile(space, storage, {
    providerId: "custom",
    name: "Always",
    customUrl: "http://127.0.0.1:8765/",
  });
  const userDataDir = join(profileRoot(storage, space.userId, profile.id), "chromium");
  await profiles.openProfile({
    profileId: profile.id,
    userDataDir,
    allowedOrigins: [],
    approvedOrigins: new Set(profile.approvedOrigins),
  });

  await profiles.approveOrigin(profile.id, ORIGIN, "always", async (origins) => {
    await service.patchProfile(space, storage, profile.id, { approvedOrigins: origins });
  });

  const onDisk = await loadProfile(storage, space.userId, profile.id);
  assert.deepEqual(onDisk?.approvedOrigins, [ORIGIN]);

  resetFakeProfileLocks();
  const reloaded = await loadProfile(storage, space.userId, profile.id);
  const reloadDir = join(profileRoot(storage, space.userId, profile.id), "chromium");
  const restarted = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  await restarted.openProfile({
    profileId: profile.id,
    userDataDir: reloadDir,
    allowedOrigins: [],
    approvedOrigins: new Set(reloaded?.approvedOrigins ?? []),
  });

  const decision = await checkUrl(`${ORIGIN}/page`, {
    approvedOrigins: new Set(reloaded?.approvedOrigins ?? []),
    resolve: publicDns,
  });
  assert.equal(decision.ok, true);
});
