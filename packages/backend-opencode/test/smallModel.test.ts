import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("an OAuth login never invents an unconfigured small model", async () => {
  const previousData = process.env.XDG_DATA_HOME;
  const previousFetch = globalThis.fetch;
  const data = mkdtempSync(join(tmpdir(), "polyth-small-model-"));
  mkdirSync(join(data, "opencode"), { recursive: true });
  writeFileSync(join(data, "opencode", "auth.json"), JSON.stringify({
    openai: { type: "oauth", access: "not-used", expires: Date.now() + 60_000 },
  }));
  process.env.XDG_DATA_HOME = data;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("must not call a provider without an explicit model");
  };
  try {
    await assert.rejects(
      () => completeSmallModelDirect({ cwd: "/repo", prompt: "next action" }),
      (error: Error & { code?: string }) => error.code === "unsupported" && /unresolved/.test(error.message),
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
  }
});

test("one-shot direct requests never opt into provider prompt caching", async () => {
  const saved = {
    anthropic: process.env.ANTHROPIC_API_KEY, anthropicBase: process.env.ANTHROPIC_BASE_URL,
    openai: process.env.OPENAI_API_KEY, openaiBase: process.env.OPENAI_BASE_URL, data: process.env.XDG_DATA_HOME,
  };
  const previousFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = "https://anthropic.test";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://openai.test/v1";
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "polyth-small-model-"));
  const bodies: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    bodies.push(await request.text());
    return request.url.startsWith("https://anthropic.test")
      ? new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    for (const providerID of ["anthropic", "openai"]) {
      await completeSmallModelDirect({
        cwd: "/repo", prompt: "title this", systemPrompt: "be brief",
        model: { providerID, modelID: "small" }, maxOutputTokens: 16,
      });
    }
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.doesNotMatch(body, /cache_control|prompt_cache|cachePoint/i);
    }
    // The system prompt stays a plain string: no content blocks to hang a breakpoint on.
    assert.equal(typeof (JSON.parse(bodies[0]!) as { system: unknown }).system, "string");
  } finally {
    globalThis.fetch = previousFetch;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("ANTHROPIC_API_KEY", saved.anthropic);
    restore("ANTHROPIC_BASE_URL", saved.anthropicBase);
    restore("OPENAI_API_KEY", saved.openai);
    restore("OPENAI_BASE_URL", saved.openaiBase);
    restore("XDG_DATA_HOME", saved.data);
  }
});
