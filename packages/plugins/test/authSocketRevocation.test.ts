import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPrincipal } from "@polyth/contracts";
import {
  PairedSocketRegistry,
  closeAuthSessionSockets,
  closeAuthUserSessionSockets,
  closeAuthUserSockets,
} from "../src/pairedSockets.ts";

const ui = (sessionId: string, userId: string): AuthPrincipal => ({
  kind: "ui-session",
  sessionId,
  rememberedDeviceId: sessionId,
  userId,
} as AuthPrincipal & { userId: string });
const paired = (deviceId: string, userId: string): AuthPrincipal => ({
  kind: "paired-device",
  deviceId,
  deviceEndpointId: `${deviceId}-endpoint`,
  connectionId: `${deviceId}-connection`,
  transport: "direct",
  grants: [],
  grantRevision: 1,
  userId,
} as AuthPrincipal & { userId: string });

test("one revoked browser session closes across registries without touching sibling sessions", () => {
  const a = new PairedSocketRegistry();
  const b = new PairedSocketRegistry();
  const closed: string[] = [];
  const a1 = {}, a2 = {}, b1 = {};
  a.bind(a1, ui("ses_a", "usr_owner"), () => closed.push("a1"));
  a.bind(a2, ui("ses_b", "usr_owner"), () => closed.push("a2"));
  b.bind(b1, ui("ses_a", "usr_owner"), () => closed.push("b1"));

  assert.equal(closeAuthSessionSockets("ses_a"), 2);
  assert.deepEqual(closed.sort(), ["a1", "b1"]);
  assert.equal(closeAuthSessionSockets("ses_a"), 0);
  a.unbind(a2);
});

test("credential invalidation closes browser sessions but preserves paired-device grants", () => {
  const registry = new PairedSocketRegistry();
  const closed: string[] = [];
  const browser = {}, device = {}, other = {};
  registry.bind(browser, ui("ses_owner", "usr_owner"), () => closed.push("browser"));
  registry.bind(device, paired("dev_owner", "usr_owner"), () => closed.push("device"));
  registry.bind(other, paired("dev_other", "usr_other"), () => closed.push("other"));

  assert.equal(registry.size, 2);
  assert.equal(closeAuthUserSessionSockets("usr_owner"), 1);
  assert.deepEqual(closed, ["browser"]);
  assert.equal(registry.activeCount("dev_owner"), 1);

  assert.equal(closeAuthUserSockets("usr_owner"), 1);
  assert.deepEqual(closed.sort(), ["browser", "device"]);
  assert.equal(registry.activeCount("dev_owner"), 0);
  assert.equal(registry.activeCount("dev_other"), 1);

  registry.closeDevice("dev_other");
  assert.deepEqual(closed.sort(), ["browser", "device", "other"]);
  assert.equal(registry.size, 0);
});
