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
globalThis.fetch = async (input) => {
  const path = String(input);
  requests.push(path);
  const url = new URL(path, "http://test");
  if (!url.searchParams.has("harnessId")) return new Response(JSON.stringify(
    url.searchParams.has("force") && forcedSnapshots ? await forcedSnapshots : cheapSnapshots,
  ), { status: 200 });
  const id = url.searchParams.get("harnessId")!;
  const data = await new Promise((resolve) => pending.set(id, resolve));
  return new Response(JSON.stringify(data), { status: 200 });
};
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { invalidateRuntimeCatalogs, peekHarnessSnapshots, readHarnessSnapshots, useRuntimeCatalog } = await import("../widgets/runtimeCatalog.ts");
const models: ModelDescriptor[] = [];
const agents: AgentDescriptor[] = [];
const snapshot = (harnessId: string, modelID: string) => [{
  identity: { id: harnessId, name: harnessId },
  availability: { state: "ready", installed: true, healthy: true, authenticated: true },
  catalog: { models: [{ harnessId, providerID: "native", modelID, name: modelID }] },
}];

test("mounted draft A/B/A rejects stale publishes and reuses the pending catalog across remounts", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [];
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness({ harnessId, spaceId = "space-a" }: { harnessId: string; spaceId?: string }) {
    catalog = useRuntimeCatalog(null, models, agents, { projectId: "p", harnessId, spaceId });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor" })); });
    assert.equal(catalog?.ready, true, "a staged route is immediately usable with its native default");
    await act(async () => { root.render(createElement(Harness, { harnessId: "codex" })); });
    await act(async () => { pending.get("cursor")!(snapshot("cursor", "cursor-choice")); });
    assert.equal(catalog?.harnessId, "codex");
    assert.equal(catalog?.models.length, 0, "the slower previous route cannot replace Codex");
    await act(async () => { pending.get("codex")!(snapshot("codex", "luna")); });
    assert.equal(catalog?.models[0]?.modelID, "luna");
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor" })); });
    assert.equal(catalog?.models[0]?.modelID, "cursor-choice");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 1);
    assert.equal(requests.some((path) => path.includes("detail=1")), false,
      "picker previews must never start detailed native discovery");
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor" })); });
    assert.equal(catalog?.models[0]?.modelID, "cursor-choice");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 1, "remount is warm");
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor", spaceId: "space-b" })); });
    assert.equal(catalog?.models.length, 0, "another Space never sees the cached catalog");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 2);
    await act(async () => { pending.get("cursor")!(snapshot("cursor", "space-b-choice")); });
    assert.equal(catalog?.models[0]?.modelID, "space-b-choice");
    await act(async () => { invalidateRuntimeCatalogs(); });
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 3, "auth/settings invalidation rediscovers");
    await act(async () => {
      pending.get("cursor")!([{ identity: { id: "cursor", name: "Cursor" }, availability: { state: "auth-required" }, message: "Sign in again" }]);
    });
    assert.equal(catalog?.models.length, 0);
    assert.deepEqual(catalog?.discovery, { state: "unavailable", reason: "Sign in again" });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("preview catalogs load only the selected summary and stay warm without native detail discovery", async (t) => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [];
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness({ models, harnessId = "codex" }: { models: ModelDescriptor[]; harnessId?: string }) {
    catalog = useRuntimeCatalog(null, models, [], { projectId: "warm", harnessId });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness, { models: [] })); });
    assert.equal(requests.some((path) => path.includes("harnessId=codex")), true);
    assert.equal(requests.some((path) => path.includes("harnessId=cursor")), false,
      "an alternate harness must not be speculatively connected or discovered");
    assert.equal(requests.some((path) => path.includes("detail=1")), false);
    await act(async () => { pending.get("codex")!([{ identity: { id: "codex", name: "Codex" }, availability: { state: "ready" }, catalog: { models: [] } }]); });
    assert.equal(catalog?.ready, true, "Codex is usable while Cursor is still loading");
    const cursorRequests = () => requests.filter((path) => path.includes("harnessId=cursor")).length;
    assert.equal(cursorRequests(), 0);
    await act(async () => { root.render(createElement(Harness, { models: [], harnessId: "cursor" })); });
    assert.equal(catalog?.ready, true, "the tab changes synchronously before its summary arrives");
    assert.equal(cursorRequests(), 1);
    await act(async () => { pending.get("cursor")!(snapshot("cursor", "cursor-a")); });
    assert.equal(catalog?.models[0]?.modelID, "cursor-a");
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
