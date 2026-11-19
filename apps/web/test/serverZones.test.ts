import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "@polyth/contracts";
import type {
  DesktopServerZone,
  DesktopServerZoneProject,
  DesktopServerZonesView,
  PolythDesktopApi,
} from "../src/desktopBridge.ts";
import type { ProjectRegistryState } from "../src/projectRegistry.ts";
import { createServerZonesStore, installServerZones, zoneProjectsOf, zoneRows } from "../src/serverZones.ts";

const project = (id: string, more: Partial<Project> = {}): Project =>
  ({ id, path: `/home/someone/${id}`, name: id.toUpperCase(), createdAt: 1, ...more }) as Project;

const ready = (projects: Project[]): ProjectRegistryState =>
  ({ status: "ready", requestId: 1, mutationVersion: 0, projects }) as unknown as ProjectRegistryState;
const loading = { status: "loading", requestId: 0, projects: [] } as ProjectRegistryState;

const zone = (key: string, more: Partial<DesktopServerZone> = {}): DesktopServerZone => ({
  key, kind: "address", label: key, available: true, folded: false, projects: [], reportedAt: 1, ...more,
});

function harness(view: DesktopServerZonesView = { access: "granted", zones: [zone("address:https://team.example")] }) {
  const reports: DesktopServerZoneProject[][] = [];
  const opens: Array<[string, string | undefined]> = [];
  const folds: Array<[string, boolean]> = [];
  let current = view;
  let finishOpen: (() => void) | null = null;
  let failReports = false;
  const timers: Array<() => void> = [];
  const api = {
    surface: "local",
    getInfo: async () => ({ server: { kind: "local", label: "This computer" } }),
    servers: {
      zones: async () => current,
      reportZoneProjects: async (projects: DesktopServerZoneProject[]) => {
        if (failReports) throw new Error("gone");
        reports.push(projects);
      },
      allowZones: async () => {
        current = { access: "granted", zones: [zone("local", { kind: "local", label: "" })] };
        return current;
      },
      openZone: (key: string, projectId?: string) => {
        opens.push([key, projectId]);
        return new Promise((resolve) => { finishOpen = () => resolve({ ok: true, result: undefined }); });
      },
      foldZone: async (key: string, folded: boolean) => {
        folds.push([key, folded]);
        current = { ...current, zones: current.zones.map((item) => item.key === key ? { ...item, folded } : item) };
        return current;
      },
    },
  } as unknown as PolythDesktopApi;
  const store = createServerZonesStore(api, {
    set: (run) => { timers.push(run); return timers.length; },
    clear: () => { timers.length = 0; },
  });
  return {
    api, store, reports, opens, folds, timers,
    runTimers: () => { for (const run of timers.splice(0)) run(); },
    finishOpen: () => finishOpen?.(),
    failReports: (fail: boolean) => { failReports = fail; },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("only what a row draws leaves the page: no folder path, no Space, no private room", () => {
  const rows = zoneProjectsOf([
    project("alpha", { color: "#ff8800", icon: "🚀", spaceId: "space-1", greeting: "hi" }),
    project("room", { parentProjectId: "alpha" }),
    project("unnamed", { name: "" }),
    project("big", { icon: `data:image/svg+xml,${"x".repeat(9000)}` }),
  ]);
  assert.deepEqual(rows, [
    { id: "alpha", name: "ALPHA", icon: "🚀", color: "#ff8800" },
    { id: "unnamed", name: "/home/someone/unnamed" },
    { id: "big", name: "BIG" },
  ]);
  assert.equal(JSON.stringify(rows[0]).includes("space-1"), false);
  assert.equal(zoneProjectsOf(Array.from({ length: 500 }, (_, index) => project(`p${index}`))).length, 200);
});

test("the page lists its projects once the server confirmed them, and again only when they change", async () => {
  const h = harness();
  h.store.noteRegistry(loading);
  assert.equal(h.timers.length, 0, "a list still loading would wipe this server's zone");
  const first = ready([project("alpha")]);
  h.store.noteRegistry(first);
  h.store.noteRegistry(first);
  assert.equal(h.timers.length, 1, "one report is scheduled however often the store publishes");
  // A change before the timer fires rides the same report.
  h.store.noteRegistry(ready([project("alpha"), project("beta")]));
  h.runTimers();
  await settle();
  assert.deepEqual(h.reports, [[{ id: "alpha", name: "ALPHA" }, { id: "beta", name: "BETA" }]]);
  // The same rows in a new registry object are not sent again.
  h.store.noteRegistry(ready([project("alpha"), project("beta", { defaults: {} })]));
  h.runTimers();
  await settle();
  assert.equal(h.reports.length, 1);
  h.store.noteRegistry(ready([project("alpha")]));
  h.runTimers();
  await settle();
  assert.deepEqual(h.reports[1], [{ id: "alpha", name: "ALPHA" }]);
});

test("a report that did not arrive is sent again with the next change of the list", async () => {
  const h = harness();
  h.failReports(true);
  const same = [project("alpha")];
  h.store.noteRegistry(ready(same));
  h.runTimers();
  await settle();
  assert.equal(h.reports.length, 0);
  h.failReports(false);
  h.store.noteRegistry(ready(same));
  h.runTimers();
  await settle();
  assert.equal(h.reports.length, 1);
});

test("the zones and the server on screen arrive from the app", async () => {
  const h = harness();
  assert.equal(h.store.getState().view, null);
  let published = 0;
  h.store.subscribe(() => { published += 1; });
  await settle();
  assert.equal(h.store.getState().view?.zones[0]?.key, "address:https://team.example");
  assert.deepEqual(h.store.getState().current, { kind: "local", label: "This computer" });
  assert.ok(published >= 2);
});

test("a click moves the window once: a second click while it leaves does nothing", async () => {
  const h = harness();
  await settle();
  const target = h.store.getState().view!.zones[0]!;
  const leaving = h.store.open(target, "p1");
  assert.equal(h.store.getState().opening, "address:https://team.example/p1");
  await h.store.open(target, "p2");
  assert.deepEqual(h.opens, [["address:https://team.example", "p1"]]);
  h.finishOpen();
  await leaving;
  assert.equal(h.store.getState().opening, null);
});

test("folding shows at once and the app's answer stands", async () => {
  const h = harness();
  await settle();
  const target = h.store.getState().view!.zones[0]!;
  const folding = h.store.fold(target, true);
  assert.equal(h.store.getState().view!.zones[0]!.folded, true);
  await folding;
  assert.deepEqual(h.folds, [["address:https://team.example", true]]);
  assert.equal(h.store.getState().view!.zones[0]!.folded, true);
});

test("another server's page shows the zones only after the app's answer to the question", async () => {
  const h = harness({ access: "ask", zones: [] });
  await settle();
  assert.equal(h.store.getState().view?.access, "ask");
  await h.store.allow();
  assert.deepEqual(h.store.getState().view?.zones.map((item) => item.key), ["local"]);
});

test("nothing installs on the server list, in a browser tab or in a shell older than zones", () => {
  const registry = { get: () => loading, subscribe: () => { throw new Error("subscribed"); } };
  const h = harness();
  for (const api of [
    { ...h.api, surface: "hub" },
    { ...h.api, surface: undefined },
    { ...h.api, servers: undefined },
    { ...h.api, servers: { menu: async () => {} } },
  ]) {
    assert.doesNotThrow(() => installServerZones(api as unknown as PolythDesktopApi, registry)());
  }
});

test("a disposed store publishes nothing and sends nothing", async () => {
  const h = harness();
  let published = 0;
  h.store.subscribe(() => { published += 1; });
  h.store.noteRegistry(ready([project("alpha")]));
  h.store.dispose();
  h.runTimers();
  await settle();
  assert.equal(published, 0);
  assert.equal(h.reports.length, 0);
});

test("a long server shows six projects and counts the rest; one more is not worth a row", () => {
  const list = (count: number) => Array.from({ length: count }, (_, index) => index);
  assert.deepEqual(zoneRows(list(3), false), { shown: list(3), more: 0 });
  assert.deepEqual(zoneRows(list(7), false), { shown: list(7), more: 0 });
  assert.deepEqual(zoneRows(list(8), false), { shown: list(6), more: 2 });
  assert.deepEqual(zoneRows(list(40), true), { shown: list(40), more: 0 });
});
