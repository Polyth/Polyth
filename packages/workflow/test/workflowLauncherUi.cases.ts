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
const { activateProject, activateSession, getState, setActiveView, setModels, startNewSession } = await import("../../../apps/web/src/store.ts");
const { setWorkspaceMode } = await import("../../../apps/web/src/widgets/workspaceMode.ts");
const { installBuiltinMiniWidgets } =
  await import("../../../apps/web/src/widgets/builtinMiniWidgets.tsx");
const { WORKFLOW_WIDGET_PLUGIN } = await import("../widgets/index.tsx");
const { default: Composer } = await import("../../../apps/web/src/components/Composer.tsx");
const { default: WorkflowTimelineCard } = await import("../widgets/WorkflowTimelineCard.tsx");
const { default: WorkflowLauncher, requestWorkflowLauncher } = await import("../widgets/WorkflowLauncher.tsx");
const { default: WorkflowMessageAction } = await import("../widgets/WorkflowMessageAction.tsx");
const { default: WorkflowView } = await import("../widgets/WorkflowView.tsx");
const { workflowDecisionApi } = await import("../widgets/workflowDecision.ts");
const { workflowOutcomeApi } = await import("../widgets/workflowOutcome.ts");
const { registerWidgetPlugin } = await import("../../../apps/web/src/widgets/catalog.ts");
const { handOffWorkflowLaunch, takeWorkflowLaunch } = await import("../widgets/workflowLaunch.ts");
const { beginWorkflowStart, dismissWorkflowStart, retryWorkflowStart, workflowStartFor } =
  await import("../widgets/workflowStart.ts");
const { drainInserts, drainComposerReplacement } = await import("../../../apps/web/src/composerInsert.ts");
registerWidgetPlugin(WORKFLOW_WIDGET_PLUGIN);

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
/** A run card folds to its header and summary line; this opens it. */
const openCard = async (container: ParentNode) => {
  const toggle = container.querySelector<HTMLButtonElement>(".workflow-timeline-toggle");
  assert.ok(toggle, "the card has one toggle that opens it");
  await act(async () => { toggle.click(); await tick(); });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
};
// The view opens on the library; a workflow's page has Run and Edit tabs.
const openWorkflow = async (container: ParentNode, name: string, tab?: "edit") => {
  const card = container.querySelector<HTMLButtonElement>(`.workflow-card-main[aria-label="Open ${name}"]`);
  assert.ok(card, `the library lists ${name}`);
  await act(async () => { card.click(); await tick(); });
  if (tab) await act(async () => { container.querySelector<HTMLButtonElement>("#workflow-detail-tab-edit")?.click(); await tick(); });
};

const workflow: WorkflowDto = {
  id: "release",
  projectId: "project",
  name: "Release review",
  nodes: [{ id: "review", role: "Reviewer", prompt: "Review the release" }],
  edges: [],
  defaults: { permissions: "manual" },
  createdAt: 1,
  updatedAt: 1,
};

