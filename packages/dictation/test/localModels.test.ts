import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalModelManager,
  DEFAULT_LOCAL_MODEL_ID,
  localModelCatalog,
} from "../src/localModels.ts";

test("Nemotron catalog pins every verified multilingual latency preset", () => {
  const models = localModelCatalog();
  assert.equal(models.length, 4);
  assert.deepEqual(
    models.map((model) => [model.preset, model.latencyMs, model.archiveBytes, model.sha256]),
    [
      ["ultra", 80, 475_274_007, "fb170128c496db33a1fb9f5f9f823257f42f911224ee218bb429f3c2eaf90a8d"],
      ["fast", 160, 475_273_363, "a81909a1780d84cff16d73c15e13e67d9d81d8839faf14870d507d8499f7a61a"],
      ["balanced", 560, 475_271_763, "c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a"],
      ["accurate", 1120, 475_276_334, "adbdd5e9fef87300c37cebfcfc4f1ebe56845c860c8a760af0a1dd65ce9beed3"],
    ],
  );
  for (const model of models) assert.ok(model.languages.includes("uk-UA"));
  assert.equal(DEFAULT_LOCAL_MODEL_ID, "nemotron-3.5-streaming-0.6b-560ms");
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
    const state = await manager.status(DEFAULT_LOCAL_MODEL_ID);
    assert.equal(list.length, 4);
    assert.equal(state.state, "missing");
    assert.equal(state.downloadedBytes, 0);
    assert.equal(fetches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("download refuses insufficient disk before touching the network", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-asr-"));
  let fetches = 0;
  try {
    const manager = createLocalModelManager({
      root,
      availableBytes: async () => 1,
      fetchFn: async () => {
        fetches++;
        throw new Error("must not fetch");
      },
    });
    await assert.rejects(
      () => manager.download(DEFAULT_LOCAL_MODEL_ID),
      (error: unknown) => {
        const e = error as { code?: string; message?: string };
        return e.code === "local_model_failed" && /free disk space/i.test(e.message ?? "");
      },
    );
    assert.equal(fetches, 0);
    assert.equal((await manager.status(DEFAULT_LOCAL_MODEL_ID)).state, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelAll aborts explicit downloads without deleting the resumable partial state", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-local-asr-"));
  try {
    const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    })) as typeof fetch;
    const manager = createLocalModelManager({
      root,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
      fetchFn,
    });
    const download = manager.download(DEFAULT_LOCAL_MODEL_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await manager.status(DEFAULT_LOCAL_MODEL_ID)).state, "downloading");
    await manager.cancelAll();
    await assert.rejects(
      () => download,
      (error: unknown) => (error as { code?: string }).code === "session_expired",
    );
    assert.notEqual((await manager.status(DEFAULT_LOCAL_MODEL_ID)).state, "downloading");
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
