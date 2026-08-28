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
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
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
        : url === "/packages-manifest.json"
          ? { packages: [] }
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
const { installNotificationCentre } = await import("../src/components/NotificationCentre.tsx");
const { webPackageHost } = await import("../src/packages/webHost.ts");
const { default: installFilesPackage } = await import("../../../packages/files/widgets/index.tsx");
const { default: installBrowserPackage } = await import("../../../packages/browser/widgets/index.tsx");
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
  installNotificationCentre();
  installFilesPackage(webPackageHost)();
  installBrowserPackage(webPackageHost)();
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

    const navigation = container.querySelector<HTMLElement>('.mobile-shortcut-rail[aria-label="Quick navigation"]');
    assert.ok(navigation, "permanent mobile shortcut rail is mounted");
    const shortcut = (label: string) =>
      navigation!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    const files = shortcut("Project files");
    assert.ok(files, "Files shortcut is present");
    await act(async () => {
      files!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(getState().railPlugin, "files");
    assert.equal(container.querySelector('.rail-fullscreen')?.getAttribute("aria-label"), "Project files");
    assert.equal(document.activeElement?.textContent, "Project files", "Files heading receives focus");

    const browser = shortcut("Browser");
    assert.ok(browser, "Browser destination remains reachable above the open Files pane");
    await act(async () => {
      browser!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(getState().railPlugin, "browser");
    assert.equal(container.querySelector('.rail-fullscreen')?.getAttribute("aria-label"), "Browser");
    assert.equal(document.activeElement?.textContent, "Browser", "Browser heading receives focus");

    const notifications = shortcut("Notifications");
    assert.ok(notifications, "notification centre is a top shortcut");
    await act(async () => {
      notifications!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(getState().railPlugin, "slot:notification-centre");
    assert.equal(container.querySelector(".panel-sheet .sheet-strip"), null, "panel sheet does not duplicate the main navigation rail");

    const bottom = container.querySelector<HTMLElement>(".workspace-bottom-nav");
    assert.ok(bottom, "restored bottom session bar is mounted");
    const search = bottom!.querySelector<HTMLButtonElement>('[aria-label="Command palette"]');
    assert.ok(search);
    assert.equal(search!.textContent, "", "Search stays icon-only");
    await act(async () => { search!.click(); });
    assert.equal(getState().overlay, "palette", "Search opens the unified palette");
    await act(async () => { setOverlay(null); });

    const current = bottom!.querySelector<HTMLButtonElement>('[aria-controls="polyth-session-drawer"]');
    assert.ok(current);
    await act(async () => { current!.click(); });
    assert.equal(getState().sidebarOpen, true, "current session button opens projects and sessions");

    const newChat = bottom!.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    assert.ok(newChat);
    assert.equal(newChat!.textContent, "", "New chat stays icon-only");
    await act(async () => { newChat!.click(); });
    assert.equal(getState().activeSessionId, null);
    assert.equal(getState().newSessionIntent?.projectId, "p1", "New chat creates a project-scoped session intent");

    const settingsButton = shortcut("Settings");
    assert.ok(settingsButton, "Settings is reachable without the grouped Application menu");
    await act(async () => {
      settingsButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const settings = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]');
    assert.ok(settings, "Settings shortcut opens Settings");
    const onboarding = container.querySelector<HTMLElement>('.package-tour[role="dialog"]');
    assert.ok(onboarding, "first Settings visit opens its onboarding above Settings");
    assert.ok(onboarding!.contains(document.activeElement), "focus stays in the topmost onboarding dialog");
    await act(async () => { closePackageTour("dismiss"); });
    assert.ok(settings!.contains(document.activeElement), "dismissing onboarding returns focus inside Settings");

    await act(async () => {
      setOverlay(null);
    });
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Settings",
      "closing Settings restores the permanent top-rail shortcut",
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
