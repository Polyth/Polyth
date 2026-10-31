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
  getComputedStyle: dom.getComputedStyle.bind(dom),
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
  const body = url === "/api/providers" || url.startsWith("/api/opencode/providers")
    ? [google]
    : url === "/api/providers/auth-capabilities"
      ? {
          revision: "test",
          authorityId: "local",
          generation: 1,
          discoveredAt: 0,
          providers: {},
          discovery: { status: "unavailable", provenance: [] },
        }
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

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

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
} = await import("../../../apps/web/src/store.ts");
const { setUiSettings } = await import("../../../apps/web/src/uiPrefs.ts");
const { installBuiltinMiniWidgets } = await import("../../../apps/web/src/widgets/builtinMiniWidgets.tsx");
const { default: Header } = await import("../../../apps/web/src/components/Header.tsx");
const { default: ContextRail } = await import("../../../apps/web/src/components/ContextRail.tsx");
const { default: CommandPalette } = await import("../../../apps/web/src/components/CommandPalette.tsx");
const { default: SessionSearch } = await import("../../../apps/web/src/components/SessionSearch.tsx");
const { default: ModelsPage } = await import("../../models/widgets/ModelsPage.tsx");
installBuiltinMiniWidgets();
const { webPackageHost } = await import("../../../apps/web/src/packages/webHost.ts");
for (const entry of [
  (await import("../../files/widgets/index.tsx")).default,
  (await import("../../terminal/widgets/index.tsx")).default,
  (await import("../widgets/index.tsx")).default,
  (await import("../../goals/widgets/index.tsx")).default,
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
  // The top rail lives in the bar of the classic layout; a fresh install's
  // bare layout has no bar and docks its tools in the columns instead.
  setUiSettings({ shellLayout: "classic" });
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
    assert.ok(search && terminal);
    // The top-right header rail is curated: Session history is one click
    // away in its editor, not a default icon.
    assert.equal(history, undefined);
    assert.equal(terminal.title, "Open Terminal (Ctrl+`)");
    // One home per icon: the default top-rail Terminal is not repeated in the
    // right rail (it falls back there only when it has no other rail).
    assert.equal(terminalRail, null);
    assert.deepEqual(
      [...header.container.querySelectorAll<HTMLButtonElement>(".view-switcher .view-icon")]
        .map((button) => button.getAttribute("aria-label")),
      // Chat is the main-surface switch, not a top-rail launcher.
      ["Project files", "Open Terminal (Ctrl+`)", "Browser", "Goals & progress"],
    );

    await act(async () => { terminal.click(); });
    assert.equal(getState().railPlugin, "terminal");
    assert.equal(terminal.getAttribute("aria-pressed"), "true");
    await act(async () => { terminal.click(); });
    assert.equal(getState().railPlugin, null);
    assert.equal(terminal.getAttribute("aria-pressed"), "false");

    await act(async () => { search.click(); });
    assert.equal(getState().overlay, "palette");
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
    assert.equal(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Search workspace");
    assert.match(document.body.textContent ?? "", /Commands, projects, sessions, and files/);
  } finally {
    await searchSurface.unmount();
  }

  const historySurface = await mounted(createElement(SessionSearch));
  try {
    assert.equal(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Search sessions");
    assert.equal(
      document.body.querySelector(".session-search-input")?.getAttribute("placeholder"),
      "Search every chat and message…",
    );
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
