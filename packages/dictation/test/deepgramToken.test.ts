import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceSettings } from "../../server/src/voice.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { voiceRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

test("Deepgram direct token is short-lived and never exposes the long-lived API key", async () => {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  const voice = createVoiceSettings({
    file: join(mkdtempSync(join(tmpdir(), "polyth-deepgram-token-")), "voice.json"),
    env: { DEEPGRAM_API_KEY: "deepgram-long-lived-secret" },
  });
  voice.put({
    dictation: {
      provider: "deepgram",
      transport: "auto",
      processingPolicy: "prefer-cloud",
      apiKeyEnv: "DEEPGRAM_API_KEY",
    },
  });
  const routes = voiceRoutes({
    voice,
    providers: new ProviderRegistry(),
    fetchFn: (async (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url: String(url),
        auth: headers?.authorization ?? "",
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ access_token: "deepgram-jwt", expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  let status = 0;
  let payload: unknown;
  const request = {
    req: {},
    res: {},
    url: new URL("http://x/api/dictation/token"),
    path: "/api/dictation/token",
    method: "POST",
    body: async () => ({ provider: "deepgram" }),
    json: (code: number, body: unknown) => { status = code; payload = body; },
  } as unknown as RouteRequest;

  assert.equal(await routes(request), true);
  assert.equal(status, 200);
  assert.deepEqual(calls, [{
    url: "https://api.deepgram.com/v1/auth/grant",
    auth: "Token deepgram-long-lived-secret",
    body: JSON.stringify({ ttl_seconds: 60 }),
  }]);
  assert.deepEqual(payload, { provider: "deepgram", token: "deepgram-jwt", expiresInSeconds: 60 });
  assert.doesNotMatch(JSON.stringify(payload), /deepgram-long-lived-secret/);
});

test("auto-fallback never mints a direct cloud token because replay is server-owned", async () => {
  let fetches = 0;
  const voice = createVoiceSettings({
    file: join(mkdtempSync(join(tmpdir(), "polyth-deepgram-policy-")), "voice.json"),
    env: { DEEPGRAM_API_KEY: "deepgram-long-lived-secret" },
  });
  voice.put({
    dictation: {
      provider: "deepgram",
      transport: "auto",
      processingPolicy: "auto-fallback",
      apiKeyEnv: "DEEPGRAM_API_KEY",
    },
  });
  const routes = voiceRoutes({
    voice,
    providers: new ProviderRegistry(),
    fetchFn: (async () => {
      fetches++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });

  let status = 0;
  const request = {
    req: {}, res: {},
    url: new URL("http://x/api/dictation/token"),
    path: "/api/dictation/token", method: "POST",
    body: async () => ({ provider: "deepgram" }),
    json: (code: number) => { status = code; },
  } as unknown as RouteRequest;

  assert.equal(await routes(request), true);
  assert.equal(status, 400);
  assert.equal(fetches, 0);
});