test("editor autosave serializes newer edits with the acknowledged revision", async () => {
  const original = { listWorkflows: api.listWorkflows, listWorkflowRuns: api.listWorkflowRuns,
    getWorkflowPreferences: api.getWorkflowPreferences, harnessSnapshots: api.harnessSnapshots,
    updateWorkflow: api.updateWorkflow };
  const saved = { ...workflow, revision: 1 };
  api.listWorkflows = async () => [saved];
  api.listWorkflowRuns = async () => [];
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  api.harnessSnapshots = async () => [];
  const writes: Array<{ patch: Parameters<typeof api.updateWorkflow>[1]; resolve: (value: WorkflowDto) => void }> = [];
  api.updateWorkflow = (_id, patch) => new Promise((resolve) => { writes.push({ patch, resolve }); });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 760));
  try {
    await act(async () => { activateProject("project"); root.render(createElement(WorkflowView)); await tick(); });
    await openWorkflow(container, "Release review");
    assert.deepEqual([...container.querySelectorAll<HTMLInputElement>('.workflow-run-options input[type="number"]')].map((input) => input.value),
      ["2", "1800"], "legacy partial defaults inherit bounded run options");
    await act(async () => { container.querySelector<HTMLButtonElement>("#workflow-detail-tab-edit")?.click(); await tick(); });
    const add = () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Add worker after selected node"]');
      assert.equal(Boolean(button), true, "the editor exposes insertion beside the selected node");
      button!.click();
    };
    await act(async () => { add(); });
    await act(async () => { await settle(); });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.patch.expectedRevision, 1);
    await act(async () => { add(); });
    await act(async () => { await settle(); });
    assert.equal(writes.length, 1, "a second edit waits for the first save");
    await act(async () => {
      writes[0]!.resolve({ ...saved, ...writes[0]!.patch, revision: 2, updatedAt: 2 });
      await tick();
    });
    assert.equal(writes.length, 2);
    assert.equal(writes[1]!.patch.expectedRevision, 2, "local edits use the acknowledged revision");
    assert.equal(writes[1]!.patch.nodes?.length, 3, "the earlier response preserves the newer node");
    await act(async () => {
      writes[1]!.resolve({ ...saved, ...writes[1]!.patch, revision: 3, updatedAt: 3 });
      await tick();
    });
    assert.equal(container.querySelector(".workflow-save-state")?.textContent, "Saved");
    const undo = container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
    assert.equal(undo?.disabled, false, "an autosave acknowledgement preserves undo history");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("editor Auto clears a pinned model and harness changes clear old allowed models", async () => {
  const original = { listWorkflows: api.listWorkflows, listWorkflowRuns: api.listWorkflowRuns,
    getWorkflowPreferences: api.getWorkflowPreferences, updateWorkflow: api.updateWorkflow };
  const saved: WorkflowDto = { ...workflow, revision: 1, nodes: [
    { ...workflow.nodes[0]!, model: { providerID: "old", modelID: "pinned" },
      harness: { mode: "pinned", harnessId: "old-harness" } },
    { id: "auto", role: "Auto worker", prompt: "Do B",
      harness: { mode: "pinned", harnessId: "old-harness" },
      allowedModels: [{ providerID: "old", modelID: "allowed" }] },
  ] };
  const writes: Array<Parameters<typeof api.updateWorkflow>[1]> = [];
  api.listWorkflows = async () => [saved];
  api.listWorkflowRuns = async () => [];
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  api.updateWorkflow = async (_id, patch) => {
    writes.push(patch);
    return { ...saved, ...patch, revision: 1 + writes.length };
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const harnessSlot = (context: Record<string, unknown>) => createElement("button", {
    type: "button", "data-testid": "switch-harness",
    onClick: () => (context.onSelectHarness as (selection: { mode: "pinned"; harnessId: string }) => void)({ mode: "pinned", harnessId: "new-harness" }),
  }, "Switch harness");
  try {
    await act(async () => { activateProject("project"); root.render(createElement(WorkflowView, { harnessSlot })); await tick(); });
    await openWorkflow(container, "Release review", "edit");
    const auto = [...container.querySelectorAll<HTMLButtonElement>(".workflow-route-mode button")]
      .find((button) => button.textContent?.trim() === "Auto");
    assert.ok(auto);
    await act(async () => { auto.click(); await tick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 760)); });
    assert.equal(writes.at(-1)?.nodes?.[0]?.model, undefined, "Auto removes the pin from the saved definition");
    assert.deepEqual(writes.at(-1)?.nodes?.[0]?.allowedModels, []);
    const autoNode = [...container.querySelectorAll<HTMLButtonElement>(".workflow-canvas-node")]
      .find((button) => button.querySelector("strong")?.textContent?.trim() === "Auto worker");
    assert.ok(autoNode, "the Auto node is selectable even when graph ordering differs from definition order");
    await act(async () => { autoNode.click(); await tick(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="switch-harness"]')?.click(); await tick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 760)); });
    assert.deepEqual(writes.at(-1)?.nodes?.[1]?.harness, { mode: "pinned", harnessId: "new-harness" });
    assert.deepEqual(writes.at(-1)?.nodes?.[1]?.allowedModels, [], "new harness starts without old allow-list");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("workflow inspector keeps coarse targets distinct and does not repeat the sheet title", async () => {
  const [styles, source] = await Promise.all([
    readFile(new URL("../widgets/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../widgets/WorkflowView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(styles, /\.workflow-route-mode \.config-chip \{ min-block-size: var\(--tap\); \}/);
  assert.match(styles, /\.workflow-inspector-heading \.ui-icon-btn--sm \{[\s\S]*?min-inline-size: var\(--tap\);[\s\S]*?min-block-size: var\(--tap\);/);
  assert.match(styles, /\.workflow-inspector-sheet \.workflow-inspector-heading \.stat-label \{ display: none; \}/);
  assert.match(source, /title=\{tr\("workflowview\.nodeInspector"\)\}/);
  assert.match(source, /className="workflow-inspector-sheet"/);
});

test("Auto allow-list uses the shared model picker and stops at the 24-model contract limit", async () => {
  const original = { listWorkflows: api.listWorkflows, listWorkflowRuns: api.listWorkflowRuns,
    getWorkflowPreferences: api.getWorkflowPreferences };
  const models = Array.from({ length: 25 }, (_, index) => ({
    providerID: "test", modelID: `m${index}`, name: `Model ${index}`, connected: true,
  }));
  api.listWorkflows = async () => [{ ...workflow, revision: 1, nodes: [{
    ...workflow.nodes[0]!, allowedModels: models.slice(0, 24).map(({ providerID, modelID }) => ({ providerID, modelID })),
  }] }];
  api.listWorkflowRuns = async () => [];
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  setModels(models);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); root.render(createElement(WorkflowView)); await tick(); });
    await openWorkflow(container, "Release review", "edit");
    const trigger = container.querySelector<HTMLButtonElement>(".workflow-route-controls .model-picker-trigger");
    assert.ok(trigger, "the Auto allow-list is the shared model picker");
    await act(async () => { trigger.click(); await tick(); });
    const row = (name: string) => [...document.querySelectorAll<HTMLElement>(".model-picker-row")]
      .find((element) => element.textContent?.includes(name));
    assert.equal(document.querySelector('[role="listbox"]')?.getAttribute("aria-multiselectable"), "true");
    assert.equal(row("Model 0")?.getAttribute("aria-selected"), "true");
    assert.equal(row("Model 0")?.getAttribute("aria-disabled"), null, "selected models can still be unchecked");
    assert.equal(row("Model 24")?.getAttribute("aria-disabled"), "true", "a 25th model cannot be selected");
    await act(async () => { row("Model 24")?.click(); await tick(); });
    assert.equal(row("Model 24")?.getAttribute("aria-selected"), "false", "a full allow-list ignores another model");
    await act(async () => { row("Model 0")?.click(); await tick(); });
    assert.equal(row("Model 0")?.getAttribute("aria-selected"), "false", "the popover stays open while toggling");
    assert.equal(row("Model 24")?.getAttribute("aria-disabled"), null, "removing a model frees one slot");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("a new-chat launch opens its parent chat at once and a lost response reuses its operation key", async () => {
  const original = { listWorkflows: api.listWorkflows, getWorkflowPreferences: api.getWorkflowPreferences,
    createSession: api.createSession, runWorkflow: api.runWorkflow, getSession: api.getSession,
    getEvents: api.getEvents, listSessions: api.listSessions };
  const requests: Parameters<typeof api.runWorkflow>[] = [];
  const created: Array<Parameters<typeof api.createSession>[0]> = [];
  let rejectRequest: ((cause: Error) => void) | undefined;
  let parents = 0;
  let consumed = 0;
  api.listWorkflows = async () => [workflow];
  api.getWorkflowPreferences = async () => ({ selectedId: workflow.id, pinnedIds: [], recentIds: [] });
  api.createSession = async (input) => {
    created.push(input);
    return { id: `parent-${++parents}` };
  };
  api.runWorkflow = (...args) => {
    requests.push(args);
    return new Promise((_resolve, reject) => { rejectRequest = reject; });
  };
  api.getSession = async (id) => ({
    id, projectId: "project", title: "New session", status: "idle", createdAt: 1, updatedAt: 1,
  }) as never;
  api.getEvents = async () => [];
  api.listSessions = async () => [];
  startNewSession("project");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(WorkflowLauncher, { projectId: "project", draftText: "Exact request",
        workflowAttachments: [{ id: "attachment", name: "notes.txt", mime: "text/plain", size: 4 }],
        model: { providerID: "chat", modelID: "current", variant: "high" },
        harness: { mode: "pinned", harnessId: "chat-harness" },
        agent: "chat-agent",
        consumeDraft: () => { consumed++; } }));
      await tick();
    });
    const trigger = container.querySelector<HTMLButtonElement>(".composer-workflow");
    assert.ok(trigger, "the workflow launcher is available beside the composer");
    assert.equal(container.querySelector(".workflow-selected-action"), null,
      "a selected workflow has no adjacent composer action");
    await act(async () => { trigger.click(); await tick(); });
    const explicitRun = () => document.querySelector<HTMLButtonElement>(".workflow-launch-row button:last-of-type");
    const run = explicitRun();
    assert.equal(run?.disabled, false, "the workflow has an explicit Run action inside its menu");
    assert.equal(document.querySelector(".workflow-launch-task"), null);
    assert.equal(document.querySelector(".workflow-launch-description"), null);
    await act(async () => { run?.click(); run?.click(); await tick(); });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.[2], "Exact request");
    assert.equal(requests[0]?.[4]?.model?.modelID, "current");
    assert.deepEqual(requests[0]?.[4]?.harness, { mode: "pinned", harnessId: "chat-harness" });
    assert.equal(requests[0]?.[4]?.agent, "chat-agent");
    assert.equal(parents, 1);
    // The server names the parent from the admitted run's task, so the
    // launcher leaves the title to automatic naming instead of a manual copy.
    assert.deepEqual(created[0], {
      projectId: "project",
      purpose: "workflow",
      model: { providerID: "chat", modelID: "current", variant: "high" },
      harness: { mode: "pinned", harnessId: "chat-harness" },
      agent: "chat-agent",
    });
    // The new chat does not wait for admission: the parent chat opens while the
    // start is still in flight. The run's card lives there once admitted.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tick(); });
    assert.equal(getState().activeSessionId, "parent-1", "the parent session opens before admission");
    assert.equal(takeWorkflowLaunch("project"), null, "the workflow window is handed nothing: a run is watched in its chat");
    assert.equal(workflowStartFor("parent-1")?.status, "starting");
    assert.equal(workflowStartFor("parent-1")?.input, "Exact request");
    assert.equal(consumed, 1, "the task moved into the launch; the composer is left clean");
    await act(async () => { rejectRequest?.(new Error("response lost")); await tick(); });
    assert.equal(workflowStartFor("parent-1")?.status, "failed", "a failed start stays visible");
    await act(async () => { void retryWorkflowStart("parent-1")?.catch(() => undefined); await tick(); });
    assert.equal(requests.length, 2);
    assert.equal(parents, 1, "an uncertain launch does not create a second parent");
    assert.equal(requests[0]?.[1], requests[1]?.[1]);
    assert.equal(requests[0]?.[4]?.clientOperationId, requests[1]?.[4]?.clientOperationId);
    assert.equal(requests[1]?.[4]?.attachments?.[0]?.id, "attachment");
    await act(async () => { rejectRequest?.(new Error("response still lost")); await tick(); });
  } finally {
    takeWorkflowLaunch("project");
    dismissWorkflowStart("parent-1");
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("the launcher keeps a short workflow list and reveals more on demand", async () => {
  const original = { listWorkflows: api.listWorkflows, getWorkflowPreferences: api.getWorkflowPreferences };
  const many = Array.from({ length: 6 }, (_, index) => ({
    ...workflow,
    id: `workflow-${index}`,
    name: `Workflow ${index + 1}`,
  }));
  api.listWorkflows = async () => many;
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(WorkflowLauncher, { projectId: "project", draftText: "Run this" }));
      await tick();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".composer-workflow")?.click();
      await tick();
    });
    assert.equal(document.querySelectorAll(".workflow-launch-row").length, 4);
    assert.ok(document.querySelector<HTMLButtonElement>(".workflow-launch-more"));
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".workflow-launch-more")?.click();
      await tick();
    });
    assert.equal(document.querySelectorAll(".workflow-launch-row").length, 6);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("a late accepted run cannot consume a draft or navigate after a scope switch", async () => {
  const original = { listWorkflows: api.listWorkflows, getWorkflowPreferences: api.getWorkflowPreferences,
    runWorkflow: api.runWorkflow };
  api.listWorkflows = async () => [workflow];
  api.getWorkflowPreferences = async () => ({ selectedId: workflow.id, pinnedIds: [], recentIds: [] });
  let finish!: (run: WorkflowRunDto) => void;
  api.runWorkflow = () => new Promise((resolve) => { finish = resolve; });
  const consumed: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (projectId: string, sessionId: string) => root.render(createElement(WorkflowLauncher, {
    projectId, sessionId, draftText: "Keep my draft", consumeDraft: () => { consumed.push(projectId); },
  }));
  try {
    activateProject("project");
    await act(async () => { render("project", "parent"); await tick(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".composer-workflow")?.click(); await tick(); });
    await act(async () => { document.querySelector<HTMLButtonElement>(".workflow-launch-row button:last-of-type")?.click(); await tick(); });
    await act(async () => { activateProject("other-project"); render("other-project", "other-parent"); await tick(); });
    await act(async () => { finish({ id: "accepted", workflowId: workflow.id, projectId: "project",
      parentSessionId: "parent", name: workflow.name, input: "Keep my draft", status: "running",
      startedAt: 1, nodes: [], layers: [] }); await tick(); });
    assert.deepEqual(consumed, []);
    assert.equal(getState().activeProjectId, "other-project");
    await act(async () => { container.querySelector<HTMLButtonElement>(".composer-workflow")?.click(); await tick(); });
    assert.equal(document.querySelector<HTMLButtonElement>(".workflow-launch-row button:last-of-type")?.disabled, false,
      "a stale completion does not leave the new scope's explicit Run action busy");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("message actions load lazily and ignore the composer command", async () => {
  const original = { listWorkflows: api.listWorkflows, getWorkflowPreferences: api.getWorkflowPreferences };
  let loads = 0;
  api.listWorkflows = async () => { loads++; return [workflow]; };
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowMessageAction, {
      projectId: "project", sessionId: "parent", eventSeq: 7, messageText: "Existing message",
    })); await tick(); });
    assert.equal(loads, 0);
    await act(async () => { requestWorkflowLauncher({ projectId: "project" }); await tick(); });
    assert.equal(document.querySelectorAll(".workflow-launch-overlay").length, 0);
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Run in workflow"]')?.click(); await tick(); });
    assert.equal(loads, 1);
    assert.equal(document.querySelector(".workflow-launch-task"), null);
    assert.equal(document.querySelector(".workflow-launch-description"), null);
    assert.equal(document.querySelector<HTMLButtonElement>(".workflow-launch-row button:last-of-type")?.disabled, false);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("a message action placed in More has no trigger and opens on each host request", async () => {
  const original = { listWorkflows: api.listWorkflows, getWorkflowPreferences: api.getWorkflowPreferences };
  api.listWorkflows = async () => [workflow];
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);
  const root = createRoot(container);
  const props = (request: number) => ({
    projectId: "project", sessionId: "parent", eventSeq: 7, messageText: "Existing message",
    messageActionPlacement: "menu", messageActionRequest: request, messageActionAnchor: () => anchor,
  });
  try {
    await act(async () => { root.render(createElement(WorkflowMessageAction, props(2))); await tick(); });
    assert.equal(container.querySelector("button"), null, "no visible trigger inside the More menu placement");
    assert.equal(document.querySelectorAll(".workflow-launch-overlay").length, 0, "mounting does not replay an old request");
    await act(async () => { root.render(createElement(WorkflowMessageAction, props(3))); await tick(); });
    assert.equal(document.querySelectorAll(".workflow-launch-overlay").length, 1);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
    anchor.remove();
  }
});

test("a retried timeline follows the new run immediately without a WebSocket update", async () => {
  const original = { retryWorkflowRun: api.retryWorkflowRun, getWorkflowRun: api.getWorkflowRun };
  const failed: WorkflowRunDto = { id: "failed", workflowId: workflow.id, projectId: "project",
    parentSessionId: "parent", name: workflow.name, input: "Task", startedAt: 1, status: "error",
    layers: [["review"]], nodes: [{ id: "review", role: "Reviewer", status: "error", retryable: true }] };
  const retried: WorkflowRunDto = { ...failed, id: "retried", retryOf: failed.id, startedAt: 2,
    status: "running", nodes: [{ id: "review", role: "Reviewer", status: "running" }] };
  let attempts = 0;
  const fetched: string[] = [];
  api.retryWorkflowRun = async () => { attempts++; return retried; };
  api.getWorkflowRun = async (id) => {
    fetched.push(id);
    return { ...retried, status: "done", finishedAt: 3, result: "Verified result",
      nodes: [{ id: "review", role: "Reviewer", status: "done" }] };
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: failed })); await tick(); });
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Retry step");
    assert.equal(Boolean(retry), true);
    await act(async () => { retry?.click(); retry?.click(); await tick(); });
    assert.equal(attempts, 1);
    assert.deepEqual(fetched, ["retried"]);
    assert.equal(Boolean(container.querySelector(".workflow-timeline-card.status-done")), true);
    assert.match(container.textContent ?? "", /Verified result/);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("a unit the run holds is fixed right in the chat card, never retried from a forked run", async () => {
  const held: WorkflowRunDto = { id: "held", workflowId: workflow.id, projectId: "project",
    parentSessionId: "parent", name: workflow.name, input: "Task", startedAt: 1, status: "running",
    layers: [["scout"], ["review"]], nodes: [
      { id: "scout", role: "Codebase Scout", status: "error", retryable: true, needsFix: true,
        error: "gpt-gone is not available on this engine. Pick a model from the list." },
      { id: "review", role: "Reviewer", status: "queued" },
    ] };
  const original = { getWorkflowRun: api.getWorkflowRun };
  api.getWorkflowRun = async () => held;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: held })); await tick(); });
    assert.equal(container.querySelectorAll(".workflow-timeline-card .workflow-retry-controls").length, 1,
      "the held unit offers its other-route controls under its row");
    assert.ok(buttonByText(container, "Continue"), "the fix continues the run in place");
    assert.ok(!container.querySelector('button[aria-label="Fix Codebase Scout"]'), "no hand-off button to another window");
    assert.ok(!buttonByText(container, "Retry step"), "a running run is never forked from the card");
    assert.ok(container.querySelector(".workflow-timeline-card.has-attention"), "the card asks for attention");
    assert.match(container.textContent ?? "", /Waiting for your fix/);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("a review held for a decision is settled in the chat card itself", async () => {
  const blocker = { severity: "blocker" as const, message: "no tests" };
  const held: WorkflowRunDto = { id: "decide", workflowId: workflow.id, projectId: "project",
    parentSessionId: "parent", name: workflow.name, input: "Task", startedAt: 1, status: "running",
    layers: [["scout"], ["review"]], nodes: [
      { id: "scout", role: "Codebase Scout", status: "done", sessionId: "scout-child" },
      { id: "review", role: "Reviewer", status: "done", sessionId: "review-child", round: 3, roundLimit: 3,
        verdict: "changes-requested", findings: [blocker], needsDecision: { items: [{ finding: blocker }], canAnotherRound: true } },
    ] };
  const original = { getWorkflowRun: api.getWorkflowRun };
  api.getWorkflowRun = async () => held;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: held })); await tick(); });
    assert.ok(container.querySelector(".workflow-timeline-card.has-attention"), "the card asks for attention");
    assert.match(container.textContent ?? "", /Waiting for your decision/);
    assert.equal(container.querySelectorAll(".workflow-timeline-card .workflow-dispute").length, 1,
      "the decision card opens under the held review");
    assert.ok(buttonByText(container, "Accept as is") ?? buttonByText(container, "Accept"), "the gate can be accepted here");
    assert.ok(!buttonByText(container, "Decide"), "no hand-off button to another window");
    assert.ok(!buttonByText(container, "Review & respond"), "the decision is made in the card, not in the reviewer's chat");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("chat composer keeps the Run workflow launcher mounted after project activation", async () => {
  const originalComposerCatalog = api.composerCatalog;
  const originalListWorkflows = api.listWorkflows;
  api.composerCatalog = async () => ({
    commands: { ok: true, items: [] },
    snippets: { ok: true, items: [] },
  });
  api.listWorkflows = async () => [workflow];
  installBuiltinMiniWidgets();
  activateProject("chat-launcher-project");
  setWorkspaceMode("chat");
  setModels([{
    providerID: "test",
    modelID: "chat",
    name: "Chat",
    connected: true,
  }]);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Composer));
      await Promise.resolve();
    });

    const composer = container.querySelector(".composer-simple");
    assert.ok(composer, "Chat mode renders the simple composer");
    const trigger = composer.querySelector<HTMLButtonElement>(".composer-workflow");
    assert.equal(trigger?.getAttribute("aria-label"), "Run workflow");

    const input = composer.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');
    assert.ok(input);
    await act(async () => {
      input.value = "Audit the release candidate";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    assert.equal(document.querySelector(".workflow-launch-task"), null);
    assert.equal(document.querySelector(".workflow-launch-description"), null);
  } finally {
    api.composerCatalog = originalComposerCatalog;
    api.listWorkflows = originalListWorkflows;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("new-session creation marks the composer busy and prevents duplicate submission", async () => {
  const originalComposerCatalog = api.composerCatalog;
  const originalCreateSession = api.createSession;
  const originalGetSession = api.getSession;
  const originalGetEvents = api.getEvents;
  const originalSendMessage = api.sendMessage;
  const originalListSessions = api.listSessions;
  let releaseCreate!: () => void;
  const creationGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let markCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  let markSent!: () => void;
  const sent = new Promise<void>((resolve) => { markSent = resolve; });
  api.composerCatalog = async () => ({
    commands: { ok: true, items: [] },
    snippets: { ok: true, items: [] },
  });
  api.createSession = async () => {
    markCreateStarted();
    await creationGate;
    return { id: "opening" };
  };
  api.getSession = async () => ({
    id: "opening", projectId: "opening-project", title: "New session", status: "idle", createdAt: 1, updatedAt: 1,
  });
  api.getEvents = async () => [];
  api.sendMessage = async () => {
    markSent();
    return { turnId: "turn-opening" };
  };
  api.listSessions = async () => [];
  startNewSession("opening-project");
  setWorkspaceMode("chat");
  setModels([{
    providerID: "test",
    modelID: "chat",
    name: "Chat",
    connected: true,
  }]);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Composer));
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');
    assert.ok(input);
    await act(async () => {
      input.value = "Start a slow session";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const send = container.querySelector<HTMLButtonElement>("button.send");
      assert.ok(send);
      send.click();
      await createStarted;
    });

    assert.equal(container.querySelector(".composer")?.getAttribute("aria-busy"), "true");
    assert.equal(container.querySelector<HTMLButtonElement>("button.send")?.disabled, true);
    assert.equal(container.querySelector<HTMLButtonElement>(".composer-workflow")?.disabled, true,
      "workflow submission cannot race with creation of the normal chat session");

    await act(async () => {
      releaseCreate();
      await sent;
      await Promise.resolve();
    });
  } finally {
    releaseCreate();
    await act(async () => { await sent; });
    api.composerCatalog = originalComposerCatalog;
    api.createSession = originalCreateSession;
    api.getSession = originalGetSession;
    api.getEvents = originalGetEvents;
    api.sendMessage = originalSendMessage;
    api.listSessions = originalListSessions;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("composer workflow action opens the launcher with the live draft", async () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  const originalListWorkflows = api.listWorkflows;
  api.listWorkflows = async () => [workflow];
  setActiveView("session");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(widget.render({
        projectId: "project",
        sessionId: "session",
        editing: false,
        instanceId: "workflow.composer-action",
        config: {},
        updateConfig: () => {},
        workflowDraftText: "Audit the release candidate",
        workflowAttachmentCount: 0,
        consumeWorkflowDraft: () => {},
      }));
    });

    const trigger = container.querySelector<HTMLButtonElement>(".composer-workflow");
    assert.equal(trigger?.getAttribute("aria-label"), "Run workflow");
    assert.equal(trigger?.getAttribute("aria-haspopup"), "dialog");

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    assert.equal(getState().activeView, "session", "opening the picker must not navigate to the builder");
    assert.ok(document.querySelector('[role="dialog"][aria-label="Run a workflow"]'));
    // Never pass a Happy DOM node to assert.equal: failure formatting can
    // traverse its Window and React graph. Compare primitive evidence only.
    assert.equal(
      document.querySelector(".workflow-launch-overlay")?.parentElement === document.body,
      true,
      "the launcher escapes composer visual containing blocks",
    );
    assert.equal(document.querySelector(".workflow-launch-task"), null);
    assert.equal(document.querySelector(".workflow-launch-description"), null);
    assert.match(document.body.textContent ?? "", /Release review/);
    assert.match(document.body.textContent ?? "", /chat's approvals/);
  } finally {
    api.listWorkflows = originalListWorkflows;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("workflow launcher does not claim the list is empty while it loads", async () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  const originalListWorkflows = api.listWorkflows;
  let finishLoading: ((items: WorkflowDto[]) => void) | undefined;
  api.listWorkflows = () => new Promise<WorkflowDto[]>((resolve) => { finishLoading = resolve; });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(widget.render({
        projectId: "project",
        sessionId: "session",
        editing: false,
        instanceId: "workflow.composer-action",
        config: {},
        updateConfig: () => {},
        workflowDraftText: "",
        workflowAttachmentCount: 0,
        consumeWorkflowDraft: () => {},
      }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".composer-workflow")?.click();
      await Promise.resolve();
    });
    assert.match(document.querySelector(".workflow-launch-footer")?.textContent ?? "", /Open workflow builder/);
    assert.doesNotMatch(document.querySelector(".workflow-launch-footer")?.textContent ?? "", /Create workflow/);
    assert.match(document.querySelector('.workflow-launch-empty[role="status"]')?.textContent ?? "", /Loading workflows/);
    assert.doesNotMatch(document.querySelector(".workflow-launch-panel")?.textContent ?? "", /No workflows saved/);
    await act(async () => {
      finishLoading?.([]);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(document.querySelector(".workflow-launch-empty")?.textContent ?? "", /Create workflow/);
    assert.doesNotMatch(document.querySelector(".workflow-launch-footer")?.textContent ?? "", /Create workflow/);
  } finally {
    api.listWorkflows = originalListWorkflows;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("workflow launcher retries a failed list without losing the composer draft", async () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  const originalListWorkflows = api.listWorkflows;
  let attempts = 0;
  api.listWorkflows = async () => {
    attempts++;
    // The eager load at mount and the retry made by opening both fail.
    if (attempts <= 2) throw new Error("synthetic list failure");
    return [workflow];
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(widget.render({
        projectId: "project",
        sessionId: "session",
        editing: false,
        instanceId: "workflow.composer-action",
        config: {},
        updateConfig: () => {},
        workflowDraftText: "Keep this workflow task",
        workflowAttachmentCount: 0,
        consumeWorkflowDraft: () => {},
      }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".composer-workflow")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 2, "opening the launcher asks again after the failed mount load");
    assert.match(document.body.textContent ?? "", /Workflows couldn’t be loaded/);
    assert.equal(
      (document.body.textContent ?? "").match(/Workflows couldn’t be loaded/g)?.length,
      1,
      "the failed state does not repeat its heading",
    );
    assert.equal(document.querySelector(".workflow-launch-task"), null);
    assert.equal(document.querySelector(".workflow-launch-description"), null);

    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Retry")
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 3);
    assert.match(document.body.textContent ?? "", /Release review/);
    assert.equal(document.querySelector(".workflow-launch-task"), null);
  } finally {
    api.listWorkflows = originalListWorkflows;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a workflow list that failed while the link was down heals on open and on reconnect", async () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  const { CONNECTION_RESTORED_EVENT } = await import("@polyth/contracts/transport-retry");
  const originalListWorkflows = api.listWorkflows;
  let attempts = 0;
  let linkUp = false;
  api.listWorkflows = async () => {
    attempts++;
    // What WKWebView reports for a request the Link proxy could not answer.
    if (!linkUp) throw new TypeError("Load failed");
    return [workflow];
  };
  const render = (root: ReturnType<typeof createRoot>) => root.render(widget.render({
    projectId: "project",
    sessionId: "session",
    editing: false,
    instanceId: "workflow.composer-action",
    config: {},
    updateConfig: () => {},
    workflowDraftText: "Ship it",
    workflowAttachmentCount: 0,
    consumeWorkflowDraft: () => {},
  }));
  const containers: HTMLElement[] = [];
  const roots: Array<ReturnType<typeof createRoot>> = [];
  try {
    // 1. A restored connection reloads the failed list before anyone looks.
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => { render(root); await tick(); });
    assert.equal(attempts, 1);
    linkUp = true;
    await act(async () => { window.dispatchEvent(new Event(CONNECTION_RESTORED_EVENT)); await tick(); });
    assert.equal(attempts, 2, "the restored connection asks again");
    await act(async () => { container.querySelector<HTMLButtonElement>(".composer-workflow")?.click(); await tick(); });
    assert.match(document.body.textContent ?? "", /Release review/);
    assert.doesNotMatch(document.body.textContent ?? "", /couldn’t be loaded/);
    await act(async () => { window.dispatchEvent(new Event(CONNECTION_RESTORED_EVENT)); await tick(); });
    assert.equal(attempts, 2, "a loaded list is not refetched on every reconnect");
  } finally {
    api.listWorkflows = originalListWorkflows;
    for (const root of roots) await act(async () => { root.unmount(); });
    for (const container of containers) container.remove();
  }
});

test("a Workflows page that could not read its library offers Retry and reloads on reconnect", async () => {
  const { CONNECTION_RESTORED_EVENT } = await import("@polyth/contracts/transport-retry");
  const original = { listWorkflows: api.listWorkflows, listWorkflowRuns: api.listWorkflowRuns,
    getWorkflowPreferences: api.getWorkflowPreferences, harnessSnapshots: api.harnessSnapshots };
  let linkUp = false;
  let reads = 0;
  api.listWorkflows = async () => {
    reads++;
    if (!linkUp) throw new TypeError("Load failed");
    return [workflow];
  };
  api.listWorkflowRuns = async () => [];
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  api.harnessSnapshots = async () => [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); root.render(createElement(WorkflowView)); await tick(); });
    assert.equal(reads, 1);
    const banner = container.querySelector(".workflow-error");
    assert.match(banner?.textContent ?? "", /Could not load workflows/);
    assert.equal(banner?.querySelector("button")?.textContent, "Retry", "a failed library read offers Retry, not Dismiss");
    linkUp = true;
    await act(async () => { window.dispatchEvent(new Event(CONNECTION_RESTORED_EVENT)); await tick(); });
    assert.equal(reads, 2, "the restored connection reads the library again");
    assert.equal(container.querySelector(".workflow-error"), null);
    assert.ok(container.querySelector('.workflow-card-main[aria-label="Open Release review"]'));
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("closing a lazy launcher mid-load reloads on reopen instead of staying on Loading", async () => {
  const original = { listWorkflows: api.listWorkflows, getWorkflowPreferences: api.getWorkflowPreferences };
  const loads: Array<(items: WorkflowDto[]) => void> = [];
  api.listWorkflows = () => new Promise<WorkflowDto[]>((resolve) => { loads.push(resolve); });
  api.getWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);
  const root = createRoot(container);
  const props = (openRequest: number) => ({
    projectId: "project", sessionId: "parent", draftText: "Existing message", lazy: true,
    subscribeToRequests: false, trigger: "none" as const, openRequest, anchor: () => anchor,
  });
  try {
    await act(async () => { root.render(createElement(WorkflowLauncher, props(0))); await tick(); });
    await act(async () => { root.render(createElement(WorkflowLauncher, props(1))); await tick(); });
    assert.equal(loads.length, 1);
    assert.match(document.querySelector('.workflow-launch-empty[role="status"]')?.textContent ?? "", /Loading workflows/);
    // Dismissed before the list arrived: that request is abandoned.
    await act(async () => {
      document.dispatchEvent(new (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await tick();
    });
    assert.equal(document.querySelectorAll(".workflow-launch-overlay").length, 0);
    loads[0]!([workflow]);
    await act(async () => { root.render(createElement(WorkflowLauncher, props(2))); await tick(); });
    assert.equal(loads.length, 2, "reopening asks again instead of trusting the abandoned request");
    await act(async () => { loads[1]!([workflow]); await tick(); });
    assert.match(document.body.textContent ?? "", /Release review/);
    assert.equal(document.querySelector('.workflow-launch-empty[role="status"]'), null);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
    anchor.remove();
  }
});

test("failed workflow start never consumes or replaces the composer draft", async () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  const originalListWorkflows = api.listWorkflows;
  const originalRunWorkflow = api.runWorkflow;
  api.listWorkflows = async () => [workflow];
  api.runWorkflow = async () => { throw new Error("synthetic start failure"); };
  let consumed = 0;
  let restored = "";
  const onReplace = (event: Event) => {
    restored = (event as CustomEvent<string>).detail;
    event.preventDefault();
  };
  window.addEventListener("polyth:composer-replace", onReplace);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(widget.render({
        projectId: "project",
        sessionId: "session",
        editing: false,
        instanceId: "workflow.composer-action",
        config: {},
        updateConfig: () => {},
        workflowDraftText: "Audit the release candidate",
        workflowAttachmentCount: 0,
        consumeWorkflowDraft: () => { consumed++; },
      }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".composer-workflow")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Run Release review workflow"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(consumed, 0);
    assert.equal(restored, "");
    assert.equal(document.querySelector(".workflow-launch-task"), null);
    assert.equal(document.querySelector(".workflow-launch-description"), null);
    assert.match(document.body.textContent ?? "", /Couldn’t start the workflow/);
  } finally {
    window.removeEventListener("polyth:composer-replace", onReplace);
    api.listWorkflows = originalListWorkflows;
    api.runWorkflow = originalRunWorkflow;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the settings handoff waits for workflow surface registration and follows unload", async () => {
  const { registerSurface } = await import("../../../apps/web/src/surfaces.ts");
  const run: WorkflowRunDto = {
    id: "cold-start-run", workflowId: workflow.id, projectId: workflow.projectId,
    name: workflow.name, input: "Inspect a saved run", status: "error", startedAt: 1,
    layers: [["review"]], nodes: [{ id: "review", role: "Reviewer", status: "error" }],
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let dispose: (() => void) | undefined;
  const action = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Workflow settings");
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); });
    await openCard(container);
    assert.equal(action()?.disabled, true, "history can arrive before package activation");
    await act(async () => {
      dispose = registerSurface({ id: "workflow", title: "Workflows", order: 22,
        component: () => null,
        presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380,
          preferredMaxWidth: 760, keepAlive: false, escape: "close" } });
    });
    assert.equal(action()?.disabled, false, "registration makes the handoff actionable");
    await act(async () => { dispose?.(); dispose = undefined; });
    assert.equal(action()?.disabled, true, "an unloaded package cannot accept the handoff");
  } finally {
    await act(async () => { dispose?.(); root.unmount(); });
    container.remove();
  }
});

