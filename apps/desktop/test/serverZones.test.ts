import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SERVERS_STATE, forgetServerKey, normalizeServersState, type DesktopServersState } from "../src/servers.ts";
import {
  allServerZones,
  foldZone,
  normalizeZoneProjects,
  normalizeZoneSnapshots,
  planZoneOpen,
  pruneZoneSnapshots,
  readZoneSnapshotsSync,
  recordZoneReport,
  serverZonesView,
  writeZoneSnapshots,
  zoneProjectPath,
  zoneTarget,
  type ZoneSources,
} from "../src/serverZones.ts";

const TEAM = "https://team.example.com";
const STUDIO = "https://studio.example.com";

const sources = (servers: Partial<DesktopServersState> = {}, more: Partial<ZoneSources> = {}): ZoneSources => ({
  servers: {
    ...DEFAULT_SERVERS_STATE,
    addresses: [{ url: TEAM, lastUsedAt: 2 }, { url: STUDIO, lastUsedAt: 9 }],
    ...servers,
  },
  links: [{ id: "abc", hostLabel: "Office Mac", revoked: false }],
  localAvailable: true,
  snapshots: {
    local: { projects: [{ id: "home", name: "Home" }], reportedAt: 5 },
    "link:abc": { projects: [{ id: "p1", name: "Backend", color: "#ff0000" }], reportedAt: 6 },
    [`address:${TEAM}`]: { projects: [{ id: "t1", name: "Site" }, { id: "t2", name: "App" }], reportedAt: 7 },
  },
  ...more,
});

test("this computer's page lists every other server with the projects it last showed", () => {
  const view = serverZonesView({ kind: "local" }, sources());
  assert.equal(view.access, "granted");
  assert.deepEqual(view.zones.map((zone) => [zone.key, zone.kind, zone.label, zone.projects.length, zone.reportedAt]), [
    ["link:abc", "link", "Office Mac", 1, 6],
    [`address:${STUDIO}`, "address", "studio.example.com", 0, null],
    [`address:${TEAM}`, "address", "team.example.com", 2, 7],
  ]);
});

test("a zone order does not follow which server was used last", () => {
  const before = allServerZones(sources()).map((zone) => zone.key);
  const after = allServerZones(sources({ addresses: [{ url: STUDIO, lastUsedAt: 1 }, { url: TEAM, lastUsedAt: 99 }] })).map((zone) => zone.key);
  assert.deepEqual(after, before);
  assert.equal(before[0], "local");
});

test("another server's page learns nothing about the other servers until the person allows it", () => {
  const team = { kind: "address" as const, url: TEAM };
  const asked = serverZonesView(team, sources());
  assert.deepEqual(asked, { access: "ask", zones: [] });
  assert.equal(JSON.stringify(asked).includes("Office"), false);

  const allowed = serverZonesView(team, sources({ zoneServers: [`address:${TEAM}`] }));
  assert.equal(allowed.access, "granted");
  // Its own zone is the page itself; this computer is one of the others.
  assert.deepEqual(allowed.zones.map((zone) => zone.key), ["local", "link:abc", `address:${STUDIO}`]);
  assert.equal(allowed.zones[0]!.label, "");
});

test("allowing one server allows only that one", () => {
  const granted = sources({ zoneServers: [`address:${TEAM}`] });
  assert.equal(serverZonesView({ kind: "address", url: STUDIO }, granted).access, "ask");
  assert.equal(serverZonesView({ kind: "link", id: "abc" }, granted).access, "ask");
});

test("with no other server there is nothing to show and nothing to ask", () => {
  const alone = sources({ addresses: [] }, { links: [] });
  assert.deepEqual(serverZonesView({ kind: "local" }, alone), { access: "granted", zones: [] });
  const onlyClient = sources({ addresses: [{ url: TEAM, lastUsedAt: 1 }] }, { links: [], localAvailable: false });
  assert.deepEqual(serverZonesView({ kind: "address", url: TEAM }, onlyClient), { access: "granted", zones: [] });
});

test("someone who only connects has no zone for this computer", () => {
  const view = serverZonesView({ kind: "address", url: TEAM }, sources({ zoneServers: [`address:${TEAM}`] }, { localAvailable: false }));
  assert.equal(view.zones.some((zone) => zone.key === "local"), false);
});

