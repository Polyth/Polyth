import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";
import { memoryApi, type MemoryPolicy } from "../src/client.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

test("memory utility model is chosen in the shared picker and saved without granting consent", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // The utility model is chosen from the harness catalog in the shared
  // composer ModelPicker; it reads /api/harnesses/snapshots. The API transport
  // binds fetch when its module loads, so stub it before the import.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!/\/api\/harnesses\/snapshots\?/.test(url)) return originalFetch(input);
    return new Response(JSON.stringify([{
      identity: { id: "local-harness", name: "Local", integration: "test" },
      catalog: { models: [{ providerID: "local", modelID: "small", name: "Small" }] },
    }]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: MemorySettings } = await import("../widgets/MemorySettings.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const originalApi = { ...memoryApi };
  let policy: MemoryPolicy = {
    mode: "auto", generation: "g1", settingsRevision: "1", updatedAt: 0,
    contextBudget: { maxRecords: 6, maxBytes: 6144 }, harvesting: "paused",
    utilityAllowlist: [], utilityStatus: "disabled", utilityModelAllowed: false, consentRequired: true,
    utilityBudget: { maxCalls: 0, usedCalls: 0, reservedCalls: 0, remainingCalls: 0 },
    blockWithoutMemory: false, reviewPolicy: "low-risk-auto-active", exclusions: { sessions: [], sources: [], paths: [] },
  };
  const writes: unknown[] = [];
  memoryApi.list = async () => ({ items: [], total: 0, policy });
  memoryApi.policy = async () => policy;
  memoryApi.updatePolicy = async (_id, patch) => {
    writes.push(patch);
    const { utilityBudget, expectedSettingsRevision, ...updates } = patch;
    assert.equal(expectedSettingsRevision, policy.settingsRevision);
    policy = { ...policy, ...updates, utilityBudget: { ...policy.utilityBudget, ...utilityBudget }, settingsRevision: String(Number(policy.settingsRevision) + 1) };
    return policy;
  };
  try {
    await act(async () => root.render(createElement(MemorySettings, {
      projectId: "project-a", project: { id: "project-a", name: "Test project" } as Project,
      mobile: false, onBack() {}, onClose() {},
    })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.ok(!container.querySelector('input[placeholder="exact provider id"]'), "no free-text model ids");
    const trigger = container.querySelector(".memory-model-picker .model-picker-trigger") as unknown as HTMLButtonElement | null;
    assert.ok(trigger, "the utility model uses the shared model picker");
    assert.equal(writes.length, 0);
    await act(async () => { trigger!.click(); });
    const row = ([...dom.document.body.querySelectorAll(".model-picker-row")] as unknown as HTMLElement[])
      .find((item) => item.textContent?.includes("Small"));
    assert.ok(row, "the catalog model is offered");
    await act(async () => { row!.click(); });
    assert.deepEqual(writes, [{
      utilityModel: { providerID: "local", modelID: "small" }, utilityAllowlist: [{ providerID: "local", modelID: "small" }],
      utilityModelAllowed: false, consentRequired: true, expectedSettingsRevision: "1",
    }]);
    assert.equal(policy.utilityModelAllowed, false, "choosing a model never grants consent");
    const review = [...container.querySelectorAll("label")].find((item) => item.textContent?.startsWith("Harvest review"))!.querySelector("select")!;
    await act(async () => { review.value = "manual"; review.dispatchEvent(new dom.Event("change", { bubbles: true })); });
    assert.equal(policy.reviewPolicy, "manual");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    Object.assign(memoryApi, originalApi);
    await dom.happyDOM.close();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