test("running workflow card exposes manual permission handoff", async () => {
  const run: WorkflowRunDto = {
    id: "run",
    workflowId: workflow.id,
    projectId: workflow.projectId,
    parentSessionId: "session",
    name: workflow.name,
    input: "Audit the release candidate",
    status: "running",
    startedAt: 1,
    layers: [["review"]],
    nodes: [{
      id: "review",
      role: "Reviewer",
      status: "running",
      sessionId: "child-session",
      activity: "awaiting permission: bash",
    }],
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); });
    assert.match(container.textContent ?? "", /1 waiting for you/);
    assert.match(container.textContent ?? "", /Review & respond/);
    assert.equal(
      container.querySelector(".needs-human button")?.getAttribute("aria-label"),
      "Review and respond in Reviewer child session",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("chat workflow card styles itself and lets the reader inspect and jump to agents", async () => {
  // Timeline renders the card from history before the lazy package bundle
  // (and its styles.css) loads, so the card must carry its own stylesheet.
  const [source, packageStyles, cardStyles] = await Promise.all([
    readFile(new URL("../widgets/WorkflowTimelineCard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../widgets/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../widgets/timelineCard.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /^import "\.\/timelineCard\.css";$/m);
  assert.doesNotMatch(packageStyles, /\.workflow-timeline-card\s*[{.]/);
  assert.match(cardStyles, /@container workflow-timeline-card \(max-width: 520px\)/);

  const run: WorkflowRunDto = {
    id: "detail-run",
    workflowId: workflow.id,
    projectId: workflow.projectId,
    parentSessionId: "session",
    name: "Build + Review",
    input: "Ship it",
    status: "running",
    startedAt: Date.now() - 65_000,
    layers: [["build"], ["review"]],
    nodes: [
      { id: "build", role: "Builder", status: "running", sessionId: "builder-session",
        model: { providerID: "test", modelID: "builder-model" }, agent: "build", startedAt: Date.now() - 30_000,
        activity: "tool: edit" },
      { id: "review", role: "Reviewer", status: "queued" },
    ],
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); });
    const segments = [...container.querySelectorAll(".workflow-timeline-progress i")].map((segment) => segment.className);
    assert.deepEqual(segments, ["tone-running", "tone-queued"], "one progress segment per node");
    assert.match(container.querySelector(".workflow-timeline-card > header .workflow-timeline-elapsed")?.textContent ?? "", /^1:0\d$/);
    // Folded, the card is its header and one line naming what runs now.
    assert.equal(container.querySelector(".workflow-timeline-now")?.textContent, "Builder · tool: edit");
    assert.equal(container.querySelector(".workflow-timeline-count")?.textContent, "0/2");
    assert.equal(Boolean(container.querySelector(".workflow-timeline-nodes")), false, "no unit rows until the card opens");
    assert.equal(Boolean(container.querySelector(".workflow-timeline-card > footer")), false, "no action row until the card opens");
    await openCard(container);
    assert.ok(container.querySelector('button[aria-label="Open Builder child session"]'), "a running agent is two taps away");
    assert.ok(container.querySelector('button[aria-label="Stop Build + Review workflow run"]'), "Stop opens with the card");
    assert.equal(Boolean(container.querySelector('button[aria-label="Reviewer details"]')), false, "nothing extra to show for a queued node");

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Builder details"]');
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    await act(async () => { toggle?.click(); });
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    const details = container.querySelector(".workflow-timeline-node-details")?.textContent ?? "";
    assert.match(details, /builder-model/);
    assert.match(details, /Agent.*build/);
    assert.match(details, /Elapsed/);
    await act(async () => { toggle?.click(); });
    assert.equal(Boolean(container.querySelector(".workflow-timeline-node-details")), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("long workflow cards expand and collapse without burying chat", async () => {
  const run: WorkflowRunDto = {
    id: "long-run",
    workflowId: workflow.id,
    projectId: workflow.projectId,
    parentSessionId: "session",
    name: "Release train",
    input: "Audit every release stage",
    status: "running",
    startedAt: 1,
    layers: [],
    nodes: Array.from({ length: 12 }, (_, index) => ({
      id: `stage-${index + 1}`,
      role: `Stage ${index + 1}`,
      status: index === 7 ? "running" : index < 7 ? "done" : "queued",
    })),
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); });
    assert.equal(container.querySelectorAll(".workflow-timeline-card li").length, 0, "a folded card lists no units");
    await openCard(container);
    assert.equal(container.querySelectorAll(".workflow-timeline-card li").length, 6);
    const toggle = container.querySelector<HTMLButtonElement>(".workflow-timeline-nodes-toggle");
    assert.match(toggle?.textContent?.trim() ?? "", /Show all 12 nodes/);
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    assert.match(container.querySelector(".workflow-timeline-range")?.textContent ?? "", /Showing 5–10 of 12/);

    await act(async () => { toggle?.click(); });
    assert.equal(container.querySelectorAll(".workflow-timeline-card li").length, 12);
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    assert.match(toggle?.textContent?.trim() ?? "", /Show focused nodes/);

    await act(async () => { toggle?.click(); });
    assert.equal(container.querySelectorAll(".workflow-timeline-card li").length, 6);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});


test("user and assistant workflow actions receive the canonical project's Space", async () => {
  const { default: MessageQuickActions } = await import("../../../apps/web/src/components/MessageQuickActions.tsx");
  const { default: ChatResponseFooter } = await import("../../../apps/web/src/components/ChatResponseFooter.tsx");
  const { registerSlot } = await import("../../../apps/web/src/slots.ts");
  const { applyProjectUpsert } = await import("../../../apps/web/src/store.ts");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const seen: Array<{ role: unknown; spaceId: unknown; eventSeq: unknown }> = [];
  const dispose = registerSlot("session.message.actions", "workflow.test.message-context", (props) => {
    seen.push({ role: props.messageRole, spaceId: props.spaceId, eventSeq: props.eventSeq });
    return null;
  });
  try {
    await act(async () => {
      applyProjectUpsert({ id: "message-project", name: "Messages", path: "/synthetic", createdAt: 1, spaceId: "message-space" });
      activateProject("message-project");
      root.render(createElement("div", null,
        createElement(MessageQuickActions, { message: { kind: "user", id: "u1", eventSeq: 2,
          text: "Review this", time: 1 }, announce: () => {} }),
        createElement(ChatResponseFooter, { m: { kind: "assistant", id: "a1", partId: "a1",
          eventSeq: 3, text: "Review result", reasoning: "", finalized: true, time: 2 } }),
      ));
    });
    assert.equal(seen.some((item) => item.role === "user" && item.spaceId === "message-space" && item.eventSeq === 2), true);
    assert.equal(seen.some((item) => item.role === "assistant" && item.spaceId === "message-space" && item.eventSeq === 3), true);
  } finally {
    await act(async () => { root.unmount(); dispose(); });
    container.remove();
  }
});

// ---- Workflow window (template settings) and the chat card (the run surface) ----

const GAPPED = "Checking the diff.\n\n\n\n\n\n\n\nRunning the tests.";
const COMPACT = "Checking the diff.\n\nRunning the tests.";
const failedRun: WorkflowRunDto = {
  id: "failed-run", workflowId: workflow.id, projectId: "project", parentSessionId: "parent",
  name: workflow.name, input: "Review the release candidate",
  options: { pipe: "direct", permissions: "manual", maxParallel: 2, nodeTimeoutMs: 60_000, reviewRounds: 2 },
  status: "error", startedAt: 1, finishedAt: 2, layers: [["review"]], result: GAPPED,
  nodes: [{ id: "review", role: "Reviewer", status: "error", sessionId: "child", output: GAPPED,
    error: "Timed out after 1 minute. Open the child session to review its last activity." }],
};
const doneRun: WorkflowRunDto = { ...failedRun, id: "done-run", status: "done", result: "All good.",
  nodes: [{ id: "review", role: "Reviewer", status: "done", sessionId: "child", output: "All good." }] };

function stubWorkflowApi(saved: WorkflowDto[], runs: WorkflowRunDto[]) {
  const original = { listWorkflows: api.listWorkflows, listWorkflowRuns: api.listWorkflowRuns,
    getWorkflowPreferences: api.getWorkflowPreferences, updateWorkflowPreferences: api.updateWorkflowPreferences,
    harnessSnapshots: api.harnessSnapshots, runWorkflow: api.runWorkflow, createSession: api.createSession };
  const started: Array<{ workflowId: string; parentId: string; input: string; options: unknown }> = [];
  api.listWorkflows = async () => saved;
  api.listWorkflowRuns = async () => runs;
  api.getWorkflowPreferences = async () => ({ selectedId: saved[0]?.id, pinnedIds: [], recentIds: [] });
  api.updateWorkflowPreferences = async () => ({ pinnedIds: [], recentIds: [] });
  api.harnessSnapshots = async () => [];
  api.createSession = async () => ({ id: "parent" }) as never;
  api.runWorkflow = async (workflowId, parentId, input, options) => {
    started.push({ workflowId, parentId, input, options });
    return { ...failedRun, id: `started-${started.length}`, workflowId, input, status: "running",
      startedAt: 100 + started.length, finishedAt: undefined, result: undefined, nodes: [], layers: [] };
  };
  // Runs belong to the chat that ran them; the tests open the fixtures' chat.
  return { started, restore: () => { Object.assign(api, original); activateSession(null); } };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// React tracks the instance's own `value`; the prototype setter makes the change visible to it.
const typeInto = (element: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};
const buttonByText = (container: ParentNode, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);

const noRunRequests = () => {
  const original = { listWorkflowRuns: api.listWorkflowRuns, getWorkflowRun: api.getWorkflowRun,
    stopWorkflowRun: api.stopWorkflowRun, retryWorkflowRun: api.retryWorkflowRun };
  const calls: string[] = [];
  api.listWorkflowRuns = async () => { calls.push("listWorkflowRuns"); return []; };
  api.getWorkflowRun = async () => { calls.push("getWorkflowRun"); return failedRun; };
  api.stopWorkflowRun = async () => { calls.push("stopWorkflowRun"); return failedRun; };
  api.retryWorkflowRun = async () => { calls.push("retryWorkflowRun"); return failedRun; };
  return { calls, restore: () => { Object.assign(api, original); } };
};
const runUi = (container: ParentNode) => container.querySelectorAll(
  ".workflow-run-form, .workflow-run-results, .workflow-run-starting, .workflow-run-units, .workflow-run-usage, #workflow-detail-tab-run").length;

test("a failed run's card keeps its output compact and offers no one-click replay", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: failedRun })); await tick(); });
    assert.equal(container.querySelector(".workflow-timeline-result p")?.textContent, COMPACT, "recorded gaps collapse to one blank line");
    assert.ok(!buttonByText(container, "Run again"), "a failed run is not replayed in one click");
    assert.ok(!buttonByText(container, "Retry full workflow"));
    assert.ok(!buttonByText(container, "Workflow settings"), "settings wait in the opened card");
    await openCard(container);
    assert.ok(buttonByText(container, "Workflow settings"), "the card opens the template's settings");
    assert.equal(container.querySelectorAll(".workflow-run-usage").length, 1, "a settled run asks how its result was used");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a folded failed run says why; a retryable failure shows its retry row instead; a done run says nothing", async () => {
  const lineOf = (container: HTMLElement) => container.querySelector(".workflow-timeline-summary .workflow-timeline-now")?.textContent ?? null;
  const render = async (run: WorkflowRunDto) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); await tick(); });
    return { container, root };
  };
  const dispose = async (view: { container: HTMLElement; root: ReturnType<typeof createRoot> }) => {
    await act(async () => { view.root.unmount(); });
    view.container.remove();
  };
  const failedUnit = failedRun.nodes[0]!;
  const failed = await render(failedRun);
  try {
    assert.equal(lineOf(failed.container), `Reviewer · ${failedUnit.error}`, "a folded failed run names the unit and its error");
    assert.equal(buttonByText(failed.container, "Retry step") === undefined, true);
    await openCard(failed.container);
    assert.equal(lineOf(failed.container), null, "the opened card carries the error on the unit row, not in a second line");
    assert.equal((failed.container.textContent ?? "").includes(failedUnit.error!), true, "the unit row still shows the error");
  } finally { await dispose(failed); }
  const retryable = await render({ ...failedRun, nodes: [{ ...failedUnit, retryable: true }] });
  try {
    assert.equal(lineOf(retryable.container), null, "a retry row replaces the line");
    assert.equal(buttonByText(retryable.container, "Retry step") !== undefined, true, "the retry row is shown folded");
  } finally { await dispose(retryable); }
  const done = await render(doneRun);
  try {
    assert.equal(lineOf(done.container), null, "a done run has no failure line");
  } finally { await dispose(done); }
});

