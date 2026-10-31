import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { AgentDescriptor, ModelDescriptor, SessionProjection } from "@polyth/contracts";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const requests: string[] = [];
const pending = new Map<string, (value: unknown) => void>();
let cheapSnapshots: unknown[] = [];
let forcedSnapshots: Promise<unknown[]> | undefined;
const failingHarnesses = new Set<string>();
// Harnesses the server hides from this caller (account limits, allowlists).
const hiddenHarnesses = new Set<string>();
// Live session routes answer from here; tests replace the body per session.
const liveCatalogs = new Map<string, unknown>();
const roster = [
  { identity: { id: "codex", name: "Codex", color: "#3f7de8" }, policy: { enabled: true, priority: 10, autoSelect: true } },
  { identity: { id: "cursor", name: "Cursor", accountLabel: "work" }, policy: { enabled: true, priority: 20, autoSelect: false } },
  { identity: { id: "fx", name: "fx" }, policy: { enabled: false, priority: 30, autoSelect: false } },
];
globalThis.fetch = async (input) => {
  const path = String(input);
  requests.push(path);
  const url = new URL(path, "http://test");
  if (url.pathname === "/api/harnesses/roster") {
    return new Response(JSON.stringify(roster), { status: 200 });
  }
  if (url.pathname === "/api/runtime-catalog") {
    const sessionId = url.searchParams.get("sessionId")!;
    return new Response(JSON.stringify(liveCatalogs.get(sessionId) ?? {
      models: [],
      agents: [],
      nativeDefault: true,
      ready: true,
      discovery: { state: "empty", code: "runtime-empty" },
    }), { status: 200 });
  }
  if (!url.searchParams.has("harnessId")) return new Response(JSON.stringify(
    url.searchParams.has("force") && forcedSnapshots ? await forcedSnapshots : cheapSnapshots,
  ), { status: 200 });
  const id = url.searchParams.get("harnessId")!;
  if (hiddenHarnesses.has(id)) return new Response(JSON.stringify({ error: "not-found", message: "harness not found" }), { status: 404 });
  if (failingHarnesses.has(id)) return new Response("upstream down", { status: 503 });
  const data = await new Promise((resolve) => pending.set(id, resolve));
  return new Response(JSON.stringify(data), { status: 200 });
};
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
// Seeded before the catalog module loads: a stored roster from a client that
// never recorded which harness packages produced it.
const { accountStorageKey, activeBrowserAccountId } = await import("@polyth/web/account-storage");
const unprovenRosterKey = accountStorageKey("polyth.runtimeRosters.v1", activeBrowserAccountId());
localStorage.setItem(unprovenRosterKey, JSON.stringify(
  [[JSON.stringify([activeBrowserAccountId(), "page", "unproven"]), { value: roster, expiresAt: Date.now() + 60_000 }]],
));
const {
  composerRecoveryKind,
  invalidateRuntimeCatalogs,
  NO_ENGINE_REASON,
  peekHarnessSnapshots,
  preloadRuntimeCatalogs,
  readHarnessRoster,
  readHarnessSnapshots,
  reconcileHarnessTopology,
  resetRuntimeCatalogMemory,
  retryUnavailableRuntimeCatalogs,
  useHarnessColors,
  useRuntimeCatalog,
  useVisibleHarnessIds,
} = await import("../widgets/runtimeCatalog.ts");
const { harnessColor } = await import("../widgets/harnessColor.ts");
const models: ModelDescriptor[] = [];
const agents: AgentDescriptor[] = [];
const snapshot = (harnessId: string, modelID: string, projectId = "p", spaceId = "space-a", cwd = `/${projectId}`) => [{
  identity: { id: harnessId, name: harnessId },
  availability: { state: "ready", installed: true, healthy: true, authenticated: true },
  catalog: { models: [{ harnessId, providerID: "native", modelID, name: modelID }] },
  context: { projectId, spaceId, cwd, revision: "1", fetchedAt: 1 },
}];

test("stored metadata with no recorded harness topology is dropped before the shell can paint it", () => {
  assert.equal(localStorage.getItem(unprovenRosterKey), null);
});

