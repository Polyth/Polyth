import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceStorage } from "@polyth/tenancy";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntryWithDeviceRuntime.ts";

function fakeHost(): ServerPackageHost {
  const provided = new Map<string, unknown>();
  const storage = createSpaceStorage(mkdtempSync(join(tmpdir(), "polyth-cw-scope-")));
  return {
    services: {
      get: (key: { id: string }) => provided.get(key.id) ?? null,
      provide: (key: { id: string }, value: unknown) => { provided.set(key.id, value); },
      require: (key: { id: string }) => {
        const value = provided.get(key.id);
        if (!value) throw new Error("missing service");
        return value;
      },
    },
    onHttpServer: () => {},
    spaceStorage: () => storage,
    forSpace: () => ({ projects: { get: async () => ({ id: "p1" }) }, sessions: {} }),
  } as unknown as ServerPackageHost;
}

function request(path: string, url: string) {
  const responses: { code: number; body: unknown }[] = [];
  return {
    request: {
      path,
      method: "GET",
      url: new URL(url, "http://localhost"),
      space: {},
      json: (code: number, body: unknown) => { responses.push({ code, body }); },
      body: async () => ({}),
    },
    responses,
  };
}

// Contributed routes are offered every request, so the "waiting for Desktop
// runtime" gate must decline paths owned by other packages — `/api/worktrees`
// carries a `projectId` query too.
test("device-runtime gate does not answer other packages' projectId routes", async () => {
  const pkg = registerPackage(fakeHost());
  const foreign = request("/api/worktrees", "/api/worktrees?projectId=p1");
  assert.equal(await pkg.routes!(foreign.request as never), false);
  assert.deepEqual(foreign.responses, []);

  const own = request("/api/chat-workspace/projects/p1/workspace", "/api/chat-workspace/projects/p1/workspace");
  assert.equal(await pkg.routes!(own.request as never), true);
  assert.equal(own.responses[0]?.code, 503);
});
