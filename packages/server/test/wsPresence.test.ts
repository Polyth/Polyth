// Device presence over /ws: `presence` reports, `presence/state` answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { AuthPrincipal, SessionService } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { createWsGateway } from "../src/ws.ts";
import { createDevicePresence } from "../src/devicePresence.ts";

const sessions = { list: async () => [], events: async () => [] } as unknown as SessionService;
const spaces = {
  resolve: (_principal: unknown, _opts?: unknown) => ({ userId: "usr_a", spaceId: "sp_a" }),
  services: () => ({ sessions }),
  cookieName: "polyth_space",
};
const paired = (endpoint: string, grants: string[]): AuthPrincipal => ({
  kind: "paired-device", deviceId: `dev-${endpoint}`, deviceEndpointId: endpoint, connectionId: `c-${endpoint}`, transport: "direct", grants, grantRevision: 1,
}) as AuthPrincipal;
const FULL = [REMOTE_CAPABILITY.coreSessionsRead, REMOTE_CAPABILITY.coreNotificationsRead];

function connect(port: number, endpoint: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { "x-endpoint": endpoint } });
  const states: boolean[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as { type: string; activeElsewhere?: boolean };
    if (m.type === "presence/state") states.push(m.activeElsewhere!);
  });
  return new Promise<{ ws: WebSocket; states: boolean[] }>((res, rej) => { ws.on("open", () => res({ ws, states })); ws.on("error", rej); });
}
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail(`timed out: ${what}`);
};
const quiet = () => new Promise((r) => setTimeout(r, 150));
const report = (ws: WebSocket, active: boolean, idleMs = 0) => ws.send(JSON.stringify({ type: "presence", clientId: "ignored-for-paired", active, idleMs }));

async function rig(grantsFor: (endpoint: string) => string[]) {
  const presence = createDevicePresence();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const gateway = createWsGateway(sessions, undefined, undefined, spaces as never, { presence });
  gateway.attach(server, {
    identity: (req) => {
      const endpoint = String(req.headers["x-endpoint"]);
      return { authenticated: true, principal: paired(endpoint, grantsFor(endpoint)) };
    },
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { presence, port, close: () => { gateway.close(); server.close(); } };
}
const account = { userId: "usr_a", spaceId: "sp_a" };

test("a presence report is answered with presence/state and the newest active device wins", async () => {
  const t = await rig(() => FULL);
  try {
    const one = await connect(t.port, "ep1");
    report(one.ws, true);
    await until(() => one.states.length === 1, "first state");
    assert.deepEqual(one.states, [false]);
    assert.equal(t.presence.activeDevice(account), "device:ep1");
    const two = await connect(t.port, "ep2");
    report(two.ws, true);
    await until(() => one.states.length === 2, "flip");
    assert.deepEqual(one.states, [false, true]);
    assert.deepEqual(two.states, [false]);
    assert.equal(t.presence.activeDevice(account), "device:ep2");
    // Closing the active connection drops its report: the first is no longer "elsewhere".
    two.ws.close();
    await until(() => one.states.length === 3, "after close");
    assert.equal(one.states[2], false);
    assert.equal(t.presence.activeDevice(account), "device:ep1");
    one.ws.close();
    await until(() => t.presence.activeDevice(account) === undefined, "all closed");
  } finally { t.close(); }
});

test("a connection without core notifications read is ignored", async () => {
  const t = await rig((endpoint) => endpoint === "restricted" ? [REMOTE_CAPABILITY.coreSessionsRead] : FULL);
  try {
    const restricted = await connect(t.port, "restricted");
    report(restricted.ws, true);
    await quiet();
    assert.equal(t.presence.activeDevice(account), undefined);
    assert.deepEqual(restricted.states, []);
    const allowed = await connect(t.port, "ep1");
    report(allowed.ws, true);
    await until(() => allowed.states.length === 1, "allowed answered");
    report(restricted.ws, true);
    await quiet();
    assert.equal(t.presence.activeDevice(account), "device:ep1", "a restricted device cannot silence the others");
    restricted.ws.close();
    allowed.ws.close();
  } finally { t.close(); }
});
