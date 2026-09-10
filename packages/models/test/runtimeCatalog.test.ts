import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { AgentDescriptor, ModelDescriptor } from "@polyth/contracts";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const requests: string[] = [];
const pending = new Map<string, (value: unknown) => void>();
let cheapSnapshots: unknown[] = [];
let forcedSnapshots: Promise<unknown[]> | undefined;
const roster = [
  { identity: { id: "codex", name: "Codex" }, policy: { enabled: true, priority: 10, autoSelect: true } },
  { identity: { id: "cursor", name: "Cursor" }, policy: { enabled: true, priority: 20, autoSelect: false } },
  { identity: { id: "fx", name: "fx" }, policy: { enabled: false, priority: 30, autoSelect: false } },
];
globalThis.fetch = async (input) => {
  const path = String(input);
  requests.push(path);
  const url = new URL(path, "http://test");
  if (url.pathname === "/api/harnesses/roster") {
    return new Response(JSON.stringify(roster), { status: 200 });
  }
  if (!url.searchParams.has("harnessId")) return new Response(JSON.stringify(
    url.searchParams.has("force") && forcedSnapshots ? await forcedSnapshots : cheapSnapshots,
  ), { status: 200 });
  const id = url.searchParams.get("harnessId")!;
  const data = await new Promise((resolve) => pending.set(id, resolve));
  return new Response(JSON.stringify(data), { status: 200 });
};
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  invalidateRuntimeCatalogs,
  peekHarnessSnapshots,
  preloadRuntimeCatalogs,
  readHarnessSnapshots,
  useRuntimeCatalog,
} = await import("../widgets/runtimeCatalog.ts");
const models: ModelDescriptor[] = [];
const agents: AgentDescriptor[] = [];
const snapshot = (harnessId: string, modelID: string, projectId = "p", spaceId = "space-a", cwd = `/${projectId}`) => [{
  identity: { id: harnessId, name: harnessId },
  availability: { state: "ready", installed: true, healthy: true, authenticated: true },
  catalog: { models: [{ harnessId, providerID: "native", modelID, name: modelID }] },
  context: { projectId, spaceId, cwd, revision: "1", fetchedAt: 1 },
}];

test("mounted draft A/B/A rejects stale publishes and reuses the pending catalog across remounts", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [];
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness({ harnessId, spaceId = "space-a", cwd = "/p" }: { harnessId: string; spaceId?: string; cwd?: string }) {
    catalog = useRuntimeCatalog(null, models, agents, { projectId: "p", harnessId, spaceId, cwd });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor" })); });
    assert.equal(catalog?.ready, false, "the route changes immediately while its catalog is still loading");
    assert.deepEqual(catalog?.discovery, { state: "pending" });
    assert.equal(requests.some((path) => path.includes("harnessId=cursor") && path.includes("detail=1")), true,
      "the selected route starts read-only catalog discovery");
    await act(async () => { root.render(createElement(Harness, { harnessId: "codex" })); });
    await act(async () => { pending.get("cursor")!(snapshot("cursor", "cursor-choice")); });
    assert.equal(catalog?.harnessId, "codex");
    assert.equal(catalog?.models.length, 0, "the slower previous route cannot replace Codex");
    await act(async () => { pending.get("codex")!(snapshot("codex", "luna")); });
    assert.equal(catalog?.models[0]?.modelID, "luna");
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor" })); });
    assert.equal(catalog?.models[0]?.modelID, "cursor-choice");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 1);
    assert.equal(requests.every((path) => path.includes("/api/harnesses/snapshots")
      || path.includes("/api/harnesses/roster")), true,
      "catalog preview must not commit a session route");
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor" })); });
    assert.equal(catalog?.models[0]?.modelID, "cursor-choice");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 1, "remount is warm");
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor", spaceId: "space-b" })); });
    assert.equal(catalog?.models.length, 0, "another Space never sees the cached catalog");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 2);
    await act(async () => { pending.get("cursor")!(snapshot("cursor", "space-b-choice", "p", "space-b")); });
    assert.equal(catalog?.models[0]?.modelID, "space-b-choice");
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor", spaceId: "space-b", cwd: "/p-renamed" })); });
    assert.equal(catalog?.models.length, 0, "a changed cwd never reuses the prior project-path catalog");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 3);
    await act(async () => { pending.get("cursor")!(snapshot("cursor", "renamed-choice", "p", "space-b", "/p-renamed")); });
    assert.equal(catalog?.models[0]?.modelID, "renamed-choice");
    await act(async () => { invalidateRuntimeCatalogs(); });
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 4, "auth/settings invalidation rediscovers");
    await act(async () => {
      pending.get("cursor")!([{
        identity: { id: "cursor", name: "Cursor" },
        availability: { state: "auth-required" },
        message: "Sign in again",
        context: { projectId: "p", spaceId: "space-b", cwd: "/p-renamed", revision: "2", fetchedAt: 2 },
      }]);
    });
    assert.equal(catalog?.models.length, 0);
    assert.deepEqual(catalog?.discovery, { state: "unavailable", reason: "Sign in again" });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("shell bootstrap preloads enabled catalogs, scopes returned data, and keeps it warm", async (t) => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [];
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness({ models, harnessId = "codex" }: { models: ModelDescriptor[]; harnessId?: string }) {
    catalog = useRuntimeCatalog(null, models, [], { projectId: "warm", harnessId, cwd: "/warm" });
    return null;
  }
  const warming = preloadRuntimeCatalogs();
  for (let attempt = 0; attempt < 20 && (!pending.has("codex") || !pending.has("cursor")); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(requests.some((path) => path.includes("harnessId=codex") && path.includes("detail=1")), true);
  assert.equal(requests.some((path) => path.includes("harnessId=cursor") && path.includes("detail=1")), true,
    "alternate model metadata warms before the picker is mounted");
  assert.equal(requests.some((path) => path.includes("projectId=")), false,
    "bootstrap discovery starts before project restoration");
  assert.equal(requests.some((path) => path.includes("harnessId=fx")), false,
    "disabled harnesses do not consume discovery resources");
  pending.get("codex")!(snapshot("codex", "luna", "warm"));
  pending.get("cursor")!(snapshot("cursor", "cursor-a", "warm"));
  await warming;
  const requestCountAfterWarm = requests.length;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness, { models: [] })); });
    assert.equal(catalog?.models[0]?.modelID, "luna", "the returned project/Space scope is reusable immediately");
    const cursorRequests = () => requests.filter((path) => path.includes("harnessId=cursor")).length;
    assert.equal(cursorRequests(), 1);
    await act(async () => { root.render(createElement(Harness, { models: [], harnessId: "cursor" })); });
    assert.equal(catalog?.harnessId, "cursor");
    assert.equal(catalog?.models[0]?.modelID, "cursor-a", "the preloaded tab paints its models synchronously");
    assert.equal(catalog?.ready, true);
    assert.equal(cursorRequests(), 1);
    assert.equal(requests.length, requestCountAfterWarm, "mount and tab switch add no catalog requests");
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 24 * 60 * 60_000);
    await act(async () => { root.render(createElement(Harness, { models: [{ harnessId: "other", providerID: "p", modelID: "m", name: "changed" }], harnessId: "cursor" })); });
    assert.equal(catalog?.models[0]?.modelID, "cursor-a");
    assert.equal(cursorRequests(), 1, "the page-lifetime preview stays warm across rerenders and elapsed time");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    cheapSnapshots = [];
  }
});

