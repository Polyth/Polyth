import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { isUiSlot, type WorkflowRunDto } from "@polyth/contracts";
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

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { default: StatusBar } = await import("../src/components/StatusBar.tsx");
const { getArea, listAreas } = await import("../src/widgets/areas.ts");
const { installBuiltinAreas } = await import("../src/widgets/builtinAreas.ts");
const { installBuiltinMiniWidgets } = await import("../src/widgets/builtinMiniWidgets.tsx");
const { installStatusbarWidgets } = await import("../src/widgets/statusbarWidgets.tsx");
const { listWidgets } = await import("../src/widgets/catalog.ts");
const { widgetsForZone } = await import("../src/widgets/zoneWidgets.ts");
const { cacheGitStatus } = await import("../../../packages/git/widgets/gitStatusStore.ts");
const {
  applyWidgetLayoutMutations,
  getWidgetLayout,
  updateWidgetLayout,
  widgetSlotOf,
} = await import("../src/widgets/widgetLayout.ts");
const { STATUS_BAR_MODES, UI_DEFAULTS, UI_SETTINGS_KEY, getUiSettings, parseUiSettings, setUiSettings } = await import("../src/uiPrefs.ts");
const { WIDGET_MIME } = await import("../src/dnd.ts");
const { chooseHidden, fitSegments, hideOrder } = await import("../src/statusbar/fitSegments.ts");
const { activateProject, activateSession, applyProjectUpsert, setSessions } = await import("../src/store.ts");

installBuiltinAreas();
installBuiltinMiniWidgets();
installStatusbarWidgets();
// The status-bar run segment is package-owned; install whichever discovered
// package contributes it instead of naming a removable package.
const { webPackageHost } = await import("../src/packages/webHost.ts");
const packagesDir = new URL("../../../packages/", import.meta.url);
let packageStatusbarEntry = "";
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = new URL(`${entry.name}/`, packagesDir);
  if (!existsSync(new URL("package.json", packageDir))) continue;
  const entryURL = new URL("widgets/index.tsx", packageDir);
  if (!existsSync(entryURL)) continue;
  const source = await readFile(entryURL, "utf8");
  if (!source.includes("statusbar.workflow")) continue;
  packageStatusbarEntry = source;
  const installer = (await import(entryURL.href)).default as (host: typeof webPackageHost) => () => void;
  installer(webPackageHost)();
}

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
/** happy-dom events are structurally close to, but not typed as, the DOM's. */
const fire = (target: Element, event: unknown) => target.dispatchEvent(event as Event);

const LEADING = "app.statusbar.leading" as const;
const TRAILING = "app.statusbar.trailing" as const;
const SEGMENTS = [
  "statusbar.project", "statusbar.branch", "statusbar.editor", "statusbar.changes",
  "statusbar.model", "statusbar.agent",
  // The workflow segment is package-owned, so it is only in the bar when its
  // package is installed. The shell always ships the rest.
  ...(packageStatusbarEntry ? ["statusbar.workflow"] as const : []),
  "statusbar.view",
] as const;

type GitStatusResult = Awaited<ReturnType<typeof api.gitStatus>>;
const gitStatus = (patch: Partial<GitStatusResult> = {}): GitStatusResult => ({
  branch: "main", ahead: 0, behind: 0,
  staged: [], unstaged: [], untracked: [], conflicted: [],
  ...patch,
});
const modified = (...paths: string[]) => paths.map((path) => ({ path, status: "modified" as const, staged: false }));

interface Probes { git: number; runs: number }
let mounts = 0;

