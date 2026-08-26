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
const { api } = await import("@polyth/session/web-api");
const { activateProject, getState, setActiveView, setModels, startNewSession } = await import("../../../apps/web/src/store.ts");
const { setWorkspaceMode } = await import("../../../apps/web/src/widgets/workspaceMode.ts");
const { installBuiltinMiniWidgets, WORKFLOW_WIDGET_PLUGIN } =
  await import("../../../apps/web/src/widgets/builtinMiniWidgets.tsx");
const { default: Composer } = await import("../../../apps/web/src/components/Composer.tsx");
const { default: WorkflowTimelineCard } = await import("../widgets/WorkflowTimelineCard.tsx");

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
    assert.equal(trigger?.textContent?.trim(), "Run workflow");
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
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".workflow-launch-task textarea")?.value,
      "Audit the release candidate",
    );
  } finally {
    api.composerCatalog = originalComposerCatalog;
    api.listWorkflows = originalListWorkflows;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("new-session creation immediately replaces the empty composer with loading feedback", async () => {
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

    assert.equal(container.querySelector(".session-loading")?.textContent?.trim(), "Loading session…");
    assert.equal(container.querySelector('[aria-label="Message"]'), null, "a second draft cannot be lost while creation is pending");

    await act(async () => {
      releaseCreate();
      await sent;
      await Promise.resolve();
    });
  } finally {
    releaseCreate();
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
    assert.equal(trigger?.textContent?.trim(), "Run workflow");
    assert.equal(trigger?.getAttribute("aria-label"), "Run workflow");
    assert.equal(trigger?.getAttribute("aria-haspopup"), "dialog");

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    assert.equal(getState().activeView, "session", "opening the picker must not navigate to the builder");
    assert.ok(document.querySelector('[role="dialog"][aria-label="Run a workflow"]'));
    assert.equal(
      document.querySelector(".workflow-launch-backdrop")?.parentElement,
      document.body,
      "the launcher escapes composer visual containing blocks",
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".workflow-launch-task textarea")?.value,
      "Audit the release candidate",
    );
    assert.match(document.body.textContent ?? "", /Release review/);
    assert.match(document.body.textContent ?? "", /manual approval/);
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
    assert.equal(document.querySelectorAll(".workflow-launch-skeleton .workflow-launch-row").length, 3);
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

test("workflow launcher retries a failed list without losing the task", async () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  const originalListWorkflows = api.listWorkflows;
  let attempts = 0;
  api.listWorkflows = async () => {
    attempts++;
    if (attempts === 1) throw new Error("synthetic list failure");
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
    assert.match(document.body.textContent ?? "", /Workflows couldn’t be loaded/);
    assert.equal(
      (document.body.textContent ?? "").match(/Workflows couldn’t be loaded/g)?.length,
      1,
      "the failed state does not repeat its heading",
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".workflow-launch-task textarea")?.value,
      "Keep this workflow task",
    );

    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Retry")
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 2);
    assert.match(document.body.textContent ?? "", /Release review/);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".workflow-launch-task textarea")?.value,
      "Keep this workflow task",
    );
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
      document.querySelector<HTMLButtonElement>('button[aria-label="Run Release review workflow"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(consumed, 1);
    assert.equal(restored, "Audit the release candidate");
    assert.match(document.body.textContent ?? "", /Couldn’t start the workflow/);
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
