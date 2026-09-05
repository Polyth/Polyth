import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { ProviderCatalogDto } from "@polyth/session/web-api";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
let nextAnimationFrame = 0;
const animationFrames = new Map<number, ReturnType<typeof setTimeout>>();
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    const id = ++nextAnimationFrame;
    animationFrames.set(id, setTimeout(() => {
      animationFrames.delete(id);
      callback(performance.now());
    }, 0));
    return id;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: (id: number) => {
    const timer = animationFrames.get(id);
    if (timer !== undefined) clearTimeout(timer);
    animationFrames.delete(id);
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const google: ProviderCatalogDto = {
  id: "google",
  name: "Google",
  connected: true,
  enabled: true,
  models: [
    {
      providerID: "google",
      modelID: "gemini-3.1-flash-image",
      key: "google/gemini-3.1-flash-image",
      name: "Nano Banana 2",
      connected: true,
      enabled: true,
    },
    {
      providerID: "google",
      modelID: "gemini-3.1-flash-image-preview",
      key: "google/gemini-3.1-flash-image-preview",
      name: "Nano Banana 2",
      connected: true,
      enabled: true,
    },
  ],
};

(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const url = String(input);
  const body = url === "/api/providers"
    ? [google]
    : url === "/api/terminals"
      ? { terminalId: "audit-terminal" }
    : url.startsWith("/api/git/status")
      ? {
          branch: null,
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          clean: true,
          isRepo: false,
        }
      : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject,
  activateSession,
  closeWorkspacePane,
  getState,
  setModels,
  setOverlay,
  setSessions,
} = await import("../src/store.ts");
const { installBuiltinMiniWidgets } = await import("../src/widgets/builtinMiniWidgets.tsx");
const { default: Header } = await import("../src/components/Header.tsx");
const { default: ContextRail } = await import("../src/components/ContextRail.tsx");
const { default: CommandPalette } = await import("../src/components/CommandPalette.tsx");
const { default: SessionSearch } = await import("../src/components/SessionSearch.tsx");
const { default: ModelsPage } = await import("../../../packages/models/widgets/ModelsPage.tsx");
installBuiltinMiniWidgets();
const { webPackageHost } = await import("../src/packages/webHost.ts");
for (const entry of [
  (await import("../../../packages/files/widgets/index.tsx")).default,
  (await import("../../../packages/terminal/widgets/index.tsx")).default,
  (await import("../../../packages/browser/widgets/index.tsx")).default,
  (await import("../../../packages/goals/widgets/index.tsx")).default,
]) {
  entry(webPackageHost)();
}

async function mounted(component: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("header primary rail exposes a permanent Terminal toggle after project activation", async () => {
  await act(async () => {
    activateProject("audit-project");
    setSessions("audit-project", [{
      id: "audit-session",
      projectId: "audit-project",
      title: "Audit session",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    }]);
    activateSession("audit-session");
  });
  const header = await mounted(createElement(Header));
  const rail = await mounted(createElement(ContextRail));
  try {
    const search = [...header.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "Search commands and actions");
    const history = [...header.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "Search session history");
    const terminal = header.container.querySelector<HTMLButtonElement>(
      '.view-switcher .view-icon[aria-label="Open Terminal (Ctrl+`)"]',
    );
    const terminalRail = rail.container.querySelector<HTMLButtonElement>(
      '.rail-icon[data-pane-launcher="terminal"]',
    );
    assert.ok(search && history && terminal);
    assert.equal(terminal.title, "Open Terminal (Ctrl+`)");
    assert.equal(terminalRail?.title, "Open Terminal (Ctrl+`)");
    assert.deepEqual(
      [...header.container.querySelectorAll<HTMLButtonElement>(".view-switcher .view-icon")]
        .map((button) => button.getAttribute("aria-label")),
      ["Chat", "Project files", "Open Terminal (Ctrl+`)", "Browser", "Goals & progress", "More workspace tools"],
    );

    await act(async () => { terminal.click(); });
    assert.equal(getState().railPlugin, "terminal");
    assert.equal(terminal.getAttribute("aria-pressed"), "true");
    await act(async () => { terminal.click(); });
    assert.equal(getState().railPlugin, null);
    assert.equal(terminal.getAttribute("aria-pressed"), "false");

    await act(async () => { search.click(); });
    assert.equal(getState().overlay, "palette");
    await act(async () => { history.click(); });
    assert.equal(getState().overlay, "search");
  } finally {
    await act(async () => {
      setOverlay(null);
      closeWorkspacePane();
      activateSession(null);
      activateProject(null);
      setSessions("audit-project", []);
    });
    await header.unmount();
    await rail.unmount();
  }

  const searchSurface = await mounted(createElement(CommandPalette));
  try {
    assert.equal(searchSurface.container.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Search workspace");
    assert.match(searchSurface.container.textContent ?? "", /Commands, projects, sessions, and files/);
  } finally {
    await searchSurface.unmount();
  }

  const historySurface = await mounted(createElement(SessionSearch));
  try {
    assert.equal(historySurface.container.querySelector(".palette-heading-title")?.textContent, "Session history");
    assert.match(historySurface.container.textContent ?? "", /Recent sessions and conversation content/);
  } finally {
    await historySurface.unmount();
  }
});

test("Providers & Models disambiguates colliding names in the expanded provider list", async () => {
  setModels(google.models.map((model) => ({
    providerID: model.providerID,
    modelID: model.modelID,
    name: model.name,
    connected: model.connected,
  })));
  const page = await mounted(createElement(ModelsPage));
  try {
    const expand = page.container.querySelector<HTMLButtonElement>(".provider-expand");
    assert.ok(expand);
    await act(async () => { expand.click(); });
    const labels = [...page.container.querySelectorAll<HTMLElement>(".set-model-name")]
      .map((element) => element.textContent);
    assert.deepEqual(labels, [
      "Nano Banana 2 · google/gemini-3.1-flash-image",
      "Nano Banana 2 · google/gemini-3.1-flash-image-preview",
    ]);
    assert.equal(new Set(labels).size, labels.length);
  } finally {
    await page.unmount();
  }
});