/** Mount the real bar against a stubbed API; everything is restored on exit. */
async function withBar(
  options: {
    mode: "off" | "workflows" | "always";
    git?: GitStatusResult | (() => GitStatusResult | Promise<GitStatusResult>);
    runs?: (projectId: string) => WorkflowRunDto[];
    project?: boolean;
  },
  body: (ctx: { container: HTMLElement; probes: Probes; flush: () => Promise<void>; projectId: string; sessionId: string }) => Promise<void>,
): Promise<void> {
  const originalGit = api.gitStatus;
  const originalRuns = api.listWorkflowRuns;
  const probes: Probes = { git: 0, runs: 0 };
  // Widget layouts are persisted per project, so every mount gets its own
  // project and starts from the registered defaults.
  const projectId = `bar-project-${++mounts}`;
  const sessionId = `${projectId}-session`;
  api.gitStatus = async () => {
    probes.git++;
    const value = options.git ?? gitStatus();
    return typeof value === "function" ? value() : value;
  };
  api.listWorkflowRuns = async () => {
    probes.runs++;
    return options.runs?.(projectId) ?? [];
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const flush = async () => { await act(async () => { await Promise.resolve(); }); await act(async () => {}); };
  try {
    if (options.project !== false) {
      applyProjectUpsert({ id: projectId, path: "/work/bar", name: "Bar project", createdAt: 1 });
      activateProject(projectId);
      setSessions(projectId, [{
        id: sessionId, projectId, title: "Bar", status: "idle", createdAt: 1, updatedAt: 1,
        model: { providerID: "anthropic", modelID: "claude-test" }, agent: "build",
      }]);
      activateSession(sessionId);
    }
    setUiSettings({ statusBar: options.mode });
    await act(async () => root.render(createElement(StatusBar)));
    await flush();
    await body({ container, probes, flush, projectId, sessionId });
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

test("the status bar is off unless the user turns it on, and old records stay off", () => {
  assert.equal(UI_DEFAULTS.statusBar, "off");
  assert.deepEqual([...STATUS_BAR_MODES], ["off", "workflows", "always"]);
  assert.equal(parseUiSettings(null).statusBar, "off");
  assert.equal(parseUiSettings("{}").statusBar, "off");
  assert.equal(parseUiSettings("not json").statusBar, "off");
  assert.equal(parseUiSettings(JSON.stringify({ statusBar: "always" })).statusBar, "always");
  assert.equal(parseUiSettings(JSON.stringify({ statusBar: "workflows" })).statusBar, "workflows");
  assert.equal(parseUiSettings(JSON.stringify({ statusBar: "sometimes" })).statusBar, "off");
  assert.equal(parseUiSettings(JSON.stringify({ statusBar: true })).statusBar, "off");
  assert.equal(parseUiSettings(JSON.stringify({ ...UI_DEFAULTS })).statusBar, "off");
});

test("both ends of the bar are canonical widget areas that Customize can target", () => {
  for (const id of [LEADING, TRAILING]) {
    assert.equal(isUiSlot(id), true, `${id} is a UiSlot`);
    const area = getArea(id);
    assert.ok(area, `${id} is a built-in area`);
    assert.equal(area.orientation, "row");
    assert.equal(area.preferredKind, "mini-widget");
  }
  assert.equal(listAreas().filter((area) => area.id === LEADING || area.id === TRAILING).length, 2);

  const byId = new Map(listWidgets().map((widget) => [widget.id, widget]));
  for (const id of SEGMENTS) {
    const widget = byId.get(id);
    assert.ok(widget, `${id} is registered`);
    assert.equal(widget.kind, "mini-widget");
    assert.deepEqual([...(widget.supportedSlots ?? [])], [LEADING, TRAILING]);
    assert.equal(widget.defaultVisible, true);
  }
  assert.equal(byId.get("statusbar.view")?.defaultSlot, TRAILING);
  assert.equal(byId.get("statusbar.project")?.defaultSlot, LEADING);
  // Search, settings and workspace-tool launchers can be dropped into the bar too.
  for (const id of ["shell.search", "shell.settings", "capability:git"]) {
    const widget = byId.get(id);
    if (!widget) continue;
    assert.ok(widget.supportedSlots?.includes(LEADING) && widget.supportedSlots.includes(TRAILING), `${id} fits the bar`);
  }
  assert.ok(byId.has("shell.search") && byId.has("shell.settings"));
});

test("off renders nothing and runs no probe at all", async () => {
  await withBar({ mode: "off" }, async ({ container, probes }) => {
    assert.equal(container.innerHTML, "");
    assert.deepEqual(probes, { git: 0, runs: 0 });
  });
});

test("always shows the full bar with its built-in segments in their two ends", async () => {
  await withBar({
    mode: "always",
    git: gitStatus({ branch: "feature/bar", ahead: 2, behind: 1, unstaged: modified("a.ts", "b.ts") }),
  }, async ({ container, probes }) => {
    const bar = container.querySelector<HTMLElement>(".statusbar");
    assert.ok(bar, "the bar is mounted");
    assert.equal(bar.getAttribute("data-statusbar"), "always");
    assert.equal(bar.getAttribute("role"), "group", "the bar itself is a group, not a live region");
    assert.ok(bar.classList.contains("customize-zone"), "Shift over the bar arms the customize pencil");

    const leading = cluster(container, "leading")!;
    const trailing = cluster(container, "trailing")!;
    assert.ok(leading && trailing);
    assert.match(text(leading.querySelector(".sb-project")), /Bar project/);
    assert.match(text(leading.querySelector(".sb-branch")), /feature\/bar/);
    assert.match(text(leading.querySelector(".sb-branch")), /↑2/);
    assert.match(text(leading.querySelector(".sb-branch")), /↓1/);
    assert.match(text(leading.querySelector(".sb-changes")), /2 changed files/);
    assert.match(text(leading.querySelector(".sb-model")), /claude-test/);
    assert.match(text(leading.querySelector(".sb-agent")), /build agent/);
    assert.match(text(trailing.querySelector(".sb-view")), /^Chat/);
    assert.equal(leading.querySelector(".sb-view"), null, "the view label sits at the trailing end");
    assert.ok(probes.git >= 1, "Git is scanned for the full bar");
    assert.ok(container.querySelector(".statusbar > .zone-customize-trigger"), "the Customize button is present");

    // Source order is the default placement order, not an accident of the DOM.
    const order = [...leading.querySelectorAll(".sb")].map((node) => [...node.classList].find((name) => /^sb-(project|branch|changes|model|agent)$/.test(name)));
    assert.deepEqual(order.filter(Boolean), ["sb-project", "sb-branch", "sb-changes", "sb-model", "sb-agent"]);
  });
});

test("segments move between the ends, hide, and come back like any other widget", async () => {
  await withBar({ mode: "always", git: gitStatus({ unstaged: modified("a.ts") }) }, async ({ container, flush }) => {
    assert.ok(cluster(container, "leading")!.querySelector(".sb-model"));

    await act(async () => {
      updateWidgetLayout((layout) => applyWidgetLayoutMutations(layout, [
        { type: "place", id: "statusbar.model", slot: TRAILING, index: 0 },
        { type: "visibility", id: "statusbar.changes", visible: false },
      ]));
    });
    await flush();
    assert.equal(cluster(container, "leading")!.querySelector(".sb-model"), null, "the model segment left the leading end");
    const trailing = cluster(container, "trailing")!;
    assert.ok(trailing.querySelector(".sb-model"), "...and landed at the trailing end");
    assert.ok(trailing.querySelector(".sb-model")!.compareDocumentPosition(trailing.querySelector(".sb-view")!) & 4, "at the requested index, before the view label");
    assert.equal(container.querySelector(".sb-changes"), null, "a hidden segment disappears");
    assert.equal(widgetSlotOf(getWidgetLayout(), "statusbar.model"), TRAILING);

    await act(async () => {
      updateWidgetLayout((layout) => applyWidgetLayoutMutations(layout, [
        { type: "visibility", id: "statusbar.changes", visible: true },
        { type: "place", id: "statusbar.changes", slot: LEADING },
      ]));
    });
    await flush();
    assert.match(text(cluster(container, "leading")!.querySelector(".sb-changes")), /1 changed file$/);
  });
});

test("Customize lists the segments as active and offers launchers to add", async () => {
  await withBar({ mode: "always" }, async () => {
    const { active, inactive } = widgetsForZone(listWidgets(), getWidgetLayout(), [LEADING, TRAILING]);
    const activeIds = active.map((widget) => widget.id);
    for (const id of SEGMENTS) assert.ok(activeIds.includes(id), `${id} is shown in the bar`);
    const offered = inactive.map((widget) => widget.id);
    assert.ok(offered.includes("shell.search") && offered.includes("shell.settings"), "launchers can be added");
    assert.equal(offered.some((id) => id.startsWith("statusbar.")), false);

    // Hiding a segment moves it from "shown" to "available", where it can be re-added.
    await act(async () => {
      updateWidgetLayout((layout) => applyWidgetLayoutMutations(layout, [{ type: "visibility", id: "statusbar.agent", visible: false }]));
    });
    const after = widgetsForZone(listWidgets(), getWidgetLayout(), [LEADING, TRAILING]);
    assert.equal(after.active.some((widget) => widget.id === "statusbar.agent"), false);
    assert.equal(after.inactive.some((widget) => widget.id === "statusbar.agent"), true);
  });
});

test("dropping a dragged segment on an end appends it there, even when that end is empty", async () => {
  await withBar({ mode: "always" }, async ({ container, flush }) => {
    await act(async () => {
      updateWidgetLayout((layout) => applyWidgetLayoutMutations(layout, [
        { type: "visibility", id: "statusbar.view", visible: false },
      ]));
    });
    await flush();
    const trailing = cluster(container, "trailing")!;
    assert.equal(trailing.querySelector(".sb"), null, "the trailing end is empty");

    const drop = new dom.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: [WIDGET_MIME], getData: (type: string) => type === WIDGET_MIME ? "statusbar.agent" : "" },
    });
    await act(async () => { fire(trailing, drop); });
    await flush();
    assert.equal(drop.defaultPrevented, true);
    assert.equal(widgetSlotOf(getWidgetLayout(), "statusbar.agent"), TRAILING);
    assert.ok(cluster(container, "trailing")!.querySelector(".sb-agent"));
    assert.equal(cluster(container, "leading")!.querySelector(".sb-agent"), null);
  });
});

