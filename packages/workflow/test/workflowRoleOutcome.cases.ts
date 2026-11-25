import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import type { WorkflowDto, WorkflowRunDto } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
// Every request these cases make is stubbed on `api`; an unstubbed one (such
// as workflow preferences) must fail at once. Node's fetch rejects a relative
// URL with a TypeError, which the shared read retry takes for a dropped
// connection and retries for seconds — reject with a plain error instead.
globalThis.fetch = async (input: RequestInfo | URL) => {
  throw new Error(`unstubbed request in workflow launcher cases: ${String(input)}`);
};
(globalThis as typeof globalThis & { requestAnimationFrame: typeof requestAnimationFrame; cancelAnimationFrame: typeof cancelAnimationFrame }).requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window) as unknown as typeof requestAnimationFrame;
(globalThis as typeof globalThis & { requestAnimationFrame: typeof requestAnimationFrame; cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window) as unknown as typeof cancelAnimationFrame;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { activateProject, activateSession } = await import("../../../apps/web/src/store.ts");
const { default: WorkflowView } = await import("../widgets/WorkflowView.tsx");
const { default: WorkflowTimelineCard } = await import("../widgets/WorkflowTimelineCard.tsx");
const { workflowOutcomeApi } = await import("../widgets/workflowOutcome.ts");

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const openWorkflow = async (container: ParentNode, name: string, tab?: "edit") => {
  const card = container.querySelector<HTMLButtonElement>(`.workflow-card-main[aria-label="Open ${name}"]`);
  assert.ok(card, `the library lists ${name}`);
  await act(async () => { card.click(); await tick(); });
  if (tab) await act(async () => { container.querySelector<HTMLButtonElement>("#workflow-detail-tab-edit")?.click(); await tick(); });
};
const buttonByText = (container: ParentNode, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);

const workflow: WorkflowDto = {
  id: "release", projectId: "project", name: "Release review", revision: 1,
  nodes: [{ id: "build", role: "Builder", prompt: "Build it" }],
  edges: [], defaults: { permissions: "manual" }, createdAt: 1, updatedAt: 1,
};
const baseRun: WorkflowRunDto = {
  id: "run-1", workflowId: workflow.id, projectId: "project", parentSessionId: "parent",
  name: workflow.name, input: "Ship it",
  options: { pipe: "direct", permissions: "manual", maxParallel: 2, nodeTimeoutMs: 60_000, reviewRounds: 2 },
  status: "done", startedAt: 1, finishedAt: 2, layers: [["build"]], result: "Shipped.",
  nodes: [{ id: "build", role: "Builder", status: "done", sessionId: "child", output: "Shipped." }],
};

function stubApi(saved: WorkflowDto[], runs: WorkflowRunDto[], writes: Array<Parameters<typeof api.updateWorkflow>[1]>) {
  const original = { listWorkflows: api.listWorkflows, listWorkflowRuns: api.listWorkflowRuns,
    getWorkflowPreferences: api.getWorkflowPreferences, updateWorkflow: api.updateWorkflow,
    harnessSnapshots: api.harnessSnapshots };
  api.listWorkflows = async () => saved;
  api.listWorkflowRuns = async () => runs;
  api.getWorkflowPreferences = async () => ({ selectedId: saved[0]?.id, pinnedIds: [], recentIds: [] });
  api.harnessSnapshots = async () => [];
  api.updateWorkflow = async (_id, patch) => {
    writes.push(patch);
    return { ...saved[0]!, ...patch, revision: 1 + writes.length } as WorkflowDto;
  };
  return { restore: () => { Object.assign(api, original); activateSession(null); } };
}

const writesOf = (): Array<Parameters<typeof api.updateWorkflow>[1]> => [];
async function mount(run: (container: HTMLElement) => Promise<void>, saved: WorkflowDto[], runs: WorkflowRunDto[], writes = writesOf()) {
  const { restore } = stubApi(saved, runs, writes);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await run(container);
  } finally {
    await act(async () => { root.unmount(); });
    restore();
    container.remove();
  }
  return writes;
}

