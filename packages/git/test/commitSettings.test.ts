import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createCommitSettingsStore } from "../src/commitSettingsStore.ts";
import { parseCommitSettings } from "../src/commitSettings.ts";

test("commit settings persist per Space and reject stale revisions and invalid selections", () => {
  const root = mkdtempSync(join(tmpdir(), "commit-settings-"));
  try {
    const store = createCommitSettingsStore((space) => ({ root, path: (path) => join(root, space.spaceId, path), packageDir: (id) => {
      const path = join(root, space.spaceId, "packages", id); mkdirSync(path, { recursive: true }); return path;
    } }));
    const a = { spaceId: "a" } as SpaceContext, b = { spaceId: "b" } as SpaceContext;
    assert.deepEqual(store.read(a), { revision: 0, settings: { mode: "session" } });
    const settings = { mode: "custom", model: { harnessId: "codex", providerID: "openai", modelID: "test" } };
    store.save(a, settings, 0);
    assert.deepEqual(store.read(a).settings, settings);
    assert.equal(store.read(b).settings.mode, "session");
    assert.throws(() => store.save(a, { mode: "small" }, 0), /changed elsewhere/);
    assert.throws(() => parseCommitSettings({ mode: "custom" }), /custom model/);
    assert.throws(() => parseCommitSettings({ mode: "unknown" }), /Choose/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
