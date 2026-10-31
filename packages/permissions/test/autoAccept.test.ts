// Auto-accept policy: pure nearest-parent resolution (child opt-out wins,
// root default off, cycles bounded), the explicit-settings store, and the
// Space/project approval defaults with their routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, RouteRequest } from "@polyth/contracts";
import {
  createApprovalDefaultsService,
  createAutoAcceptStore,
  parseApprovalDefaults,
  resolveAutoAccept,
  resolveAutoAcceptLevel,
  type AutoAcceptSetting,
} from "../src/index.ts";
import { APPROVAL_DEFAULTS_PATH, FULL_ACCESS_DEFAULT_PATH, approvalDefaultsRoutes } from "../src/serverEntry.ts";

const chain = (settings: Record<string, AutoAcceptSetting>, parents: Record<string, string>) =>
  (id: string) => resolveAutoAccept(id, (x) => settings[x] ?? "inherit", (x) => parents[x]);

test("resolution: explicit setting wins, inherit walks up, root default is off", () => {
  // root → mid → leaf
  const parents = { leaf: "mid", mid: "root" };

  // nothing set anywhere: off (never a global default)
  assert.equal(chain({}, parents)("leaf"), false);

  // parent on, descendants inherit
  assert.equal(chain({ root: "on" }, parents)("leaf"), true);
  assert.equal(chain({ root: "on" }, parents)("mid"), true);
  assert.equal(chain({ root: "on" }, parents)("root"), true);

  // nearest parent wins: mid off shadows root on for the leaf
  assert.equal(chain({ root: "on", mid: "off" }, parents)("leaf"), false);
  assert.equal(chain({ root: "on", mid: "off" }, parents)("root"), true);

  // child opt-out beats an inherited on
  assert.equal(chain({ root: "on", leaf: "off" }, parents)("leaf"), false);

  // own setting needs no parent at all
  assert.equal(chain({ leaf: "on" }, {})("leaf"), true);
});

test("level: Full access inherits like Auto-Approve and a child can narrow it", () => {
  const level = (settings: Record<string, AutoAcceptSetting>, parents: Record<string, string>) =>
    (id: string) => resolveAutoAcceptLevel(id, (x) => settings[x] ?? "inherit", (x) => parents[x]);
  const parents = { leaf: "mid", mid: "root" };
  assert.equal(level({}, parents)("leaf"), "off");
  assert.equal(level({ root: "on" }, parents)("leaf"), "routine");
  assert.equal(level({ root: "all" }, parents)("leaf"), "all");
  assert.equal(level({ root: "all", mid: "on" }, parents)("leaf"), "routine", "a nearer \"on\" narrows Full access");
  assert.equal(level({ root: "all", leaf: "off" }, parents)("leaf"), "off");
  assert.equal(level({ root: "on", mid: "all" }, parents)("leaf"), "all");
  // The boolean view stays true for both automatic levels.
  assert.equal(chain({ root: "all" }, parents)("leaf"), true);
});

test("resolution: parent cycles and unknown parents terminate safely", () => {
  assert.equal(chain({}, { a: "b", b: "a" })("a"), false);
  assert.equal(chain({ b: "on" }, { a: "b", b: "a" })("a"), true);
  assert.equal(chain({}, { a: "ghost" })("a"), false); // parent without settings
});

test("store: persists explicit choices only; inherit removes the record", () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-aa-")), "auto-accept.json");
  const s1 = createAutoAcceptStore(file);
  assert.equal(s1.get("s1"), "inherit");

  s1.set("s1", "on");
  s1.set("s2", "off");
  assert.equal(s1.get("s1"), "on");
  assert.equal(s1.get("s2"), "off");

  // survives a reload
  const s2 = createAutoAcceptStore(file);
  assert.equal(s2.get("s1"), "on");
  assert.equal(s2.get("s2"), "off");

  // inherit clears the entry from the file
  s2.set("s1", "inherit");
  assert.equal(s2.get("s1"), "inherit");
  assert.doesNotMatch(readFileSync(file, "utf8"), /s1/);
  const s3 = createAutoAcceptStore(file);
  assert.equal(s3.get("s1"), "inherit");
  assert.equal(s3.get("s2"), "off");
});

