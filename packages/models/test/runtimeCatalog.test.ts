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
globalThis.fetch = async (input) => {
  const path = String(input);
  requests.push(path);
  const url = new URL(path, "http://test");
  if (!url.searchParams.has("harnessId")) return new Response("[]", { status: 200 });
  const id = url.searchParams.get("harnessId")!;
  const data = await new Promise((resolve) => pending.set(id, resolve));
  return new Response(JSON.stringify(data), { status: 200 });
};
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { invalidateRuntimeCatalogs, useRuntimeCatalog } = await import("../widgets/runtimeCatalog.ts");
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
    assert.equal(catalog?.ready, false);
    await act(async () => { root.render(createElement(Harness, { harnessId: "codex" })); });
    await act(async () => { pending.get("cursor")!(snapshot("cursor", "cursor-choice")); });
    assert.equal(catalog?.harnessId, "codex");
    assert.equal(catalog?.models.length, 0, "the slower previous route cannot replace Codex");
    await act(async () => { pending.get("codex")!(snapshot("codex", "luna")); });
    assert.equal(catalog?.models[0]?.modelID, "luna");
    await act(async () => { root.render(createElement(Harness, { harnessId: "cursor" })); });
    assert.equal(catalog?.models[0]?.modelID, "cursor-choice");
    assert.equal(requests.filter((path) => path.includes("harnessId=cursor")).length, 1);
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
