// The workflow status-bar segment is this package's UI. Moved out of
// apps/web/test/statusBar.test.ts, whose host contract now discovers and
// installs whichever package contributes a status-bar segment instead of
// requiring that a removable package is present.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import type { WorkflowRunDto } from "@polyth/contracts";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { default: StatusBar } = await import("../../../apps/web/src/components/StatusBar.tsx");
const { installBuiltinAreas } = await import("../../../apps/web/src/widgets/builtinAreas.ts");
const { installBuiltinMiniWidgets } = await import("../../../apps/web/src/widgets/builtinMiniWidgets.tsx");
const { installStatusbarWidgets } = await import("../../../apps/web/src/widgets/statusbarWidgets.tsx");
const { listWidgets } = await import("../../../apps/web/src/widgets/catalog.ts");
const {
  applyWidgetLayoutMutations,
  getWidgetLayout,
  updateWidgetLayout,
  widgetSlotOf,
} = await import("../../../apps/web/src/widgets/widgetLayout.ts");
const { setUiSettings } = await import("../../../apps/web/src/uiPrefs.ts");
const { activateProject, activateSession, applyProjectUpsert, setSessions } = await import("../../../apps/web/src/store.ts");
const { webPackageHost } = await import("../../../apps/web/src/packages/webHost.ts");
const { default: installWorkflowWidgets } = await import("../widgets/index.tsx");

installBuiltinAreas();
installBuiltinMiniWidgets();
installStatusbarWidgets();
installWorkflowWidgets(webPackageHost)();

const LEADING = "app.statusbar.leading" as const;
const TRAILING = "app.statusbar.trailing" as const;
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

type GitStatusResult = Awaited<ReturnType<typeof api.gitStatus>>;
const emptyGitStatus = (): GitStatusResult => ({
  branch: "main", ahead: 0, behind: 0,
  staged: [], unstaged: [], untracked: [], conflicted: [],
});
const workflowRun = (projectId: string, activity?: string): WorkflowRunDto => ({
  id: "run-1",
  workflowId: "wf-1",
  projectId,
  parentSessionId: `${projectId}-session`,
  name: "Release audit",
  input: "Audit the release",
  status: "running",
  startedAt: 10,
  layers: [["review", "ship"]],
  nodes: [
    { id: "review", role: "Reviewer", status: "running", ...(activity ? { activity } : {}) },
    { id: "ship", role: "Shipper", status: "queued" },
  ],
});

let mounts = 0;

/** Mount the real bar against a stubbed API; everything is restored on exit. */
async function withBar(
  options: {
    mode: "off" | "workflows" | "always";
    runs?: (projectId: string) => WorkflowRunDto[];
  },
  body: (ctx: { container: HTMLElement; probes: { git: number; runs: number }; flush: () => Promise<void>; projectId: string }) => Promise<void>,
): Promise<void> {
  const originalGit = api.gitStatus;
  const originalRuns = api.listWorkflowRuns;
  const probes = { git: 0, runs: 0 };
  const projectId = `workflow-bar-project-${++mounts}`;
  const sessionId = `${projectId}-session`;
  api.gitStatus = async () => { probes.git++; return emptyGitStatus(); };
  api.listWorkflowRuns = async () => { probes.runs++; return options.runs?.(projectId) ?? []; };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const flush = async () => { await act(async () => { await Promise.resolve(); }); await act(async () => {}); };
  try {
    applyProjectUpsert({ id: projectId, path: "/work/bar", name: "Bar project", createdAt: 1 });
    activateProject(projectId);
    setSessions(projectId, [{
      id: sessionId, projectId, title: "Bar", status: "idle", createdAt: 1, updatedAt: 1,
      model: { providerID: "anthropic", modelID: "claude-test" }, agent: "build",
    }]);
    activateSession(sessionId);
    setUiSettings({ statusBar: options.mode });
    await act(async () => root.render(createElement(StatusBar)));
    await flush();
    await body({ container, probes, flush, projectId });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    api.gitStatus = originalGit;
    api.listWorkflowRuns = originalRuns;
    setUiSettings({ statusBar: "off" });
    activateSession(null);
    activateProject(null);
    setSessions(projectId, []);
  }
}

const text = (element: Element | null | undefined) => element?.textContent ?? "";
const cluster = (container: HTMLElement, end: "leading" | "trailing") =>
  container.querySelector<HTMLElement>(`.statusbar-cluster[data-end="${end}"]`);

