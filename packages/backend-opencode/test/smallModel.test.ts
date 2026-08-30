import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSmallModelDirect } from "../src/smallModel.ts";

test("direct small-model transport posts a stateless OpenAI-compatible completion", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousData = process.env.XDG_DATA_HOME;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://provider.test/v1";
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "polyth-small-model-"));
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: " concise result " } }] }), { status: 200 });
  };
  try {
    const result = await completeSmallModelDirect({
      cwd: "/repo", prompt: "diff", systemPrompt: "be concise",
      model: { providerID: "openai", modelID: "gpt-test" }, maxOutputTokens: 99,
    });
    assert.equal(result.text, "concise result");
    assert.equal(result.transport, "direct");
    assert.equal(request?.url, "https://provider.test/v1/chat/completions");
    assert.equal((await request?.json() as { max_completion_tokens: number }).max_completion_tokens, 99);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
  }
});

test("direct small-model transport propagates AbortSignal", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousData = process.env.XDG_DATA_HOME;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "polyth-small-model-"));
  let observedAbort = false;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { observedAbort = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
  const controller = new AbortController();
  const pending = completeSmallModelDirect({
    cwd: "/repo", prompt: "diff", model: { providerID: "openai", modelID: "gpt-test" }, signal: controller.signal,
  });
  controller.abort();
  try {
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(observedAbort, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
  }
});