test("a page's list is bounded and reduced to what a row draws", () => {
  const long = "x".repeat(500);
  const projects = normalizeZoneProjects([
    { id: "a", name: "  Alpha \n project ", icon: "🚀", color: "#abc", path: "/home/someone/alpha", spaceId: "s" },
    { id: "a", name: "Duplicate" },
    { id: "b/../c", name: "Traversal" },
    { id: "has space", name: "Spaces" },
    { id: "q?x=1", name: "Query" },
    { id: "", name: "Empty" },
    { id: "c", name: "" },
    { id: "d", name: long, color: "red; background: url(x)", icon: "y".repeat(5000) },
    { id: "e", name: 7 },
    null,
    "nonsense",
  ]);
  assert.deepEqual(projects, [
    { id: "a", name: "Alpha project", icon: "🚀", color: "#abc" },
    { id: "d", name: "x".repeat(120) },
  ]);
  assert.deepEqual(normalizeZoneProjects("nope"), []);
  assert.deepEqual(normalizeZoneProjects(undefined), []);
  const many = Array.from({ length: 5000 }, (_, index) => ({ id: `p${index}`, name: `P${index}` }));
  assert.equal(normalizeZoneProjects(many).length, 200);
});

test("a report is filed under the sender's server and rewrites only on change", () => {
  const start = sources().snapshots;
  const same = recordZoneReport(start, "local", [{ id: "home", name: "Home" }], 100);
  assert.equal(same, start);
  const changed = recordZoneReport(start, "local", [{ id: "home", name: "Home" }, { id: "lab", name: "Lab" }], 100);
  assert.notEqual(changed, start);
  assert.deepEqual(changed.local, { projects: [{ id: "home", name: "Home" }, { id: "lab", name: "Lab" }], reportedAt: 100 });
  assert.deepEqual(changed["link:abc"], start["link:abc"]);
  // An empty list is an answer too: the server has no projects now.
  assert.deepEqual(recordZoneReport(start, "local", [], 200).local, { projects: [], reportedAt: 200 });
});

test("a click opens only a listed project of a visible zone", () => {
  const local = { kind: "local" as const };
  const all = sources();
  assert.deepEqual(planZoneOpen(local, all, { key: `address:${TEAM}`, projectId: "t2" }), { kind: "address", url: TEAM, path: "/p/t2" });
  assert.deepEqual(planZoneOpen(local, all, { key: "link:abc", projectId: "p1" }), { kind: "link", id: "abc", path: "/p/p1" });
  assert.deepEqual(planZoneOpen(local, all, { key: `address:${STUDIO}` }), { kind: "address", url: STUDIO });
  // Not a project that zone listed, not a saved server, not the page's own.
  assert.equal(planZoneOpen(local, all, { key: `address:${TEAM}`, projectId: "elsewhere" }), null);
  assert.equal(planZoneOpen(local, all, { key: "address:https://evil.example" }), null);
  assert.equal(planZoneOpen(local, all, { key: "local", projectId: "home" }), null);
  assert.equal(planZoneOpen(local, all, null), null);
  assert.equal(planZoneOpen(local, all, { key: 7 }), null);
});

test("another server's page moves the window nowhere until it is allowed", () => {
  const team = { kind: "address" as const, url: TEAM };
  assert.equal(planZoneOpen(team, sources(), { key: "local", projectId: "home" }), null);
  assert.equal(planZoneOpen(team, sources(), { key: "link:abc" }), null);
  const allowed = sources({ zoneServers: [`address:${TEAM}`] });
  assert.deepEqual(planZoneOpen(team, allowed, { key: "local", projectId: "home" }), { kind: "local", path: "/p/home" });
});

test("a revoked pairing opens the server list, where it can be paired again", () => {
  const revoked = sources({}, { links: [{ id: "abc", hostLabel: "Office Mac", revoked: true }] });
  assert.equal(serverZonesView({ kind: "local" }, revoked).zones[0]!.available, false);
  assert.deepEqual(planZoneOpen({ kind: "local" }, revoked, { key: "link:abc", projectId: "p1" }), { kind: "server-list" });
});

