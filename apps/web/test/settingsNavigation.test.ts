import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window();
let mobileViewport = false;
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({
    matches: mobileViewport,
    media,
    addEventListener() {},
    removeEventListener() {},
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const {
  activateProject,
  applyProjectAdded,
  applyProjectRemoved,
  openSettingsPage,
  setModels,
  setOverlay,
} = await import("../src/store.ts");
const { registerSlot } = await import("../src/slots.ts");
const { registerSettingsItems } = await import("../src/settings/registry.ts");
const { default: SettingsView } = await import("../src/components/SettingsView.tsx");
const { ProjectsPage } = await import("../src/components/settings/pages.tsx");

function HarnessPage({ settingsTarget }: { settingsTarget?: { itemId?: string; sectionId?: string } }) {
  return createElement("div", { "data-settings-target": true }, `${settingsTarget?.itemId ?? ""}/${settingsTarget?.sectionId ?? ""}`);
}

test("settings aliases redirect to the canonical page and mounted navigation updates targets", async () => {
  const offHarness = registerSlot(
    "settings.pages",
    "test.harnesses",
    (props) => createElement(HarnessPage, { settingsTarget: props.settingsTarget as { itemId?: string; sectionId?: string } | undefined }),
    10,
    { pageId: "harnesses", label: "Harnesses", group: "Engineering" },
  );
  const offAlias = registerSlot(
    "settings.pages",
    "test.opencode",
    () => null,
    11,
    {
      pageId: "opencode",
      label: "OpenCode",
      group: "Engineering",
      nav: false,
      redirect: { pageId: "harnesses", target: { itemId: "opencode", sectionId: "providers-models" } },
    },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    openSettingsPage("opencode");
    await act(async () => { root.render(createElement(SettingsView)); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(container.querySelector(".settings-page-harnesses") !== null, true);
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/providers-models");

    await act(async () => {
      openSettingsPage("harnesses", { itemId: "opencode", sectionId: "runtime" });
    });
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/runtime");
    await act(async () => {
      openSettingsPage("harnesses", { itemId: "opencode", sectionId: "roles" });
    });
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/roles");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offAlias();
    offHarness();
    setOverlay(null);
  }
});

test("legacy integrations settings route redirects to Source Control and stays out of navigation", async () => {
  const offGit = registerSlot(
    "settings.pages",
    "test.source-control",
    () => createElement("div", { "data-source-control-settings": true }, "Source Control"),
    10,
    { pageId: "git", label: "Source Control", group: "Engineering" },
  );
  const offIntegrations = registerSlot(
    "settings.pages",
    "test.legacy-integrations",
    () => createElement("div", { "data-legacy-integrations-settings": true }, "Legacy Integrations"),
    11,
    {
      pageId: "integrations",
      label: "Integrations",
      group: "Workspace",
      nav: false,
      redirect: { pageId: "git" },
    },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    openSettingsPage("integrations");
    await act(async () => { root.render(createElement(SettingsView)); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(container.querySelector(".settings-page-git") !== null, true);
    assert.ok(container.querySelector("[data-source-control-settings]"));
    assert.equal(container.querySelector("[data-legacy-integrations-settings]"), null);
    assert.equal(
      [...container.querySelectorAll(".settings-nav-item")].some((button) => (button.textContent ?? "").includes("Integrations")),
      false,
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offIntegrations();
    offGit();
    setOverlay(null);
  }
});

test("a search hit whose row sits behind the page's own tab is handed to the page as its target", async () => {
  // The page renders only the row of its current tab: "visible" now, "hidden"
  // once its target names it, like a tabbed package page.
  function TabbedPage({ settingsTarget }: { settingsTarget?: { itemId?: string } }) {
    const item = settingsTarget?.itemId === "tabbed.hidden" ? "tabbed.hidden" : "tabbed.visible";
    return createElement("div", { "data-settings-item": item, "data-settings-target": true }, settingsTarget?.itemId ?? "");
  }
  const offPage = registerSlot(
    "settings.pages",
    "test.tabbed",
    (props) => createElement(TabbedPage, { settingsTarget: props.settingsTarget as { itemId?: string } | undefined }),
    10,
    { pageId: "tabbed", label: "Tabbed", group: "Engineering" },
  );
  const offItems = registerSettingsItems([
    { id: "tabbed.visible", pageId: "tabbed", label: "Visible row", focusTarget: "tabbed.visible" },
    { id: "tabbed.hidden", pageId: "tabbed", label: "Hidden row", focusTarget: "tabbed.hidden" },
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const search = async (query: string) => {
    const input = container.querySelector<HTMLInputElement>(".settings-nav-search")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(input, query);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    const hit = [...container.querySelectorAll<HTMLButtonElement>(".settings-result-item")]
      .find((button) => button.textContent?.includes(query));
    assert.ok(hit, `"${query}" is a search hit`);
    await act(async () => { hit.click(); });
    for (let index = 0; index < 4; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  };
  try {
    openSettingsPage("tabbed");
    await act(async () => { root.render(createElement(SettingsView)); });
    await act(async () => { await Promise.resolve(); });
    await search("Visible row");
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "", "a rendered row needs no target");
    await search("Hidden row");
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "tabbed.hidden", "the page learns which row to reveal");
    assert.ok(container.querySelector('[data-settings-item="tabbed.hidden"]'));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offItems();
    offPage();
    setOverlay(null);
  }
});

test("nested settings deep links open the page stage on mobile", async () => {
  mobileViewport = true;
  const offHarness = registerSlot(
    "settings.pages",
    "test.mobile-harnesses",
    (props) => createElement(HarnessPage, { settingsTarget: props.settingsTarget as { itemId?: string; sectionId?: string } | undefined }),
    10,
    { pageId: "harnesses", label: "Harnesses", group: "Engineering" },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    openSettingsPage("harnesses/opencode/roles");
    await act(async () => { root.render(createElement(SettingsView)); });
    assert.equal(container.querySelector(".settings-mobile-page") !== null, true);
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/roles");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offHarness();
    setOverlay(null);
    mobileViewport = false;
  }
});

test("navigation requests before mount preserve the latest target", async () => {
  const offHarness = registerSlot(
    "settings.pages",
    "test.pre-mount-harnesses",
    (props) => createElement(HarnessPage, { settingsTarget: props.settingsTarget as { itemId?: string; sectionId?: string } | undefined }),
    10,
    { pageId: "harnesses", label: "Harnesses", group: "Engineering" },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    openSettingsPage("harnesses", { itemId: "opencode", sectionId: "providers-models" });
    openSettingsPage("harnesses", { itemId: "opencode", sectionId: "runtime" });
    await act(async () => { root.render(createElement(SettingsView)); });
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/runtime");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offHarness();
    setOverlay(null);
  }
});

test("a plain open resumes the last settings page and phone stage, deep links still win", async () => {
  const offHarness = registerSlot(
    "settings.pages",
    "test.resume-harnesses",
    (props) => createElement(HarnessPage, { settingsTarget: props.settingsTarget as { itemId?: string; sectionId?: string } | undefined }),
    10,
    { pageId: "harnesses", label: "Harnesses", group: "Engineering" },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root = createRoot(container);
  const reopen = async (route?: string) => {
    await act(async () => { root.unmount(); });
    if (route) openSettingsPage(route);
    root = createRoot(container);
    await act(async () => { root.render(createElement(SettingsView)); });
  };
  try {
    localStorage.clear();
    await act(async () => { root.render(createElement(SettingsView)); });
    assert.ok(container.querySelector(".settings-page-general"), "first open lands on General");

    const harnessButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-nav-item")]
      .find((button) => (button.textContent ?? "").includes("Harnesses"));
    assert.ok(harnessButton);
    await act(async () => { harnessButton.click(); });
    await reopen();
    assert.ok(container.querySelector(".settings-page-harnesses"), "reopen resumes the last page");
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "/", "no stale item target");

    await reopen("about");
    assert.ok(container.querySelector(".settings-page-about"), "an explicit route wins over the remembered page");

    mobileViewport = true;
    await reopen("harnesses");
    assert.ok(container.querySelector(".settings-mobile-page"));
    await reopen();
    assert.ok(container.querySelector(".settings-page-harnesses.settings-mobile-page"), "phone reopens the page closed from its page stage");
    await act(async () => { container.querySelector<HTMLButtonElement>(".settings-mobile-back")?.click(); });
    await reopen();
    assert.ok(container.querySelector(".settings-page-harnesses.settings-mobile-nav"), "phone reopens the nav list it was closed from");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offHarness();
    setOverlay(null);
    mobileViewport = false;
    localStorage.clear();
  }
});

test("Projects settings keeps one focused project with compact selection and inline appearance", async () => {
  const alpha = { id: "project-alpha", name: "Alpha", path: "/work/alpha", createdAt: 1, defaults: undefined };
  const beta = { id: "project-beta", name: "Beta", path: "/work/beta", createdAt: 2, defaults: undefined };
  const originalHarnessSnapshots = api.harnessSnapshots;
  const originalPatchProject = api.patchProject;
  const patches: Array<{ id: string; patch: Parameters<typeof api.patchProject>[1] }> = [];
  api.harnessSnapshots = async () => [];
  api.patchProject = async (id, patch) => {
    patches.push({ id, patch });
    const project = id === alpha.id ? alpha : beta;
    return { ...project, defaults: { ...(project.defaults ?? {}), ...(patch.defaults ?? {}) } };
  };
  setModels([{ providerID: "test", modelID: "model", name: "Test Model", connected: true }]);
  applyProjectAdded(alpha);
  applyProjectAdded(beta);
  activateProject(alpha.id);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(ProjectsPage)); });
    await act(async () => { await Promise.resolve(); });

    // The redesign dropped the per-project card; one path line = one focused project.
    assert.equal(container.querySelectorAll(".projects-settings-path").length, 1);
    const projectTrigger = container.querySelector<HTMLButtonElement>(".project-selector .picker-chip");
    assert.ok(projectTrigger, "the projects page uses the shared project picker");
    assert.match(projectTrigger.textContent ?? "", /Alpha/);
    const modelRow = container.querySelector('[data-settings-item="projects.defaultModel"]');
    const harnessRow = container.querySelector('[data-settings-item="projects.executionHarness"]');
    assert.ok(modelRow);
    assert.ok(harnessRow);

    const harnessTrigger = harnessRow.querySelector<HTMLButtonElement>("button");
    assert.ok(harnessTrigger);
    await act(async () => { harnessTrigger.click(); });
    const autoOption = Array.from(document.querySelectorAll<HTMLElement>(".picker-item"))
      .find((item) => item.textContent?.includes("Auto"));
    assert.ok(autoOption);
    await act(async () => {
      autoOption.click();
      await Promise.resolve();
    });
    assert.deepEqual(patches[0], {
      id: alpha.id,
      patch: { defaults: { harness: { mode: "auto" } } },
    });

    const modelTrigger = modelRow.querySelector<HTMLButtonElement>(".project-default-model-picker");
    assert.ok(modelTrigger);
    await act(async () => { modelTrigger.click(); });
    const modelOption = Array.from(document.querySelectorAll<HTMLElement>(".model-picker-row"))
      .find((item) => item.textContent?.includes("Test Model"));
    assert.ok(modelOption);
    await act(async () => {
      modelOption.click();
      await Promise.resolve();
    });
    assert.deepEqual(patches[1], {
      id: alpha.id,
      patch: { defaults: { rememberModelSelection: true, model: { providerID: "test", modelID: "model" } } },
    });

    await act(async () => { projectTrigger.click(); });
    const betaOption = Array.from(document.querySelectorAll<HTMLElement>(".picker-item"))
      .find((item) => item.textContent?.includes("Beta"));
    assert.ok(betaOption, "the picker lists every project");
    await act(async () => {
      betaOption.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.match(container.querySelector(".projects-settings-path")?.textContent ?? "", /\/work\/beta/);
    assert.equal(document.activeElement, projectTrigger, "closing the picker restores trigger focus");
    assert.equal(container.querySelector(".project-selector-kicker"), null);

    const inlineAppearance = container.querySelector<HTMLElement>(".project-appearance-inline");
    assert.ok(inlineAppearance);
    assert.ok(inlineAppearance.querySelector(".project-icon-options"));
    assert.equal(container.querySelector(".project-appearance-dialog"), null);
    assert.equal(
      inlineAppearance.querySelector<HTMLInputElement>('[aria-label="Project title"]')?.value,
      "Beta",
      "switching projects resets the inline appearance draft",
    );
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    applyProjectRemoved(beta.id);
    applyProjectRemoved(alpha.id);
    activateProject(null);
    setModels([]);
    api.harnessSnapshots = originalHarnessSnapshots;
    api.patchProject = originalPatchProject;
  }
});

test("phone Settings knows the edge it came from and moves its stages as a stack", async () => {
  const { presentSettingsFrom, stepSettingsBack } = await import("../src/settingsPresentation.ts");
  // Phone width, motion on (so the stage exit is observable before it ends).
  const previousMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({ matches: media.includes("max-width: 700px"), media, addEventListener() {}, removeEventListener() {} }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root = createRoot(container);
  const shell = () => container.querySelector<HTMLElement>(".settings-shell")!;
  try {
    localStorage.clear();
    presentSettingsFrom("start");
    await act(async () => { root.render(createElement(SettingsView)); });
    assert.equal(shell().getAttribute("data-origin"), "start", "opened from the Navigator: it takes the Navigator's side");
    assert.equal(shell().getAttribute("data-stage-motion"), "rest");
    assert.ok(container.querySelector(".settings-mobile-nav"));

    const general = [...container.querySelectorAll<HTMLButtonElement>(".settings-nav-item")]
      .find((button) => (button.textContent ?? "").includes("Appearance"));
    assert.ok(general);
    await act(async () => { general.click(); });
    assert.ok(container.querySelector(".settings-mobile-page"));
    assert.equal(shell().getAttribute("data-stage-motion"), "push", "a page is pushed over the list");
    assert.ok(container.querySelector(".settings-shell > .settings-nav"), "the list stays mounted beneath it");

    // Android Back steps the page back to the list first.
    await act(async () => { assert.equal(stepSettingsBack(), true); });
    assert.ok(container.querySelector(".settings-mobile-nav"));
    assert.equal(shell().getAttribute("data-stage-motion"), "pop", "the page leaves over the list");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    assert.equal(shell().getAttribute("data-stage-motion"), "rest", "…and is gone once its exit has run");
    assert.equal(stepSettingsBack(), false, "on the list, Back closes Settings");

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(createElement(SettingsView)); });
    assert.equal(shell().getAttribute("data-origin"), "end", "the origin is read once: other openings are pushed from the end");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
    setOverlay(null);
    localStorage.clear();
  }
});

test("the Appearance page mirror layout toggle writes mirrorLayout", async () => {
  const { AppearancePage } = await import("../src/components/settings/pages.tsx");
  const { getUiSettings, setUiSettings } = await import("../src/uiPrefs.ts");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  setUiSettings({ mirrorLayout: false });
  try {
    await act(async () => { root.render(createElement(AppearancePage)); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const row = container.querySelector('[data-settings-item="appearance.mirrorLayout"]') as HTMLElement | null;
    assert.ok(row !== null, "the mirrorLayout row is rendered in Appearance");
    const toggle = row?.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    assert.ok(toggle !== null, "the toggle button exists");
    assert.equal(toggle?.getAttribute("aria-checked"), "false");
    assert.equal(getUiSettings().mirrorLayout, false);

    await act(async () => { toggle?.click(); });
    assert.equal(getUiSettings().mirrorLayout, true, "clicking the toggle writes mirrorLayout = true");
    assert.equal(toggle?.getAttribute("aria-checked"), "true");

    await act(async () => { toggle?.click(); });
    assert.equal(getUiSettings().mirrorLayout, false, "clicking again writes mirrorLayout = false");
    assert.equal(toggle?.getAttribute("aria-checked"), "false");
  } finally {
    setUiSettings({ mirrorLayout: false });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
