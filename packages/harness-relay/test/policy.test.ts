// Which vendor policies the package honours: a prohibited family never gets a
// Relay, an unsupported one is off until a harness manager turns it on (or
// somebody already rotates it), a tolerated one is on unless turned off, and a
// caller who may not use a family never sees it.
import assert from "node:assert/strict";
import { after } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime, HarnessProvider, HarnessRegistry, HarnessRelayVendorPolicy, RouteRequest } from "@polyth/contracts";
import { createHarnessAccountFamily, harnessCommandLine } from "@polyth/harness-runtime/accounts";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";
import type { RelaysResponse } from "../src/views.ts";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
const cleanup: Array<() => unknown> = [];
/** Tears down the previous test's package before its families: a package left
 *  enabled keeps reconciling every live family and would re-register into a
 *  later test's registry. */
const drain = async () => {
  for (const stop of cleanup.splice(0).reverse()) { try { await stop(); } catch { /* already gone */ } }
};
after(async () => {
  await drain();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const provider = (id: string): HarnessProvider => ({
  descriptor: { id, name: id, integration: "test", priority: 10 },
  probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
  createRuntime: async () => ({ dispose: async () => {} } as AgentRuntime),
});

/** The account families' registry seam: register, look up, list, dispose. */
const fakeRegistry = () => {
  const providers = new Map<string, HarnessProvider>();
  const registry = {
    register(entry: HarnessProvider) {
      providers.set(entry.descriptor.id, entry);
      return { dispose: () => { if (providers.get(entry.descriptor.id) === entry) providers.delete(entry.descriptor.id); } };
    },
    get: (id: string) => providers.get(id),
    providers: () => [...providers.values()],
  };
  return { registry: registry as unknown as HarnessRegistry, ids: () => [...providers.keys()] };
};

const family = (dir: string, registry: HarnessRegistry, name: string, label: string, policy: HarnessRelayVendorPolicy) =>
  createHarnessAccountFamily({
    family: name, label, packageId: `backend-${name}`, storageDir: join(dir, name), deployment: "local-trusted",
    registry: () => registry,
    relay: { policy },
    createProvider: (account) => provider(account?.harnessId ?? name),
    status: async () => ({ loggedIn: true }),
    signInCommand: () => harnessCommandLine([name]),
  });

const packageHost = (dir: string) => ({
  pluginId: "harness-relay",
  storageDir: dir,
  services: {
    get: () => undefined,
    require: () => { throw new Error("unexpected service"); },
  },
  forSpace: () => ({
    projects: { get: async (id: string) => ({ id, path: dir }), list: async () => [{ id: "p", path: dir }] },
    sessions: {},
  }),
}) as unknown as ServerPackageHost;

const call = (pkg: ReturnType<typeof registerPackage>, method: string, path: string, userId: string, body: Record<string, unknown> = {}, authority: Record<string, unknown> = {}) => {
  let reply: { code: number; body: any } | undefined;
  const url = new URL(`http://polyth.test${path}`);
  const space = {
    spaceId: "s", userId, role: "owner", instanceOwner: false, harnessManager: false, harnessPersonal: false,
    allowedHarnesses: null, ...authority,
  };
  const req = {
    method, path: url.pathname, url, space, principal: { kind: "ui-session" },
    body: async () => body, json: (code: number, payload: unknown) => { reply = { code, body: payload }; },
  } as unknown as RouteRequest;
  return pkg.routes!(req).then((handled) => {
    assert.equal(handled, true, `${method} ${path} is the package's route`);
    return reply!;
  });
};
const manager = { instanceOwner: true };
const familiesPath = (dir: string) => join(dir, "packages", "harness-relay", "families.json");

test("a prohibited family never gets a Relay and cannot be switched on", async () => {
  await drain();
  const dir = tempDir("relay-policy-prohibited-");
  const { registry, ids } = fakeRegistry();
  const vibe = family(dir, registry, "vibe", "Vibe", "prohibited");
  cleanup.push(() => vibe.onDisable());
  await vibe.onEnable();
  const pkg = registerPackage(packageHost(dir));
  cleanup.push(() => pkg.onDisable!());
  await pkg.onEnable!();
  assert.equal(ids().includes("vibe-relay"), false, "no Relay harness is registered");

  const listed = await call(pkg, "GET", "/api/harness-relay/relays", "u1", {}, manager);
  const view = (listed.body as RelaysResponse).families.find((row) => row.family === "vibe")!;
  assert.deepEqual([view.policy, view.enabled, view.editable], ["prohibited", false, false]);
  assert.deepEqual((listed.body as RelaysResponse).relays, []);

  const refused = await call(pkg, "PUT", "/api/harness-relay/families/vibe", "u1", { enabled: true }, manager);
  assert.equal(refused.code, 400, "a manager cannot force it on");
  assert.equal(ids().includes("vibe-relay"), false);
  assert.equal(existsSync(familiesPath(dir)), false, "no choice is stored for a family without a Relay");
});

test("an unsupported family is off until a manager turns it on; a member cannot", async () => {
  await drain();
  const dir = tempDir("relay-policy-unsupported-");
  const { registry, ids } = fakeRegistry();
  const codex = family(dir, registry, "codex", "Codex", "unsupported");
  cleanup.push(() => codex.onDisable());
  await codex.onEnable();
  const pkg = registerPackage(packageHost(dir));
  cleanup.push(() => pkg.onDisable!());
  await pkg.onEnable!();
  assert.equal(ids().includes("codex-relay"), false, "nobody rotates it yet: off");

  const listed = await call(pkg, "GET", "/api/harness-relay/relays", "u1");
  const before = (listed.body as RelaysResponse).families.find((row) => row.family === "codex")!;
  assert.deepEqual([before.policy, before.enabled], ["unsupported", false]);

  await assert.rejects(
    call(pkg, "PUT", "/api/harness-relay/families/codex", "u1", { enabled: true }),
    (error: Error & { code?: string }) => error.code === "forbidden",
    "a member cannot make a deployment decision",
  );
  assert.equal(ids().includes("codex-relay"), false, "still nothing registered");
  assert.equal(existsSync(familiesPath(dir)), false, "and nothing stored");

  const enabled = await call(pkg, "PUT", "/api/harness-relay/families/codex", "u1", { enabled: true }, manager);
  assert.equal(enabled.code, 200);
  assert.equal((enabled.body as { enabled: boolean }).enabled, true);
  assert.equal(ids().includes("codex-relay"), true, "a manager's choice registers the Relay harness");
  assert.deepEqual(JSON.parse(readFileSync(familiesPath(dir), "utf8")), { codex: true });
  const after_ = await call(pkg, "GET", "/api/harness-relay/relays", "u1");
  assert.deepEqual((after_.body as RelaysResponse).relays.map((row) => row.id), ["codex-relay"]);
});

test("an unsupported family a person already rotates stays on with no stored choice", async () => {
  await drain();
  const dir = tempDir("relay-policy-in-use-");
  const { registry, ids } = fakeRegistry();
  const codex = family(dir, registry, "codex", "Codex", "unsupported");
  cleanup.push(() => codex.onDisable());
  await codex.store!.add("Work", async () => {});
  await codex.store!.setRelay("u1", { members: ["codex", "codex-work"], order: "manual", handoverAt: 0.05 });
  await codex.onEnable();
  const pkg = registerPackage(packageHost(dir));
  cleanup.push(() => pkg.onDisable!());
  await pkg.onEnable!();
  assert.equal(ids().includes("codex-relay"), true, "the Relay people already use does not vanish");
  assert.equal(existsSync(familiesPath(dir)), false, "on without anyone choosing it");

  const listed = await call(pkg, "GET", "/api/harness-relay/relays", "u1");
  const view = (listed.body as RelaysResponse).families.find((row) => row.family === "codex")!;
  assert.deepEqual([view.policy, view.enabled, view.offered], ["unsupported", true, true]);
});

test("a tolerated family is on by default and a manager can turn it off", async () => {
  await drain();
  const dir = tempDir("relay-policy-tolerated-");
  const { registry, ids } = fakeRegistry();
  const cursor = family(dir, registry, "cursor", "Cursor", "tolerated");
  cleanup.push(() => cursor.onDisable());
  await cursor.onEnable();
  const pkg = registerPackage(packageHost(dir));
  cleanup.push(() => pkg.onDisable!());
  await pkg.onEnable!();
  assert.equal(ids().includes("cursor-relay"), true, "on with no stored choice");
  assert.equal(existsSync(familiesPath(dir)), false);

  const off = await call(pkg, "PUT", "/api/harness-relay/families/cursor", "u1", { enabled: false }, manager);
  assert.equal(off.code, 200);
  assert.equal((off.body as { enabled: boolean }).enabled, false);
  assert.equal(ids().includes("cursor-relay"), false, "turning it off disposes the registration");
  assert.deepEqual(JSON.parse(readFileSync(familiesPath(dir), "utf8")), { cursor: false });

  const listed = await call(pkg, "GET", "/api/harness-relay/relays", "u1");
  assert.deepEqual((listed.body as RelaysResponse).relays, [], "the GET lists no Relay for it");
  const view = (listed.body as RelaysResponse).families.find((row) => row.family === "cursor")!;
  assert.equal(view.enabled, false);
  assert.equal((await call(pkg, "PUT", "/api/harness-relay/relays/cursor-relay", "u1", { members: [], order: "manual", handoverAt: 0.05 })).code, 404);
});

test("a family this person may not use is absent and never named", async () => {
  await drain();
  const dir = tempDir("relay-policy-foreign-");
  const { registry } = fakeRegistry();
  const claude = family(dir, registry, "claude", "Claude Code", "tolerated");
  cleanup.push(() => claude.onDisable());
  await claude.onEnable();
  const pkg = registerPackage(packageHost(dir));
  cleanup.push(() => pkg.onDisable!());
  await pkg.onEnable!();

  const foreign = "other-space-relay";
  const listed = await call(pkg, "GET", "/api/harness-relay/relays", "u1", {}, { allowedHarnesses: [foreign] });
  assert.equal(listed.code, 200);
  assert.deepEqual((listed.body as RelaysResponse).families, [], "a family outside this account's limits does not exist for it");
  assert.deepEqual((listed.body as RelaysResponse).relays, []);
  assert.equal(JSON.stringify(listed.body).includes("other-space-relay"), false, "the response never names the foreign id");
  assert.equal(JSON.stringify(listed.body).includes("Claude Code"), false);
});

test("onDisable unregisters every Relay harness", async () => {
  await drain();
  const dir = tempDir("relay-policy-disable-");
  const { registry, ids } = fakeRegistry();
  const claude = family(dir, registry, "claude", "Claude Code", "tolerated");
  const codex = family(dir, registry, "codex", "Codex", "unsupported");
  cleanup.push(() => claude.onDisable(), () => codex.onDisable());
  await claude.onEnable();
  await codex.onEnable();
  const pkg = registerPackage(packageHost(dir));
  cleanup.push(() => pkg.onDisable!());
  await pkg.onEnable!();
  await call(pkg, "PUT", "/api/harness-relay/families/codex", "u1", { enabled: true }, manager);
  assert.deepEqual(ids().filter((id) => id.endsWith("-relay")).toSorted(), ["claude-relay", "codex-relay"]);

  await pkg.onDisable!();
  assert.deepEqual(ids().filter((id) => id.endsWith("-relay")), [], "every Relay harness is gone");
  assert.equal(ids().includes("claude"), true, "the families' own harnesses stay registered");
});