test("Run again on a done run's card starts the same template with its own request in this chat", async () => {
  const original = { runWorkflow: api.runWorkflow };
  const started: Array<Parameters<typeof api.runWorkflow>> = [];
  api.runWorkflow = async (...args) => { started.push(args); return { ...doneRun, id: "again", status: "running", finishedAt: undefined } as WorkflowRunDto; };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: doneRun })); await tick(); });
    assert.ok(!buttonByText(container, "Run again"), "a settled card is a result line until opened");
    await openCard(container);
    const again = buttonByText(container, "Run again");
    assert.ok(again, "a done run offers Run again on its card");
    await act(async () => { again.click(); await settle(); await settle(); });
    assert.equal(started.length, 1);
    assert.equal(started[0]![0], doneRun.workflowId);
    assert.equal(started[0]![1], "parent", "it starts in the chat the run came from");
    assert.equal(started[0]![2], doneRun.input);
    assert.deepEqual(started[0]![3], doneRun.options);
    assert.equal(started[0]![4]?.context, "request");
    assert.equal(typeof started[0]![4]?.clientOperationId, "string");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("a run card records how the result was used, from the card itself", async () => {
  const original = workflowOutcomeApi.record;
  const calls: Array<{ id: string; value: string }> = [];
  workflowOutcomeApi.record = async (id, input) => {
    calls.push({ id, value: input.value });
    return { ...doneRun, outcome: { value: input.value, at: 5, by: "person" } };
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: doneRun })); await tick(); });
    assert.equal(container.querySelector(".workflow-run-usage-text")?.textContent, "How was the result used?");
    await act(async () => { buttonByText(container, "Accepted")?.click(); await settle(); await settle(); });
    assert.deepEqual(calls, [{ id: "done-run", value: "accepted" }]);
    assert.equal(container.querySelector(".workflow-run-usage-text")?.textContent, "Result: Accepted · recorded by you");
    assert.ok(buttonByText(container, "Change"));
  } finally {
    workflowOutcomeApi.record = original;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("opening settings from a card leads with the template page and no run; a plain open shows the library", async () => {
  const { restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [failedRun]);
  const requests = noRunRequests();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    return async () => { await act(async () => { root.unmount(); }); };
  };
  try {
    let unmount = await mount();
    assert.equal(container.querySelector(".workflow-page")?.getAttribute("data-page"), "library", "a plain open starts from the library");
    await unmount();

    handOffWorkflowLaunch({ projectId: "project", workflowId: workflow.id });
    unmount = await mount();
    assert.equal(container.querySelector(".workflow-page")?.getAttribute("data-page"), "workflow",
      "Workflow settings leads with the template, not the library");
    assert.equal(runUi(container), 0, "the window shows no run form, no Run tab, no run monitor");
    assert.ok(container.querySelector(".workflow-canvas"), "the template's editor is on the page itself");
    assert.ok(!container.textContent?.includes(failedRun.input), "no run request is shown");
    assert.equal(container.querySelector('[role="tablist"]'), null, "the page has no tabs");
    assert.match(container.querySelector(".workflow-started-from")?.textContent ?? "", /started from a chat/);
    await unmount();
    assert.deepEqual(requests.calls, [], "the Workflows window makes no run request");
  } finally {
    requests.restore();
    restore();
    container.remove();
  }
});