test("level: the approval default applies only where no session chose", () => {
  const parents = { leaf: "mid", mid: "root" };
  const level = (settings: Record<string, AutoAcceptSetting>, rootDefault: "off" | "routine" | "all") =>
    resolveAutoAcceptLevel("leaf", (x) => settings[x] ?? "inherit", (x) => parents[x as keyof typeof parents], rootDefault);
  assert.equal(level({}, "all"), "all");
  assert.equal(level({}, "routine"), "routine");
  assert.equal(level({ mid: "off" }, "all"), "off");
  assert.equal(level({ mid: "off" }, "routine"), "off", "an explicit Ask beats an Auto-approve default");
  assert.equal(level({ root: "on" }, "all"), "routine");
  assert.equal(level({ root: "all" }, "routine"), "all");
  // A chain may start at a missing parent: only the default remains.
  assert.equal(resolveAutoAcceptLevel(undefined, () => "on", () => undefined, "routine"), "routine");
});

test("approval defaults: per Space, per project, persisted, fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-ad-"));
  const fileOf = (spaceId: string) => spaceId === "broken" ? undefined : join(dir, spaceId, "full-access.json");
  const service = createApprovalDefaultsService(fileOf);
  const changed: string[] = [];
  service.subscribe((spaceId) => changed.push(spaceId));
  assert.equal(service.level("a"), "off");
  assert.equal(service.level("a", "p1"), "off");
  assert.equal(service.level(undefined), "off");

  const routine = service.setSpaceLevel("a", "routine", "owner");
  assert.equal(routine.level, "routine");
  assert.equal(routine.changedBy, "owner");
  assert.equal(service.level("a"), "routine");
  assert.equal(service.level("a", "p1"), "routine", "a project without its own level follows the Space");
  assert.equal(service.level("b"), "off", "another Space is unaffected");

  // A project may go either way.
  service.setProjectLevel("a", "p1", "all", "owner");
  service.setProjectLevel("a", "p2", "off", "owner");
  assert.equal(service.level("a", "p1"), "all");
  assert.equal(service.level("a", "p2"), "off");
  assert.equal(service.level("a", "p3"), "routine");
  assert.deepEqual(changed, ["a", "a", "a"]);

  const reloaded = createApprovalDefaultsService(fileOf);
  assert.equal(reloaded.level("a"), "routine", "survives a reload");
  assert.equal(reloaded.level("a", "p1"), "all");
  assert.equal(reloaded.level("a", "p2"), "off");

  service.setProjectLevel("a", "p1", "inherit", "owner");
  assert.equal(service.level("a", "p1"), "routine");
  assert.deepEqual(Object.keys(createApprovalDefaultsService(fileOf).get("a").projects), ["p2"]);

  assert.throws(() => service.setSpaceLevel("broken", "routine", "owner"), { code: "unavailable" });
  assert.equal(service.level("broken"), "off");
  assert.throws(() => service.setSpaceLevel("a", "yes" as never, "owner"), { code: "invalid-input" });
  assert.throws(() => service.setProjectLevel("a", "p1", "always" as never, "owner"), { code: "invalid-input" });
});

test("approval defaults: older files, unknown values and what older servers read", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-ad-legacy-"));
  const fileOf = (spaceId: string) => join(dir, spaceId, "full-access.json");
  const seed = (spaceId: string, value: unknown) => {
    mkdirSync(join(dir, spaceId), { recursive: true });
    writeFileSync(fileOf(spaceId), typeof value === "string" ? value : JSON.stringify(value));
  };
  seed("legacy-on", { enabled: true, enabledAt: 5, enabledBy: "owner" });
  seed("legacy-off", { enabled: false });
  seed("unknown", { enabled: true, level: "everything" });
  seed("broken-project", { level: "all", projects: { p1: { level: "maybe" }, p2: "all" } });
  seed("garbage", "{not json");
  const service = createApprovalDefaultsService(fileOf);
  assert.deepEqual(service.get("legacy-on"), { level: "all", changedAt: 5, changedBy: "owner", projects: {} });
  assert.equal(service.level("legacy-off"), "off");
  assert.equal(service.level("unknown"), "off", "an unknown level never falls back to the legacy flag");
  assert.equal(service.level("broken-project"), "all");
  assert.equal(service.level("broken-project", "p1"), "off", "an unreadable project entry holds that project at off");
  assert.equal(service.level("broken-project", "p2"), "off");
  assert.equal(service.level("broken-project", "p3"), "all");
  assert.equal(service.level("garbage"), "off");
  assert.throws(() => service.setSpaceLevel("garbage", "routine", "owner"), { code: "unavailable" },
    "a change never starts from the fail-closed stand-in");

  // Older servers only read `enabled`: true only where nothing narrower exists.
  const legacyEnabled = (spaceId: string) => (JSON.parse(readFileSync(fileOf(spaceId), "utf8")) as { enabled: boolean }).enabled;
  service.setSpaceLevel("fresh", "routine", "owner");
  assert.equal(legacyEnabled("fresh"), false);
  service.setSpaceLevel("fresh", "all", "owner");
  assert.equal(legacyEnabled("fresh"), true);
  service.setProjectLevel("fresh", "p1", "routine", "owner");
  assert.equal(legacyEnabled("fresh"), false, "a narrower project keeps older servers off everywhere");
  service.setProjectLevel("fresh", "p1", "all", "owner");
  assert.equal(legacyEnabled("fresh"), true);
  assert.deepEqual(parseApprovalDefaults(JSON.parse(readFileSync(fileOf("fresh"), "utf8"))).projects.p1?.level, "all");
});

