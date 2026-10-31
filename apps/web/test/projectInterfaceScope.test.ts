import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  CustomEvent: dom.CustomEvent,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }),
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/api/browse")
      ? { path: "/home/demo", parent: "/home", home: "/home/demo", entries: [] }
      : url.includes("/api/packages") ? { packages: [] } : url.includes("/api/projects") ? [] : {};
    return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const scope = await import("../src/projectInterfaceScope.ts");
const sync = await import("../src/projectPresentationSync.ts");
const relevance = await import("../src/packages/projectRelevance.ts");
const { capabilityLayoutStorageKey } = await import("../src/capabilityLayout.ts");
const { widgetLayoutStorageKey } = await import("../src/widgets/widgetLayout.ts");
const { workspacePanelStorageKey } = await import("../src/workspacePanel.ts");
const { workspaceCanvasStorageKey } = await import("../src/widgets/workspaceMode.ts");
const { workbenchProfileOffersStorageKey } = await import("../src/workbench/profileOffers.ts");
const { mobileRailKey } = await import("../src/composer/mobileRail.ts");
const { default: ProjectSetupFlowDialog } = await import("../src/components/ProjectSetupFlowDialog.tsx");

const saves: string[] = [];
api.projectPresentationSettings = async () => ({ revision: 1, updatedAt: 1, settings: {} });
api.projectPresentationSettingsSave = async (projectId) => {
  saves.push(projectId);
  return { revision: 2, updatedAt: 2, settings: {} };
};

test.afterEach(() => {
  scope.resetProjectInterfaceModeForTest();
  localStorage.clear();
});

test("a shared interface resolves every project's presentation records to one scope", () => {
  const keys = (projectId: string) => [
    capabilityLayoutStorageKey(projectId),
    widgetLayoutStorageKey(projectId),
    workspacePanelStorageKey(projectId),
    workspaceCanvasStorageKey(projectId),
    workbenchProfileOffersStorageKey(projectId),
    mobileRailKey("space", projectId),
  ];
  assert.notDeepEqual(keys("alpha"), keys("beta"));
  assert.ok(keys("alpha").every((key) => key.endsWith("alpha")));

  scope.setProjectInterfaceMode("shared");
  assert.deepEqual(keys("alpha"), keys("beta"));
  assert.ok(keys("alpha").every((key) => key.endsWith(scope.SHARED_PRESENTATION_SCOPE) || key.endsWith(encodeURIComponent(scope.SHARED_PRESENTATION_SCOPE))));
  assert.equal(scope.sharesPresentationScope("alpha", "beta"), true);
  assert.equal(scope.sharesPresentationScope("alpha", null), false);
});

test("the mode is a tolerant account preference", () => {
  assert.equal(scope.parseProjectInterfaceMode({ mode: "shared" }), "shared");
  assert.equal(scope.parseProjectInterfaceMode("shared"), "shared");
  assert.equal(scope.parseProjectInterfaceMode({ mode: "everything" }), "per-project");
  assert.equal(scope.parseProjectInterfaceMode(null), "per-project");
  scope.projectInterfacePreference.write({ mode: "shared" });
  assert.deepEqual(scope.projectInterfacePreference.read(), { mode: "shared" });
});

test("switching to shared starts from the current project and never rewrites project records", async () => {
  let active: string | null = "alpha";
  sync.initProjectPresentationSync(() => () => {}, () => active);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const project = { capabilityLayout: { version: 1, placements: { "git": { tier: "primary", rank: 0 } } } };
  localStorage.setItem("polyth.capabilityLayout.v1.alpha", JSON.stringify(project.capabilityLayout));

  const hydrated: unknown[] = [];
  const onHydrated = (event: Event) => hydrated.push((event as CustomEvent).detail);
  window.addEventListener(sync.PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  let sharedChanges = 0;
  const off = sync.sharedProjectPresentationPreference.subscribe(() => { sharedChanges += 1; });
  try {
    sync.chooseProjectInterface("shared", "alpha");
    assert.equal(scope.getProjectInterfaceMode(), "shared");
    assert.deepEqual(sync.sharedProjectPresentationPreference.read(), project);
    assert.ok(hydrated.some((detail) => (detail as { keys: string[] }).keys.includes("capabilityLayout")),
      "stores re-read the active project's records from the new scope");

    // Edits land in the shared record and its account mirror, not the project.
    const before = saves.length;
    localStorage.setItem(capabilityLayoutStorageKey("alpha"), JSON.stringify({ version: 1, placements: {} }));
    sync.markProjectPresentationChanged("alpha", "capabilityLayout");
    assert.ok(sharedChanges > 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(saves.length, before, "no project PUT while the interface is shared");
    assert.equal(localStorage.getItem("polyth.capabilityLayout.v1.alpha"), JSON.stringify(project.capabilityLayout));

    // Arrivals wait for the account snapshot before deciding anything.
    assert.equal(sync.isProjectPresentationSynced("alpha"), false);
    sync.markSharedProjectPresentationSettled();
    assert.equal(sync.isProjectPresentationSynced("alpha"), true);

    // Coming back keeps the shared arrangement for next time.
    sync.chooseProjectInterface("per-project", "alpha");
    sync.chooseProjectInterface("shared", "alpha");
    assert.deepEqual(sync.sharedProjectPresentationPreference.read(), { capabilityLayout: { version: 1, placements: {} } });

    // A remote shared snapshot replaces the local copy.
    sync.sharedProjectPresentationPreference.write({ canvasEnabled: true, unknown: 1 });
    assert.deepEqual(sync.sharedProjectPresentationPreference.read(), { canvasEnabled: true });
  } finally {
    off();
    active = null;
    window.removeEventListener(sync.PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }
});

test("a shared interface ignores project directions", () => {
  relevance.replaceProjectPackageCatalog([
    { id: "git", name: "Git", description: "", core: false, enabled: true, hasSettings: false, category: "engineering", projectAffinity: { directions: ["engineering"] } },
    { id: "coach", name: "Coach", description: "", core: false, enabled: true, hasSettings: false, category: "wellbeing", projectAffinity: { directions: ["wellbeing"] } },
  ] as never);
  relevance.setProjectCompositionContext("alpha", { version: 1, directions: ["engineering"], packageOverrides: { git: "include" } });
  assert.equal(relevance.isProjectContributionRelevant("coach"), false);
  let notified = 0;
  const off = relevance.subscribeProjectRelevance(() => { notified += 1; });
  scope.setProjectInterfaceMode("shared");
  off();
  assert.ok(notified > 0);
  assert.equal(relevance.isProjectContributionRelevant("coach"), true);
  assert.deepEqual(relevance.projectRailPlanContext("alpha"), { composition: { version: 1, directions: [], packageOverrides: {} }, personal: false });
  relevance.resetProjectRelevanceForTest();
});

test("new projects skip the directions step while the interface is shared", async () => {
  const mount = async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ProjectSetupFlowDialog, { onClose() {} })); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const text = document.body.textContent ?? "";
    const folderDialog = document.querySelector(".folder-dialog") !== null;
    await act(async () => { root.unmount(); });
    document.body.innerHTML = "";
    return { text, folderDialog };
  };

  const separate = await mount();
  assert.match(separate.text, /What are you working on\?/);
  assert.equal(separate.folderDialog, false);

  scope.setProjectInterfaceMode("shared");
  const shared = await mount();
  assert.doesNotMatch(shared.text, /What are you working on\?|Step 1 of 2|Step 2 of 2/);
  assert.equal(shared.folderDialog, true);
});
