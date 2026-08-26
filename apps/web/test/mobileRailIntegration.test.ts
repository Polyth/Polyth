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
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }),
});
(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const url = String(input);
  const body = url.startsWith("/api/git/status")
    ? { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] }
    : url.startsWith("/api/github/status")
      ? { installed: false, authenticated: false, user: null }
      : url === "/api/packages"
        ? { packages: [{ id: "models", name: "Providers & Models", description: "Model configuration.", core: true, enabled: true, hasSettings: true }] }
      : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject, applyProjectUpsert, closeWorkspacePane, getState, setActiveView,
  setOverlay, useStore,
} = await import("../src/store.ts");
const { default: Header } = await import("../src/components/Header.tsx");
const { default: ContextRail } = await import("../src/components/ContextRail.tsx");
const { default: SettingsModal } = await import("../src/components/SettingsModal.tsx");
const { bootPackages } = await import("../src/packages/registry.ts");
const { closePackageTour } = await import("../src/packages/onboarding/controller.ts");

function MountedShell() {
  const overlay = useStore((state) => state.overlay);
  return createElement("div", { className: "app mode-chat view-session" },
    createElement(Header),
    createElement("div", { className: "app-shell" },
      createElement("div", { className: "workspace" },
        createElement("main", { className: "main" },
          createElement("h1", { className: "view-title" }, "Multi-run"),
        ),
      ),
      createElement(ContextRail),
    ),
    createElement(SettingsModal, {
      open: overlay === "settings",
      onClose: () => setOverlay(null),
    }),
  );
}

test("mobile app header focuses workspace destinations without escaping a destination modal", async () => {
  await bootPackages();
  applyProjectUpsert({ id: "p1", name: "Project one", path: "/workspace", createdAt: Date.now() });
  activateProject("p1");
  setActiveView("session");
  closeWorkspacePane();

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(MountedShell));
    });

    const openNavigation = async () => {
      const trigger = container.querySelector<HTMLButtonElement>(
        '.mobile-navigation-trigger[aria-label="Application"]',
      );
      assert.ok(trigger, "permanent mobile header navigation trigger is mounted");
      await act(async () => { trigger!.click(); });
      return container.querySelector<HTMLElement>('.mobile-navigation-rail[aria-label="Application"]');
    };

    let navigation = await openNavigation();
    assert.ok(navigation, "grouped destination rail opens");
    const files = [...navigation!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.trim() === "Project files");
    assert.ok(files, "Files destination is present");
    await act(async () => {
      files!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(getState().railPlugin, "files");
    assert.equal(container.querySelector('.rail-fullscreen')?.getAttribute("aria-label"), "Project files");
    assert.equal(document.activeElement?.textContent, "Project files", "Files heading receives focus");

    navigation = await openNavigation();
    const browser = [...navigation!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.trim() === "Browser");
    assert.ok(browser, "Browser destination remains reachable above the open Files pane");
    await act(async () => {
      browser!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(getState().railPlugin, "browser");
    assert.equal(container.querySelector('.rail-fullscreen')?.getAttribute("aria-label"), "Browser");
    assert.equal(document.activeElement?.textContent, "Browser", "Browser heading receives focus");

    navigation = await openNavigation();
    const models = [...navigation!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.trim() === "Models & agents");
    assert.ok(models, "Models & agents destination is present");
    await act(async () => {
      models!.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const settings = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]');
    const onboarding = container.querySelector<HTMLElement>('.package-tour[role="dialog"]');
    assert.ok(settings, "Models & agents opens Settings");
    assert.ok(onboarding, "first visit opens the Models onboarding dialog above Settings");
    assert.ok(
      onboarding!.contains(document.activeElement),
      "focus remains inside the topmost onboarding dialog",
    );
    assert.notEqual(
      document.activeElement?.textContent,
      "Multi-run",
      "focus never moves to the obscured workspace heading",
    );
    await act(async () => {
      closePackageTour("dismiss");
    });
    assert.equal(
      document.activeElement,
      container.querySelector(".settings-nav-title"),
      "dismissing onboarding restores focus to the visible Settings heading",
    );
    assert.notEqual(document.activeElement, document.body, "tour dismissal never orphans focus on body");

    await act(async () => {
      setOverlay(null);
    });
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Application",
      "closing Settings restores the permanent mobile rail trigger",
    );
    assert.notEqual(document.activeElement, document.body, "Settings dismissal never orphans focus on body");
  } finally {
    await act(async () => {
      closePackageTour("dismiss");
      setOverlay(null);
      root.unmount();
    });
    container.remove();
    closeWorkspacePane();
  }
});
