import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createCommitSettingsStore } from "../src/commitSettingsStore.ts";
import { COMMIT_RULE_MAX, parseCommitSettings } from "../src/commitSettings.ts";

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

test("a commit style is trimmed, bounded, and collapses to the built-in style when it says nothing", () => {
  const parsed = parseCommitSettings({ mode: "small", style: { titleRule: "  Start with [Fix].\r\n", detailsRule: "Bullets.\u0007", details: "always", matchHistory: true } });
  assert.deepEqual(parsed, { mode: "small", style: { titleRule: "Start with [Fix].", detailsRule: "Bullets.", details: "always", matchHistory: true } });
  assert.deepEqual(parseCommitSettings({ mode: "session", style: { titleRule: " ", detailsRule: "", details: "auto", matchHistory: false } }), { mode: "session" });
  assert.deepEqual(parseCommitSettings({ mode: "session", style: { details: "never" } }), { mode: "session", style: { titleRule: "", detailsRule: "", details: "never", matchHistory: false } });
  assert.throws(() => parseCommitSettings({ mode: "session", style: { titleRule: "x".repeat(COMMIT_RULE_MAX + 1) } }), /longer than/);
  assert.throws(() => parseCommitSettings({ mode: "session", style: { details: "sometimes" } }), /when to write details/);
  assert.throws(() => parseCommitSettings({ mode: "session", style: { titleRule: 42 } }), /must be text/);
  assert.throws(() => parseCommitSettings({ mode: "session", style: "terse" }), /must be an object/);
  const custom = parseCommitSettings({ mode: "custom", model: { harnessId: "codex", providerID: "openai", modelID: "m" }, style: { titleRule: "Lowercase." } });
  assert.equal(custom.style?.titleRule, "Lowercase.");
  assert.equal(custom.model?.modelID, "m");
});
