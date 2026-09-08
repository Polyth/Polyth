import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ChatTabDto } from "@polyth/contracts";
import {
  buildTabContextMenuEntries,
  tabContextMenuLabels,
} from "../widgets/lib/tabMenus.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => {},
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const tab = {
  id: "tab-1",
  profileId: "profile-1",
  title: "Polyth test chat",
  url: "http://127.0.0.1:8765/",
  pinned: false,
  hibernated: false,
  lastActiveAt: Date.now(),
  contentAccess: {
    contentAccess: "manual-only",
    agentControl: false,
    observation: false,
    contextCapture: false,
    inspect: false,
  },
} as ChatTabDto;

test("tab context menu lists expected items with separators", () => {
  const actions: string[] = [];
  const entries = buildTabContextMenuEntries({
    tab,
    hasMultipleProfiles: false,
    onAction: (action) => actions.push(action),
  });
  assert.deepEqual(tabContextMenuLabels(entries), [
    "Reload",
    "Duplicate",
    "Move left",
    "Move right",
    "separator",
    "Open in system browser",
    "Copy URL",
    "separator",
    "Pin tab",
    "separator",
    "Close",
    "Close others",
  ]);
  const reload = entries.find((entry) => typeof entry === "object" && "id" in entry && entry.id === "reload");
  assert.equal(typeof reload, "object");
  if (reload && typeof reload === "object" && "onSelect" in reload) reload.onSelect();
  assert.deepEqual(actions, ["reload"]);
});

test("tab context menu closes after selecting an item", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChatWorkspaceTabStrip } = await import("../widgets/ChatWorkspaceTabStrip.tsx");

  const transport = {
    post: async () => ({}),
    delete: async () => ({}),
    get: async () => ({}),
    put: async () => ({}),
    patch: async () => ({}),
    request: async () => ({}),
  } as import("@polyth/web-sdk").ApiTransport;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ChatWorkspaceTabStrip, {
      transport,
      projectId: "project-1",
      tabs: [tab],
      order: [tab.id],
      activeTabId: tab.id,
      providers: [{ id: "custom", name: "Custom", homeUrl: "about:blank", allowedOrigins: [] }],
      profiles: [{
        id: "profile-1",
        providerId: "custom",
        name: "Test chat",
        lastUsedAt: Date.now(),
        createdAt: Date.now(),
        customUrl: tab.url,
        approvedOrigins: [],
      }],
      onSelect: () => {},
      onWorkspaceChange: () => {},
      onOpenProvider: () => {},
      onCustomOpen: () => {},
    }));
  });

  const tabButton = container.querySelector<HTMLElement>(".chat-workspace-tab");
  assert.ok(tabButton);
  const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  await act(async () => {
    tabButton!.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, clientX: 120, clientY: 48 }));
  });
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Tab context menu"]');
  assert.ok(menu, "context menu renders in a portal");
  const labels = [...menu!.querySelectorAll(".ui-menu-item-label")].map((node) => node.textContent);
  assert.ok(labels.includes("Reload"));
  assert.ok(labels.includes("Close others"));
  assert.equal(menu!.querySelectorAll('[role="separator"]').length, 3);
  const reload = menu!.querySelector<HTMLButtonElement>(".ui-menu-item");
  assert.ok(reload);
  await act(async () => {
    reload!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  assert.equal(document.querySelector('[role="menu"][aria-label="Tab context menu"]'), null, "menu closes after selection");
  await act(async () => { root.unmount(); });
  container.remove();
});
