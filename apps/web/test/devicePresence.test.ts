import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeElsewhere, installDevicePresence, presenceClientId, subscribeActiveElsewhere,
  PRESENCE_HEARTBEAT_MS, PRESENCE_IDLE_MS, type PresenceEnvironment, type PresenceReport,
} from "../src/devicePresence.ts";

const ID = "abcdefghijklmnop0123";

function rig(open = true) {
  let clock = 1_000_000;
  let visible = true;
  const reports: PresenceReport[] = [];
  let isOpen = open;
  let onOpen: (() => void) | undefined;
  let onEvent: ((msg: { type: string; activeElsewhere?: unknown }) => void) | undefined;
  let touch = () => {};
  let visibility = () => {};
  let beat = () => {};
  const transport = {
    sendPresence(report: PresenceReport) { if (!isOpen) return false; reports.push(report); return true; },
    onOpen(cb: () => void) { onOpen = cb; return () => { onOpen = undefined; }; },
    onEvent(cb: (msg: { type: string; activeElsewhere?: unknown }) => void) { onEvent = cb; return () => { onEvent = undefined; }; },
  };
  const env: PresenceEnvironment = {
    now: () => clock,
    visible: () => visible,
    listen(t, v) { touch = t; visibility = v; return () => { touch = () => {}; visibility = () => {}; }; },
    every(ms, cb) { assert.equal(ms, PRESENCE_HEARTBEAT_MS); beat = cb; return () => { beat = () => {}; }; },
  };
  return {
    reports, transport, env,
    advance: (ms: number) => { clock += ms; },
    setVisible: (v: boolean) => { visible = v; },
    setOpen: (v: boolean) => { isOpen = v; },
    touch: () => touch(), visibility: () => visibility(), beat: () => beat(),
    open: () => onOpen?.(), event: (m: { type: string; activeElsewhere?: unknown }) => onEvent?.(m),
  };
}

test("installing reports active once the socket is open; touches are throttled to 15 s", () => {
  const r = rig();
  const stop = installDevicePresence(r.transport, r.env, ID);
  assert.deepEqual(r.reports, [{ clientId: ID, active: true, idleMs: 0 }]);
  r.advance(5_000); r.touch();
  assert.equal(r.reports.length, 1, "a touch within 15 s does not re-report");
  r.advance(11_000); r.touch();
  assert.equal(r.reports.length, 2, "after 15 s it does");
  assert.deepEqual(r.reports[1], { clientId: ID, active: true, idleMs: 0 });
  stop();
});

test("hiding reports inactive at once; showing again reports active", () => {
  const r = rig();
  const stop = installDevicePresence(r.transport, r.env, ID);
  r.setVisible(false); r.visibility();
  assert.equal(r.reports.at(-1)!.active, false);
  r.setVisible(true); r.visibility();
  assert.equal(r.reports.at(-1)!.active, true);
  stop();
});

test("the heartbeat keeps the lease while in use and reports idle after five minutes without a touch", () => {
  const r = rig();
  const stop = installDevicePresence(r.transport, r.env, ID);
  r.advance(PRESENCE_HEARTBEAT_MS); r.beat();
  assert.equal(r.reports.length, 2);
  assert.equal(r.reports[1]!.active, true);
  assert.equal(r.reports[1]!.idleMs, PRESENCE_HEARTBEAT_MS);
  r.advance(PRESENCE_IDLE_MS); r.beat();
  assert.equal(r.reports.at(-1)!.active, false);
  assert.ok(r.reports.at(-1)!.idleMs >= PRESENCE_IDLE_MS);
  stop();
});

test("a socket that opens later re-reports; an unsent report is retried on open", () => {
  const r = rig(false);
  const stop = installDevicePresence(r.transport, r.env, ID);
  assert.equal(r.reports.length, 0, "closed socket: nothing sent");
  r.setOpen(true); r.open();
  assert.equal(r.reports.length, 1);
  r.open();
  assert.equal(r.reports.length, 2, "every open re-reports");
  stop();
});

test("presence/state flips activeElsewhere and notifies; uninstall resets it", () => {
  const r = rig();
  let calls = 0;
  const off = subscribeActiveElsewhere(() => { calls++; });
  const stop = installDevicePresence(r.transport, r.env, ID);
  assert.equal(activeElsewhere(), false);
  r.event({ type: "presence/state", activeElsewhere: true });
  assert.equal(activeElsewhere(), true);
  assert.equal(calls, 1);
  r.event({ type: "presence/state", activeElsewhere: true });
  assert.equal(calls, 1, "unchanged: no notification");
  r.event({ type: "presence/state", activeElsewhere: "yes" });
  r.event({ type: "other", activeElsewhere: false });
  assert.equal(activeElsewhere(), true, "non-boolean or other types are ignored");
  stop();
  assert.equal(activeElsewhere(), false);
  assert.equal(calls, 2);
  off();
});

test("presenceClientId keeps a valid stored id and mints and stores one otherwise", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  const key = "polyth.presence.client-id";
  data.set(key, ID);
  assert.equal(presenceClientId(storage), ID);
  data.set(key, "bad id!");
  const minted = presenceClientId(storage);
  assert.match(minted, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(data.get(key), minted);
  assert.equal(presenceClientId(storage), minted, "stable once stored");
  assert.match(presenceClientId({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } }), /^[A-Za-z0-9_-]{16,64}$/);
});
