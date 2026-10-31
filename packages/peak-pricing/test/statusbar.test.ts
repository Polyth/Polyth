// The peak-pricing segment in the host's real status bar: registered by the
// package entry, drawn as a bar segment, read from the active session's (or a
// new chat's draft) route, and movable between the bar's two ends.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MutationObserver: dom.MutationObserver,
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
const { installStatusbarWidgets } = await import("../../../apps/web/src/widgets/statusbarWidgets.tsx");
const { listWidgets } = await import("../../../apps/web/src/widgets/catalog.ts");
const { getWidgetLayout, moveWidgetToSlot, updateWidgetLayout, widgetSlotOf } =
  await import("../../../apps/web/src/widgets/widgetLayout.ts");
const { setUiSettings } = await import("../../../apps/web/src/uiPrefs.ts");
const { activateProject, activateSession, applyProjectUpsert, setSessions } = await import("../../../apps/web/src/store.ts");
const { updateDraftExecutionConfig, clearDraftExecutionConfig } = await import("../../../apps/web/src/executionDraft.ts");
const { webPackageHost } = await import("../../../apps/web/src/packages/webHost.ts");
const { default: installPeakPricing } = await import("../widgets/index.tsx");

installBuiltinAreas();
installStatusbarWidgets();
const uninstall = installPeakPricing(webPackageHost)();

const LEADING = "app.statusbar.leading" as const;
const TRAILING = "app.statusbar.trailing" as const;
// Monday 08:39 UTC: inside DeepSeek's 06:00–10:00 peak window.
const PEAK_NOW = Date.parse("2026-10-19T08:39:00Z");
const deepseek = { providerID: "deepseek-official", modelID: "deepseek-flash" };
const anthropic = { providerID: "anthropic", modelID: "claude-test" };

let mounts = 0;

async function withBar(
  route: { session?: typeof deepseek; draft?: typeof deepseek & { harnessId: string } },
  body: (container: HTMLElement) => Promise<void>,
): Promise<void> {
  const originalGit = api.gitStatus;
  const realNow = Date.now;
  const projectId = `peak-bar-project-${++mounts}`;
  const sessionId = `${projectId}-session`;
  api.gitStatus = async () => ({ branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] });
  Date.now = () => PEAK_NOW;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    applyProjectUpsert({ id: projectId, path: "/work/peak", name: "Peak project", createdAt: 1 });
    activateProject(projectId);
    if (route.session) {
      setSessions(projectId, [{
        id: sessionId, projectId, title: "Peak", status: "idle", createdAt: 1, updatedAt: 1,
        model: route.session, resolvedHarnessId: "deepseek",
      }]);
      activateSession(sessionId);
    } else {
      activateSession(null);
      if (route.draft) updateDraftExecutionConfig(projectId, { model: route.draft });
    }
    setUiSettings({ statusBar: "always" });
    await act(async () => root.render(createElement(StatusBar)));
    await act(async () => { await Promise.resolve(); });
    await body(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    api.gitStatus = originalGit;
    Date.now = realNow;
    setUiSettings({ statusBar: "off" });
    clearDraftExecutionConfig(projectId);
    activateSession(null);
    activateProject(null);
    setSessions(projectId, []);
  }
}

const cluster = (container: HTMLElement, end: "leading" | "trailing") =>
  container.querySelector<HTMLElement>(`.statusbar-cluster[data-end="${end}"]`);

test("the package registers a movable, hideable status-bar segment", () => {
  const widget = listWidgets().find((entry) => entry.id === "peak-pricing.statusbar");
  assert.ok(widget, "peak-pricing.statusbar is registered by the package entry");
  assert.equal(widget.kind, "mini-widget");
  assert.equal(widget.defaultSlot, TRAILING);
  assert.deepEqual([...(widget.supportedSlots ?? [])], [LEADING, TRAILING]);
  assert.equal(widget.defaultVisible, true);
  assert.notEqual(widget.requiredVisible, true);
});

test("a DeepSeek session shows Peak with the time left as a bar segment", async () => {
  await withBar({ session: deepseek }, async (container) => {
    const chip = cluster(container, "trailing")!.querySelector<HTMLButtonElement>(".peak-pricing-chip")!;
    assert.ok(chip, "the segment renders at its default end");
    assert.ok(chip.classList.contains("sb"), "it is a bar segment");
    assert.equal(chip.classList.contains("config-chip"), false, "not the composer chip");
    assert.equal(chip.dataset.surface, "statusbar");
    assert.equal(chip.dataset.phase, "peak");
    assert.match(chip.textContent ?? "", /Peak.*1h 21m/);
    await act(async () => chip.click());
    assert.ok(document.body.querySelector(".peak-pricing-card"), "a click opens the pricing card");
    await act(async () => chip.click());
  });
});

test("a route without a time-of-day price takes no room in the bar", async () => {
  await withBar({ session: anthropic }, async (container) => {
    assert.equal(container.querySelector(".peak-pricing-chip"), null);
  });
});

test("a new chat reads the draft route", async () => {
  await withBar({ draft: { ...deepseek, harnessId: "deepseek" } }, async (container) => {
    assert.ok(container.querySelector(".peak-pricing-chip.sb"), "the draft's DeepSeek route has a segment");
  });
});

test("the segment moves to the other end of the bar", async () => {
  await withBar({ session: deepseek }, async (container) => {
    await act(async () => updateWidgetLayout((layout) => moveWidgetToSlot(layout, "peak-pricing.statusbar", LEADING)));
    assert.equal(widgetSlotOf(getWidgetLayout(), "peak-pricing.statusbar"), LEADING);
    assert.ok(cluster(container, "leading")!.querySelector(".peak-pricing-chip"));
    assert.equal(cluster(container, "trailing")!.querySelector(".peak-pricing-chip"), null);
    await act(async () => updateWidgetLayout((layout) => moveWidgetToSlot(layout, "peak-pricing.statusbar", TRAILING)));
  });
});

test.after(() => uninstall?.());