test("choosing a saved workflow opens its own settings page; back returns to the library", async () => {
  const first: WorkflowDto = { ...workflow, revision: 1 };
  const second: WorkflowDto = { ...workflow, id: "second", name: "Second flow", revision: 1 };
  const secondRun: WorkflowRunDto = { ...doneRun, id: "second-run", workflowId: "second", input: "Second request" };
  const { restore } = stubWorkflowApi([first, second], [failedRun, secondRun]);
  const requests = noRunRequests();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const page = () => container.querySelector(".workflow-page")?.getAttribute("data-page");
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    assert.equal(page(), "library");
    await openWorkflow(container, "Second flow");
    assert.equal(page(), "workflow");
    assert.equal(container.querySelector<HTMLInputElement>(".workflow-detail-title input")?.value, "Second flow");
    assert.ok(container.querySelector(".workflow-canvas"), "the pipeline is on the page");
    assert.equal(runUi(container), 0);
    assert.ok(!container.textContent?.includes("Second request"), "a run's request never shows in the window");
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="More workflow actions"]')?.click(); await settle(); });
    assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
      ["Duplicate", "Delete workflow"], "secondary actions live in one menu");
    await act(async () => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); await settle(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="All workflows"]')?.click(); await settle(); });
    assert.equal(page(), "library");
    assert.deepEqual(requests.calls, []);
  } finally {
    await act(async () => { root.unmount(); });
    requests.restore();
    restore();
    container.remove();
  }
});

