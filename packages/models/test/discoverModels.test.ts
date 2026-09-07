import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverOpenAiModels } from "../src/discoverModels.ts";

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("successful /models discovery maps ids without spending inference", async () => {
  const urls: string[] = [];
  const result = await discoverOpenAiModels({
    baseURL: "http://127.0.0.1:1234/v1",
    apiKey: "sk-test-secret",
    fetchImpl: async (input) => {
      urls.push(String(input));
      return jsonResponse(200, { data: [{ id: "llama-3", name: "Llama 3" }, { id: "llama-3" }] });
    },
  });
  assert.deepEqual(urls, ["http://127.0.0.1:1234/v1/models"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.models, [{ id: "llama-3", name: "Llama 3" }]);
});

test("404/405 becomes unsupported so the UI can fall back to manual models", async () => {
  const result = await discoverOpenAiModels({
    baseURL: "https://gateway.example/v1",
    fetchImpl: async () => jsonResponse(404, { error: "nope" }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unsupported");
    assert.match(result.message, /manually/i);
  }
});

test("401 is auth-rejected and the secret never appears in the message", async () => {
  const secret = "sk-live-should-not-leak";
  const result = await discoverOpenAiModels({
    baseURL: "https://gateway.example/v1",
    apiKey: secret,
    fetchImpl: async () => jsonResponse(401, { error: `bad ${secret}` }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "auth-rejected");
    assert.equal(result.message.includes(secret), false);
  }
});

test("malformed payload is a clear invalid-response, not a crash", async () => {
  const result = await discoverOpenAiModels({
    baseURL: "https://gateway.example/v1",
    fetchImpl: async () => jsonResponse(200, { unexpected: true }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid-response");
});

test("redirects are rejected", async () => {
  const result = await discoverOpenAiModels({
    baseURL: "https://gateway.example/v1",
    fetchImpl: async (_input, init) => {
      assert.equal((init as RequestInit).redirect, "error");
      throw new TypeError("redirect not allowed");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unreachable");
});

test("Content-Length over the byte limit is rejected without reading the body", async () => {
  let cancelled = false;
  let read = false;
  const result = await discoverOpenAiModels({
    baseURL: "https://gateway.example/v1",
    maxBytes: 32,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json", "content-length": "999999" }),
      body: {
        cancel: async () => { cancelled = true; },
        getReader() {
          read = true;
          throw new Error("reader must not start after Content-Length precheck");
        },
      },
      arrayBuffer: async () => {
        read = true;
        throw new Error("body must not be buffered after Content-Length precheck");
      },
    }) as unknown as Response,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /too large/);
  assert.equal(cancelled, true);
  assert.equal(read, false);
});

test("streaming read cancels once the byte limit is exceeded", async () => {
  const chunk = new Uint8Array(200).fill(65);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  const result = await discoverOpenAiModels({
    baseURL: "https://gateway.example/v1",
    maxBytes: 250,
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /too large/);
  assert.equal(cancelled, true);
});

test("header values never appear in discovery error messages", async () => {
  const header = "super-secret-header-value";
  const result = await discoverOpenAiModels({
    baseURL: "https://gateway.example/v1",
    headers: { "X-Api-Key": header },
    fetchImpl: async () => jsonResponse(500, { error: header }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.message.includes(header), false);
});

test("discovered display names are bounded", async () => {
  const name = "n".repeat(512);
  const result = await discoverOpenAiModels({
    baseURL: "http://127.0.0.1:1234/v1",
    fetchImpl: async () => jsonResponse(200, { data: [{ id: "llama", name }] }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.models[0]?.name?.length, 256);
  }
});
