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
import { saveProfile } from "../src/storage.ts";

const ctx = (spaceId: string, userId: string, storageDir: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role: "owner",
  deployment: "local-trusted",
  storageDir,
});

test("profile ids from another Space storage answer not-found", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "polyth-cw-iso-home-"));
  const workRoot = mkdtempSync(join(tmpdir(), "polyth-cw-iso-work-"));
  const homeStorage = createSpaceStorage(homeRoot);
  const workStorage = createSpaceStorage(workRoot);
  const userId = "user-1";
  const profileId = randomUUID();
  const profile = {
    id: profileId,
    providerId: "chatgpt",
    name: "Personal",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    approvedOrigins: [] as string[],
  };
  await saveProfile(homeStorage, userId, profile);

  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const service = createChatWorkspaceService(profiles);

  await assert.rejects(
    () => service.deleteProfile(ctx("work-space", userId, workRoot), workStorage, profileId),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
});
