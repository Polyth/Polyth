import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceStorage } from "@polyth/tenancy";
import {
  loadProjectRuntimeBinding,
  normalizeRuntimePreference,
  saveProjectRuntimeBinding,
} from "../src/runtimeBinding.ts";

test("runtime binding defaults to local-first without implicit remote fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-cw-runtime-"));
  const storage = createSpaceStorage(root);
  const binding = await loadProjectRuntimeBinding(storage, "project-a");
  assert.equal(binding.preference.mode, "local-first");
  assert.equal(binding.preference.allowRemoteFallback, false);
  assert.equal(binding.updatedAt, 0);
});

test("runtime binding is project-scoped and persists selected device", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-cw-runtime-"));
  const storage = createSpaceStorage(root);
  await saveProjectRuntimeBinding(storage, "project-a", {
    mode: "local-first",
    deviceId: "desktop-a",
    allowRemoteFallback: false,
  });
  await saveProjectRuntimeBinding(storage, "project-b", {
    mode: "remote",
    allowRemoteFallback: true,
  });

  const a = await loadProjectRuntimeBinding(storage, "project-a");
  const b = await loadProjectRuntimeBinding(storage, "project-b");
  assert.equal(a.preference.deviceId, "desktop-a");
  assert.equal(a.preference.mode, "local-first");
  assert.equal(b.preference.mode, "remote");
  assert.equal(b.preference.deviceId, undefined);
});

test("normalizes untrusted runtime preference input", () => {
  assert.deepEqual(normalizeRuntimePreference({
    mode: "wat",
    deviceId: "  macbook  ",
    allowRemoteFallback: "yes",
  }), {
    mode: "local-first",
    deviceId: "macbook",
    allowRemoteFallback: false,
  });
});
