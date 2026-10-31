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
const { registerWidgetPlugin } = await import("../../../apps/web/src/widgets/catalog.ts");
const { handOffWorkflowLaunch, takeWorkflowLaunch } = await import("../widgets/workflowLaunch.ts");
const { beginWorkflowStart, dismissWorkflowStart, retryWorkflowStart, workflowStartFor } =
  await import("../widgets/workflowStart.ts");
const { drainInserts } = await import("../../../apps/web/src/composerInsert.ts");
registerWidgetPlugin(WORKFLOW_WIDGET_PLUGIN);

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
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

test("a new-chat launch opens its workflow window at once and a lost response reuses its operation key", async () => {
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
    // The new chat does not wait for admission: the parent and its workflow
    // window open while the start is still in flight.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tick(); });
    assert.equal(getState().activeSessionId, "parent-1", "the parent session opens before admission");
    const intent = takeWorkflowLaunch("project");
    assert.equal(intent?.sessionId, "parent-1", "the workflow window is handed this launch");
    assert.equal(intent?.workflowId, workflow.id);
    assert.equal(workflowStartFor("parent-1")?.status, "starting");
    assert.equal(workflowStartFor("parent-1")?.input, "Exact request");
    assert.equal(consumed, 1, "the task moved into the workflow window");
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

test("a unit the run holds offers Fix in the chat card instead of a retry", async () => {
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
    const fix = container.querySelector<HTMLButtonElement>('button[aria-label="Fix Codebase Scout"]');
    assert.ok(fix, "the held unit offers Fix");
    assert.equal(fix.textContent?.trim(), "Fix");
    assert.ok(!buttonByText(container, "Retry step"), "a running run is never forked from the card");
    assert.ok(container.querySelector(".workflow-timeline-card.has-attention"), "the card asks for attention");
    assert.match(container.textContent ?? "", /Waiting for your fix/);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(api, original);
    container.remove();
  }
});

test("a review held for a decision asks for it in the chat card and points to the run", async () => {
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
    const decide = container.querySelector<HTMLButtonElement>('button[aria-label="Decide on Reviewer"]');
    assert.ok(decide, "the held review offers Decide");
    assert.equal(decide.textContent?.trim(), "Decide");
    assert.ok(!buttonByText(container, "Review & respond"), "the decision is made in the run, not in the reviewer's chat");
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

test("history handoff waits for workflow surface registration and follows unload", async () => {
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
    .find((button) => button.textContent?.trim() === "View workflow");
  try {
    await act(async () => { root.render(createElement(WorkflowTimelineCard, { run })); });
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
    assert.match(container.querySelector(".workflow-timeline-title .workflow-timeline-elapsed")?.textContent ?? "", /^1:0\d$/);
    assert.ok(container.querySelector('button[aria-label="Open Builder child session"]'), "a running agent is one tap away");
    assert.equal(container.querySelector('button[aria-label="Reviewer details"]'), null, "nothing extra to show for a queued node");

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Builder details"]');
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    await act(async () => { toggle?.click(); });
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    const details = container.querySelector(".workflow-timeline-node-details")?.textContent ?? "";
    assert.match(details, /builder-model/);
    assert.match(details, /Agent.*build/);
    assert.match(details, /Elapsed/);
    await act(async () => { toggle?.click(); });
    assert.equal(container.querySelector(".workflow-timeline-node-details"), null);
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

// ---- Workflow view: run panel, library and chat-card layout -------------------

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

test("a failed run keeps its output compact and offers an explicit new run, never a one-click replay", async () => {
  const { started, restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [failedRun]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, workflow.name);
    assert.equal(container.querySelector(".workflow-run-result")?.textContent, COMPACT, "recorded gaps collapse to one blank line");
    assert.equal(container.querySelector(".workflow-node-output")?.textContent, COMPACT);
    assert.equal(Boolean(container.querySelector(".workflow-run-form")), true, "a failed run leaves a way to start a new run");
    assert.ok(!buttonByText(container, "Run again"), "a failed run is not replayed in one click");
    const run = () => buttonByText(container.querySelector(".workflow-run-footer")!, "Run workflow");
    assert.equal(run()?.disabled, true, "the form needs a request before it can launch");
    const input = container.querySelector<HTMLTextAreaElement>(".workflow-run-form textarea");
    assert.ok(input);
    await act(async () => { typeInto(input, "Run the review again"); });
    assert.equal(run()?.disabled, false);
    await act(async () => { run()?.click(); await settle(); await settle(); });
    assert.equal(started.length, 1);
    assert.equal(started[0]!.input, "Run the review again");
    assert.equal(started[0]!.workflowId, workflow.id);
    assert.ok(!container.querySelector(".workflow-run-form"), "the form steps aside while the new run is running");
  } finally {
    await act(async () => { root.unmount(); });
    restore();
    container.remove();
  }
});

test("Run again reruns the recorded request even when the form starts empty", async () => {
  const { started, restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [doneRun]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, workflow.name);
    assert.ok(!container.querySelector(".workflow-run-form"), "a done run keeps its single Run again action");
    const again = buttonByText(container, "Run again");
    assert.ok(again, "done run offers Run again");
    await act(async () => { again.click(); await settle(); await settle(); });
    assert.equal(started.length, 1, "no hand-off is needed for Run again to work");
    assert.equal(started[0]!.input, doneRun.input);
    assert.deepEqual(started[0]!.options, doneRun.options);
  } finally {
    await act(async () => { root.unmount(); });
    restore();
    container.remove();
  }
});

test("opening the view from a run leads with that run's page; a plain open shows the library", async () => {
  const { restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [failedRun]);
  const revealed: string[] = [];
  const originalReveal = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function reveal(this: HTMLElement) { revealed.push(this.className); };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    return async () => { await act(async () => { root.unmount(); }); };
  };
  try {
    let unmount = await mount();
    assert.equal(container.querySelector(".workflow-page")?.getAttribute("data-page"), "library",
      "a plain open starts from the library");
    assert.ok(!container.querySelector(".workflow-run-form"), "no workflow page is mixed into the library");
    assert.deepEqual(revealed, []);
    await unmount();

    handOffWorkflowLaunch({ projectId: "project", workflowId: workflow.id, input: failedRun.input, run: failedRun });
    unmount = await mount();
    assert.equal(container.querySelector(".workflow-page")?.getAttribute("data-page"), "workflow",
      "View workflow leads with the workflow, not the library");
    assert.deepEqual(revealed, ["workflow-run-results"], "the run is brought into view once");
    assert.equal(container.querySelector<HTMLTextAreaElement>(".workflow-run-form textarea")?.value, failedRun.input,
      "the new-run form starts from the request being viewed");
    await unmount();
  } finally {
    HTMLElement.prototype.scrollIntoView = originalReveal;
    restore();
    container.remove();
  }
});

test("a start in flight leads the workflow window and the admitted run replaces it", async () => {
  const { restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [failedRun]);
  let admit!: (run: WorkflowRunDto) => void;
  let fail!: (cause: Error) => void;
  let attempts = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    activateProject("project");
    activateSession("parent");
    void beginWorkflowStart(
      { parentSessionId: "parent", projectId: "project", workflowId: workflow.id, input: "Ship it" },
      () => new Promise((resolve, reject) => { attempts++; admit = resolve; fail = reject; }),
      (cause) => String((cause as Error).message),
    ).catch(() => undefined);
    handOffWorkflowLaunch({ projectId: "project", sessionId: "parent", workflowId: workflow.id, input: "Ship it" });
    await act(async () => { root.render(createElement(WorkflowView)); await settle(); });
    assert.equal(container.querySelector(".workflow-page")?.getAttribute("data-page"), "workflow");
    assert.ok(container.querySelector(".workflow-run-starting"), "the start shows at once");
    assert.equal(container.querySelector(".workflow-run-starting .workflow-run-request")?.textContent, "Ship it");
    assert.ok(!container.querySelector(".workflow-run-form"), "no empty run form while starting");
    assert.ok(!container.textContent?.includes(failedRun.input), "the previous run does not stand in for the new one");

    await act(async () => { fail(new Error("server busy")); await settle(); });
    assert.match(container.querySelector(".workflow-run-starting.failed [role=alert]")?.textContent ?? "", /server busy/);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".workflow-run-starting .workflow-run-actions button")?.click();
      await settle();
    });
    assert.equal(attempts, 2, "Retry resends the same start");
    assert.ok(container.querySelector(".workflow-run-starting:not(.failed)"));

    await act(async () => {
      admit({ ...doneRun, id: "admitted", parentSessionId: "parent", input: "Ship it", status: "running" });
      await settle();
    });
    assert.ok(!container.querySelector(".workflow-run-starting"), "the admitted run takes over");
    assert.equal(container.querySelector(".workflow-run-request")?.textContent, "Ship it");
  } finally {
    dismissWorkflowStart("parent");
    await act(async () => { root.unmount(); });
    activateSession(null);
    restore();
    container.remove();
  }
});

