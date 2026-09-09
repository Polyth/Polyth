import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntime, ModelRef } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import { createSmallModelService } from "../src/smallModel.ts";

test("a direct-provider failure does not wait then replay as a session turn", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let submitted = 0;
  const runtime = {
    models: async () => [{ providerID: "custom", modelID: "small", name: "Small" }],
    completeSmallModel: async () => {
      throw Object.assign(new Error("provider timed out"), { code: "timeout" });
    },
    startTurnOperation: async () => {
      submitted += 1;
      throw new Error("must not submit a duplicate turn");
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    () => createSmallModelService(store).complete(runtime, {
      cwd: "/repo", prompt: "next action", maxOutputTokens: 64,
    }),
    /provider timed out/,
  );
  assert.equal(submitted, 0);
  await store.close();
});

test("a stale configured model fails before provider invocation", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let invoked = false;
  const runtime = {
    models: async () => [{ providerID: "openai", modelID: "available", name: "Available" }],
    completeSmallModel: async () => {
      invoked = true;
      throw new Error("must not invoke provider");
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    () => createSmallModelService(store).complete(runtime, {
      cwd: "/repo",
      prompt: "improve this",
      model: { providerID: "openai", modelID: "deleted" },
      maxOutputTokens: 64,
    }),
    (error: Error & { code?: string }) => error.code === "invalid-model" && /not available/.test(error.message),
  );
  assert.equal(invoked, false);
  await store.close();
});

test("an unresolved small model never falls through to the runtime default", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let submitted = 0;
  const runtime = {
    completeSmallModel: async () => {
      throw Object.assign(new Error("direct transport unavailable"), { code: "unsupported" });
    },
    startTurnOperation: async () => {
      submitted += 1;
      throw new Error("must not use the default model");
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    () => createSmallModelService(store).complete(runtime, {
      cwd: "/repo",
      prompt: "improve this",
      maxOutputTokens: 64,
    }),
    (error: Error & { code?: string }) => error.code === "unavailable" && /no small model configured/.test(error.message),
  );
  assert.equal(submitted, 0);
  await store.close();
});

test("an unsupported direct transport falls back to one compatibility turn", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let handler: Parameters<AgentRuntime["onEvent"]>[0] = () => {};
  let submitted = 0;
  let directModel: unknown;
  let fallbackModel: unknown;
  const runtime = {
    models: async () => [{ providerID: "custom", modelID: "small", name: "Small" }],
    completeSmallModel: async (request: { model?: unknown }) => {
      directModel = request.model;
      throw Object.assign(new Error("direct transport unavailable"), { code: "unsupported" });
    },
    createSessionOperation: async () => ({
      kind: "confirmed" as const,
      value: { backendSessionId: "backend-utility" },
    }),
    startTurnOperation: async (request: { sessionId: string; model?: unknown }) => {
      submitted += 1;
      fallbackModel = request.model;
      handler(request.sessionId, { type: "assistant/message", partId: "answer", text: "improved prompt" });
      handler(request.sessionId, { type: "turn/stopped", reason: "completed" });
      return { kind: "confirmed" as const, value: undefined };
    },
    onEvent: (next: typeof handler) => {
      handler = next;
      return { dispose() {} };
    },
  } as unknown as AgentRuntime;

  const result = await createSmallModelService(store).complete(runtime, {
    cwd: "/repo",
    prompt: "improve this",
    model: { providerID: "custom", modelID: "small", harnessId: "opencode" } as ModelRef & { harnessId: string },
    maxOutputTokens: 64,
  });

  assert.equal(result.text, "improved prompt");
  assert.equal(result.transport, "compatibility");
  assert.equal(submitted, 1);
  assert.deepEqual(directModel, { providerID: "custom", modelID: "small" });
  assert.deepEqual(fallbackModel, directModel);
  await store.close();
});
