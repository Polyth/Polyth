// Choosing "Import sessions" in a project's action menu. A
// `sidebar.project.actions` contribution unmounts with its dropdown, so the
// dialog lives in `app.layers` and has to outlive the menu. Moved out of
// apps/web/test/sessionRowMenu.test.ts so the host test no longer names the
// removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
// Menus restore focus through requestAnimationFrame; run it synchronously.
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
// A wide shell on a mouse: the project card menu is the desktop one.
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("hover: hover") && query.includes("pointer: fine"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// An empty server: installed before the imports below, because the API
// transport binds `fetch` when its module loads.
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string }) => {
  const summaries = (init?.method ?? "GET") === "GET" && String(url).startsWith("/api/sessions/summaries?");
  const payload = summaries ? { sessions: [], revision: 0, complete: true } : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject, applyProjectUpsert, setSessions } = await import("../../../apps/web/src/store.ts");
const { default: Sidebar } = await import("../../../apps/web/src/components/Sidebar.tsx");
const { registerSlot } = await import("../../../apps/web/src/slots.ts");
const { default: SlotHost } = await import("../../../apps/web/src/components/slots/SlotHost.ts");
const { ImportDialogLayer, ImportMenuEntry } = await import("../widgets/index.tsx");

/** The project menu renders through a ui/Menu portal on document.body. */
const openMenu = () => document.querySelector<HTMLElement>('[role="menu"]');
const importDialog = () => document.querySelector('[role="dialog"][aria-label="Import sessions"]');

test("selecting Import sessions closes the project menu and keeps its dialog mounted", async () => {
  applyProjectUpsert({ id: "p-import", name: "Import project", path: "/workspace/import", createdAt: Date.now() });
  activateProject("p-import");
  setSessions("p-import", []);
  const offTrigger = registerSlot("sidebar.project.actions", "test.import-trigger", (context) => {
    const closeMenu = context.closeMenu as (() => void) | undefined;
    return createElement(ImportMenuEntry, {
      projectId: String(context.projectId),
      ...(closeMenu ? { closeMenu } : {}),
    });
  }, 10);
  const offLayer = registerSlot("app.layers", "test.import-dialog", () => createElement(ImportDialogLayer), 10);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement("div", null,
        createElement(Sidebar),
        createElement(SlotHost, { slot: "app.layers" }),
      ));
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '.project-menu-btn[aria-label="Actions for Import project"]',
    );
    assert.ok(trigger, "the project action menu is rendered");
    await act(async () => { trigger!.click(); });
    assert.ok(openMenu(), "the project menu opens");
    const importRow = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((row) => (row.textContent ?? "").includes("Import sessions"));
    assert.ok(importRow, "the package row is in the menu footer");
    await act(async () => {
      importRow!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(openMenu() === null, true, "choosing the action dismisses the dropdown");
    assert.ok(importDialog(), "the import dialog stays mounted after its menu unmounts");
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => (button.textContent ?? "").trim() === "Cancel");
    assert.ok(cancel, "the dialog offers Cancel");
    await act(async () => { cancel!.click(); });
    assert.equal(importDialog() === null, true, "closing the dialog releases the floating layer");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offTrigger();
    offLayer();
  }
});
