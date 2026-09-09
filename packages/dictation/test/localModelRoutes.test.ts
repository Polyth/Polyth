import { test } from "node:test";
import assert from "node:assert/strict";
import { localModelRoutes } from "../src/localModelRoutes.ts";
import type { LocalModelManager, LocalModelStatus } from "../src/localModels.ts";
import type { LocalRuntimeManager } from "../src/localRuntime.ts";
import type { RouteRequest } from "@polyth/contracts";

const model = (state: LocalModelStatus["state"]): LocalModelStatus => ({
  id: "nemotron-3.5-streaming-0.6b-560ms",
  label: "Balanced",
  provider: "local-nemotron",
  languages: ["uk-UA", "en"],
  streaming: true,
  latencyMs: 560,
  preset: "balanced",
  archiveBytes: 475_271_763,
  state,
  downloadedBytes: 0,
  totalBytes: 475_271_763,
});

test("explicit model download never starts the separate native runtime download", async () => {
  let modelState: LocalModelStatus["state"] = "missing";
  let modelDownloads = 0;
  let runtimeDownloads = 0;
  const models: LocalModelManager = {
    list: async () => [model(modelState)],
    status: async () => model(modelState),
    download: async () => {
      modelDownloads++;
      modelState = "downloading";
      return model(modelState);
    },
    cancelAll: async () => {},
    remove: async () => {},
    path: async () => null,
  };
  const runtime: LocalRuntimeManager = {
    status: async () => ({
      state: "missing",
      version: "1.13.7",
      platform: "linux",
      arch: "x64",
      downloadedBytes: 0,
    }),
    download: async () => {
      runtimeDownloads++;
      return {
        state: "downloading",
        version: "1.13.7",
        platform: "linux",
        arch: "x64",
        downloadedBytes: 0,
      };
    },
    cancel: async () => {},
    remove: async () => {},
    path: async () => null,
  };

  let statusCode = 0;
  let payload: unknown;
  const route = localModelRoutes(models, runtime);
  const handled = await route({
    path: "/api/dictation/models/nemotron-3.5-streaming-0.6b-560ms/download",
    method: "POST",
    json(code, body) { statusCode = code; payload = body; },
  } as unknown as RouteRequest);

  assert.equal(handled, true);
  assert.equal(statusCode, 202);
  assert.equal(modelDownloads, 1);
  assert.equal(runtimeDownloads, 0);
  assert.equal((payload as { state?: string }).state, "downloading");
});
