import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRemotePath } from "@polyth/contracts";
import { createDictationService, type SttAdapter } from "@polyth/dictation";
import { DICTATION_REMOTE_ACCESS, dictationRoutes } from "../src/serverEntry.ts";
import { validateRemoteAccessPolicy } from "../../server/src/remotePolicy.ts";

const allowed = (method: string, path: string): boolean =>
  DICTATION_REMOTE_ACCESS.http.some((rule) =>
    (rule.methods as readonly string[]).includes(method) && matchRemotePath(rule.path, path));

test("paired dictation policy exposes session use but not voice/model/runtime administration", () => {
  // The server refuses to start a package whose policy fails this.
  validateRemoteAccessPolicy("dictation", DICTATION_REMOTE_ACCESS);
  assert.deepEqual(DICTATION_REMOTE_ACCESS.routeScopes, ["dictation", "voice", "tts"]);
  for (const rule of DICTATION_REMOTE_ACCESS.http) {
    assert.ok(
      (DICTATION_REMOTE_ACCESS.routeScopes as readonly string[]).includes(rule.path.split("/")[2]!),
      `${rule.path} must belong to a declared route scope`,
    );
  }
  assert.equal(allowed("GET", "/api/dictation/capability"), true);
  assert.equal(allowed("POST", "/api/dictation/sessions"), true);
  assert.equal(allowed("GET", "/api/dictation/sessions/session-1"), true);
  assert.equal(allowed("DELETE", "/api/dictation/sessions/session-1"), true);
  assert.equal(allowed("POST", "/api/dictation/sessions/session-1/finalize"), true);
  assert.equal(allowed("GET", "/api/voice/providers"), true);
  assert.equal(allowed("POST", "/api/dictation/token"), true);

  assert.equal(allowed("POST", "/api/dictation"), false);
  assert.equal(allowed("GET", "/api/dictation/runtime"), false);
  assert.equal(allowed("DELETE", "/api/dictation/runtime"), false);
  assert.equal(allowed("GET", "/api/dictation/models"), false);
  assert.equal(allowed("POST", "/api/dictation/models/model/download"), false);
  assert.equal(allowed("GET", "/api/settings/voice"), false);
  assert.equal(allowed("PUT", "/api/settings/voice"), false);
  assert.equal(allowed("POST", "/api/tts/speak"), false, "a paid custom voice server stays local-only");
  // Built-in voices cost nothing: a phone may list them and hear one, but
  // installing or removing them stays on the server's own screen.
  assert.equal(allowed("GET", "/api/tts/voices"), true);
  assert.equal(allowed("POST", "/api/tts/local"), true);
  assert.equal(allowed("POST", "/api/tts/voices/piper-uk_UA-lada-x_low/download"), false);
  assert.equal(allowed("DELETE", "/api/tts/voices/piper-uk_UA-lada-x_low"), false);
});

const adapter: SttAdapter = {
  engine: "fake",
  createStream: () => ({
    push() {},
    partial: () => "partial",
    finalize: async () => "final",
  }),
};

const call = async (
  route: ReturnType<typeof dictationRoutes>,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ handled: boolean; status: number; payload: unknown }> => {
  let status = 0;
  let payload: unknown;
  const handled = await route({
    path,
    method,
    body: async () => body,
    json(code: number, value: unknown) { status = code; payload = value; },
  } as never);
  return { handled, status, payload };
};

test("remote-safe session namespace is behaviorally equivalent to legacy lifecycle routes", async () => {
  const service = createDictationService({ adapter });
  const route = dictationRoutes(service);
  const created = await call(route, "POST", "/api/dictation/sessions", {
    sessionId: "chat-1",
    language: "uk-UA",
    context: { keywords: ["Polyth"] },
  });
  assert.equal(created.handled, true);
  assert.equal(created.status, 200);
  const id = (created.payload as { id: string }).id;

  const read = await call(route, "GET", `/api/dictation/sessions/${id}`);
  assert.equal(read.status, 200);
  assert.equal((read.payload as { sessionId?: string }).sessionId, "chat-1");

  const final = await call(route, "POST", `/api/dictation/sessions/${id}/finalize`);
  assert.equal(final.status, 200);
  assert.equal((final.payload as { transcript: string }).transcript, "final");

  const cancelled = await call(route, "DELETE", `/api/dictation/sessions/${id}`);
  assert.equal(cancelled.status, 200);
});

test("capability names the server's recognition choice for clients that cannot read voice settings", async () => {
  const service = createDictationService({ adapter });
  const selection = {
    provider: "local-nemotron" as const,
    transport: "local-worker" as const,
    model: "",
    language: "auto",
    contextInjection: false,
    processingPolicy: "local-only" as const,
  };
  const capability = await call(dictationRoutes(service, () => selection), "GET", "/api/dictation/capability");
  assert.equal(capability.status, 200);
  assert.deepEqual((capability.payload as { selection?: unknown }).selection, selection);
  assert.equal((capability.payload as { available?: boolean }).available, true);
  // The paired-device surface exposes the capability but not the settings.
  assert.ok(DICTATION_REMOTE_ACCESS.http.some((rule) => rule.path === "/api/dictation/capability"));
  assert.ok(!DICTATION_REMOTE_ACCESS.http.some((rule) => rule.path === "/api/settings/voice"));
});
