import test from "node:test";
import assert from "node:assert/strict";
import { api } from "@polyth/session/web-api";

interface FetchCall {
  path: string;
  init?: RequestInit;
}

test("Secure Safe API encodes ids and sends values only in write requests", async () => {
  const calls: FetchCall[] = [];
  const entry = {
    id: "entry/id",
    handle: "deploy-token",
    label: "Deployment token",
    purpose: "Publish releases",
    kind: "token" as const,
    scope: "global" as const,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const isList = path === "/api/secure-safe" && !init;
      return {
        ok: true,
        status: isList ? 200 : 204,
        statusText: "OK",
        json: async () => isList ? [entry] : undefined,
        text: async () => "",
      };
    },
  });

  assert.deepEqual(await api.listSecureSafe(), [entry]);
  await api.saveSecureSafe({ handle: entry.handle, label: entry.label, value: "write-only" });
  await api.replySecret("session/id", "request/id", "save", "one-use-value");
  await api.replySecret("session/id", "request/id", "dismiss");
  await api.deleteSecureSafe(entry.id);

  assert.equal(calls[0]?.path, "/api/secure-safe");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    handle: "deploy-token",
    label: "Deployment token",
    value: "write-only",
  });
  assert.equal(calls[2]?.path, "/api/sessions/session%2Fid/secrets/request%2Fid");
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { action: "save", value: "one-use-value" });
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { action: "dismiss" });
  assert.equal(calls[4]?.path, "/api/secure-safe/entry%2Fid");
  assert.equal(calls[4]?.init?.method, "DELETE");
});
