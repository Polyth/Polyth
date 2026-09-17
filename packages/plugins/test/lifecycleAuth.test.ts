import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_CAPABILITY,
  type AuthPrincipal,
  type RouteRequest,
  type SpaceContext,
} from "@polyth/contracts";
import {
  assertDeploymentPackageMutator,
  assertSpacePackageDisable,
  assertSpacePackageEnable,
  assertSpacePackageGrant,
} from "../src/lifecycleAuth.ts";

const ui = (userId: string): AuthPrincipal => ({
  kind: "ui-session",
  sessionId: `ses_${userId}`,
  rememberedDeviceId: `device_${userId}`,
  userId,
} as AuthPrincipal & { userId: string });

const paired = (userId: string, grants: string[] = []): AuthPrincipal => ({
  kind: "paired-device",
  deviceId: `dev_${userId}`,
  deviceEndpointId: `endpoint_${userId}`,
  connectionId: `connection_${userId}`,
  transport: "direct",
  grants,
  grantRevision: 1,
  userId,
} as AuthPrincipal & { userId: string });

const space = (
  role: SpaceContext["role"],
  instanceOwner?: boolean,
): SpaceContext => ({
  spaceId: "spc_test",
  spaceSlug: "test",
  userId: "usr_test",
  role,
  deployment: "server-trusted",
  storageDir: "/tmp/polyth-space-test",
  ...(instanceOwner === undefined ? {} : { instanceOwner }),
} as SpaceContext & { instanceOwner?: boolean });

const request = (
  principal: AuthPrincipal,
  ctx: SpaceContext,
  allowedCapabilities: readonly string[] = [],
): RouteRequest => ({
  principal,
  space: ctx,
  ingress: { kind: "public-http", listenerId: "test", loopback: true, secure: true },
  req: {} as never,
  res: {} as never,
  url: new URL("https://polyth.test/api/plugins/example/grants"),
  path: "/api/plugins/example/grants",
  method: "POST",
  requireCapability(capability) {
    if (!allowedCapabilities.includes(capability)) {
      throw Object.assign(new Error(`missing ${capability}`), { code: "forbidden" });
    }
  },
  body: async () => ({}),
  json: () => {},
} as RouteRequest);

test("local ui membership no longer bypasses Space package admin checks", () => {
  const member = request(ui("usr_member"), space("member"));
  assert.throws(() => assertSpacePackageEnable(member, member.space), { code: "forbidden" });
  assert.throws(() => assertSpacePackageDisable(member, member.space), { code: "forbidden" });
  assert.throws(() => assertSpacePackageGrant(member, member.space), { code: "forbidden" });

  const admin = request(ui("usr_admin"), space("admin"));
  assert.doesNotThrow(() => assertSpacePackageEnable(admin, admin.space));
  assert.doesNotThrow(() => assertSpacePackageDisable(admin, admin.space));
  assert.doesNotThrow(() => assertSpacePackageGrant(admin, admin.space));
});

test("deployment-global package changes require canonical instance owner authority", () => {
  const ordinaryOwner = request(
    ui("usr_space_owner"),
    space("owner", false),
    [REMOTE_CAPABILITY.packagesInstall],
  );
  assert.throws(() => assertDeploymentPackageMutator(ordinaryOwner), { code: "forbidden" });

  const instanceOwner = request(
    ui("usr_instance_owner"),
    space("member", true),
    [REMOTE_CAPABILITY.packagesInstall],
  );
  assert.doesNotThrow(() => assertDeploymentPackageMutator(instanceOwner));
});

test("paired-device package lifecycle requires role plus explicit transport capability and cannot grant", () => {
  const noGrant = request(paired("usr_admin"), space("admin"));
  assert.throws(() => assertSpacePackageEnable(noGrant, noGrant.space), { code: "forbidden" });

  const enabled = request(
    paired("usr_admin", [REMOTE_CAPABILITY.packagesEnable, REMOTE_CAPABILITY.packagesDisable]),
    space("admin"),
    [REMOTE_CAPABILITY.packagesEnable, REMOTE_CAPABILITY.packagesDisable],
  );
  assert.doesNotThrow(() => assertSpacePackageEnable(enabled, enabled.space));
  assert.doesNotThrow(() => assertSpacePackageDisable(enabled, enabled.space));
  assert.throws(() => assertSpacePackageGrant(enabled, enabled.space), { code: "forbidden" });
});