const routeRequest = (opts: {
  method: string;
  path?: string;
  body?: Record<string, unknown>;
  owner?: boolean;
  ingress?: RouteRequest["ingress"]["kind"];
  deviceGrants?: string[];
}) => {
  const sent: { code?: number; body?: unknown } = {};
  const ingress = opts.ingress === "internal"
    ? { kind: "internal" as const, serviceId: "polyth-control" }
    : opts.ingress === "polyth-link"
      ? { kind: "polyth-link" as const, connectionId: "c1", transport: "relay" as const }
      : { kind: "public-http" as const, listenerId: "public", loopback: false, secure: true };
  const principal = opts.ingress === "polyth-link"
    ? { kind: "paired-device", deviceId: "phone", deviceEndpointId: "e", connectionId: "c1", transport: "relay", grants: opts.deviceGrants ?? [], grantRevision: 1 }
    : { kind: "ui-session", sessionId: "ui", rememberedDeviceId: "d" };
  const request = {
    path: opts.path ?? APPROVAL_DEFAULTS_PATH,
    method: opts.method,
    ingress,
    principal,
    space: { spaceId: "a", spaceSlug: "a", userId: "u1", role: "owner", deployment: "trusted", storageDir: "/tmp", instanceOwner: opts.owner ?? true },
    body: async () => opts.body ?? {},
    json: (code: number, body: unknown) => { sent.code = code; sent.body = body; },
  } as unknown as RouteRequest;
  return { request, sent };
};

const spaceProjects = (ids: string[]) => {
  const projects = ids.map((id): Project => ({ id, path: `/work/${id}`, name: id, spaceId: "a", createdAt: 1 }));
  return () => ({
    list: async () => projects,
    get: async (id: string) => projects.find((project) => project.id === id),
  });
};

const freshService = () =>
  createApprovalDefaultsService((spaceId) => join(mkdtempSync(join(tmpdir(), "polyth-ad-route-")), spaceId, "full-access.json"));

test("approval defaults route: only the instance owner, and only a person raises", async () => {
  const service = freshService();
  const routes = approvalDefaultsRoutes(service, spaceProjects(["p1"]));

  await assert.rejects(routes(routeRequest({ method: "PUT", body: { level: "routine" }, owner: false }).request), { code: "forbidden" });
  await assert.rejects(routes(routeRequest({ method: "PUT", body: { level: "routine" }, ingress: "internal" }).request), { code: "forbidden" });
  await assert.rejects(routes(routeRequest({ method: "PUT", body: { level: "yes" } }).request), { code: "invalid-input" });
  assert.equal(service.level("a"), "off");

  const person = routeRequest({ method: "PUT", body: { level: "routine" } });
  assert.equal(await routes(person.request), true);
  assert.equal(service.level("a"), "routine");
  assert.equal((person.sent.body as { level: string; canEdit: boolean }).level, "routine");

  // Full access by the agent control socket stays a person's decision...
  await assert.rejects(routes(routeRequest({ method: "PUT", body: { level: "all" }, ingress: "internal" }).request), { code: "forbidden" });
  // ...but it may lower, or keep, the level.
  await routes(routeRequest({ method: "PUT", body: { level: "routine" }, ingress: "internal" }).request);
  await routes(routeRequest({ method: "PUT", body: { level: "off" }, ingress: "internal" }).request);
  assert.equal(service.level("a"), "off");

  // A paired phone is a person only when its owner trusts it like this computer.
  await assert.rejects(routes(routeRequest({ method: "PUT", body: { level: "all" }, ingress: "polyth-link", deviceGrants: ["core.sessions.read"] }).request), { code: "forbidden" });
  await routes(routeRequest({ method: "PUT", body: { level: "all" }, ingress: "polyth-link", deviceGrants: ["device.full-access"] }).request);
  assert.equal(service.level("a"), "all");

  const read = routeRequest({ method: "GET", owner: false });
  await routes(read.request);
  assert.equal(read.sent.code, 200);
  assert.equal((read.sent.body as { level: string }).level, "all");
  assert.equal((read.sent.body as { canEdit: boolean }).canEdit, false, "a member reads them but cannot change them");
});