test("change counts read naturally, and a folder that is not a repository shows no Git segments", async () => {
  await withBar({ mode: "always", git: gitStatus({ unstaged: modified("only.ts") }) }, async ({ container }) => {
    assert.equal(text(container.querySelector(".sb-changes")), "1 changed file");
  });
  await withBar({ mode: "always", git: gitStatus({ staged: modified("a.ts"), untracked: modified("b.ts", "c.ts") }) }, async ({ container }) => {
    assert.equal(text(container.querySelector(".sb-changes")), "3 changed files");
  });
  await withBar({ mode: "always", git: gitStatus() }, async ({ container }) => {
    const clean = container.querySelector(".sb-changes");
    assert.equal(text(clean), "No changes");
    assert.ok(clean!.classList.contains("is-clean"));
  });
  await withBar({ mode: "always", git: gitStatus({ branch: null, isRepo: false }) }, async ({ container }) => {
    assert.equal(container.querySelector(".sb-changes"), null, "a plain folder is not a clean repository");
    assert.equal(container.querySelector(".sb-branch"), null);
    assert.ok(container.querySelector(".sb-project"), "the rest of the bar is unaffected");
  });
});

test("a rescan of the same scope keeps the last Git result on screen instead of blinking", async () => {
  let release: (() => void) | null = null;
  let calls = 0;
  const second = () => new Promise<GitStatusResult>((resolve) => {
    release = () => resolve(gitStatus({ branch: "after-rescan", unstaged: modified("a.ts", "b.ts", "c.ts") }));
  });
  await withBar({
    mode: "always",
    git: () => (++calls === 1 ? gitStatus({ branch: "before-rescan", unstaged: modified("a.ts") }) : second()),
  }, async ({ container, flush, projectId }) => {
    assert.match(text(container.querySelector(".sb-branch")), /before-rescan/);
    assert.equal(text(container.querySelector(".sb-changes")), "1 changed file");

    // Any widget refreshing Git status invalidates the bar's scan.
    await act(async () => { cacheGitStatus(projectId, null); });
    await flush();
    assert.equal(calls, 2, "the bar rescans");
    assert.match(text(container.querySelector(".sb-branch")), /before-rescan/, "the branch does not disappear while rescanning");
    assert.equal(text(container.querySelector(".sb-changes")), "1 changed file");

    await act(async () => { release!(); });
    await flush();
    assert.match(text(container.querySelector(".sb-branch")), /after-rescan/);
    assert.equal(text(container.querySelector(".sb-changes")), "3 changed files");
  });
});