test("first mount paints cached harness snapshots while detail discovery is still pending", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [];
  const warm = readHarnessSnapshots({ projectId: "p", harnessId: "cursor", spaceId: "space-a", cwd: "/p", detail: true });
  for (let attempt = 0; attempt < 20 && !pending.has("cursor"); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending.get("cursor")!(snapshot("cursor", "cached-choice", "p", "space-a", "/p"));
  await warm;
  requests.length = 0;
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(null, models, agents, { projectId: "p", harnessId: "cursor", spaceId: "space-a", cwd: "/p" });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(catalog?.models[0]?.modelID, "cached-choice");
    assert.deepEqual(catalog?.discovery, { state: "available" });
    assert.equal(
      requests.filter((path) => path.includes("harnessId=cursor") && path.includes("detail=1")).length,
      0,
      "a warm harness snapshot satisfies the route without another detail fetch",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("persisted unknown harness metadata paints without a second request", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [{
    identity: { id: "antigravity", name: "Antigravity" },
    availability: { state: "unknown", installed: true, healthy: true, authenticated: "unknown" },
    context: { projectId: "unknown-cache", spaceId: "space-a", cwd: "/unknown-cache", revision: "1", fetchedAt: 1 },
  }];
  await readHarnessSnapshots({ projectId: "unknown-cache", detail: true });
  resetRuntimeCatalogMemory(false);
  requests.length = 0;
  const rows = await readHarnessSnapshots({ projectId: "unknown-cache", detail: true });
  assert.equal(rows[0]?.identity.id, "antigravity");
  assert.equal(requests.length, 0, "unknown native auth metadata remains presentation-safe to reuse");
  cheapSnapshots = [];
});

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

test("restart paints persisted Auto models and executable harnesses before revalidation", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = snapshot("codex", "persisted-auto", "warm");
  const warming = preloadRuntimeCatalogs();
  for (let attempt = 0; attempt < 20 && (!pending.has("codex") || !pending.has("cursor")); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending.get("codex")!(snapshot("codex", "persisted-auto", "warm"));
  pending.get("cursor")!(snapshot("cursor", "persisted-cursor", "warm"));
  await warming;
  await readHarnessSnapshots({ projectId: "warm", spaceId: "space-a" });
  const requestsBeforeRestart = requests.length;
  resetRuntimeCatalogMemory(false);
  await preloadRuntimeCatalogs();
  assert.equal(requests.length, requestsBeforeRestart,
    "a page restart reuses the fresh daily catalog instead of probing harnesses again");
  await readHarnessRoster({ projectId: "warm", spaceId: "space-a" });
  await readHarnessSnapshots({ projectId: "warm", spaceId: "space-a" });
  await readHarnessRoster({ projectId: "warm" });
  await readHarnessSnapshots({ projectId: "warm" });
  assert.equal(requests.length, requestsBeforeRestart,
    "picker and harness settings reuse the scoped roster and availability snapshot");

  assert.equal(peekHarnessSnapshots({ projectId: "warm", spaceId: "space-a" })?.[0]?.identity.id, "codex",
    "last-known executable harnesses survive the in-memory restart boundary");
  const paints: string[] = [];
  function Harness() {
    const catalog = useRuntimeCatalog(null, models, agents, {
      projectId: "warm",
      spaceId: "space-a",
      cwd: "/warm",
    });
    paints.push(catalog.models[0]?.modelID ?? "empty");
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(paints[0], "persisted-auto", "the first post-restart paint does not wait for discovery");
    assert.equal(requests.length, requestsBeforeRestart,
      "mounting the picker route after reload does not revalidate a fresh persisted catalog");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    cheapSnapshots = [];
  }
});

test("a failed shell preload is evicted so restored context can discover models", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  cheapSnapshots = [];
  const warming = preloadRuntimeCatalogs();
  for (let attempt = 0; attempt < 20 && (!pending.has("codex") || !pending.has("cursor")); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending.get("codex")!([{
    identity: { id: "codex", name: "Codex" },
    availability: { state: "degraded" },
    message: "Previous executor has no verified release receipt",
    context: { projectId: "restored", spaceId: "space-a", cwd: "/restored", revision: "1", fetchedAt: 1 },
  }]);
  pending.get("cursor")!(snapshot("cursor", "cursor-a", "restored"));
  await warming;

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
    assert.deepEqual(catalog?.discovery, { state: "pending" });
    assert.equal(requests.filter((path) => path.includes("harnessId=codex")).length, 2,
      "the failed bootstrap value must not poison the page cache");
    await act(async () => { pending.get("codex")!(snapshot("codex", "recovered", "restored")); });
    assert.equal(catalog?.models[0]?.modelID, "recovered");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a failed route catalog is asked again on retry and on return to the foreground", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  failingHarnesses.add("lossy");
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(null, models, agents, { projectId: "lossy", harnessId: "lossy", spaceId: "space-a", cwd: "/lossy" });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const lossyRequests = () => requests.filter((path) => path.includes("harnessId=lossy")).length;
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    assert.equal(catalog?.discovery.state, "unavailable");
    assert.equal(lossyRequests(), 1);

    // Still failing: an explicit retry asks once more and stays honest.
    await act(async () => { retryUnavailableRuntimeCatalogs(); await settle(); });
    assert.equal(lossyRequests(), 2);
    assert.equal(catalog?.discovery.state, "unavailable");

    // Returning to the foreground asks again; the healed engine is shown.
    failingHarnesses.delete("lossy");
    await act(async () => { document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event); await settle(); });
    assert.equal(lossyRequests(), 3);
    await act(async () => { pending.get("lossy")!(snapshot("lossy", "back", "lossy")); await settle(); });
    assert.equal(catalog?.models[0]?.modelID, "back");

    // A healthy route is not re-requested by later retry signals.
    await act(async () => { retryUnavailableRuntimeCatalogs(); await settle(); });
    assert.equal(lossyRequests(), 3);
  } finally {
    failingHarnesses.clear();
    await act(async () => { root.unmount(); });
    container.remove();
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

test("a harness package installed between page loads drops the persisted roster", async () => {
  invalidateRuntimeCatalogs();
  const scope = { projectId: "topology", spaceId: "space-a" };
  const before = JSON.stringify([["backend-codex", true]]);
  const after = JSON.stringify([["backend-antigravity", true], ["backend-codex", true]]);
  reconcileHarnessTopology(before);
  requests.length = 0;
  await readHarnessRoster(scope);
  assert.equal(requests.length, 1);

  resetRuntimeCatalogMemory(false);
  reconcileHarnessTopology(before);
  await readHarnessRoster(scope);
  assert.equal(requests.length, 1, "an unchanged harness topology keeps the day-long roster");

  resetRuntimeCatalogMemory(false);
  reconcileHarnessTopology(after);
  await readHarnessRoster(scope);
  assert.equal(requests.length, 2, "a harness added while the client was away must force a fresh roster");
});

test("a route with no ready engine offers Manage harnesses, never Reconnect", () => {
  assert.equal(
    composerRecoveryKind({ state: "unavailable", reason: NO_ENGINE_REASON, code: "no-engine" }),
    "manage-harnesses",
  );
  // An authoritative account filter is also fixed in Harness Settings, not by
  // reconnecting to the same empty answer.
  assert.equal(composerRecoveryKind({ state: "empty", code: "models-hidden" }), "manage-harnesses");
  // Every other named failure has a retry that can actually succeed.
  assert.equal(composerRecoveryKind({ state: "unavailable", reason: "Can't reach Polyth. Retrying…" }), "reconnect");
  assert.equal(composerRecoveryKind({ state: "unavailable", reason: "Cursor is not installed" }), "reconnect");
  assert.equal(composerRecoveryKind({ state: "empty", code: "runtime-empty" }), "reconnect");
  assert.equal(composerRecoveryKind({ state: "empty" }), "reconnect");
  assert.equal(composerRecoveryKind(undefined), "reconnect");
});

test("an empty route catalog reaches the composer with the structured no-engine cause", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  failingHarnesses.clear();
  cheapSnapshots = [];
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(null, models, agents, {
      projectId: "no-engine",
      spaceId: "space-a",
      cwd: "/no-engine",
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    assert.equal(catalog?.discovery.state, "unavailable");
    // The preview read rejects before caching; the structured cause must
    // survive the rejection so the composer does not depend on English copy.
    assert.equal(catalog?.discovery.code, "no-engine");
    assert.equal(catalog?.discovery.reason, NO_ENGINE_REASON);
    assert.equal(composerRecoveryKind(catalog?.discovery), "manage-harnesses");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a transport-unavailable route still carries no code and keeps Reconnect", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  failingHarnesses.add("down");
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(null, models, agents, {
      projectId: "down",
      harnessId: "down",
      spaceId: "space-a",
      cwd: "/down",
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    assert.equal(catalog?.discovery.state, "unavailable");
    assert.equal(catalog?.discovery.code, undefined);
    assert.equal(composerRecoveryKind(catalog?.discovery), "reconnect");
  } finally {
    failingHarnesses.clear();
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a pinned route the server hides from this caller quietly shows the first available harness", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  hiddenHarnesses.add("hidden");
  cheapSnapshots = snapshot("codex", "first-available", "limited", "space-a", "/limited");
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(null, models, agents, {
      projectId: "limited",
      harnessId: "hidden",
      spaceId: "space-a",
      cwd: "/limited",
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    // No error, no Reconnect: the first harness the server offers, with its models.
    assert.equal(catalog?.discovery.state, "available");
    assert.equal(catalog?.harnessId, "codex");
    assert.deepEqual(catalog?.models.map((model) => model.modelID), ["first-available"]);
    // One stale-roster recovery, not an invalidation loop.
    const asked = requests.filter((path) => path.includes("harnessId=hidden")).length;
    assert.ok(asked >= 1 && asked <= 2, `asked ${asked} times`);
  } finally {
    hiddenHarnesses.clear();
    cheapSnapshots = [];
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("visible harness ids follow the caller's server roster", async () => {
  invalidateRuntimeCatalogs();
  let ids: ReadonlySet<string> | undefined;
  function Harness() {
    ids = useVisibleHarnessIds("roster-project", "space-a");
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Harness));
      for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.deepEqual([...ids ?? []].sort(), ["codex", "cursor", "fx"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("harness colors follow the roster: a Space color, else the account's own, else none", async () => {
  invalidateRuntimeCatalogs();
  let colors: ReadonlyMap<string, string> | undefined;
  function Harness() {
    colors = useHarnessColors("roster-project", "space-a");
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Harness));
      for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(Object.fromEntries(colors ?? []), {
      codex: "#3f7de8",
      cursor: harnessColor({ accountLabel: "work" }),
    });
    assert.ok(colors?.get("cursor"), "an extra login gets its own color");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a live empty catalog keeps the last known models and a retry can recover it", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  const warm = readHarnessSnapshots({
    projectId: "live-warm",
    harnessId: "pi",
    spaceId: "space-a",
    cwd: "/live-warm",
    detail: true,
  });
  for (let attempt = 0; attempt < 20 && !pending.has("pi"); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending.get("pi")!(snapshot("pi", "warm-model", "live-warm", "space-a", "/live-warm"));
  await warm;
  liveCatalogs.set("session-live", {
    models: [],
    agents: [],
    nativeDefault: true,
    ready: true,
    discovery: { state: "empty", code: "runtime-empty" },
  });
  const session = {
    id: "session-live",
    projectId: "live-warm",
    spaceId: "space-a",
    resolvedHarnessId: "pi",
    status: "working",
    runtimeLeg: { id: "leg-1" },
  } as SessionProjection;
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(session, [], [], {
      projectId: "live-warm",
      spaceId: "space-a",
      cwd: "/live-warm",
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const liveRequests = () => requests.filter((path) => path.includes("/api/runtime-catalog")).length;
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    assert.equal(catalog?.models[0]?.modelID, "warm-model",
      "a transient runtime-empty answer must not erase the last known catalog");
    assert.deepEqual(catalog?.discovery, { state: "available" });
    assert.equal(liveRequests(), 1);

    liveCatalogs.set("session-live", {
      models: [{ harnessId: "pi", providerID: "native", modelID: "fresh-model", name: "Fresh" }],
      agents: [],
      nativeDefault: false,
      ready: true,
      discovery: { state: "available" },
    });
    await act(async () => { retryUnavailableRuntimeCatalogs(); await settle(); });
    assert.equal(liveRequests(), 2, "Reconnect bypasses the cached empty answer");
    assert.equal(catalog?.models[0]?.modelID, "fresh-model");
    assert.deepEqual(catalog?.discovery, { state: "available" });
  } finally {
    liveCatalogs.delete("session-live");
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("an authoritative empty catalog shows its real cause instead of stale models", async () => {
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  const warm = readHarnessSnapshots({
    projectId: "hidden-models",
    harnessId: "opencode",
    spaceId: "space-a",
    cwd: "/hidden-models",
    detail: true,
  });
  for (let attempt = 0; attempt < 20 && !pending.has("opencode"); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending.get("opencode")!(snapshot("opencode", "warm-model", "hidden-models", "space-a", "/hidden-models"));
  await warm;
  liveCatalogs.set("session-hidden", {
    models: [],
    agents: [],
    nativeDefault: false,
    ready: true,
    discovery: { state: "empty", code: "models-hidden" },
  });
  const session = {
    id: "session-hidden",
    projectId: "hidden-models",
    spaceId: "space-a",
    resolvedHarnessId: "opencode",
    status: "idle",
    runtimeLeg: { id: "leg-2" },
  } as SessionProjection;
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(session, [], [], {
      projectId: "hidden-models",
      spaceId: "space-a",
      cwd: "/hidden-models",
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    assert.equal(catalog?.models.length, 0,
      "models filtered out for this account must not be resurrected from a warm catalog");
    assert.deepEqual(catalog?.discovery, { state: "empty", code: "models-hidden" });
  } finally {
    liveCatalogs.delete("session-hidden");
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a transient live-empty answer retries on its own timer and recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  const warm = readHarnessSnapshots({
    projectId: "timer-warm",
    harnessId: "pi",
    spaceId: "space-a",
    cwd: "/timer-warm",
    detail: true,
  });
  for (let attempt = 0; attempt < 20 && !pending.has("pi"); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  pending.get("pi")!(snapshot("pi", "warm-model", "timer-warm", "space-a", "/timer-warm"));
  await warm;
  liveCatalogs.set("session-timer", {
    models: [],
    agents: [],
    nativeDefault: true,
    ready: true,
    discovery: { state: "empty", code: "runtime-empty" },
  });
  const session = {
    id: "session-timer",
    projectId: "timer-warm",
    spaceId: "space-a",
    resolvedHarnessId: "pi",
    status: "working",
    runtimeLeg: { id: "leg-timer" },
  } as SessionProjection;
  let catalog: ReturnType<typeof useRuntimeCatalog> | undefined;
  function Harness() {
    catalog = useRuntimeCatalog(session, [], [], {
      projectId: "timer-warm",
      spaceId: "space-a",
      cwd: "/timer-warm",
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const liveRequests = () => requests.filter((path) => path.includes("/api/runtime-catalog")).length;
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    assert.equal(catalog?.models[0]?.modelID, "warm-model");
    assert.equal(liveRequests(), 1, "the first live request answers empty");

    liveCatalogs.set("session-timer", {
      models: [{ harnessId: "pi", providerID: "native", modelID: "timer-fresh", name: "Fresh" }],
      agents: [],
      nativeDefault: false,
      ready: true,
      discovery: { state: "available" },
    });
    // No user action: the first bounded retry (1.2 s) asks the server again.
    await act(async () => { t.mock.timers.tick(1_200); await settle(); });
    assert.equal(liveRequests(), 2, "the scheduled empty retry bypasses the cached empty answer");
    assert.equal(catalog?.models[0]?.modelID, "timer-fresh");
    assert.deepEqual(catalog?.discovery, { state: "available" });

    // Recovery stops the sequence; no later timer asks again.
    await act(async () => { t.mock.timers.tick(120_000); await settle(); });
    assert.equal(liveRequests(), 2, "a recovered catalog stops the empty retry sequence");
  } finally {
    liveCatalogs.delete("session-timer");
    await act(async () => { root.unmount(); });
    container.remove();
    t.mock.timers.reset();
  }
});

test("a persistently empty live catalog retries four times and then stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  invalidateRuntimeCatalogs();
  requests.length = 0;
  pending.clear();
  liveCatalogs.set("session-exhaust", {
    models: [],
    agents: [],
    nativeDefault: true,
    ready: true,
    discovery: { state: "empty", code: "runtime-empty" },
  });
  const session = {
    id: "session-exhaust",
    projectId: "exhaust",
    spaceId: "space-a",
    resolvedHarnessId: "pi",
    status: "working",
    runtimeLeg: { id: "leg-exhaust" },
  } as SessionProjection;
  function Harness() {
    useRuntimeCatalog(session, [], [], { projectId: "exhaust", spaceId: "space-a", cwd: "/exhaust" });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const liveRequests = () => requests.filter((path) => path.includes("/api/runtime-catalog")).length;
  try {
    await act(async () => { root.render(createElement(Harness)); await settle(); });
    assert.equal(liveRequests(), 1);
    for (const delay of [1_200, 3_000, 7_000, 15_000]) {
      await act(async () => { t.mock.timers.tick(delay); await settle(); });
    }
    assert.equal(liveRequests(), 5, "the initial request plus exactly four bounded retries");
    await act(async () => { t.mock.timers.tick(120_000); await settle(); });
    assert.equal(liveRequests(), 5, "after the fourth empty answer no new timer is armed");
  } finally {
    liveCatalogs.delete("session-exhaust");
    await act(async () => { root.unmount(); });
    container.remove();
    t.mock.timers.reset();
  }
});
