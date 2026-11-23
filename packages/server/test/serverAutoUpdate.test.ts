import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServerAutoUpdater,
  serverAutoUpdateRoutes,
  type SelfUpdateResult,
  type ServerSelfUpdater,
} from "../src/serverAutoUpdate.ts";

function rig(input: {
  version?: string;
  newest?: string | null;
  apply?: (version: string) => SelfUpdateResult;
  busy?: number[];
  unavailable?: string | null;
  stored?: object;
}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-auto-update-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "server-auto-update.json");
  if (input.stored) writeFileSync(file, JSON.stringify(input.stored));
  const applied: string[] = [];
  let restarts = 0;
  let clock = 1_000_000;
  const busy = [...(input.busy ?? [])];
  const updater: ServerSelfUpdater = {
    kind: "npm",
    unavailable: input.unavailable ?? null,
    newest: async () => input.newest ?? null,
    apply: async (version) => {
      applied.push(version);
      return input.apply?.(version) ?? { ok: true, installed: version, message: `Installed ${version}.` };
    },
  };
  const auto = createServerAutoUpdater({
    file,
    version: input.version ?? "1.2.10",
    updater,
    busy: async () => busy.length > 1 ? busy.shift()! : (busy[0] ?? 0),
    restart: () => { restarts += 1; },
    now: () => clock,
    log: () => {},
  });
  return {
    auto,
    file,
    applied,
    restarts: () => restarts,
    advance: (ms: number) => { clock += ms; },
    stored: () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
  };
}

test("does nothing until the owner turns it on", async () => {
  const r = rig({ newest: "1.2.11" });
  await r.auto.tick();
  assert.deepEqual(r.applied, []);
  assert.equal(r.restarts(), 0);
  assert.equal((await r.auto.status(true)).phase, "off");
});

test("installs a newer release and restarts once no chat is working", async () => {
  const r = rig({ newest: "1.2.11", busy: [2, 0] });
  await r.auto.setEnabled(true);
  await r.auto.tick();
  assert.deepEqual(r.applied, [], "a working chat holds the install");
  const waiting = await r.auto.status(true);
  assert.equal(waiting.phase, "waiting");
  assert.equal(waiting.busy, 2);
  assert.equal(waiting.available, "1.2.11");
  await r.auto.tick();
  assert.deepEqual(r.applied, ["1.2.11"]);
  assert.equal(r.restarts(), 1);
  assert.deepEqual(r.stored().pending, { from: "1.2.10", to: "1.2.11", at: 1_000_000 });
});

test("a chat that starts during the install delays only the restart", async () => {
  const r = rig({ newest: "1.2.11", busy: [0, 1, 0] });
  await r.auto.setEnabled(true);
  await r.auto.tick();
  assert.deepEqual(r.applied, ["1.2.11"]);
  assert.equal(r.restarts(), 0);
  await r.auto.tick();
  assert.deepEqual(r.applied, ["1.2.11"], "not installed twice");
  assert.equal(r.restarts(), 1);
});

test("the same or an older release is left alone", async () => {
  const r = rig({ version: "1.2.11", newest: "1.2.11" });
  await r.auto.setEnabled(true);
  await r.auto.tick();
  assert.deepEqual(r.applied, []);
  assert.equal((await r.auto.status(true)).available, null);
});

test("a failed install is recorded and not retried for a day", async () => {
  const r = rig({ newest: "1.2.11", apply: () => ({ ok: false, installed: "1.2.10", message: "npm install failed: EACCES" }) });
  await r.auto.setEnabled(true);
  await r.auto.tick();
  const status = await r.auto.status(true);
  assert.equal(status.last?.ok, false);
  assert.match(status.last?.message ?? "", /EACCES/);
  assert.equal(r.restarts(), 0);
  r.advance(7 * 60 * 60_000);
  await r.auto.tick();
  assert.equal(r.applied.length, 1);
  r.advance(18 * 60 * 60_000);
  await r.auto.tick();
  assert.equal(r.applied.length, 2);
});

test("the next boot reports the update it came back from", async () => {
  const ok = rig({ version: "1.2.11", stored: { enabled: true, pending: { from: "1.2.10", to: "1.2.11", at: 1 } } });
  const done = await ok.auto.status(true);
  assert.equal(done.last?.ok, true);
  assert.match(done.last?.message ?? "", /1\.2\.10 to 1\.2\.11/);
  assert.equal(ok.stored().pending, undefined);

  const failed = rig({ version: "1.2.10", newest: "1.2.11", stored: { enabled: true, pending: { from: "1.2.10", to: "1.2.11", at: 1 } } });
  const back = await failed.auto.status(true);
  assert.equal(back.last?.ok, false);
  await failed.auto.tick();
  assert.deepEqual(failed.applied, [], "a release that did not come up waits a day");
});

test("an install that cannot update itself refuses to be turned on", async () => {
  const r = rig({ unavailable: "No service restarts this server." });
  await assert.rejects(r.auto.setEnabled(true), /No service/);
  const status = await r.auto.status(true);
  assert.equal(status.canChange, false);
  assert.equal(status.unavailable, "No service restarts this server.");
});

test("route: only the instance owner changes it; a limited paired device cannot read it", async () => {
  const r = rig({});
  const route = serverAutoUpdateRoutes(r.auto);
  const call = async (method: string, principal: object, space: object, body?: unknown) => {
    let sent: { status: number; body: unknown } | undefined;
    const handled = await route({
      path: "/api/system/auto-update",
      method,
      principal,
      space,
      body: async () => body,
      json: (status: number, value: unknown) => { sent = { status, body: value }; },
    } as never);
    return { handled, sent };
  };
  const owner = { kind: "ui-session", userId: "u1" };
  await assert.rejects(call("PUT", owner, { instanceOwner: false }, { enabled: true }), (error: { code?: string }) => error.code === "forbidden");
  const read = await call("GET", owner, { instanceOwner: false });
  assert.equal((read.sent?.body as { canChange: boolean }).canChange, false);
  const changed = await call("PUT", owner, { instanceOwner: true }, { enabled: true });
  assert.equal((changed.sent?.body as { enabled: boolean }).enabled, true);
  await assert.rejects(call("PUT", owner, { instanceOwner: true }, { enabled: "yes" }), (error: { code?: string }) => error.code === "invalid-input");
  await assert.rejects(call("GET", { kind: "paired-device", deviceId: "d1", grants: [] }, {}), (error: { code?: string }) => error.code === "forbidden");
  await assert.rejects(call("GET", { kind: "anonymous" }, {}), (error: { code?: string }) => error.code === "unauthorized");
  assert.equal((await route({ path: "/api/system/other", method: "GET" } as never)), false);
});

test("only the owner reads install paths and package-manager output", async () => {
  const r = rig({ newest: "1.2.11", apply: () => ({ ok: false, installed: "1.2.10", message: "EACCES: /usr/lib/node_modules/polyth" }) });
  await r.auto.setEnabled(true);
  await r.auto.tick();
  assert.match((await r.auto.status(true)).last?.message ?? "", /node_modules/);
  const member = await r.auto.status(false);
  assert.doesNotMatch(member.last?.message ?? "", /node_modules/);
  assert.equal(member.canChange, false);
  const blocked = rig({ unavailable: "This server's account cannot write /usr/lib/node_modules" });
  assert.doesNotMatch((await blocked.auto.status(false)).unavailable ?? "", /node_modules/);
});