test("the connection dot is honest and offers a reconnect when the socket is down", async () => {
  await withBar({ mode: "always" }, async ({ container }) => {
    const dot = container.querySelector(".sb-live");
    assert.ok(dot);
    assert.ok(["live", "pending", "down"].includes(dot.getAttribute("data-connection") ?? ""));
    // No sync client runs in tests, so the transport reads as not connected.
    assert.equal(dot.getAttribute("data-connection"), "down");
    assert.match(text(container.querySelector(".sb-reconnect")), /Reconnect/);
    assert.match(text(container.querySelector(".sb-project .sr-only")), /Connection problem/);
  });
});

test("the open file keeps its name visible and reports the cursor", async () => {
  const views = await import("../src/resources/views.ts");
  const store = await import("../src/store.ts");
  await withBar({ mode: "always" }, async ({ container, flush, projectId, sessionId }) => {
    await act(async () => {
      store.setRailPlugin("files");
      store.setEditorFile("src/deep/dir/Widget.tsx");
    });
    await flush();
    const resource = { scheme: "file" as const, projectId, sessionId, locator: "src/deep/dir/Widget.tsx" };
    await act(async () => { views.reportEditorCursor(resource, { line: 12, column: 7 }); });
    const editor = container.querySelector(".sb-editor");
    assert.ok(editor);
    assert.equal(text(editor.querySelector(".sb-path-base")), "Widget.tsx", "only the directory may truncate");
    assert.equal(text(editor.querySelector(".sb-path-dir")), "src/deep/dir/");
    assert.match(text(editor), / · ts · Ln 12, Col 7$/);
    await act(async () => { views.reportEditorCursor(resource, null); store.setEditorFile(null); store.setRailPlugin(null); });
  });
});

