import test from "node:test";
import assert from "node:assert/strict";
import { NativePushController, type NativePushBridge, type NativePushServer } from "../src/nativePushController.ts";

const input = { accountId: "account-1" };
const claim = { subscriptionId: `sub_${"s".repeat(22)}`, claimToken: "c".repeat(43), claimExpiresAt: Date.now() + 60_000 };

function setup() {
  const calls: string[] = [];
  const bridge: NativePushBridge = {
    status: async () => ({ state: "enabled", subscriptionId: claim.subscriptionId }),
    enable: async () => claim,
    disable: async () => { calls.push("disable"); },
    setForeground: async ({ active }) => { calls.push(`foreground:${active}`); },
  };
  const server: NativePushServer = {
    status: async () => ({ enabled: true, subscribed: true, subscriptionId: claim.subscriptionId }),
    claim: async () => ({ subscriptionId: claim.subscriptionId }),
    unregister: async () => { calls.push("server-delete"); },
  };
  return { calls, bridge, server, controller: new NativePushController(bridge, server) };
}

test("claims only the native subscription returned to the currently authenticated server", async () => {
  const { controller, calls } = setup();
  const result = await controller.enable(input);
  assert.equal(result.claimed, true);
  assert.deepEqual(calls, ["foreground:true"]);
});

test("failed claims clean up the native mapping instead of reporting enabled", async () => {
  const { controller, server, calls } = setup();
  server.claim = async () => { throw new Error("unauthorized"); };
  await assert.rejects(controller.enable(input), /unauthorized/);
  assert.deepEqual(calls, ["disable"]);
});

test("disable invokes native relay cleanup even when server-side unregister is unavailable", async () => {
  const { controller, server, calls } = setup();
  server.unregister = async () => { calls.push("server-delete"); throw new Error("offline"); };
  await assert.rejects(controller.disable(input), /offline/);
  assert.deepEqual(calls, ["foreground:false", "server-delete", "disable"]);
});

test("an unresponsive server cannot postpone native relay cleanup", async () => {
  const { controller, server, calls } = setup();
  let rejectUnregister: ((error: Error) => void) | undefined;
  server.unregister = async () => await new Promise<void>((_resolve, reject) => {
    calls.push("server-delete");
    rejectUnregister = reject;
  });

  const disabling = controller.disable(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["foreground:false", "server-delete", "disable"]);

  rejectUnregister?.(new Error("offline"));
  await assert.rejects(disabling, /offline/);
});

test("a local mapping is not reported enabled without matching authoritative server state", async () => {
  const { controller, server } = setup();
  server.status = async () => ({ enabled: true, subscribed: false });
  assert.deepEqual(await controller.status(), { state: "disabled" });
  server.status = async () => { throw new Error("offline"); };
  assert.deepEqual(await controller.status(), { state: "failed", reason: "registration-failed" });
});

test("the content key from native enable is passed to the server claim, and only then", async () => {
  const contentKey = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
  const seen: unknown[] = [];
  const { bridge, server } = setup();
  bridge.enable = async () => ({ ...claim, contentKey });
  server.claim = async (value) => { seen.push(value.contentKey); return { subscriptionId: claim.subscriptionId }; };
  await new NativePushController(bridge, server).enable(input);
  const plain = setup();
  plain.server.claim = async (value) => { seen.push(value.contentKey); return { subscriptionId: claim.subscriptionId }; };
  await plain.controller.enable(input);
  assert.deepEqual(seen, [contentKey, undefined]);
});

test("direct mode: the APNs token goes to the server, and a foreground re-sends the current registration", async () => {
  const registration = { subscriptionId: claim.subscriptionId, providerToken: "ab".repeat(32), environment: "production" as const };
  const sent: unknown[] = [];
  const { bridge, server } = setup();
  bridge.enable = async () => registration;
  server.claim = async (value) => { sent.push(value); return { subscriptionId: registration.subscriptionId }; };
  const controller = new NativePushController(bridge, server);
  assert.equal((await controller.enable(input)).claimed, true);
  bridge.status = async () => ({ state: "enabled", subscriptionId: registration.subscriptionId, registration: { ...registration, providerToken: "cd".repeat(32) } });
  await controller.setForeground(input, true);
  await controller.setForeground(input, false);
  assert.deepEqual(sent, [registration, { ...registration, providerToken: "cd".repeat(32) }]);
});