test("library cards stay compact: counts instead of role chains, examples as a badge, every template copies into an editable copy", async () => {
  const example: WorkflowDto = { ...workflow, id: "example", name: "Example · Build & Review", revision: 1,
    nodes: [{ id: "scout", role: "Codebase Scout", prompt: "Scout" }, { id: "build", role: "Builder", prompt: "Build" }],
    edges: [{ id: "scout-build", source: "scout", target: "build" }] };
  const { restore } = stubWorkflowApi([example], [failedRun]);
  const originalCreate = api.createWorkflow;
  const created: Array<Parameters<typeof api.createWorkflow>[0]> = [];
  api.createWorkflow = async (input) => {
    created.push(input);
    return { ...input, id: "copy", revision: 1, createdAt: 3, updatedAt: 3 } as WorkflowDto;
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    const card = container.querySelector('.workflow-card-main[aria-label="Open Build & Review"]');
    assert.ok(card, "the example prefix is not part of the card name");
    assert.equal(card.querySelector(".workflow-card-badge")?.textContent, "Example");
    assert.equal(card.querySelector(".workflow-card-meta > span")?.textContent, "2 agents · 2 stages");
    assert.match(card.querySelector(".workflow-card-description")?.textContent ?? "", /review it independently/,
      "an example seeded without a description borrows the catalog's");
    assert.ok(!container.querySelector(".workflow-page")?.textContent?.includes("Codebase Scout → Builder"),
      "the role chain is not printed on the library");
    assert.deepEqual([...container.querySelectorAll(".workflow-shelf-title")].map((title) => title.firstChild?.textContent),
      ["Templates"], "saved workflows and bundled templates are one list");
    assert.equal(container.querySelectorAll(".workflow-card").length,
      container.querySelectorAll(".workflow-card-copy-action").length, "every card offers the same copy action");
    assert.ok(!container.querySelector(".workflow-card-run"), "a template has no run status");
    assert.ok(!/Failed/.test(container.querySelector(".workflow-page")?.textContent ?? ""),
      "a failed run in a chat never marks its template");
    const copy = [...container.querySelectorAll<HTMLButtonElement>(".workflow-card-copy-action")]
      .find((button) => button.getAttribute("aria-label") === "Duplicate Build + Review");
    assert.ok(copy, "a bundled template copies like any other");
    await act(async () => { copy.click(); await settle(); });
    assert.equal(created.length, 1);
    assert.equal(container.querySelector(".workflow-page")?.getAttribute("data-page"), "workflow");
    assert.ok(container.querySelector('button[aria-label="Add worker after selected node"]'), "the copy opens on its editable pipeline");
  } finally {
    await act(async () => { root.unmount(); });
    api.createWorkflow = originalCreate;
    restore();
    container.remove();
  }
});

test("a template's page shows only settings, never a run of this or another chat", async () => {
  const otherChatRun: WorkflowRunDto = { ...failedRun, id: "other-chat-run", parentSessionId: "another-chat", input: "Someone else's request" };
  const { restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [otherChatRun, failedRun]);
  const requests = noRunRequests();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, workflow.name);
    assert.ok(!container.textContent?.includes("Someone else's request"));
    assert.ok(!container.textContent?.includes(failedRun.input));
    assert.equal(runUi(container), 0);
    assert.deepEqual(requests.calls, []);
  } finally {
    await act(async () => { root.unmount(); });
    requests.restore();
    restore();
    container.remove();
  }
});

test("a held unit continues in place on another model from its card, kept for future runs", async () => {
  const models = [
    { providerID: "openai", modelID: "gpt-gone", name: "GPT Gone", connected: true },
    { providerID: "openai", modelID: "gpt-good", name: "GPT Good", connected: true },
  ];
  setModels(models);
  const heldRun: WorkflowRunDto = { ...failedRun, id: "held-run", status: "running", finishedAt: undefined, result: undefined,
    nodes: [{ id: "review", role: "Reviewer", status: "error", retryable: true, needsFix: true,
      model: { providerID: "openai", modelID: "gpt-gone" },
      error: "gpt-gone is not available on this engine. Pick a model from the list." }] };
  const originalRetry = api.retryWorkflowRun;
  const originalGet = api.getWorkflowRun;
  const originalHarness = api.harnessSnapshots;
  const retries: Array<Parameters<typeof api.retryWorkflowRun>[1]> = [];
  api.harnessSnapshots = async () => [];
  api.getWorkflowRun = async () => heldRun;
  api.retryWorkflowRun = async (_runId, input) => {
    retries.push(input);
    return { ...heldRun, nodes: [{ id: "review", role: "Reviewer", status: "queued", model: input.replacement?.model }] };
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); root.render(createElement(WorkflowTimelineCard, { run: heldRun })); await settle(); });
    const unit = container.querySelector<HTMLElement>(".workflow-timeline-nodes > li.needs-fix");
    assert.ok(unit, "the held unit is marked for a fix");
    assert.match(unit.textContent ?? "", /Waiting for your fix/);
    const proceed = buttonByText(unit, "Continue");
    assert.ok(proceed && !proceed.disabled, "a running run can be fixed in place");
    assert.ok(!unit.querySelector(".workflow-retry-save"), "nothing to keep before another route is chosen");
    await act(async () => { unit.querySelector<HTMLButtonElement>(".model-picker-trigger")?.click(); await settle(); });
    const row = [...document.querySelectorAll<HTMLElement>(".model-picker-row")].find((element) => element.textContent?.includes("GPT Good"));
    assert.ok(row, "the replacement comes from the shared model picker");
    await act(async () => { row.click(); await settle(); });
    const keep = unit.querySelector<HTMLInputElement>(".workflow-retry-save input");
    assert.ok(keep?.checked, "a new route is kept for future runs by default");
    await act(async () => { buttonByText(unit, "Continue")?.click(); await settle(); await settle(); });
    assert.equal(retries.length, 1);
    assert.equal(retries[0]!.nodeId, "review");
    assert.deepEqual(retries[0]!.replacement?.model, { providerID: "openai", modelID: "gpt-good" });
    assert.equal(retries[0]!.saveToWorkflow, true);
  } finally {
    await act(async () => { root.unmount(); });
    api.retryWorkflowRun = originalRetry;
    api.getWorkflowRun = originalGet;
    api.harnessSnapshots = originalHarness;
    container.remove();
  }
});