test("choosing a saved workflow opens its own page with its latest run; back returns to the library", async () => {
  const first: WorkflowDto = { ...workflow, revision: 1 };
  const second: WorkflowDto = { ...workflow, id: "second", name: "Second flow", revision: 1 };
  const secondRun: WorkflowRunDto = { ...doneRun, id: "second-run", workflowId: "second", input: "Second request" };
  const { restore } = stubWorkflowApi([first, second], [failedRun, secondRun]);
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
    assert.equal(container.querySelector(".workflow-run-request")?.textContent, "Second request",
      "the page shows this workflow's own latest run, not the first workflow's");
    assert.ok(!container.querySelector(".workflow-canvas"), "the pipeline lives on the Edit tab");
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="More workflow actions"]')?.click(); await settle(); });
    assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
      ["Duplicate", "Delete workflow"], "secondary actions live in one menu");
    await act(async () => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); await settle(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("#workflow-detail-tab-edit")?.click(); await settle(); });
    assert.ok(container.querySelector(".workflow-canvas"));
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="All workflows"]')?.click(); await settle(); });
    assert.equal(page(), "library");
  } finally {
    await act(async () => { root.unmount(); });
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
    assert.equal(container.querySelector("#workflow-detail-tab-edit")?.getAttribute("aria-selected"), "true",
      "a fresh copy opens on its pipeline");
    assert.ok(container.querySelector('button[aria-label="Add worker after selected node"]'), "the copy is editable");
  } finally {
    await act(async () => { root.unmount(); });
    api.createWorkflow = originalCreate;
    restore();
    container.remove();
  }
});

