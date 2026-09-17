import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import { createOpenCodePendingService } from "../src/opencodePending.ts";
import { createPackageRegistry } from "../src/packages.ts";
import { opencodePendingRoutes } from "../src/routes/opencodePending.ts";
import { packageRoutes } from "../src/routes/packages.ts";
import { settingsRoutes } from "../src/routes/settings.ts";

const dir = () => mkdtempSync(join(tmpdir(), "polyth-instance-auth-"));

type AuthoritativeSpace = SpaceContext & { readonly instanceOwner: boolean };

const space = (instanceOwner?: boolean): SpaceContext => ({
  spaceId: "spc_test",
  spaceSlug: "test",
  userId: "usr_test",
  role: "owner",
  deployment: "local-trusted",
  storageDir: dir(),
  ...(instanceOwner === undefined ? {} : { instanceOwner }),
} as AuthoritativeSpace);

const uiPrincipal = {
  kind: "ui-session" as const,
  sessionId: "ses_test",
  rememberedDeviceId: "dev_test",
};

const request = (overrides: Partial<RouteRequest> = {}): RouteRequest => ({
  req: {} as never,
  res: {} as never,
  url: new URL("http://polyth.test/api/test"),
  path: "/api/test",
  method: "GET",
  ingress: { kind: "public-http", listenerId: "test", loopback: true, secure: true },
  principal: uiPrincipal,
  space: space(false),
  requireCapability() {},
  body: async () => ({}),
  json() {},
  ...overrides,
});

test("canonical Space ownership does not grant installation authority", () => {
  assert.throws(
    () => requireInstanceOwnerAuthority(request()),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.doesNotThrow(() => requireInstanceOwnerAuthority(request({ space: space(true) })));
});

test("pre-canonical local-user remains the narrow compatibility operator", () => {
  const legacySpace = space();
  assert.doesNotThrow(() => requireInstanceOwnerAuthority(request({
    principal: { kind: "local-user", trustedLoopback: true },
    space: legacySpace,
  })));
  assert.throws(
    () => requireInstanceOwnerAuthority(request({ principal: uiPrincipal, space: legacySpace })),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
});

test("global package toggles reject a canonical non-instance-owner", async () => {
  const registry = createPackageRegistry({
    file: join(dir(), "packages.json"),
    descriptors: [{
      id: "demo",
      name: "Demo",
      description: "test",
      core: false,
      enabled: true,
      hasSettings: false,
    }],
  });
  const route = packageRoutes(registry);
  await assert.rejects(
    () => route(request({
      path: "/api/packages/demo",
      method: "PATCH",
      body: async () => ({ enabled: false }),
    })),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.equal(registry.isEnabled("demo"), true);
});

test("global behavior mutations reject a canonical non-instance-owner before write", async () => {
  let writes = 0;
  const route = settingsRoutes({
    behavior: {
      get: async () => ({ text: "", revision: "0" }),
      put: async () => { writes += 1; return { text: "changed", revision: "1" }; },
      subagentPolicy: async () => ({ enabled: true }),
      putSubagentPolicy: async () => { writes += 1; return { enabled: false }; },
      workspaceInstructionsPolicy: async () => ({ enabled: false }),
      putWorkspaceInstructionsPolicy: async () => { writes += 1; return { enabled: true }; },
      current: async () => null,
    } as never,
    mcp: {} as never,
    systemInfo: () => ({
      version: "test",
      applicationUrl: "http://127.0.0.1:1",
      tunnelUrl: null,
      dataDirLabel: "data",
      capabilities: [],
    }),
  });

  await assert.rejects(
    () => route(request({
      path: "/api/settings/behavior",
      method: "PUT",
      body: async () => ({ text: "changed", expectedRevision: "0" }),
    })),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.equal(writes, 0);
});

test("OpenCode apply-and-restart rejects a canonical non-instance-owner before restart", async () => {
  let restarts = 0;
  const pending = createOpenCodePendingService({
    restart: async () => { restarts += 1; return 1; },
  });
  const route = opencodePendingRoutes(pending);
  await assert.rejects(
    () => route(request({ path: "/api/opencode/apply-restart", method: "POST" })),
    (error: Error & { code?: string }) => error.code === "forbidden",
  );
  assert.equal(restarts, 0);
});
