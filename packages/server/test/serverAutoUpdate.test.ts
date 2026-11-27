import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfUpdateDrivers,
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
  assert.deepEqual(r.stored().pending, { from: "1.2.10", to: "1.2.11", at: 1_000_000, kind: "npm" });
  assert.equal((await r.auto.status(true)).last, null, "the attempt this process wrote waits for the next boot");
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

/** A package's revision-named driver (a checkout) contributed through the seam. */
function contributedRig(input: {
  service?: string | null;
  revision?: string;
  newest?: string | (() => string);
  stored?: object;
  hostUpdater?: ServerSelfUpdater;
}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-auto-update-contributed-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "server-auto-update.json");
  if (input.stored) writeFileSync(file, JSON.stringify(input.stored));
  let revision = input.revision ?? "aaaaaaaaaaaa";
  let restarts = 0;
  const applied: string[] = [];
  const drivers = createSelfUpdateDrivers(input.service === undefined ? "polyth.service" : input.service);
  const driver: ServerSelfUpdater = {
    kind: "checkout",
    unavailable: null,
    current: async () => revision,
    source: () => "origin/devel",
    isNewer: (candidate, current) => candidate !== current,
    newest: async () => typeof input.newest === "function" ? input.newest() : (input.newest ?? revision),
    apply: async (target) => {
      applied.push(target);
      revision = target;
      return { ok: true, installed: target, message: `Updated the checkout to ${target}.` };
    },
  };
  const auto = createServerAutoUpdater({
    file,
    version: "1.2.0",
    ...(input.hostUpdater ? { updater: input.hostUpdater } : {}),
    contributed: () => drivers.current(),
    restartingService: drivers.restartingService,
    busy: async () => 0,
    restart: () => { restarts += 1; },
    now: () => 5_000,
    log: () => {},
  });
  return {
    auto,
    drivers,
    driver,
    applied,
    restarts: () => restarts,
    stored: () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
  };
}

test("contributed driver: one at a time, and gone when disposed", async () => {
  const r = contributedRig({});
  assert.equal((await r.auto.status(true)).install, null, "nothing contributed yet");
  const contribution = r.drivers.contribute(r.driver);
  assert.throws(() => r.drivers.contribute({ ...r.driver }), (error: { code?: string }) => error.code === "conflict");
  assert.equal((await r.auto.status(true)).install, "checkout");
  contribution.dispose();
  assert.equal((await r.auto.status(true)).install, null);
});

test("contributed driver: needs a service that restarts the server", async () => {
  const r = contributedRig({ service: null });
  r.drivers.contribute(r.driver);
  const status = await r.auto.status(true);
  assert.equal(status.install, "checkout");
  assert.equal(status.canChange, false);
  assert.match(status.unavailable ?? "", /No service restarts this server/);
  await assert.rejects(r.auto.setEnabled(true), /No service/);
});

test("contributed driver: updates by revision and the next boot settles it with the driver", async () => {
  const r = contributedRig({ newest: "bbbbbbbbbbbb" });
  r.drivers.contribute(r.driver);
  await r.auto.setEnabled(true);
  await r.auto.tick();
  assert.deepEqual(r.applied, ["bbbbbbbbbbbb"]);
  assert.equal(r.restarts(), 1);
  assert.deepEqual(r.stored().pending, { from: "aaaaaaaaaaaa", to: "bbbbbbbbbbbb", at: 5_000, kind: "checkout", revision: true });
  assert.equal((await r.auto.status(true)).source, "origin/devel");
  assert.equal((await r.auto.status(false)).source, null, "the source is for the owner");

  // The next boot: the package's driver is not there yet, so the pending
  // update waits for it instead of comparing the server's version.
  const next = contributedRig({ revision: "bbbbbbbbbbbb", stored: r.stored() });
  assert.equal((await next.auto.status(true)).last ?? null, null);
  assert.ok(next.stored().pending, "pending kept until its driver can read the revision");
  next.drivers.contribute(next.driver);
  const settled = await next.auto.status(true);
  assert.equal(settled.last?.ok, true);
  assert.match(settled.last?.message ?? "", /aaaaaaaaaaaa to bbbbbbbbbbbb/);
  assert.equal(next.stored().pending, undefined);
});

test("contributed driver: a check that cannot offer an update says why, to the owner only", async () => {
  const r = contributedRig({ newest: () => { throw new Error("This checkout has local changes (package-lock.json)."); } });
  r.drivers.contribute(r.driver);
  await r.auto.setEnabled(true);
  await r.auto.tick();
  assert.deepEqual(r.applied, []);
  assert.match((await r.auto.status(true)).problem ?? "", /package-lock\.json/);
  assert.doesNotMatch((await r.auto.status(false)).problem ?? "", /package-lock/);
  await r.auto.setEnabled(false);
  assert.equal((await r.auto.status(true)).problem, null);
});

test("the host's own driver wins over a contributed one", async () => {
  const host: ServerSelfUpdater = {
    kind: "npm",
    unavailable: null,
    newest: async () => null,
    apply: async () => ({ ok: false, installed: null, message: "unused" }),
  };
  const r = contributedRig({ service: null, hostUpdater: host });
  r.drivers.contribute(r.driver);
  const status = await r.auto.status(true);
  assert.equal(status.install, "npm");
  assert.equal(status.unavailable, null, "the host's driver checked its own service");
});