test("a workflow's page shows only this chat's run of it, never another chat's", async () => {
  const otherChatRun: WorkflowRunDto = { ...failedRun, id: "other-chat-run", parentSessionId: "another-chat", input: "Someone else's request" };
  const { restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [otherChatRun]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, workflow.name);
    assert.ok(!container.textContent?.includes("Someone else's request"), "another chat's run stays in that chat");
    assert.ok(!container.querySelector(".workflow-run-results"));
    assert.ok(container.querySelector(".workflow-run-form"), "the page offers a run for this chat");
  } finally {
    await act(async () => { root.unmount(); });
    restore();
    container.remove();
  }
});

test("a held unit continues in place on another model, kept for future runs", async () => {
  const models = [
    { providerID: "openai", modelID: "gpt-gone", name: "GPT Gone", connected: true },
    { providerID: "openai", modelID: "gpt-good", name: "GPT Good", connected: true },
  ];
  setModels(models);
  const heldRun: WorkflowRunDto = { ...failedRun, id: "held-run", status: "running", finishedAt: undefined, result: undefined,
    nodes: [{ id: "review", role: "Reviewer", status: "error", retryable: true, needsFix: true,
      model: { providerID: "openai", modelID: "gpt-gone" },
      error: "gpt-gone is not available on this engine. Pick a model from the list." }] };
  const { restore } = stubWorkflowApi([{ ...workflow, revision: 1 }], [heldRun]);
  const originalRetry = api.retryWorkflowRun;
  const originalGet = api.getWorkflowRun;
  const retries: Array<Parameters<typeof api.retryWorkflowRun>[1]> = [];
  let listed = 0;
  const originalList = api.listWorkflows;
  api.listWorkflows = async (projectId) => { listed++; return originalList(projectId); };
  api.getWorkflowRun = async () => heldRun;
  api.retryWorkflowRun = async (_runId, input) => {
    retries.push(input);
    return { ...heldRun, nodes: [{ id: "review", role: "Reviewer", status: "queued", model: input.replacement?.model }] };
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, workflow.name);
    assert.match(container.querySelector(".workflow-run-notice.wait-fix")?.textContent ?? "", /Reviewer could not start/);
    const unit = container.querySelector<HTMLElement>(".workflow-run-unit.needs-fix");
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
    const listedBefore = listed;
    await act(async () => { buttonByText(unit, "Continue")?.click(); await settle(); await settle(); });
    assert.equal(retries.length, 1);
    assert.equal(retries[0]!.nodeId, "review");
    assert.deepEqual(retries[0]!.replacement?.model, { providerID: "openai", modelID: "gpt-good" });
    assert.equal(retries[0]!.saveToWorkflow, true);
    assert.ok(listed > listedBefore, "the saved template is read back for the library and editor");
  } finally {
    await act(async () => { root.unmount(); });
    api.retryWorkflowRun = originalRetry;
    api.getWorkflowRun = originalGet;
    restore();
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

test("the run panel reads as stages with rounds and verdicts, and the options stay minimal", async () => {
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
      { id: "builder", role: "Builder", status: "running", round: 2, sessionId: "builder-child", activity: "tool: edit", output: "Fixing the icon." },
      { id: "review", role: "Reviewer", status: "done", round: 1, verdict: "changes-requested", sessionId: "review-child", output: "Icon is a box.\n\nVerdict: changes requested" },
    ],
  };
  const approved: WorkflowRunDto = {
    ...reworking, id: "approved", status: "done", result: "All good.\n\nVerdict: approved", startedAt: 5,
    nodes: [
      { id: "builder", role: "Builder", status: "done", round: 2, sessionId: "builder-child", output: "Fixed." },
      { id: "review", role: "Reviewer", status: "done", round: 2, verdict: "approved", sessionId: "review-child", output: "All good.\n\nVerdict: approved" },
    ],
  };
  const { restore } = stubWorkflowApi([reviewed], [approved]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const texts = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent?.trim());
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, reviewed.name);
    assert.deepEqual(texts(".workflow-run-stage-label"), ["Stage 1", "Stage 2"], "units are grouped by the run's own stages");
    assert.deepEqual(texts(".workflow-run-unit-round"), ["Round 2", "Round 2"]);
    assert.deepEqual(texts(".workflow-run-unit-verdict"), ["Approved"]);
    assert.deepEqual(texts(".workflow-run-unit-report > summary"), ["Report", "Report"], "reports stay folded by default");
    assert.equal(container.querySelector(".workflow-run-unit-report .workflow-node-output")?.textContent, "Fixed.");
    assert.equal(container.querySelector(".workflow-run-result")?.textContent, "All good.\n\nVerdict: approved");
    assert.ok(!container.querySelector(".workflow-run-notice.waiting"), "an approved run carries no unresolved-review notice");

    await act(async () => { container.querySelector<HTMLButtonElement>("#workflow-detail-tab-edit")?.click(); await settle(); });
    assert.deepEqual(texts(".workflow-canvas-stage-label"), ["Stage 1", "Stage 2"]);
    assert.deepEqual(texts(".workflow-node-gate"), ["Can send work back"], "the reviewer card says what it can do");
    assert.ok(!container.querySelector('select[aria-label="Execution profile"]'), "profiles are gone");
    assert.ok(!container.querySelector('select[aria-label="Workflow category"]'), "categories are gone");
    assert.ok(!container.querySelector(".workflow-category-tabs"));
  } finally {
    await act(async () => { root.unmount(); });
    restore();
    container.remove();
  }

  // A review that sent work back shows where it went, in the view and in chat.
  const { restore: restoreRework } = stubWorkflowApi([reviewed], [reworking]);
  const again = document.createElement("div");
  document.body.appendChild(again);
  const reworkRoot = createRoot(again);
  const text = (selector: string) => [...again.querySelectorAll(selector)].map((element) => element.textContent?.trim());
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); reworkRoot.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(again, reviewed.name);
    assert.deepEqual(text(".workflow-run-unit-verdict"), ["Changes requested"]);
    assert.deepEqual(text(".workflow-run-unit.status-done .workflow-node-activity"), ["Sent back to Builder"]);
    assert.deepEqual(text(".workflow-run-unit.status-running .workflow-node-activity"), ["tool: edit"]);
    assert.ok(!again.querySelector(".workflow-run-form"), "a running run shows no second form");
    await act(async () => { reworkRoot.unmount(); });
  } finally {
    restoreRework();
  }
  try {
    const card = createRoot(again);
    await act(async () => { card.render(createElement(WorkflowTimelineCard, { run: reworking })); });
    assert.deepEqual(text(".workflow-timeline-card li small"), ["Round 2 · tool: edit", "Changes requested · Sent back to Builder"]);
    assert.deepEqual(text(".workflow-timeline-summary em"), ["Rework round 2"]);
    await act(async () => { card.unmount(); });
  } finally {
    again.remove();
  }
});

