import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";
import { localModelCatalog } from "../src/localModelCatalog.ts";
import { localVoiceCatalog } from "../src/localVoiceCatalog.ts";

const voiceSettings = {
  get: () => ({
    stt: { baseUrl: "", model: "", apiKeyEnv: "", language: "en-US" },
    tts: { baseUrl: "", model: "", apiKeyEnv: "", voice: "" },
    dictation: {
      provider: "web-speech",
      transport: "browser",
      model: "",
      localModel: "",
      language: "auto",
      contextInjection: true,
      processingPolicy: "selected",
      fallbackApiKeyEnv: "",
      cloudFallback: false,
      latencyPreference: "balanced",
      apiKeyEnv: "",
    },
  }),
  put: () => voiceSettings.get(),
  storedKeys: () => [],
  resolveKey: () => undefined,
  resolveTtsSecret: () => undefined,
  resolveDictationProviderKey: () => undefined,
};

/** The minimal host dictation needs to register; it opens no adapter while idle. */
const registrationHost = (root: string): ServerPackageHost => ({
  pluginId: "dictation",
  storageDir: root,
  services: { require: () => voiceSettings, provide: () => {} },
} as unknown as ServerPackageHost);

test("dictation adopts only its own catalog entries and runtime dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-dictation-data-"));
  try {
    const modelId = localModelCatalog()[0]!.id;
    const voiceId = localVoiceCatalog()[0]!.id;
    for (const dir of [
      join(root, "models", modelId),
      join(root, "models", "another-owner-model"),
      join(root, "voices", voiceId),
      join(root, "voices", "another-owner-voice"),
      join(root, "runtime", "sherpa-onnx-node-1.13.7"),
      join(root, "runtime", "another-owner-runtime"),
    ]) mkdirSync(dir, { recursive: true });

    registerPackage(registrationHost(root));

    const dataDir = join(root, "packages", "dictation");
    for (const rel of [`models/${modelId}`, `voices/${voiceId}`, "runtime/sherpa-onnx-node-1.13.7"]) {
      assert.equal(existsSync(join(dataDir, rel)), true, `${rel} moved into the package directory`);
      assert.equal(existsSync(join(root, rel)), false, `${rel} left the shared root`);
    }
    // Generic names in the same shared directories may belong to another owner.
    for (const rel of ["models/another-owner-model", "voices/another-owner-voice", "runtime/another-owner-runtime"]) {
      assert.equal(existsSync(join(root, rel)), true, `${rel} stays in the shared root`);
      assert.equal(existsSync(join(dataDir, rel)), false, `${rel} is not stolen`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh dictation install creates its data only under the package directory", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-dictation-data-"));
  try {
    registerPackage(registrationHost(root));
    assert.deepEqual(readdirSync(root), ["packages"], "nothing is written to the shared root");
    assert.equal(existsSync(join(root, "models")), false);
    assert.equal(existsSync(join(root, "voices")), false);
    assert.equal(existsSync(join(root, "runtime")), false);
    assert.equal(existsSync(join(root, "packages", "dictation", "models")), true);
    assert.equal(existsSync(join(root, "packages", "dictation", "voices")), true);
    assert.equal(existsSync(join(root, "packages", "dictation", "runtime")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