test("Appearance offers the Status bar choice, Off by default, and remembers it", async () => {
  const { AppearancePage } = await import("../src/components/settings/pages.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  setUiSettings({ statusBar: "off" });
  try {
    await act(async () => root.render(createElement(AppearancePage)));
    const row = container.querySelector('[data-settings-item="appearance.statusBar"]');
    assert.ok(row, "the setting is in Appearance → Layout");
    assert.match(text(row.querySelector(".set-row-hint")), /Not shown on phones/);
    const choices = () => Array.from(row.querySelectorAll("button")).map((button) => [text(button), button.getAttribute("aria-pressed")]);
    assert.deepEqual(choices(), [["Off", "true"], ["Workflows", "false"], ["Always", "false"]]);

    await act(async () => { fire(row.querySelectorAll("button")[2]!, new dom.MouseEvent("click", { bubbles: true })); });
    assert.equal(getUiSettings().statusBar, "always");
    assert.deepEqual(choices(), [["Off", "false"], ["Workflows", "false"], ["Always", "true"]]);
    assert.equal(JSON.parse(dom.localStorage.getItem(UI_SETTINGS_KEY) ?? "{}").statusBar, "always", "the choice is persisted");

    await act(async () => { fire(row.querySelectorAll("button")[1]!, new dom.MouseEvent("click", { bubbles: true })); });
    assert.equal(getUiSettings().statusBar, "workflows");
  } finally {
    setUiSettings({ statusBar: "off" });
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an end that is too narrow drops whole segments, last first, and keeps what must be seen", () => {
  assert.deepEqual(hideOrder([false, false, false, false]), [3, 2, 1, 0]);
  assert.deepEqual(hideOrder([false, false, true, false]), [3, 1, 0, 2], "a protected segment goes after everything else");
  const widths = [100, 80, 60, 50];
  const fits = (keep: boolean[], room: number) => chooseHidden(keep, (hidden) =>
    widths.reduce((sum, width, index) => sum + (hidden.has(index) ? 0 : width), 0) > room);
  assert.deepEqual([...fits([false, false, false, false], 300)], [], "everything fits");
  assert.deepEqual([...fits([false, false, false, false], 250)], [3]);
  assert.deepEqual([...fits([false, false, false, false], 150)], [3, 2, 1]);
  assert.deepEqual([...fits([false, false, false, true], 250)], [2], "the protected segment stays while others can go");
  assert.deepEqual([...fits([false, false, false, true], 60)], [2, 1, 0], "...and is last to go only when nothing else is left");
  assert.deepEqual([...fits([false, false, false, false], 10)], [3, 2, 1, 0]);
});

test("fitting hides and restores real segments against measured geometry", () => {
  const widths = [100, 80, 60, 50];
  const cluster = document.createElement("div");
  const parts = widths.map((width, index) => {
    const wrapper = document.createElement("span");
    wrapper.className = "placed-mini-widget";
    const chip = document.createElement("span");
    if (index === 3) chip.setAttribute("data-fit-keep", "");
    wrapper.appendChild(chip);
    cluster.appendChild(wrapper);
    return { wrapper, chip, width };
  });
  const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect;
  let room = 300;
  cluster.getBoundingClientRect = () => rect(0, room);
  parts.forEach(({ wrapper, chip, width }, index) => {
    chip.getBoundingClientRect = () => {
      if (wrapper.getAttribute("data-fit") === "hidden") return rect(0, 0);
      const left = parts.slice(0, index).reduce((sum, part) => sum + (part.wrapper.getAttribute("data-fit") === "hidden" ? 0 : part.width), 0);
      return rect(left, left + width);
    };
  });
  const hiddenNow = () => parts.map(({ wrapper }, index) => wrapper.getAttribute("data-fit") === "hidden" ? index : -1).filter((index) => index >= 0);

  fitSegments(cluster as unknown as HTMLElement);
  assert.deepEqual(hiddenNow(), []);
  room = 250;
  fitSegments(cluster as unknown as HTMLElement);
  assert.deepEqual(hiddenNow(), [2], "the segment marked data-fit-keep survives; the one before it goes");
  room = 160;
  fitSegments(cluster as unknown as HTMLElement);
  assert.deepEqual(hiddenNow(), [1, 2], "the first segment and the protected one still fit");
  room = 120;
  fitSegments(cluster as unknown as HTMLElement);
  assert.deepEqual(hiddenNow(), [0, 1, 2], "only the protected segment is left");
  room = 400;
  fitSegments(cluster as unknown as HTMLElement);
  assert.deepEqual(hiddenNow(), [], "growing the bar brings every segment back");
});

test("the command palette switches the status bar without opening Settings", async () => {
  const { installShell } = await import("../src/shell.ts");
  const commands = await import("../src/commands.ts");
  installShell();
  setUiSettings({ statusBar: "off" });
  try {
    const find = () => commands.listCommands().find((command) => command.id === "cmd.statusBar");
    assert.equal(find()?.label, "Status bar");
    assert.equal(find()?.checked?.(), false);
    assert.equal(commands.filterPalette(commands.listCommands(), "footer")[0]?.id, "cmd.statusBar");

    assert.equal(commands.runCommand("cmd.statusBar"), true);
    assert.equal(getUiSettings().statusBar, "always");
    assert.equal(find()?.checked?.(), true);
    assert.equal(commands.runCommand("cmd.statusBar"), true);
    assert.equal(getUiSettings().statusBar, "off");

    // From the workflow-only strip the command promotes to the full bar.
    setUiSettings({ statusBar: "workflows" });
    commands.runCommand("cmd.statusBar");
    assert.equal(getUiSettings().statusBar, "always");
  } finally {
    setUiSettings({ statusBar: "off" });
  }
});

test("an end fits contributions that sit directly in it, not only placed widgets", () => {
  const cluster = document.createElement("div");
  const chip = document.createElement("span");
  cluster.appendChild(chip);
  const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect;
  let room = 100;
  cluster.getBoundingClientRect = () => rect(0, room);
  chip.getBoundingClientRect = () => chip.getAttribute("data-fit") === "hidden" ? rect(0, 0) : rect(0, 140);
  fitSegments(cluster as unknown as HTMLElement);
  assert.equal(chip.getAttribute("data-fit"), "hidden");
  room = 200;
  fitSegments(cluster as unknown as HTMLElement);
  assert.equal(chip.getAttribute("data-fit"), null);
});

test("the Customize editor offers Hide status bar next to the segments", async () => {
  await withBar({ mode: "always" }, async ({ container, flush }) => {
    const trigger = container.querySelector(".statusbar > .zone-customize-trigger");
    assert.ok(trigger);
    await act(async () => { fire(trigger, new dom.MouseEvent("click", { bubbles: true })); });
    await flush();
    const editor = document.body.querySelector(".rail-editor");
    assert.ok(editor, "the Customize editor opened");
    assert.equal(text(editor.querySelector(".rail-editor-heading h2")), "Status bar");
    const rows = Array.from(editor.querySelectorAll(".rail-editor-shown .rail-editor-row"));
    assert.ok(rows.some((row) => /Current view/.test(text(row))), "placed segments are listed in order");
    const hide = Array.from(editor.querySelectorAll(".rail-editor-action")).find((item) => /Hide status bar/.test(text(item)));
    assert.ok(hide, "Hide status bar sits with the segments");
    await act(async () => { fire(hide, new dom.MouseEvent("click", { bubbles: true })); });
    assert.equal(getUiSettings().statusBar, "off");
  });
});

test("the styling follows the preferences instead of hiding the bar in Chat", async () => {
  const [barCss, coreCss, bar, widgets, pages, registry] = await Promise.all([
    read("../src/components/StatusBar.css"),
    read("../src/styles.css"),
    read("../src/components/StatusBar.tsx"),
    read("../src/widgets/statusbarWidgets.tsx"),
    read("../src/components/settings/pages.tsx"),
    read("../src/settings/registry.ts"),
  ]);
  // Chat no longer special-cases the bar: visibility is the Appearance setting.
  assert.doesNotMatch(coreCss, /\.app(?:\.mode-chat)?\.view-session\s+\.statusbar/);
  assert.doesNotMatch(coreCss, /\.sb-(?:workflow|branch|model|agent|sep)\b/, "segment styling lives with the bar");
  // The shared glass, glass-off and low-resource lists still own the material.
  assert.equal((coreCss.match(/^\s*\.statusbar,$/gm) ?? []).length, 2);
  assert.match(barCss, /container:\s*statusbar\s*\/\s*inline-size/);
  assert.match(barCss, /@container statusbar \(max-width: 640px\)\s*\{[^}]*\.sb-meta/s);
  assert.match(barCss, /--density-scale/);
  assert.match(barCss, /--hit-min/);
  assert.match(barCss, /--safe-bottom/);
  assert.match(barCss, /\.statusbar > \.zone-edit-button/);
  // Borders are transparent by default (Hide interface borders), so the bar
  // edge cannot depend on one.
  assert.doesNotMatch(barCss.replace(/\/\*[\s\S]*?\*\//g, ""), /(?:^|\n)\s*border(?:-top|-bottom)?\s*:\s*1px/);
  // No fixed radius literals: corners follow the rounding preference.
  for (const match of barCss.matchAll(/border-radius\s*:\s*([^;]+)/g)) {
    assert.match(match[1]!, /var\(--radius|50%/);
  }
  assert.match(bar, /import "\.\/StatusBar\.css"/);
  assert.match(bar, /if \(mode === "off"\) return null/);
  // The workflow segment (and its "cannot be hidden" rule) is package-owned;
  // the shell keeps only its generic segments. The package's own test asserts
  // the segment's live region and styling.
  assert.doesNotMatch(widgets, /segment\("statusbar\.workflow"/);
  assert.match(pages, /appearance\.statusBar/);
  assert.match(pages, /setUiSettings\(\{ statusBar \}\)/);
  assert.match(registry, /id: "appearance\.statusBar"/);
});
