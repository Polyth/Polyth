import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalModelManager, localModelCatalog } from "../src/localModels.ts";

test("Nemotron catalog pins the verified 80 ms multilingual artifact", () => {
  const model = localModelCatalog()[0]!;
  assert.equal(model.id, "nemotron-3.5-streaming-0.6b-80ms");
  assert.equal(model.archiveBytes, 475_274_007);
  assert.equal(model.sha256, "fb170128c496db33a1fb9f5f9f823257f42f911224ee218bb429f3c2eaf90a8d");
  assert.ok(model.languages.includes("uk-UA"));
  assert.equal(model.latencyMs, 80);
});

test("constructing or inspecting the model manager never downloads implicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-asr-"));
  let fetches = 0;
  try {
    const manager = createLocalModelManager({
      root,
      fetchFn: async () => {
        fetches++;
        throw new Error("must not fetch");
      },
    });
    const list = await manager.list();
    const state = await manager.status("nemotron-3.5-streaming-0.6b-80ms");
    assert.equal(list.length, 1);
    assert.equal(state.state, "missing");
    assert.equal(state.downloadedBytes, 0);
    assert.equal(fetches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown local model ids fail explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-asr-"));
  try {
    const manager = createLocalModelManager({ root });
    await assert.rejects(
      () => manager.status("made-up-model"),
      (error: unknown) => (error as { code?: string }).code === "local_model_missing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
