// Navigator header (wide sidebar): row 1 is [collapse] [search] [filter], row
// 2 the full-width New chat, then one row per chosen package action (default
// Agents then Planner, capped with More…, editable, device-local). The rail
// header puts New chat under the project row, and a collapsed rail gets a
// square New chat under its toggle. One grid runs through header and list.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  getComputedStyle: (elt: Element, pseudo?: string | null) =>
    (dom as unknown as { getComputedStyle(el: Element, pseudo?: string | null): CSSStyleDeclaration })
      .getComputedStyle(elt, pseudo),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: true, status: 200, statusText: "OK", json: async () => [], text: async () => "[]",
});

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { setSidebarViewMode } = await import("../src/sidebarPrefs.ts");
const { setSidebarLayout } = await import("../src/sidebarLayout.ts");
const { registerCapability } = await import("../src/capabilities.ts");
const { registerCommand } = await import("../src/commands.ts");
const { default: Sidebar } = await import("../src/components/Sidebar.tsx");
const {
  DEFAULT_NAVIGATOR_ACTIONS, NAVIGATOR_ACTIONS_KEY, NAVIGATOR_ACTIONS_VISIBLE_MAX, parseNavigatorActions, writeNavigatorActions,
} = await import("../src/navigatorState.ts");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id, createdAt: 1 });

const opened: string[] = [];
const capability = (id: string, label: string, available = true) => registerCapability({
  id, label, plainDescription: label, keywords: [], standardTier: "more", standardRank: 50,
  open: () => { opened.push(id); }, available: () => available,
});
for (const [id, label] of [
  ["schedule", "Agents"], ["planner", "Planner"], ["bookmarks", "Bookmarks"],
  ["browser", "Browser"], ["terminal", "Terminal"], ["usage", "Usage"],
] as const) capability(id, label);
capability("offline", "Offline tool", false);
capability("session", "Chat");
// The shell registers this at boot (shell.ts) with the user's keymap combo.
registerCommand({ id: "cmd.new", label: "New chat", hint: () => "Ctrl+N", group: "Chat", run: () => {} });

async function render(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("alpha"), project("beta")]);
  store.activateProject("alpha");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Sidebar)); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}
const rowLabels = (container: HTMLElement) => [...container.querySelectorAll(".sidebar-nav-actions > .sidebar-nav-row")]
  .map((row) => row.textContent?.trim());

test("stored action ids parse defensively and default to Agents then Planner", () => {
  assert.deepEqual(DEFAULT_NAVIGATOR_ACTIONS, ["schedule", "planner"]);
  assert.equal(parseNavigatorActions(null), DEFAULT_NAVIGATOR_ACTIONS);
  assert.equal(parseNavigatorActions("not json"), DEFAULT_NAVIGATOR_ACTIONS);
  assert.equal(parseNavigatorActions('{"a":1}'), DEFAULT_NAVIGATOR_ACTIONS);
  assert.deepEqual(parseNavigatorActions('["planner","planner",3,"","browser"]'), ["planner", "browser"]);
  assert.deepEqual(parseNavigatorActions("[]"), [], "an emptied block stays empty");
});

test("tree header: [collapse][search][filter], then New chat, then the package actions", async () => {
  localStorage.removeItem(NAVIGATOR_ACTIONS_KEY);
  setSidebarViewMode("tree");
  setSidebarLayout({ collapsed: false });
  const { container, unmount } = await render();
  try {
    const bar = container.querySelector<HTMLElement>(".sidebar-service-bar")!;
    const controls = [...bar.children]
      .filter((child) => !child.classList.contains("zone-customize-trigger"))
      .map((child) => child.classList.contains("sidebar-collapse") ? "collapse"
        : child.classList.contains("sidebar-search") ? "search"
          : child.classList.contains("sidebar-filter") ? "filter" : child.className);
    assert.deepEqual(controls, ["collapse", "search", "filter"], "row 1 holds only collapse, search and the list options");
    assert.equal(bar.querySelector(".sidebar-select-toggle"), null, "selection moved into the list options");
    assert.equal(bar.querySelector(".sidebar-new-session"), null, "the compose icon gave way to the New chat row");

    const block = bar.nextElementSibling as HTMLElement;
    assert.ok(block.classList.contains("sidebar-nav-block"), "the rows follow row 1");
    const newChat = block.firstElementChild as HTMLButtonElement;
    assert.ok(newChat.classList.contains("sidebar-nav-new"), "row 2 is New chat");
    assert.equal(newChat.getAttribute("aria-label"), "New chat in alpha");
    assert.equal(newChat.querySelector(".sidebar-nav-label")?.textContent, "New chat");
    assert.equal(newChat.querySelector(".sidebar-nav-hint")?.textContent, "Ctrl+N", "the New chat command's keymap hint is shown");
    assert.deepEqual(rowLabels(container), ["Agents", "Planner"], "defaults: Agents, then Planner");

    await act(async () => { click(container.querySelector('.sidebar-nav-action[data-capability="planner"]')!); });
    assert.deepEqual(opened.splice(0), ["planner"], "a row calls its capability's open()");
    await act(async () => { click(newChat); });
    assert.equal(store.getState().newSessionIntent?.projectId, "alpha", "New chat starts a chat in the project");
  } finally {
    await unmount();
  }
});