test("the chat card keeps a gapped result compact and leaves continuing to the chat", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  drainInserts();
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: failedRun })); });
    assert.equal(container.querySelector(".workflow-timeline-result p")?.textContent, COMPACT);
    // The parent agent already receives the result as canonical context; the
    // card offers no composer hand-off.
    assert.equal(buttonByText(container, "Continue in chat"), undefined);
    assert.deepEqual(drainInserts(), []);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a run's card reads rounds and verdicts per unit, and its report and route open with the unit", async () => {
  const reviewed: WorkflowDto = {
    ...workflow, id: "reviewed", name: "Build and review", revision: 1,
    nodes: [
      { id: "builder", role: "Builder", prompt: "Build", kind: "worker" },
      { id: "review", role: "Reviewer", prompt: "Review", kind: "review" },
    ],
    edges: [{ id: "e", source: "builder", target: "review" }],
    defaults: { permissions: "manual", reviewRounds: 2 },
  };
  const reworking: WorkflowRunDto = {
    ...doneRun, id: "reworking", workflowId: reviewed.id, name: reviewed.name, status: "running", result: undefined,
    definition: reviewed, layers: [["builder"], ["review"]],
    nodes: [
      { id: "builder", role: "Builder", status: "running", round: 2, sessionId: "builder-child", activity: "tool: edit", output: "Fixing the icon.", routedRole: "implement",
        harness: { mode: "pinned", harnessId: "opencode" }, model: { providerID: "p", modelID: "fast-1" } },
      { id: "review", role: "Reviewer", status: "done", round: 1, verdict: "changes-requested", sessionId: "review-child", output: "Icon is a box.\n\nVerdict: changes requested" },
    ],
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const texts = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent?.trim());
  const originalGet = api.getWorkflowRun;
  api.getWorkflowRun = async () => reworking;
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: reworking })); await tick(); });
    assert.deepEqual(texts(".workflow-timeline-summary em"), ["Rework round 2"]);
    await openCard(container);
    assert.deepEqual(texts(".workflow-timeline-card li small"), ["Round 2 · tool: edit", "Changes requested · Sent back to Builder"]);
    assert.ok(!container.querySelector(".workflow-run-usage"), "nothing to record while the run is running");
    const toggle = container.querySelector<HTMLButtonElement>(".workflow-timeline-nodes > li.status-running .workflow-timeline-details-toggle");
    assert.ok(toggle, "a unit with a route and a report opens its details");
    await act(async () => { toggle.click(); await tick(); });
    assert.ok(texts(".workflow-timeline-node-details p").includes("By role: Implement → opencode · fast-1"), "the route reads with its role");
    // Opening the card and the unit are the two steps; the report reads at once.
    assert.deepEqual(texts(".workflow-run-unit-report > h4"), ["Report"]);
    assert.deepEqual(texts(".workflow-run-unit-report > pre"), ["Fixing the icon."]);
  } finally {
    api.getWorkflowRun = originalGet;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("run defaults are edited on the template page and saved with the template", async () => {
  const saved: WorkflowDto = { ...workflow, revision: 1, defaults: { permissions: "manual", maxParallel: 2, nodeTimeoutMs: 60_000, reviewRounds: 2 } };
  const { restore } = stubWorkflowApi([saved], []);
  const originalUpdate = api.updateWorkflow;
  const writes: Array<Parameters<typeof api.updateWorkflow>[1]> = [];
  api.updateWorkflow = async (_id, patch) => { writes.push(patch); return { ...saved, ...patch, revision: 1 + writes.length } as WorkflowDto; };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const field = (label: string) => [...container.querySelectorAll<HTMLLabelElement>(".workflow-run-options .workflow-field")]
    .find((item) => item.querySelector("span")?.textContent === label)?.querySelector<HTMLInputElement>("input");
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 760)); });
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, workflow.name);
    assert.equal(container.querySelector("#workflow-defaults-title")?.textContent, "Defaults for runs");
    const parallel = field("Parallel workers");
    const timeout = field("Timeout (seconds)");
    assert.ok(parallel && timeout, "the four run options are template settings");
    assert.equal(parallel.value, "2");
    assert.equal(timeout.value, "60");
    await act(async () => { type(parallel, "5"); await tick(); });
    await flush();
    assert.equal(writes.at(-1)?.defaults?.maxParallel, 5, "the new default is saved with the template");
    assert.equal(writes.at(-1)?.defaults?.nodeTimeoutMs, 60_000);
    const saves = writes.length;
    await act(async () => { type(parallel, "0"); await tick(); });
    await flush();
    assert.equal(writes.length, saves, "an invalid value is never saved");
    assert.equal(parallel.getAttribute("aria-invalid"), "true", "the field says why");
  } finally {
    await act(async () => { root.unmount(); });
    api.updateWorkflow = originalUpdate;
    restore();
    container.remove();
  }
});

test("a review held for a decision is settled in the card with both sides shown", async () => {
  const blocker = { severity: "blocker" as const, path: "src/cache.ts", line: 12, message: "the cache key ignores the tenant" };
  const held: WorkflowRunDto = {
    ...doneRun, id: "held", name: "Disputed review", status: "running", result: undefined,
    layers: [["builder"], ["review"]],
    nodes: [
      { id: "builder", role: "Builder", status: "done", round: 3, sessionId: "builder-child", output: "Left it." },
      {
        id: "review", role: "Reviewer", status: "done", round: 3, roundLimit: 3, verdict: "changes-requested", sessionId: "review-child",
        output: "Verdict: changes requested",
        findings: [blocker, { severity: "note", message: "consider a clearer name" }],
        needsDecision: { items: [{ finding: blocker, reply: "already scoped upstream" }, { finding: { severity: "blocker", message: "no tests" } }], canAnotherRound: true },
      },
    ],
  };
  const decisions: Array<Parameters<typeof workflowDecisionApi.decide>[1]> = [];
  const originalDecide = workflowDecisionApi.decide;
  const originalGet = api.getWorkflowRun;
  api.getWorkflowRun = async () => held;
  workflowDecisionApi.decide = async (_runId, input) => { decisions.push(input); return held; };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const texts = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent?.trim());
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run: held })); await tick(); });
    const unit = [...container.querySelectorAll<HTMLElement>(".workflow-timeline-nodes > li")].find((element) => element.querySelector(".workflow-dispute"));
    assert.ok(unit?.classList.contains("needs-human"), "the held review is marked as waiting for a person");
    assert.match(unit?.textContent ?? "", /Waiting for your decision/);
    assert.deepEqual(texts(".workflow-dispute-columns > span"), ["Reviewer", "Builder"], "one header names the two sides");
    assert.equal(texts(".workflow-dispute-title")[0], "The review rounds are used up");
    assert.deepEqual(texts(".workflow-dispute-text.is-empty"), ["No reply"]);
    assert.ok(texts(".workflow-dispute-text").includes("already scoped upstream"));
    assert.deepEqual(texts(".workflow-dispute-actions button"), ["Accept as is", "Another round"]);
    assert.deepEqual(texts(".workflow-timeline-card .ui-btn--primary"), ["Accept as is"], "the person's call has one filled button");
    assert.deepEqual(texts(".workflow-dispute-actions .ui-btn--ghost"), ["Another round"], "the other choice is a text button");
    assert.ok(!container.querySelector(".workflow-dispute-note"), "the note field stays hidden until asked for");
    // The review's own findings (notes only; blockers are read once, in the decision) open with its details.
    await act(async () => { unit!.querySelector<HTMLButtonElement>(".workflow-timeline-details-toggle")?.click(); await tick(); });
    assert.deepEqual(texts(".workflow-finding-mark"), ["Note"], "open blockers are read once, in the decision card");

    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>(".workflow-dispute-actions button")][1]!.click(); await tick(); });
    const note = container.querySelector<HTMLTextAreaElement>(".workflow-dispute-note textarea");
    assert.ok(note, "Another round reveals an optional note");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Key it by tenant id");
      note.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
      await tick();
    });
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>(".workflow-dispute-actions button")][0]!.click(); await settle(); });
    assert.equal(decisions.length, 1);
    assert.deepEqual({ ...decisions[0], clientOperationId: undefined }, { nodeId: "review", action: "another-round", note: "Key it by tenant id", clientOperationId: undefined });
  } finally {
    workflowDecisionApi.decide = originalDecide;
    api.getWorkflowRun = originalGet;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a failed new-chat start stays in its chat: request shown, Retry reuses the operation id, Dismiss puts the request back", async () => {
  const original = { listWorkflows: api.listWorkflows, getWorkflowPreferences: api.getWorkflowPreferences, runWorkflow: api.runWorkflow };
  const attempts: Array<Parameters<typeof api.runWorkflow>> = [];
  let failNext = true;
  api.listWorkflows = async () => [workflow];
  api.getWorkflowPreferences = async () => ({ selectedId: workflow.id, pinnedIds: [], recentIds: [] });
  api.runWorkflow = async (...args) => {
    attempts.push(args);
    if (failNext) throw new Error("server busy");
    return { ...doneRun, id: "admitted", parentSessionId: "start-chat", status: "running" } as WorkflowRunDto;
  };
  const request = "Ship the export retry\nwith a note";
  const begin = (parent: string) => void beginWorkflowStart(
    { parentSessionId: parent, projectId: "project", workflowId: workflow.id, name: workflow.name, input: request },
    () => api.runWorkflow(workflow.id, parent, request, undefined, { clientOperationId: "op-fixed", context: "recent" }),
    (cause) => String((cause as Error).message),
  ).catch(() => undefined);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mount = async (sessionId: string, draftText = "") => {
    await act(async () => { root.render(createElement(WorkflowLauncher, { projectId: "project", sessionId, draftText })); await settle(); });
  };
  const openPanel = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>(".composer-workflow")?.click(); await settle(); await settle(); });
  };
  const row = () => document.querySelector<HTMLElement>(".workflow-launch-start");
  try {
    await mount("start-chat");
    assert.equal(row(), null, "nothing without a tracked start");
    // In flight: the launcher button shows its busy state, no row yet.
    await act(async () => { failNext = true; begin("start-chat"); await settle(); });
    await act(async () => { await settle(); });
    // Failed: attention on the button, the row holds the request.
    assert.equal(container.querySelector(".composer-workflow")?.getAttribute("data-attention"), "true");
    await openPanel();
    assert.ok(row(), "the failed start shows above the list");
    assert.match(row()?.textContent ?? "", /Release review did not start/);
    assert.match(row()?.textContent ?? "", /server busy/);
    assert.equal(row()?.querySelector(".workflow-launch-start-request")?.getAttribute("title"), request, "the full request is in the title");
    assert.equal(row()?.querySelector(".workflow-launch-start-request")?.textContent, request);
    assert.ok(!buttonByText(row()!, "Copy request"), "an empty composer restores the text instead");

    failNext = false;
    await act(async () => { buttonByText(row()!, "Retry")?.click(); await settle(); await settle(); });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]![4]?.clientOperationId, "op-fixed");
    assert.equal(attempts[1]![4]?.clientOperationId, attempts[0]![4]?.clientOperationId, "a retry reuses the operation id");
    assert.equal(row(), null, "the row goes once the run is admitted");
    assert.equal(workflowStartFor("start-chat"), undefined);

    // Dismiss removes the row and puts the request back into an empty composer.
    failNext = true;
    await act(async () => { begin("start-chat"); await settle(); await settle(); });
    drainComposerReplacement();
    assert.ok(row(), "a second failure shows the row again");
    await act(async () => { buttonByText(row()!, "Dismiss")?.click(); await settle(); });
    assert.equal(row(), null);
    assert.equal(workflowStartFor("start-chat"), undefined);
    assert.equal(drainComposerReplacement(), request, "the request returns to the composer");

    // With a draft already typed, the request is offered as a copy instead of replacing it.
    await act(async () => { begin("start-chat"); await settle(); await settle(); });
    await mount("start-chat", "Something else");
    await openPanel();
    assert.ok(buttonByText(row()!, "Copy request"));
    await act(async () => { buttonByText(row()!, "Dismiss")?.click(); await settle(); });
    assert.equal(drainComposerReplacement(), undefined, "a typed draft is never replaced");

    // Another chat never shows this chat's start.
    await act(async () => { begin("start-chat"); await settle(); await settle(); });
    await mount("other-chat");
    assert.equal(container.querySelector(".composer-workflow")?.getAttribute("data-attention"), null);
    await openPanel();
    assert.equal(row(), null);
  } finally {
    dismissWorkflowStart("start-chat");
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

/** Mounts a run card with polling answered by the same run. */
async function withCard(run: WorkflowRunDto, check: (container: HTMLElement) => Promise<void>) {
  const original = { getWorkflowRun: api.getWorkflowRun, harnessSnapshots: api.harnessSnapshots };
  api.getWorkflowRun = async () => run;
  api.harnessSnapshots = async () => [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); await tick(); });
    await check(container);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
}