test("the workflow segment registers as a required, package-owned bar widget", async () => {
  const widget = new Map(listWidgets().map((entry) => [entry.id, entry])).get("statusbar.workflow");
  assert.ok(widget, "statusbar.workflow is registered");
  assert.equal(widget.kind, "mini-widget");
  assert.deepEqual([...(widget.supportedSlots ?? [])], [LEADING, TRAILING]);
  assert.equal(widget.defaultVisible, true);
  assert.equal(widget.requiredVisible, true, "a run waiting on the user cannot be hidden");
  const entry = await read("../widgets/index.tsx");
  assert.match(entry, /requiredVisible/, "the package owns the cannot-be-hidden rule");
});

test("the full bar's one live region is the workflow segment", async () => {
  await withBar({ mode: "always" }, async ({ container }) => {
    const bar = container.querySelector<HTMLElement>(".statusbar")!;
    assert.equal(bar.getAttribute("role"), "group", "the bar itself is a group, not a live region");
    const regions = bar.querySelectorAll("[role='status']");
    assert.equal(regions.length, 1, "one live region, present before there is anything to announce");
    assert.equal(regions[0]!.children.length, 0);
  });
});

test("the required workflow segment cannot be hidden but still moves between the ends", async () => {
  await withBar({ mode: "always", runs: (id) => [workflowRun(id)] }, async ({ container, flush }) => {
    await act(async () => {
      updateWidgetLayout((layout) => applyWidgetLayoutMutations(layout, [
        { type: "visibility", id: "statusbar.workflow", visible: false },
        { type: "place", id: "statusbar.workflow", slot: TRAILING },
      ]));
    });
    await flush();
    assert.equal(getWidgetLayout().widgets["statusbar.workflow"]?.visible, true, "the required workflow segment cannot be hidden");
    assert.equal(widgetSlotOf(getWidgetLayout(), "statusbar.workflow"), TRAILING);
    assert.ok(cluster(container, "trailing")!.querySelector(".sb-workflow"), "it moved to the requested end");
    assert.equal(cluster(container, "leading")!.querySelector(".sb-workflow"), null);
  });
});

test("the workflow-only mode stays out of the way until a run is active, then shows just that run", async () => {
  await withBar({ mode: "workflows" }, async ({ container, probes }) => {
    assert.equal(container.innerHTML, "", "no active run, no strip");
    assert.equal(probes.git, 0, "the strip never scans Git");
    assert.ok(probes.runs >= 1, "it still watches for runs");
  });
  await withBar({ mode: "workflows", runs: (id) => [workflowRun(id)] }, async ({ container, probes }) => {
    const bar = container.querySelector(".statusbar");
    assert.equal(bar?.getAttribute("data-statusbar"), "workflows");
    assert.equal(bar!.querySelectorAll(".sb").length, 1, "only the workflow segment");
    assert.equal(text(container.querySelector(".sb-workflow")).trim(), "Release audit · 0/2");
    assert.equal(container.querySelector(".sb-workflow")!.classList.contains("waiting"), false);
    assert.equal(container.querySelector("[role='status']")?.contains(container.querySelector(".sb-workflow")), true);
    assert.equal(probes.git, 0);
  });
  await withBar({ mode: "workflows", runs: (id) => [workflowRun(id, "awaiting permission: bash")] }, async ({ container }) => {
    const button = container.querySelector(".sb-workflow")!;
    assert.ok(button.classList.contains("waiting"));
    assert.match(text(button), /Approval needed · 0\/2/);
    assert.match(button.getAttribute("title") ?? "", /Workflow action required: Approval needed/);
    // A wait shows what it waits for; the running arc would read as progress.
    assert.ok(button.querySelector(".workflow-status-wait"));
    assert.equal(button.querySelector(".workflow-status-spinner"), null);
  });
});

test("the full bar carries the workflow segment too, and it asks for an answer when that is the wait", async () => {
  await withBar({ mode: "always", runs: (id) => [workflowRun(id, "awaiting answer: question")] }, async ({ container }) => {
    assert.match(text(cluster(container, "leading")!.querySelector(".sb-workflow")), /Answer needed · 0\/2/);
  });
});

test("the workflow segment styles itself inside its package", async () => {
  const css = await read("../widgets/statusbar.css");
  // An arc drawn with a mask rather than a border: borders are transparent
  // while "Hide interface borders" is on, and the arc is the activity signal.
  const spinner = /\.workflow-status-spinner\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(spinner.includes("conic-gradient"));
  assert.doesNotMatch(spinner, /(?:^|[;\s])border(?:-(?:top|right|bottom|left|inline|block)[\w-]*)?\s*:/);
  assert.doesNotMatch(css, /(?:^|\n)\s*border(?:-top|-bottom)?\s*:\s*1px/);
});
