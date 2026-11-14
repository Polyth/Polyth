import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthPrincipal } from "@polyth/contracts";
import { createDevicePresence, presenceDeviceKey } from "../src/devicePresence.ts";

const a = { userId: "usr_a", spaceId: "sp_a" };
const b = { userId: "usr_b", spaceId: "sp_b" };

test("presenceDeviceKey names a paired device, a browser, or a valid loopback install id", () => {
  const paired = { kind: "paired-device", deviceEndpointId: "ep1" } as unknown as AuthPrincipal;
  const ui = { kind: "ui-session", rememberedDeviceId: "rd1" } as unknown as AuthPrincipal;
  const local = { kind: "local-user" } as unknown as AuthPrincipal;
  assert.equal(presenceDeviceKey(paired), "device:ep1");
  assert.equal(presenceDeviceKey(ui), "browser:rd1");
  assert.equal(presenceDeviceKey(local, "abcdefghijklmnop"), "client:abcdefghijklmnop");
  assert.equal(presenceDeviceKey(local, "A_-".repeat(21).slice(0, 64)), `client:${"A_-".repeat(21).slice(0, 64)}`);
  for (const bad of ["short", "x".repeat(65), "has space 0123456789abc", "bad/chars/0123456789", 5, undefined, null]) {
    assert.equal(presenceDeviceKey(local, bad), undefined, String(bad));
  }
  assert.equal(presenceDeviceKey(null), undefined);
  assert.equal(presenceDeviceKey(undefined), undefined);
  assert.equal(presenceDeviceKey({ kind: "something-else" } as unknown as AuthPrincipal, "abcdefghijklmnop"), undefined);
});

test("the most recently touched active device wins; inactive reports and drops clear it", () => {
  let clock = 1_000_000;
  const presence = createDevicePresence({ now: () => clock });
  const c1 = {}; const c2 = {};
  assert.equal(presence.activeDevice(a), undefined);
  presence.report(c1, a, "device:one", true, 0);
  assert.equal(presence.activeDevice(a), "device:one");
  clock += 1_000;
  presence.report(c2, a, "device:two", true, 0);
  assert.equal(presence.activeDevice(a), "device:two");
  // c1 reports later but its person last touched it longer ago (idle 60 s) than c2's touch.
  clock += 1_000;
  presence.report(c1, a, "device:one", true, 60_000);
  assert.equal(presence.activeDevice(a), "device:two");
  // c1 touched just now beats c2.
  clock += 1_000;
  presence.report(c1, a, "device:one", true, 0);
  assert.equal(presence.activeDevice(a), "device:one");
  presence.report(c1, a, "device:one", false, 0);
  assert.equal(presence.activeDevice(a), "device:two");
  presence.drop(c2);
  assert.equal(presence.activeDevice(a), undefined);
  presence.close();
});

test("accounts never see each other's devices", () => {
  const presence = createDevicePresence();
  presence.report({}, a, "device:one", true, 0);
  assert.equal(presence.activeDevice(b), undefined);
  assert.equal(presence.activeDevice({ userId: a.userId, spaceId: "sp_other" }), undefined);
  presence.report({}, b, "device:two", true, 0);
  assert.equal(presence.activeDevice(a), "device:one");
  assert.equal(presence.activeDevice(b), "device:two");
  presence.close();
});

test("subscribers hear each change once, not an unchanged report", () => {
  const presence = createDevicePresence();
  const heard: string[] = [];
  const stop = presence.subscribe((account) => heard.push(account.userId));
  const c = {};
  presence.report(c, a, "device:one", true, 0);
  assert.deepEqual(heard, ["usr_a"]);
  presence.report(c, a, "device:one", true, 5);
  presence.report(c, a, "device:one", true, 0);
  assert.equal(heard.length, 1);
  presence.report(c, a, "device:one", false, 0);
  assert.equal(heard.length, 2);
  presence.report(c, a, "device:one", false, 0);
  assert.equal(heard.length, 2);
  presence.report(c, a, "device:one", true, 0);
  presence.drop(c);
  assert.equal(heard.length, 4);
  stop();
  presence.report(c, a, "device:one", true, 0);
  assert.equal(heard.length, 4);
  presence.close();
});

test("a report older than the lease stops counting and subscribers are told when it runs out", async () => {
  const presence = createDevicePresence({ leaseMs: 60 });
  const heard: Array<string | undefined> = [];
  presence.subscribe((account) => heard.push(presence.activeDevice(account)));
  presence.report({}, a, "device:one", true, 0);
  assert.equal(presence.activeDevice(a), "device:one");
  assert.deepEqual(heard, ["device:one"]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(presence.activeDevice(a), undefined);
  assert.deepEqual(heard, ["device:one", undefined]);
  presence.close();
});
