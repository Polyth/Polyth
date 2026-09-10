import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRemotePath } from "@polyth/contracts";
import { createDictationService, type SttAdapter } from "@polyth/dictation";
import { DICTATION_REMOTE_ACCESS, dictationRoutes } from "../src/serverEntry.ts";

const allowed = (method: string, path: string): boolean =>
  DICTATION_REMOTE_ACCESS.http.some((rule) =>
    (rule.methods as readonly string[]).includes(method) && matchRemotePath(rule.path, path));

test("paired dictation policy exposes session use but not voice/model/runtime administration", () => {
  assert.deepEqual(DICTATION_REMOTE_ACCESS.routeScopes, ["dictation", "voice"]);
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
  assert.equal(allowed("POST", "/api/tts/speak"), false);
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