test("an invalidated bootstrap flight cannot alias stale models into the restored context", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [];
  const staleWarm = preloadRuntimeCatalogs();
  for (let attempt = 0; attempt < 20 && (!pending.has("codex") || !pending.has("cursor")); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  invalidateRuntimeCatalogs();
  pending.get("codex")!(snapshot("codex", "stale", "restored"));
  pending.get("cursor")!(snapshot("cursor", "stale-cursor", "restored"));
  await staleWarm;

  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(null, models, agents, {
      projectId: "restored",
      harnessId: "codex",
      spaceId: "space-a",
      cwd: "/restored",
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(catalog?.models.length, 0);
    assert.deepEqual(catalog?.discovery, { state: "pending" });
    assert.equal(requests.filter((path) => path.includes("harnessId=codex")).length, 2,
      "the restored revision must perform a fresh discovery");
    await act(async () => { pending.get("codex")!(snapshot("codex", "fresh", "restored")); });
    assert.equal(catalog?.models[0]?.modelID, "fresh");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("forced cheap snapshots seed the new revision before subscribers can refill it", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [{ identity: { id: "cursor", name: "Cursor-v1" }, policy: { enabled: true }, availability: { state: "ready" } }];
  await readHarnessSnapshots({ projectId: "force" });
  cheapSnapshots = [{ identity: { id: "cursor", name: "Cursor-v2" }, policy: { enabled: true }, availability: { state: "ready" } }];
  let finish!: (value: unknown[]) => void;
  forcedSnapshots = new Promise((resolve) => { finish = resolve; });
  const refresh = readHarnessSnapshots({ projectId: "force", force: true });
  assert.equal(peekHarnessSnapshots({ projectId: "force" })?.[0]?.identity.name, "Cursor-v1",
    "subscribers must not refill caches before the server has invalidated its provider cache");
  finish(cheapSnapshots);
  const fresh = await refresh;
  forcedSnapshots = undefined;
  assert.equal(fresh[0]?.identity.name, "Cursor-v2");
  const count = requests.length;
  const cached = await readHarnessSnapshots({ projectId: "force" });
  assert.equal(cached[0]?.identity.name, "Cursor-v2");
  assert.equal(requests.length, count);
  cheapSnapshots = [];
});