test("folding a zone is remembered per server and only for a zone on show", () => {
  const local = { kind: "local" as const };
  const start = sources();
  const folded = foldZone(local, start, { key: "link:abc", folded: true });
  assert.deepEqual(folded.foldedZones, ["link:abc"]);
  assert.equal(serverZonesView(local, { ...start, servers: folded }).zones[0]!.folded, true);
  assert.equal(foldZone(local, { ...start, servers: folded }, { key: "link:abc", folded: true }), folded);
  assert.deepEqual(foldZone(local, { ...start, servers: folded }, { key: "link:abc", folded: false }).foldedZones, []);
  // Unknown zones and pages that may not see zones change nothing.
  assert.equal(foldZone(local, start, { key: "address:https://evil.example", folded: true }), start.servers);
  assert.equal(foldZone({ kind: "address", url: TEAM }, start, { key: "local", folded: true }), start.servers);
});

test("zone keys name saved servers only", () => {
  assert.deepEqual(zoneTarget("local"), { kind: "local" });
  assert.deepEqual(zoneTarget("link:abc"), { kind: "link", id: "abc" });
  assert.deepEqual(zoneTarget(`address:${TEAM}`), { kind: "address", url: TEAM });
  for (const bad of ["", "link:", "link:a b", "address:", "address:javascript:alert(1)", `address:${TEAM}/path`, "address:team.example.com", "hub", 7, null]) {
    assert.equal(zoneTarget(bad), null, String(bad));
  }
});

test("a project route is built here, never taken from the page", () => {
  assert.equal(zoneProjectPath("8b0c9a52-1d2e-4c1f-9d5e-3a2b1c0d9e8f"), "/p/8b0c9a52-1d2e-4c1f-9d5e-3a2b1c0d9e8f");
  assert.equal(zoneProjectPath("проєкт"), `/p/${encodeURIComponent("проєкт")}`);
  for (const bad of ["", "a/b", "..\\x", "a b", "a?b", "a#b", "a%2Fb", "x".repeat(129), 7, null, undefined]) {
    assert.equal(zoneProjectPath(bad), undefined, String(bad));
  }
});

test("forgetting a server forgets its zone, its permission and its fold", () => {
  const state = normalizeServersState({
    zoneServers: [`address:${TEAM}`, "link:abc", "local", "nonsense"],
    foldedZones: ["local", `address:${TEAM}`, "link:abc", "link:abc"],
    microphoneServers: [`address:${TEAM}`],
  });
  // This computer is never "another server", so it holds no permission.
  assert.deepEqual(state.zoneServers, [`address:${TEAM}`, "link:abc"]);
  assert.deepEqual(state.foldedZones, ["local", `address:${TEAM}`, "link:abc"]);
  const forgotten = forgetServerKey(state, `address:${TEAM}`);
  assert.deepEqual(forgotten.zoneServers, ["link:abc"]);
  assert.deepEqual(forgotten.foldedZones, ["local", "link:abc"]);
  assert.deepEqual(forgotten.microphoneServers, []);

  const snapshots = sources().snapshots;
  const pruned = pruneZoneSnapshots(snapshots, new Set(["local", "link:abc"]));
  assert.deepEqual(Object.keys(pruned), ["local", "link:abc"]);
  assert.equal(pruneZoneSnapshots(pruned, new Set(["local", "link:abc"])), pruned);
});

test("the remembered lists survive a restart, private to the person, and a broken file is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-zones-"));
  try {
    const path = join(dir, "desktop", "server-zones.json");
    await writeZoneSnapshots(path, sources().snapshots);
    assert.deepEqual(readZoneSnapshotsSync(path), sources().snapshots);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
    assert.deepEqual(readZoneSnapshotsSync(join(dir, "missing.json")), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(normalizeZoneSnapshots({
    "address:not a url": { projects: [{ id: "a", name: "A" }], reportedAt: 1 },
    local: { projects: [{ id: "a", name: "A" }, { id: "../b", name: "B" }], reportedAt: "soon" },
    "link:abc": null,
  }), { local: { projects: [{ id: "a", name: "A" }], reportedAt: 0 } });
});