test("a review held for a decision shows its findings and a dispute card with both sides", async () => {
  const reviewed: WorkflowDto = {
    ...workflow, id: "disputed", name: "Disputed review", revision: 1,
    nodes: [
      { id: "builder", role: "Builder", prompt: "Build", kind: "worker" },
      { id: "review", role: "Reviewer", prompt: "Review", kind: "review" },
    ],
    edges: [{ id: "e", source: "builder", target: "review" }],
    defaults: { permissions: "manual", reviewRounds: 2 },
  };
  const blocker = { severity: "blocker" as const, path: "src/cache.ts", line: 12, message: "the cache key ignores the tenant" };
  const held: WorkflowRunDto = {
    ...doneRun, id: "held", workflowId: reviewed.id, name: reviewed.name, status: "running", result: undefined,
    definition: reviewed, layers: [["builder"], ["review"]],
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
  const { restore } = stubWorkflowApi([reviewed], [held]);
  const decisions: Array<Parameters<typeof workflowDecisionApi.decide>[1]> = [];
  const originalDecide = workflowDecisionApi.decide;
  workflowDecisionApi.decide = async (_runId, input) => { decisions.push(input); return held; };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const texts = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent?.trim());
  try {
    await act(async () => { activateProject("project"); activateSession("parent"); root.render(createElement(WorkflowView)); await settle(); });
    await openWorkflow(container, reviewed.name);
    assert.deepEqual(texts(".workflow-finding-mark"), ["Note"], "open blockers are read once, in the decision card");
    assert.deepEqual(texts(".workflow-finding-path"), ["src/cache.ts:12"], "the location reads in mono in the dispute");
    const unit = [...container.querySelectorAll<HTMLElement>(".workflow-run-unit")].find((element) => element.querySelector(".workflow-dispute"));
    assert.ok(unit?.classList.contains("needs-human"), "the held review is marked as waiting for a person");
    assert.match(unit?.textContent ?? "", /Waiting for your decision/);
    assert.deepEqual(texts(".workflow-dispute-columns > span"), ["Reviewer", "Builder"], "one header names the two sides");
    assert.deepEqual(texts(".workflow-run-unit-round"), ["Round 3", "Round 3 of 3"], "the builder keeps its plain round; the review shows the limit");
    assert.equal(texts(".workflow-dispute-title")[0], "The review rounds are used up");
    assert.deepEqual(texts(".workflow-dispute-label"), ["Reviewer", "Builder", "Reviewer", "Builder"]);
    assert.deepEqual(texts(".workflow-dispute-text.is-empty"), ["No reply"]);
    assert.ok(texts(".workflow-dispute-text").includes("already scoped upstream"));
    assert.deepEqual(texts(".workflow-dispute-actions button"), ["Accept as is", "Another round"]);
    assert.ok(!container.querySelector(".workflow-dispute-note"), "the note field stays hidden until asked for");

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
    await act(async () => { root.unmount(); });
    restore();
    container.remove();
  }
});
