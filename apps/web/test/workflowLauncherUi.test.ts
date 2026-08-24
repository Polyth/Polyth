import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../src/api.ts");
const { getState, setActiveView } = await import("../src/store.ts");
const { WORKFLOW_WIDGET_PLUGIN } = await import("../src/widgets/builtinMiniWidgets.tsx");
const { default: WorkflowTimelineCard } = await import("../src/components/WorkflowTimelineCard.tsx");

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
    assert.equal(trigger?.textContent?.trim(), "Run workflow");
    assert.equal(trigger?.getAttribute("aria-haspopup"), "dialog");

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    assert.equal(getState().activeView, "session", "opening the picker must not navigate to the builder");
    assert.ok(container.querySelector('[role="dialog"][aria-label="Run a workflow"]'));
    assert.equal(
      container.querySelector<HTMLTextAreaElement>(".workflow-launch-task textarea")?.value,
      "Audit the release candidate",
    );
    assert.match(container.textContent ?? "", /Release review/);
    assert.match(container.textContent ?? "", /manual approval/);
  } finally {
    api.listWorkflows = originalListWorkflows;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("failed workflow start restores the consumed composer draft", async () => {
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
      container.querySelector<HTMLButtonElement>('button[aria-label="Run Release review workflow"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(consumed, 1);
    assert.equal(restored, "Audit the release candidate");
    assert.match(container.textContent ?? "", /Couldn’t start the workflow/);
  } finally {
    window.removeEventListener("polyth:composer-replace", onReplace);
    api.listWorkflows = originalListWorkflows;
    api.runWorkflow = originalRunWorkflow;
    await act(async () => { root.unmount(); });
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