const pickRole = async (container: HTMLElement, label: string) => {
  const trigger = container.querySelector<HTMLButtonElement>(".workflow-route-role button[aria-haspopup]");
  assert.ok(trigger, "the unit editor offers Model by role");
  await act(async () => { trigger.click(); await tick(); });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((item) => item.textContent?.includes(label));
  assert.ok(option, `the role list offers ${label}`);
  await act(async () => { option.click(); await tick(); });
};
const flushSave = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 760)); });

test("Model by role writes routingRole, keeps the fallback route visible, and Off removes the key", async () => {
  const saved: WorkflowDto = { ...workflow, nodes: [{ ...workflow.nodes[0]!, model: { providerID: "p", modelID: "fallback-model" } }] };
  const writes = writesOf();
  await mount(async (container) => {
    await openWorkflow(container, workflow.name, "edit");
    assert.equal(container.querySelector(".workflow-route-fallback") === null, true, "no caption while the role is Off");
    await pickRole(container, "Implement");
    await flushSave();
    assert.equal(writes_last(writes)?.routingRole, "implement");
    assert.equal(container.querySelector(".workflow-route-fallback") !== null, true, "the fallback caption appears");
    assert.equal(container.querySelectorAll(".workflow-route-controls").length, 1, "harness and model controls stay visible");
    assert.equal(writes_last(writes)?.model?.modelID, "fallback-model", "the pinned route stays as the fallback");
    await pickRole(container, "Off");
    await flushSave();
    const last = writes_last(writes);
    assert.equal(last !== undefined && "routingRole" in last, false, "Off removes the key from the saved unit");
    assert.equal(JSON.stringify(last).includes("routingRole"), false);
    assert.equal(container.querySelector(".workflow-route-fallback") === null, true);
  }, [saved], [], writes);
  assert.ok(writes.length >= 2);
});
function writes_last(writes: Array<Parameters<typeof api.updateWorkflow>[1]>) {
  return writes.at(-1)?.nodes?.[0] as (WorkflowDto["nodes"][number] | undefined);
}

test("an unknown routing id stays selectable and unit routes read as By role / role → route", async () => {
  const saved: WorkflowDto = { ...workflow, nodes: [
    { id: "build", role: "Builder", prompt: "x", routingRole: "implement" },
    { id: "odd", role: "Odd", prompt: "y", routingRole: "custom-docs", model: { providerID: "p", modelID: "m1" } },
  ], edges: [] };
  await mount(async (container) => {
    await openWorkflow(container, workflow.name, "edit");
    const texts = [...container.querySelectorAll(".workflow-canvas-node small")].map((item) => item.textContent?.trim());
    assert.equal(texts.includes("By role: Implement"), true, "a role without a pinned route is just the role");
    assert.equal(texts.includes("By role: custom-docs · Project harness · m1"), true, "an unknown id reads as it is, then the fallback");
    const odd = [...container.querySelectorAll<HTMLButtonElement>(".workflow-canvas-node")].find((n) => n.textContent?.includes("Odd"));
    assert.ok(odd);
    await act(async () => { odd.click(); await tick(); });
    const trigger = container.querySelector<HTMLButtonElement>(".workflow-route-role button[aria-haspopup]");
    assert.equal(trigger?.textContent?.includes("custom-docs"), true, "the select shows the unknown id");
  }, [saved], []);
});

async function mountCard(run: WorkflowRunDto, check: (container: HTMLElement) => Promise<void>) {
  const original = { getWorkflowRun: api.getWorkflowRun };
  api.getWorkflowRun = async () => run;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); await settle(); });
    await check(container);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
}