test("package actions skip unavailable ones, cap at four and list the rest under More…", async () => {
  writeNavigatorActions(["offline", "schedule", "planner", "bookmarks", "browser", "terminal", "usage", "gone"]);
  setSidebarViewMode("tree");
  const { container, unmount } = await render();
  try {
    assert.equal(NAVIGATOR_ACTIONS_VISIBLE_MAX, 4);
    assert.deepEqual(rowLabels(container), ["Agents", "Planner", "Bookmarks", "Browser", "More…"],
      "unavailable and unknown ids are skipped; past four rows a More… row lists the rest");
    await act(async () => { click(container.querySelector(".sidebar-nav-more")!); });
    const more = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim());
    assert.deepEqual(more, ["Terminal", "Usage"]);
  } finally {
    await unmount();
    localStorage.removeItem(NAVIGATOR_ACTIONS_KEY);
  }
});

test("the block's edit menu adds and removes rows and persists them device-locally", async () => {
  localStorage.removeItem(NAVIGATOR_ACTIONS_KEY);
  setSidebarViewMode("tree");
  const { container, unmount } = await render();
  try {
    await act(async () => { click(container.querySelector(".sidebar-nav-actions-edit")!); });
    const entries = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
    const labels = entries().map((item) => item.textContent?.trim());
    assert.ok(labels.includes("Browser") && labels.includes("Agents"), "every launchable capability is offered");
    assert.ok(!labels.includes("Chat"), "Chat is the New chat row, not a package action");
    const offline = entries().find((item) => item.textContent?.trim() === "Offline tool")!;
    assert.equal(offline.getAttribute("aria-disabled") ?? String((offline as HTMLButtonElement).disabled), "true",
      "an unavailable capability cannot be added");
    await act(async () => { click(entries().find((item) => item.textContent?.trim() === "Agents")!); });
    assert.equal(localStorage.getItem(NAVIGATOR_ACTIONS_KEY), '["planner"]');
    assert.deepEqual(rowLabels(container), ["Planner"]);
    // Checkbox entries keep the menu open for several changes; reopen only if it closed.
    if (entries().length === 0) await act(async () => { click(container.querySelector(".sidebar-nav-actions-edit")!); });
    await act(async () => { click(entries().find((item) => item.textContent?.trim() === "Browser")!); });
    assert.deepEqual(rowLabels(container), ["Planner", "Browser"], "an added row goes to the end");
  } finally {
    await unmount();
    localStorage.removeItem(NAVIGATOR_ACTIONS_KEY);
  }
});

test("rail header: project row with search, filter and ⋮, then New chat; the collapsed rail has a New chat square", async () => {
  localStorage.removeItem(NAVIGATOR_ACTIONS_KEY);
  setSidebarViewMode("rail");
  setSidebarLayout({ collapsed: false });
  const { container, unmount } = await render();
  try {
    const header = container.querySelector<HTMLElement>(".sidebar-focused-project[data-tools]")!;
    assert.ok(header);
    assert.equal(header.querySelector(".sidebar-header-compose"), null, "no compose icon in the project row");
    const block = header.nextElementSibling as HTMLElement;
    assert.ok(block.classList.contains("sidebar-nav-block"));
    assert.ok(block.firstElementChild?.classList.contains("sidebar-nav-new"));
    assert.deepEqual(rowLabels(container), ["Agents", "Planner"]);
    assert.equal(container.querySelector(".sidebar-rail-new-chat"), null, "the open rail starts chats from the row");

    await act(async () => { setSidebarLayout({ collapsed: true, restoreViewMode: "rail" }); });
    const square = container.querySelector<HTMLButtonElement>(".sidebar-project-rail .sidebar-rail-new-chat")!;
    assert.ok(square, "the collapsed rail offers New chat");
    assert.equal(square.getAttribute("aria-label"), "New chat");
    assert.ok(square.closest(".sidebar-project-rail")!.querySelector(".sidebar-rail-switch + .sidebar-rail-new-chat + .sidebar-rail-divider"),
      "it sits under the expand toggle, then a divider before the project glyphs");
    await act(async () => { click(square); });
    assert.equal(store.getState().newSessionIntent?.projectId, "alpha", "it starts a chat in the rail's project, like the row");
  } finally {
    await unmount();
    setSidebarLayout({ collapsed: false });
    setSidebarViewMode("tree");
  }
});

test("navigator CSS: one grid, the search field follows corner rounding, labels never clip descenders", async () => {
  const [styles, glass] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/liquidGlassTheme.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(glass, /:is\([^)]*\.sidebar-search[^)]*\)\s*\{\s*border-radius:\s*var\(--lg-radius-capsule\)/,
    "the glass theme no longer forces the navigator search into a capsule");
  assert.match(glass, /\.sidebar-search \{ border-radius: var\(--radius-card\); \}/);
  const row = styles.match(/\.sidebar-nav-row \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(row, /padding: 0 10px 0 var\(--nav-glyph-inset\);/, "glyph at the inset, trailing hint 10px inside");
  assert.match(row, /line-height: 1\.385;/, "18px line at 13px");
  assert.match(styles, /\.sidebar-nav-glyph \{[\s\S]*?width: calc\(var\(--nav-text-inset\) - var\(--nav-glyph-inset\)\);/,
    "labels start on the text axis");
  assert.match(styles, /\.project-card > \.project-glyph \{\s*width: calc\(var\(--nav-text-inset\) - var\(--nav-glyph-inset\)\);/,
    "project names share the text axis");
  assert.match(styles, /\.sidebar \.sidebar-rail-new-chat \{[\s\S]*?width: 34px;[\s\S]*?background: var\(--accent-wash\);/);
  // Every override that re-declares the list's inline padding uses the gutter.
  for (const rule of styles.match(/\.side-scroll \{[^}]*\}/g) ?? []) {
    if (/padding-inline|padding:/.test(rule)) assert.match(rule, /var\(--nav-gutter\)/, rule);
  }
});