const agentRun = (patch: Partial<WorkflowRunDto>): WorkflowRunDto => ({
  id: "agent-run", workflowId: workflow.id, projectId: "project", parentSessionId: "parent",
  name: "Build + Review", input: "Add a retry", startedAt: Date.now() - 30_000, status: "running", wake: true,
  layers: [["builder"], ["review"]],
  nodes: [
    { id: "builder", role: "Builder", status: "done", sessionId: "builder-child", output: "Added it." },
    { id: "review", role: "Reviewer", status: "running", sessionId: "review-child", activity: "Reading src/export.ts" },
  ],
  ...patch,
});

test("an agent-steered run that goes fine is one quiet block; units and actions open with it", async () => {
  await withCard(agentRun({}), async (container) => {
    const card = container.querySelector<HTMLElement>(".workflow-timeline-card");
    assert.equal(card?.classList.contains("is-agent-steered"), true);
    assert.equal(card?.classList.contains("has-attention"), false, "no alarm while the agent runs it");
    assert.doesNotMatch(container.textContent ?? "", /waiting for you/i);
    assert.equal(container.querySelector(".workflow-timeline-now")?.textContent, "Reviewer · Reading src/export.ts");
    assert.equal(Boolean(container.querySelector(".workflow-timeline-nodes")), false, "no unit rows");
    assert.equal(Boolean(container.querySelector(".workflow-run-usage")), false, "no outcome question");
    assert.equal(Boolean(container.querySelector(".workflow-timeline-card > footer")), false, "no footer of buttons");
    assert.equal(container.querySelectorAll("button").length, 1, "the one control is the toggle that opens it");
    await openCard(container);
    assert.equal(container.querySelectorAll(".workflow-timeline-nodes > li").length, 2);
    assert.ok(container.querySelector('button[aria-label="Open Reviewer child session"]'), "a unit's chat opens from its row");
    assert.ok(container.querySelector('button[aria-label="Stop Build + Review workflow run"]'), "the person can still stop it");
    assert.ok(buttonByText(container, "Workflow settings"));
  });
});

test("an agent-steered gate says the agent is on it, and Step in opens the decision", async () => {
  const blocker = { severity: "blocker" as const, message: "no tests" };
  const gate = agentRun({ nodes: [
    { id: "builder", role: "Builder", status: "done", sessionId: "builder-child" },
    { id: "review", role: "Reviewer", status: "done", sessionId: "review-child", round: 3, roundLimit: 3,
      verdict: "changes-requested", findings: [blocker], needsDecision: { items: [{ finding: blocker }], canAnotherRound: true } },
  ] });
  await withCard(gate, async (container) => {
    assert.equal(Boolean(container.querySelector(".workflow-timeline-card.has-attention")), false, "the agent's gate is no alarm");
    assert.doesNotMatch(container.textContent ?? "", /waiting for you|Waiting for your decision/i);
    assert.equal(container.querySelector(".workflow-timeline-agent")?.textContent, "The agent is on it · Reviewer: Review rounds used up");
    assert.equal(Boolean(container.querySelector(".workflow-dispute")), false, "the decision waits behind Step in");
    const stepIn = buttonByText(container, "Step in");
    assert.ok(stepIn, "the person can take over");
    await act(async () => { stepIn.click(); await tick(); });
    assert.equal(Boolean(buttonByText(container, "Step in")), false);
    const unit = [...container.querySelectorAll<HTMLElement>(".workflow-timeline-nodes > li")].find((row) => row.querySelector(".workflow-dispute"));
    assert.ok(unit, "the decision opens under the held review");
    assert.equal(unit.classList.contains("agent-handling"), true);
    assert.equal(unit.classList.contains("needs-human"), false);
    assert.equal(unit.querySelector("small")?.textContent, "Round 3 · Review rounds used up");
    assert.ok(buttonByText(container, "Accept as is"), "the gate can be settled by the person");
    assert.equal(container.querySelectorAll(".workflow-timeline-card .ui-btn--primary").length, 0,
      "stepping in on the agent's call offers no filled button");
  });
});

test("an agent-steered held unit offers its fix after Step in, with the reason", async () => {
  const held = agentRun({ nodes: [
    { id: "builder", role: "Builder", status: "error", retryable: true, needsFix: true, error: "gpt-gone is not available." },
    { id: "review", role: "Reviewer", status: "queued" },
  ] });
  await withCard(held, async (container) => {
    assert.equal(Boolean(container.querySelector(".workflow-timeline-card.has-attention")), false);
    assert.equal(container.querySelector(".workflow-timeline-agent")?.textContent, "The agent is on it · Builder: Held for another route");
    assert.equal(Boolean(container.querySelector(".workflow-retry-controls")), false);
    await act(async () => { buttonByText(container, "Step in")?.click(); await tick(); });
    assert.equal(container.querySelectorAll(".workflow-retry-controls").length, 1);
    assert.equal(container.querySelectorAll(".workflow-timeline-card .ui-btn--primary").length, 0, "no filled Continue on the agent's fix");
    assert.equal(container.querySelector(".workflow-timeline-node-reason")?.textContent, "gpt-gone is not available.");
    assert.ok(buttonByText(container, "Continue"));
  });
});

test("an approval inside an agent-steered unit still asks the person", async () => {
  await withCard(agentRun({ nodes: [
    { id: "review", role: "Reviewer", status: "running", sessionId: "review-child", activity: "awaiting permission: bash" },
  ] }), async (container) => {
    assert.equal(Boolean(container.querySelector(".workflow-timeline-card.has-attention")), true);
    assert.match(container.textContent ?? "", /1 waiting for you/);
    assert.equal(container.querySelector(".needs-human button")?.getAttribute("aria-label"), "Review and respond in Reviewer child session");
  });
});

test("an agent-steered settled run reads its recorded outcome as text; Change and Run again open with the card", async () => {
  const settled = agentRun({ status: "done", finishedAt: Date.now(), result: "Retries twice with backoff.",
    nodes: [{ id: "builder", role: "Builder", status: "done", sessionId: "builder-child" }],
    outcome: { value: "accepted", at: 5, by: "agent" } });
  await withCard(settled, async (container) => {
    assert.equal(container.querySelector(".workflow-timeline-result p")?.textContent, "Retries twice with backoff.");
    assert.equal(container.querySelector(".workflow-run-usage-text")?.textContent, "Result: Accepted · recorded by the agent");
    assert.equal(container.querySelectorAll("button").length, 1, "only the toggle: no Change, no Run again, no settings");
    await openCard(container);
    assert.ok(buttonByText(container, "Change"), "the record can be changed from the opened card");
    assert.ok(buttonByText(container, "Run again"));
  });
  await withCard({ ...settled, id: "agent-unrecorded", outcome: undefined }, async (container) => {
    assert.equal(container.querySelector(".workflow-run-usage-text")?.textContent, "How was the result used?",
      "nothing was recorded, so the reader is asked");
    assert.ok(buttonByText(container, "Accepted"));
  });
});
