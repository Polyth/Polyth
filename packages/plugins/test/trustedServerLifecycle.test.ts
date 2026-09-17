import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_CAPABILITY,
  type AuthPrincipal,
  type RouteRequest,
  type SpaceContext,
} from "@polyth/contracts";
import type { PluginRegistry } from "../src/managedRegistry.ts";
import { guardTrustedServerLifecycle } from "../src/serverEntry.ts";

const ui = (userId: string): AuthPrincipal => ({
  kind: "ui-session",
  sessionId: `ses_${userId}`,
  rememberedDeviceId: `device_${userId}`,
  userId,
} as AuthPrincipal & { userId: string });

const request = (
  operation: "enable" | "disable",
  instanceOwner: boolean,
  allowedCapabilities: readonly string[] = [],
): RouteRequest => ({
  principal: ui(instanceOwner ? "usr_instance_owner" : "usr_admin"),
  space: {
    spaceId: "spc_test",
    spaceSlug: "test",
    userId: instanceOwner ? "usr_instance_owner" : "usr_admin",
    role: "admin",
    deployment: "server-trusted",
    storageDir: "/tmp/polyth-space-test",
    instanceOwner,
  } as SpaceContext & { instanceOwner: boolean },
  ingress: { kind: "public-http", listenerId: "test", loopback: true, secure: true },
  req: {} as never,
  res: {} as never,
  url: new URL(`https://polyth.test/api/plugins/sample.trusted/${operation}`),
  path: `/api/plugins/sample.trusted/${operation}`,
  method: "POST",
  requireCapability(capability) {
    if (!allowedCapabilities.includes(capability)) {
      throw Object.assign(new Error(`missing ${capability}`), { code: "forbidden" });
    }
  },
  body: async () => ({}),
  json: () => {},
} as RouteRequest);

const registry = (server: boolean): Pick<PluginRegistry, "canonicalManifest"> => ({
  canonicalManifest: () => ({
    manifestVersion: 1,
    id: "sample.trusted",
    version: "1.0.0",
    display: { name: "Sample", description: "test" },
    runtime: server
      ? { kind: "trusted-local", server: "./server.mjs" }
      : { kind: "sandboxed", ui: { entry: "./ui.ts" } },
  } as ReturnType<PluginRegistry["canonicalManifest"]>),
});

test("trusted Node package enable and disable require canonical instance owner authority", () => {
  for (const operation of ["enable", "disable"] as const) {
    assert.throws(
      () => guardTrustedServerLifecycle(
        registry(true),
        request(operation, false, [REMOTE_CAPABILITY.packagesInstall]),
      ),
      { code: "forbidden" },
    );

    assert.doesNotThrow(() => guardTrustedServerLifecycle(
      registry(true),
      request(operation, true, [REMOTE_CAPABILITY.packagesInstall]),
    ));
  }
});

test("sandbox package lifecycle does not require deployment-owner preflight", () => {
  assert.doesNotThrow(() => guardTrustedServerLifecycle(
    registry(false),
    request("enable", false),
  ));
});
