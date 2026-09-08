import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProfileChromiumDriver,
  createProfileRegistry,
  newChatTabId,
  resetProfileChromiumLocks,
} from "../src/index.ts";

const gated = process.env.POLYTH_REAL_CHROMIUM === "1";

test("real chromium persistent profile smoke", { skip: !gated }, async () => {
  resetProfileChromiumLocks();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-chrome-profile-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "real-profile";
  await registry.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: ["http://127.0.0.1:8765"],
  });
  const tabId = newChatTabId();
  registry.registerTab("space:proj", tabId, profileId);

  const frames: Array<{ data: Uint8Array }> = [];
  registry.onFrame((f) => { if (f.tabId === tabId) frames.push(f); });

  const tab = await registry.ensureLive(tabId, "http://127.0.0.1:8765/");
  const page = registry.getPage(tabId);
  assert.ok(page);

  await page!.startScreencast({ quality: 60, maxWidth: 800, maxHeight: 600 });
  await page!.insertText("hello chromium");
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(frames.length >= 1, "expected at least one screencast frame");

  const selection = await page!.copySelection();
  assert.match(selection + "hello chromium", /hello/);

  let locked = false;
  try {
    await driver!.openProfile({
      profileId: "dup",
      userDataDir,
      viewport: { width: 800, height: 600 },
      colorScheme: "no-preference",
      guardNavigation: async () => {},
    });
  } catch (e) {
    locked = (e as Error & { code?: string }).code === "profile-locked";
  }
  assert.equal(locked, true, "second launch on same user-data-dir must profile-lock");

  await registry.closeAll();
  rmSync(userDataDir, { recursive: true, force: true });
});
