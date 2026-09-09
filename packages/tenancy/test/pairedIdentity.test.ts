import test from "node:test";
import assert from "node:assert/strict";
import type { AuthPrincipal } from "@polyth/contracts";
import { createIdentityResolver } from "../src/context.ts";

const paired = (userId?: string): AuthPrincipal => ({
  kind: "paired-device",
  deviceId: "dev-1",
  deviceEndpointId: "ep-1",
  connectionId: "conn-1",
  transport: "direct",
  grants: [],
  grantRevision: 1,
  ...(userId ? { userId } : {}),
} as AuthPrincipal);

test("paired devices resolve to their persisted account instead of the bootstrap owner", () => {
  const resolver = createIdentityResolver({
    ownerUserId: "usr_owner",
    deployment: "local-trusted",
  });
  assert.equal(resolver.resolve(paired("usr_alice"))?.userId, "usr_alice");
  assert.equal(resolver.resolve(paired())?.userId, "usr_owner");
});
