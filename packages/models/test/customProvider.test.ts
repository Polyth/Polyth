import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactProviderError,
  slugifyProviderId,
  uniqueProviderId,
  validateCustomProviderInput,
  validateProviderBaseURL,
} from "../src/customProvider.ts";

test("slugify and unique ids allow multiple openai-compatible instances", () => {
  assert.equal(slugifyProviderId("LM Studio"), "lm-studio");
  const taken = new Set(["lm-studio"]);
  assert.equal(uniqueProviderId("lm-studio", taken), "lm-studio-2");
});

test("Display name Cursor does not steal the built-in cursor id", () => {
  assert.equal(slugifyProviderId("Cursor"), "cursor");
  assert.equal(uniqueProviderId("cursor", new Set(["cursor"])), "cursor-2");
});

test("duplicate explicit id is rejected", () => {
  assert.throws(
    () => validateCustomProviderInput({
      id: "company-gateway",
      name: "Gateway",
      baseURL: "https://ai.example/v1",
      protocol: "openai-compatible",
      authMode: "none",
    }, new Set(["company-gateway"])),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
});

test("url policy allows http localhost and rejects credentials, exotic schemes, and query/hash", () => {
  assert.equal(validateProviderBaseURL("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.throws(() => validateProviderBaseURL("file:///etc/passwd"), /http and https/);
  assert.throws(() => validateProviderBaseURL("https://user:secret@host/v1"), /credentials/);
  assert.throws(() => validateProviderBaseURL("http://127.0.0.1:1234/v1?x=1"), /query/);
  assert.throws(() => validateProviderBaseURL("http://127.0.0.1:1234/v1#frag"), /query|fragment/);
});

test("unknown protocol and auth mode are rejected rather than coerced", () => {
  assert.throws(
    () => validateCustomProviderInput({
      name: "X",
      baseURL: "https://ai.example/v1",
      protocol: "anthropic" as never,
      authMode: "none",
    }, new Set()),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );
  assert.throws(
    () => validateCustomProviderInput({
      name: "X",
      baseURL: "https://ai.example/v1",
      protocol: "openai-compatible",
      authMode: "oauth" as never,
    }, new Set()),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );
});

test("api-key mode requires a key on create, not on update", () => {
  assert.throws(
    () => validateCustomProviderInput({
      name: "OpenAI-compat",
      baseURL: "https://api.example/v1",
      protocol: "openai-compatible",
      authMode: "api-key",
    }, new Set()),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );
  const updated = validateCustomProviderInput({
    name: "OpenAI-compat",
    baseURL: "https://api.example/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
  }, new Set(), { existingId: "company-gateway" });
  assert.equal(updated.id, "company-gateway");
  assert.equal(updated.apiKey, undefined);
});

test("redactProviderError never returns the secret or header values", () => {
  const secret = "sk-live-super-secret-value";
  const header = "super-header-secret-value";
  const out = redactProviderError(`Authorization: Bearer ${secret} failed api_key=${secret} X-Org=${header}`, [secret, header]);
  assert.equal(out.includes(secret), false);
  assert.equal(out.includes(header), false);
  assert.match(out, /\*\*\*/);
});
