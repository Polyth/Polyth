import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeferredAlerts } from "../src/deferredAlerts.ts";
import type { DeviceUse } from "../src/devicePresence.ts";

const a = { userId: "usr_a", spaceId: "sp_a" };
const b = { userId: "usr_b", spaceId: "sp_a" };

function rig() {
  let clock = 1_000_000;
  const use = new Map<string, DeviceUse | undefined>();
  const read = new Set<string>();
  const sent: Array<{ user: string; alert: string; except: string }> = [];
  const alerts = createDeferredAlerts<string>({
    activeUse: (account) => use.get(account.userId),
    unread: async (_account, id) => !read.has(id),
    deliver: async (account, alert, exceptDevice) => { sent.push({ user: account.userId, alert, except: exceptDevice }); },
    now: () => clock,
    unreadMs: 120_000, quietMs: 20_000, maxMs: 900_000,
  });
  return {
    alerts, sent, read,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    setUse: (userId: string, value: DeviceUse | undefined) => { use.set(userId, value); },
  };
}
const visible = (device: string, touchedAt: number): DeviceUse => ({ device, hidden: false, touchedAt });
const hidden = (device: string, touchedAt: number): DeviceUse => ({ device, hidden: true, touchedAt });

test("an unread alert goes to the other devices once the device in use has stayed quiet", async () => {
  const r = rig();
  r.setUse("usr_a", visible("browser:one", r.now()));
  r.alerts.hold(a, "n1", "done", "browser:one");
  r.advance(600_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [], "a device on screen and in use keeps it to itself");
  r.setUse("usr_a", undefined);
  r.alerts.presenceChanged(a);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [], "a socket that just dropped is not the person leaving");
  r.advance(20_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [{ user: "usr_a", alert: "done", except: "browser:one" }]);
  r.advance(600_000);
  await r.alerts.flush();
  assert.equal(r.sent.length, 1, "sent on once");
  r.alerts.close();
});

test("a device that is back within the quiet wait keeps the alert held", async () => {
  const r = rig();
  r.setUse("usr_a", visible("browser:one", r.now()));
  r.alerts.hold(a, "n1", "done", "browser:one");
  r.setUse("usr_a", undefined);
  r.alerts.presenceChanged(a);
  r.advance(5_000);
  r.setUse("usr_a", visible("browser:one", r.now()));
  r.alerts.presenceChanged(a);
  r.advance(60_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, []);
  r.setUse("usr_a", undefined);
  r.alerts.presenceChanged(a);
  r.advance(19_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [], "the quiet wait started over");
  r.advance(1_000);
  await r.alerts.flush();
  assert.equal(r.sent.length, 1);
  r.alerts.close();
});

test("a read alert is never sent on", async () => {
  const r = rig();
  r.setUse("usr_a", visible("browser:one", r.now()));
  r.alerts.hold(a, "n1", "done", "browser:one");
  r.read.add("n1");
  r.setUse("usr_a", undefined);
  r.alerts.presenceChanged(a);
  r.advance(20_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, []);
  r.alerts.close();
});

test("a hidden page's alert is sent on when unread two minutes after it and after the person left", async () => {
  const r = rig();
  const left = r.now();
  r.setUse("usr_a", hidden("browser:one", left));
  r.advance(30_000);
  r.alerts.hold(a, "n1", "done", "browser:one");
  r.advance(119_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [], "not yet two minutes after the alert");
  r.advance(1_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [{ user: "usr_a", alert: "done", except: "browser:one" }]);
  r.alerts.close();
});

test("a page hidden after the alert waits two minutes from the leaving, and a read row stays put", async () => {
  const r = rig();
  r.setUse("usr_a", visible("browser:one", r.now()));
  r.alerts.hold(a, "n1", "done", "browser:one");
  r.alerts.hold(a, "n2", "asked", "browser:one");
  r.advance(100_000);
  r.setUse("usr_a", hidden("browser:one", r.now()));
  r.advance(20_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [], "two minutes after the alert, but only 20 s after leaving");
  r.read.add("n2");
  r.advance(100_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [{ user: "usr_a", alert: "done", except: "browser:one" }]);
  r.alerts.close();
});

test("moving to another device drops the held alert: that device shows the inbox", async () => {
  const r = rig();
  r.setUse("usr_a", hidden("browser:one", r.now()));
  r.alerts.hold(a, "n1", "done", "browser:one");
  r.setUse("usr_a", visible("device:phone", r.now()));
  r.alerts.presenceChanged(a);
  r.setUse("usr_a", undefined);
  r.alerts.presenceChanged(a);
  r.advance(600_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent, []);
  r.alerts.close();
});

test("an alert older than the limit is dropped, and accounts are separate", async () => {
  const r = rig();
  r.setUse("usr_a", visible("browser:one", r.now()));
  r.setUse("usr_b", visible("browser:two", r.now()));
  r.alerts.hold(a, "n1", "old", "browser:one");
  r.advance(880_000);
  r.alerts.hold(b, "n2", "fresh", "browser:two");
  r.setUse("usr_b", undefined);
  r.alerts.presenceChanged(b);
  r.advance(21_000);
  r.setUse("usr_a", undefined);
  await r.alerts.flush();
  assert.deepEqual(r.sent, [{ user: "usr_b", alert: "fresh", except: "browser:two" }], "usr_a's alert passed 15 minutes");
  r.alerts.close();
});

test("only the newest twenty alerts of an account are held; close forgets them", async () => {
  const r = rig();
  r.setUse("usr_a", visible("browser:one", r.now()));
  for (let i = 0; i < 25; i++) r.alerts.hold(a, `n${i}`, `alert ${i}`, "browser:one");
  r.setUse("usr_a", undefined);
  r.alerts.presenceChanged(a);
  r.advance(20_000);
  await r.alerts.flush();
  assert.deepEqual(r.sent.map((item) => item.alert), Array.from({ length: 20 }, (_, i) => `alert ${i + 5}`));
  r.alerts.hold(a, "late", "late", "browser:one");
  r.alerts.close();
  await r.alerts.flush();
  assert.equal(r.sent.length, 20);
});