test("a run unit that was routed names the role and what it ran on, in its card", async () => {
  const run: WorkflowRunDto = { ...baseRun, nodes: [{ ...baseRun.nodes[0]!, routedRole: "implement",
    harness: { mode: "pinned", harnessId: "opencode" }, model: { providerID: "p", modelID: "fast-1" } }] };
  await mountCard(run, async (container) => {
    // The card folds to its summary; the units open with it.
    await act(async () => { container.querySelector<HTMLButtonElement>(".workflow-timeline-toggle")?.click(); await tick(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".workflow-timeline-details-toggle")?.click(); await tick(); });
    const rows = [...container.querySelectorAll(".workflow-timeline-node-details p")].map((item) => item.textContent?.trim());
    assert.equal(rows.includes("By role: Implement → opencode · fast-1"), true);
  });
  // No role set (Auto routing, or a Space without the Orchestration package): no role text anywhere.
  await mountCard({ ...baseRun, id: "plain", nodes: [{ ...baseRun.nodes[0]!, harness: { mode: "pinned", harnessId: "opencode" }, model: { providerID: "p", modelID: "fast-1" } }] }, async (container) => {
    await act(async () => { container.querySelector<HTMLButtonElement>(".workflow-timeline-toggle")?.click(); await tick(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".workflow-timeline-details-toggle")?.click(); await tick(); });
    assert.equal((container.textContent ?? "").includes("By role"), false);
  });
});

test("a settled run's card asks how its result was used, records the choice, and shows it with Change", async () => {
  const calls: Array<{ id: string; value: string }> = [];
  const original = workflowOutcomeApi.record;
  workflowOutcomeApi.record = async (id, input) => {
    calls.push({ id, value: input.value });
    return { ...baseRun, outcome: { value: input.value, at: 5, by: "person" } };
  };
  try {
    await mountCard(baseRun, async (container) => {
      assert.equal(container.querySelector(".workflow-run-usage-text")?.textContent, "How was the result used?");
      for (const [label, tip] of [["Accepted", "Used as delivered"], ["Reworked", "Kept after more work"], ["Discarded", "Not used"]] as const) {
        assert.equal(buttonByText(container, label)?.title, tip);
      }
      await act(async () => { buttonByText(container, "Reworked")?.click(); await settle(); await settle(); });
      assert.deepEqual(calls, [{ id: "run-1", value: "reworked" }]);
      assert.equal(container.querySelector(".workflow-run-usage-text")?.textContent, "Result: Reworked · recorded by you");
      assert.equal(buttonByText(container, "Accepted") === undefined, true, "the choices fold away after a record");
      await act(async () => { buttonByText(container, "Change")?.click(); await tick(); });
      assert.equal(buttonByText(container, "Discarded") !== undefined, true, "Change brings the choices back");
    });
  } finally { workflowOutcomeApi.record = original; }
});

test("a recorded outcome by the agent reads with its note; a running run shows nothing; a failed POST says why", async () => {
  const recorded: WorkflowRunDto = { ...baseRun, outcome: { value: "accepted", note: "merged as is", at: 5, by: "agent" } };
  await mountCard(recorded, async (container) => {
    assert.equal(container.querySelector(".workflow-run-usage-text")?.textContent,
      "Result: Accepted · recorded by the agent · merged as is");
  });
  await mountCard({ ...baseRun, id: "run-live", status: "running", startedAt: 999, finishedAt: undefined }, async (container) => {
    assert.equal(container.querySelector(".workflow-run-usage") === null, true, "nothing while the run is running");
  });
  const original = workflowOutcomeApi.record;
  workflowOutcomeApi.record = async () => { throw new Error("conflict: someone else launched this run"); };
  try {
    await mountCard({ ...baseRun, id: "run-failed-post" }, async (container) => {
      await act(async () => { buttonByText(container, "Discarded")?.click(); await settle(); await settle(); });
      const alert = container.querySelector(".workflow-run-usage [role=\"alert\"]");
      assert.equal(alert?.textContent?.includes("Could not record the outcome"), true);
      assert.equal(buttonByText(container, "Accepted") !== undefined, true, "the choices stay for another try");
    });
  } finally { workflowOutcomeApi.record = original; }
});
