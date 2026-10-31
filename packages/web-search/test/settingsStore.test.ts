import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createWebSearchSettingsStore } from "../src/settingsStore.ts";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../src/settings.ts";

const context = (spaceId: string, root: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "user-1",
  role: "owner",
  deployment: "local-trusted",
  storageDir: root,
});

const storage = (root: string): SpaceStorage => ({
  root,
  packageDir(packageId) {
    const path = join(root, "packages", packageId);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  },
  path(relative) {
    const path = resolve(root, relative);
    if (path !== resolve(root) && !path.startsWith(`${resolve(root)}${sep}`)) {
      throw new Error("path escaped Space storage");
    }
    return path;
  },
});

test("settings are revisioned, atomic, and isolated by Space", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-web-search-settings-"));
  try {
    const store = createWebSearchSettingsStore((space) => storage(join(root, space.spaceId)));
    const first = context("space-a", join(root, "space-a"));
    const second = context("space-b", join(root, "space-b"));
    assert.deepEqual(store.read(first), { revision: 0, settings: DEFAULT_WEB_SEARCH_SETTINGS });

    const saved = store.save(first, {
      ...DEFAULT_WEB_SEARCH_SETTINGS,
      provider: "duckduckgo",
      maxResults: 5,
      region: "ua-uk",
    }, 0);
    assert.equal(saved.revision, 1);
    assert.equal(store.read(second).revision, 0);
    assert.throws(() => store.save(first, DEFAULT_WEB_SEARCH_SETTINGS, 0), (cause: unknown) => {
      assert.equal((cause as { code?: string }).code, "conflict");
      return true;
    });

    const path = join(root, "space-a", "packages", "web-search", "settings.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).settings.region, "ua-uk");
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
