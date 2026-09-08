import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import {
  createFakeProfileDriver,
  createProfileRegistry,
  resetFakeProfileLocks,
} from "@polyth/browser";
import { createChatWorkspaceService } from "../src/service.ts";

const ctx = (spaceId: string, userId: string, storageDir: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role: "owner",
  deployment: "local-trusted",
  storageDir,
});

test("external chat profile denies unlisted private and metadata targets", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-privnet-ext-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);
  const profile = await service.createProfile(space, storage, { providerId: "chatgpt", name: "Personal" });
  const tab = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const page = profiles.getPage(tab.id);
  assert.ok(page);
  await assert.rejects(
    () => page.goto("http://127.0.0.1/"),
    (error: Error & { code?: string }) => error.code === "blocked-private",
  );
  await assert.rejects(
    () => page.goto("http://10.8.0.1/"),
    (error: Error & { code?: string }) => error.code === "blocked-private",
  );
  await assert.rejects(
    () => page.goto("http://169.254.169.254/"),
    (error: Error & { code?: string }) => error.code === "blocked-private",
  );
});

test("explicit custom local profile URL remains navigable", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-privnet-custom-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);
  const profile = await service.createProfile(space, storage, {
    providerId: "custom",
    name: "HA",
    customUrl: "http://127.0.0.1:8123/",
  });
  const tab = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const page = profiles.getPage(tab.id);
  assert.ok(page);
  const nav = await page.goto("http://127.0.0.1:8123/lovelace");
  assert.equal(new URL(nav.url).origin, "http://127.0.0.1:8123");
  await assert.rejects(
    () => page.goto("http://192.168.1.1/"),
    (error: Error & { code?: string }) => error.code === "blocked-private",
  );
});

test("unsafe custom profile schemes are rejected before a profile is created", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-privnet-scheme-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);
  for (const customUrl of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
    await assert.rejects(
      () => service.createProfile(space, storage, { providerId: "custom", name: "Bad", customUrl }),
      (error: Error & { code?: string }) => error.code === "blocked-scheme",
      customUrl,
    );
  }
  const ok = await service.createProfile(space, storage, {
    providerId: "custom",
    name: "HA",
    customUrl: "http://127.0.0.1:8123/",
  });
  assert.equal(ok.customUrl, "http://127.0.0.1:8123/");
});

test("direct navigation of unsafe schemes is rejected on an existing profile", async () => {
  resetFakeProfileLocks();
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-privnet-navscheme-"));
  const storage = createSpaceStorage(homeRoot);
  const space = ctx("space-1", "user-1", homeRoot);
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver(), liveTabLimit: 4 });
  const service = createChatWorkspaceService(profiles);
  const profile = await service.createProfile(space, storage, { providerId: "chatgpt", name: "Personal" });
  const tab = await service.createTab({ ctx: space, storage, projectId: "proj-a", profileId: profile.id });
  const page = profiles.getPage(tab.id);
  assert.ok(page);
  for (const raw of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "chrome://settings"]) {
    await assert.rejects(
      () => page.goto(raw),
      (error: Error & { code?: string }) => error.code === "blocked-scheme",
      raw,
    );
  }
});