test("approval defaults route: a project's level is the Space's own project, raised only by a person", async () => {
  const service = freshService();
  const routes = approvalDefaultsRoutes(service, spaceProjects(["p1", "p2"]));
  const project = (id: string, level: string, opts: Partial<Parameters<typeof routeRequest>[0]> = {}) =>
    routeRequest({ method: "PUT", path: `${APPROVAL_DEFAULTS_PATH}/projects/${encodeURIComponent(id)}`, body: { level }, ...opts });

  // A project of another Space, or none at all, reads as not found — but a
  // member learns nothing about its existence either way.
  await assert.rejects(routes(project("foreign", "routine").request), { code: "not-found" });
  await assert.rejects(routes(project("foreign", "routine", { owner: false }).request), { code: "forbidden" });
  await assert.rejects(routes(project("p1", "routine", { owner: false }).request), { code: "forbidden" });
  await assert.rejects(routes(project("p1", "sometimes").request), { code: "invalid-input" });

  await assert.rejects(routes(project("p1", "all", { ingress: "internal" }).request), { code: "forbidden" });
  const raised = project("p1", "all");
  await routes(raised.request);
  assert.equal(service.level("a", "p1"), "all");
  assert.deepEqual(Object.keys((raised.sent.body as { projects: Record<string, unknown> }).projects), ["p1"]);

  // The agent control socket may narrow a project, but never clear a narrower
  // project level when the Space's own is broader.
  service.setSpaceLevel("a", "all", "u1");
  await routes(project("p2", "off", { ingress: "internal" }).request);
  assert.equal(service.level("a", "p2"), "off");
  await assert.rejects(routes(project("p2", "inherit", { ingress: "internal" }).request), { code: "forbidden" });
  await routes(project("p2", "inherit").request);
  assert.equal(service.level("a", "p2"), "all");

  // Levels of projects that are no longer in the Space are not reported.
  service.setProjectLevel("a", "gone", "routine", "u1");
  const read = routeRequest({ method: "GET" });
  await routes(read.request);
  assert.deepEqual(Object.keys((read.sent.body as { projects: Record<string, unknown> }).projects), ["p1"]);
});

test("Full access default route keeps working for older clients", async () => {
  const service = freshService();
  const routes = approvalDefaultsRoutes(service, spaceProjects([]));
  const legacy = (opts: Parameters<typeof routeRequest>[0]) => routeRequest({ path: FULL_ACCESS_DEFAULT_PATH, ...opts });

  await assert.rejects(routes(legacy({ method: "PUT", body: { enabled: true }, owner: false }).request), { code: "forbidden" });
  await assert.rejects(routes(legacy({ method: "PUT", body: { enabled: true }, ingress: "internal" }).request), { code: "forbidden" });
  await assert.rejects(routes(legacy({ method: "PUT", body: { enabled: "yes" } }).request), { code: "invalid-input" });
  assert.equal(service.level("a"), "off");

  await routes(legacy({ method: "PUT", body: { enabled: true } }).request);
  assert.equal(service.level("a"), "all");
  const on = legacy({ method: "GET", owner: false });
  await routes(on.request);
  assert.equal((on.sent.body as { enabled: boolean }).enabled, true);

  // Turning it off goes back to asking; the agent control socket may do that.
  await routes(legacy({ method: "PUT", body: { enabled: false }, ingress: "internal" }).request);
  assert.equal(service.level("a"), "off");

  // Off leaves an Auto-approve default alone: Full access already is.
  service.setSpaceLevel("a", "routine", "u1");
  const off = legacy({ method: "PUT", body: { enabled: false }, ingress: "internal" });
  await routes(off.request);
  assert.equal(service.level("a"), "routine");
  assert.deepEqual(off.sent.body, { enabled: false });
});
