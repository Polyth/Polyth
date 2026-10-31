// Every feature module — main-area workspace surfaces and
// right-rail panels alike — renders inside the one shared ModuleView frame.
// The frame owns the header, the single top-right close (closeAllModules),
// and the phone slide-in overlay. Feature packages no longer draw their own
// page header, "Back to chat" link, or bottom status/save bar.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import type { ComponentType } from "react";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

// Discover installed packages instead of naming removable ones.
const packagesDir = fileURLToPath(new URL("../../../packages/", import.meta.url));
const packageIds = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
  .map((entry) => entry.name)
  .sort();

function widgetFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return widgetFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const packageWidgets = packageIds.flatMap((id) =>
  widgetFiles(join(packagesDir, id, "widgets")).map((path) => ({
    rel: `packages/${id}/${path.slice(join(packagesDir, id).length + 1)}`,
    source: readFileSync(path, "utf8"),
  })));

// --- DOM-free render contract -------------------------------------------------

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ModuleView } = await import("../src/components/ui/ModuleView.ts");
const { default: WorkspaceHost } = await import("../src/components/workspace/WorkspaceHost.ts");
const { registerWorkspaceSurface } = await import("../src/workspace/surfaceRegistry.ts");
const { getState, setActiveView, setRailPlugin, closeAllModules } = await import("../src/store.ts");

async function mount(node: ComponentType<any>, props?: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(node, props ?? null)); });
  return {
    container,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("ModuleView renders one header, one description, one close button, and a body", async () => {
  let closed = 0;
  const { container, unmount } = await mount(ModuleView, {
    id: "demo",
    title: "Demo module",
    description: "A one-line purpose.",
    variant: "main",
    contentMode: "page",
    onClose: () => { closed += 1; },
    children: createElement("p", { className: "demo-body" }, "content"),
  });
  try {
    const section = container.querySelector("section.module-view.module-view--main");
    assert.ok(section, "renders a .module-view--main section");
    assert.equal(section?.getAttribute("data-module-id"), "demo");

    const title = container.querySelector(".module-view-head h1.module-view-title");
    assert.equal(title?.textContent, "Demo module");
    assert.equal(container.querySelector(".module-view-desc")?.textContent, "A one-line purpose.");

    const closers = container.querySelectorAll(".module-view-close");
    assert.equal(closers.length, 1, "exactly one close control");
    (closers[0] as unknown as { click: () => void }).click();
    assert.equal(closed, 1, "the close button calls onClose");

    assert.ok(container.querySelector(".module-view-body > .module-view-content--page > .demo-body"),
      "children land in the core-owned page content wrapper");
    // No footer / status region is part of the frame.
    assert.equal(container.querySelector(".module-view-footer"), null);
  } finally {
    await unmount();
  }
});

test("ModuleView owns pin/fullscreen/close controls and preserves the full long title", async () => {
  const calls: string[] = [];
  const longTitle = "A very long translated package title that must remain on one line";
  const { container, unmount } = await mount(ModuleView, {
    id: "long", title: longTitle, pinned: true, fullscreen: false,
    onTogglePin: () => calls.push("pin"),
    onToggleFullscreen: () => calls.push("fullscreen"),
    onClose: () => calls.push("close"),
  });
  try {
    const title = container.querySelector(".module-view-title");
    assert.equal(title?.getAttribute("title"), longTitle);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".module-view-head button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), ["Unpin window", "Enter fullscreen", "Close panel"]);
    buttons.forEach((button) => button.click());
    assert.deepEqual(calls, ["pin", "fullscreen", "close"]);
  } finally {
    await unmount();
  }
});

test("ModuleView keeps the pin beside the package-declared dock actions", async () => {
  const calls: string[] = [];
  const { container, unmount } = await mount(ModuleView, {
    id: "terminal", title: "Terminal",
    // The host passes only the edges the window can move to.
    dockActions: [
      { edge: "side", label: "Dock beside Chat", selected: false, onClick: () => calls.push("side") },
    ],
    pinned: true,
    onTogglePin: () => calls.push("pin"),
    onClose: () => calls.push("close"),
  });
  try {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".module-view-head button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), [
      "Dock beside Chat", "Unpin window", "Close panel",
    ]);
    assert.equal(buttons[0]?.hasAttribute("aria-pressed"), false, "moving to an edge is an action, not a toggle");
    assert.equal(buttons[1]?.getAttribute("aria-pressed"), "true", "a pinned window shows the pressed pin");
    buttons.forEach((button) => button.click());
    assert.deepEqual(calls, ["side", "pin", "close"]);
  } finally {
    await unmount();
  }
});

test("WorkspaceHost wraps every non-session surface in ModuleView, and never the session", async () => {
  const offs: Array<() => void> = [];
  setActiveView("session");
  const sessionMount = await mount(WorkspaceHost);
  try {
    await act(async () => {
      offs.push(registerWorkspaceSurface({
        id: "session", title: "Session", order: 0,
        component: () => createElement("div", { className: "session-body" }, "chat"),
      }));
    });
    assert.equal(sessionMount.container.querySelector(".module-view"), null,
      "the session surface is the workspace — no module frame");
  } finally {
    await sessionMount.unmount();
  }

  setActiveView("goals");
  const goalsMount = await mount(WorkspaceHost);
  try {
    await act(async () => {
      offs.push(registerWorkspaceSurface({
        id: "goals", title: "Session goals", description: "Attach an objective.",
        order: 20, requires: "none",
        component: () => createElement("div", { className: "goals-body" }, "goals"),
      }));
    });
    const frame = goalsMount.container.querySelector(".module-view--main[data-module-id='goals']");
    assert.ok(frame, "the goals surface renders inside the shared module frame");
    assert.equal(frame?.querySelector(".module-view-title")?.textContent, "Session goals");
    assert.equal(frame?.querySelector(".module-view-desc")?.textContent, "Attach an objective.");
    assert.ok(frame?.querySelector(".module-view-body .goals-body"), "surface body is nested in the frame");
  } finally {
    await act(async () => { for (const off of offs) off(); });
    setActiveView("session");
    await goalsMount.unmount();
  }
});

test("closeAllModules returns to the session and clears any rail panel", async () => {
  setActiveView("goals");
  setRailPlugin("context");
  closeAllModules();
  assert.equal(getState().activeView, "session");
  assert.equal(getState().railPlugin, null);
});

test("opening a primary module replaces an open rail surface instead of flashing Chat", () => {
  setRailPlugin("context");
  setActiveView("goals");
  assert.equal(getState().activeView, "goals");
  assert.equal(getState().railPlugin, null, "the prior panel cannot remain above the new module");
  closeAllModules();
});

// --- source + style contracts ----------------------------------------------

/** Brace-matched bodies of every `surfaces.register(...)` call in a source file. */
function surfaceRegisterCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "surfaces.register(";
  let index = source.indexOf(marker);
  while (index !== -1) {
    const open = index + marker.length - 1;
    let depth = 0;
    let cursor = open;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) { cursor += 1; break; }
      cursor += 1;
    }
    calls.push(source.slice(open, cursor));
    index = source.indexOf(marker, cursor);
  }
  return calls;
}

test("no package module view draws its own page header", () => {
  for (const { rel, source } of packageWidgets) {
    assert.doesNotMatch(source, /className="view-title"/, `${rel} keeps no local page title`);
    assert.doesNotMatch(source, /className="view-sub"/, `${rel} keeps no local page subtitle`);
    assert.doesNotMatch(source, /className="view-page/, `${rel} leaves page layout to ModuleView`);
  }
});

test("no package view draws a workflow save/status bar or a Back to chat button", () => {
  for (const { rel, source } of packageWidgets) {
    assert.doesNotMatch(source, /workflow-mobile-savebar/, rel);
    assert.doesNotMatch(source, /workflow-back-chat/, rel);
    assert.doesNotMatch(source, /workflow-page-header/, rel);
  }
});

test("every package surface registers a description for the shared header", () => {
  const surfaces = packageWidgets
    .filter(({ rel }) => rel.endsWith("/widgets/index.tsx"))
    .flatMap(({ rel, source }) => surfaceRegisterCalls(source).map((call) => ({ rel, call })));
  const described = new Set<string>();
  for (const { rel, call } of surfaces) {
    const id = /id:\s*["']([^"']+)["']/.exec(call)?.[1];
    if (/description:/.test(call)) {
      if (id) described.add(id);
      continue;
    }
    // A docked surface presents through its dock control, whose label replaces
    // the shared subtitle; every other surface must pass a description so the
    // shared header reads correctly for packages that are installed.
    assert.match(call, /dock:\s*["']/, `${rel} omits a description only for a docked surface`);
    assert.match(call, /title:\s*["'][^"']+["']/, `${rel} still titles the surface`);
  }
  // The shell ships these packages in every build, so the contract above is
  // never vacuous when the removable packages are absent.
  for (const id of ["files", "git", "terminal"]) {
    assert.ok(described.has(id), `${id} passes a description to the shared header`);
  }
});

test("styles.css realizes the phone module overlay: slide-in, opaque cover, one close", async () => {
  const css = await read("../src/styles.css");
  const stack = await read("../src/stackNavigation.css");
  const tokens = await read("../src/tokens.css");
  assert.match(stack, /@keyframes stack-in\s*\{\s*from\s*\{\s*transform:\s*translate3d\(calc\(var\(--stack-dir, 1\) \* 100%\), 0, 0\)/,
    "modules enter from the inline-end edge (mirrored by --stack-dir in RTL)");
  assert.match(css, /\.module-view--main\s*\{[^}]*position:\s*fixed[^}]*animation:\s*stack-in/s,
    "the main module view is a fixed slide-in layer on phone");
  assert.match(css, /\.module-view--main\s*\{[^}]*inset:\s*0/s,
    "the main module view covers the full phone viewport");
  assert.match(css, /\.rail-fullscreen,\s*\n\s*\.panel-sheet\s*\{[^}]*background:\s*var\(--bg\)/s,
    "rail panels share the identical opaque cover on phone");
  assert.doesNotMatch(css.slice(css.indexOf(".rail-fullscreen,\n  .panel-sheet {"), css.indexOf(".rail-fullscreen,\n  .panel-sheet {") + 400), /animation:/,
    "their travel is the shared stack grammar, not a private animation");
  assert.match(stack, /\.railbar > :is\(\.rail-workspace\.rail-fullscreen, \.panel-sheet\):not\(\.rail-exiting\)\s*\{\s*animation:\s*stack-in/,
    "workspace panes and contextual panels enter through the stack grammar");
  assert.match(css, /:is\(\.module-view--main, \.rail-fullscreen, \.panel-sheet\) \{\s*padding-block-start:\s*var\(--safe-top\);\s*padding-block-end:\s*max\(var\(--safe-bottom\),\s*var\(--keyboard-inset\)\)/,
    "the shared module header starts under the notch and clears the bottom safe area");
  assert.doesNotMatch(css, /padding-block-start:\s*calc\(60px \+ var\(--safe-top\)\)/,
    "no module layer leaves a strip for the session menu above its own header");
  for (const layer of [/\.module-view--main\s*\{\s*position:\s*fixed;\s*inset:\s*0;\s*z-index:\s*var\(--z-stack-package\)/,
    /:has\(> :is\(\.rail-fullscreen, \.panel-sheet\)\) \{\s*position:\s*fixed;\s*inset:\s*0;\s*inset-inline:\s*0;\s*z-index:\s*var\(--z-stack-package\)/]) {
    assert.match(css, layer, `phone layer stacking rule exists: ${layer}`);
  }
  // Layer order: session header/floats (+2) < Workspace (+3) < package window (+4).
  const workspaceZ = /--z-stack-workspace:\s*calc\(var\(--z-shell\) \+ (\d+)\)/.exec(tokens);
  const packageZ = /--z-stack-package:\s*calc\(var\(--z-shell\) \+ (\d+)\)/.exec(tokens);
  assert.ok(workspaceZ && packageZ, "the stack layer tokens exist");
  assert.ok(Number(workspaceZ[1]) > 2, "the Workspace covers the shell header and session floats (z-shell + 2)");
  assert.ok(Number(packageZ[1]) > Number(workspaceZ[1]), "a package window covers the Workspace it was opened from");
  assert.match(css, /var\(--app-background-image\)/,
    "mobile package windows use the selected app background");
  assert.match(css, /\.panel-sheet-backdrop\s*\{\s*display:\s*none;\s*\}/, "no dim backdrop on phone");
  assert.match(css, /\.pane-back\s*\{\s*display:\s*none;\s*\}/, "no secondary Back-to-chat affordance on phone");
  assert.match(css, /z-index:\s*calc\(var\(--z-stack-package\) \+ var\(--module-depth, 0\)\)/, "stacked rail panels layer above the Workspace, the composer and the session menu");
});

test("ContextRail uses ModuleView rather than its own second header", async () => {
  const rail = await read("../src/components/ContextRail.tsx");
  assert.match(rail, /import ModuleView(?:, \{[^}]*\})? from "\.\/ui\/ModuleView\.ts"/);
  assert.match(rail, /<ModuleView[\s\S]*?variant="rail"/);
  assert.match(rail, /contentMode=\{paneWorkspace \? "workspace" : "panel"\}/,
    "the core host chooses content behavior instead of packages");
  assert.match(rail, /presented=\{open !== null\}/,
    "a closed keep-alive frame stays mounted but is never presented");
  assert.doesNotMatch(rail, /className=\{`rail-head/, "the legacy rail header is gone");
  assert.doesNotMatch(rail, /pane-back/, "there is no rail-specific Back to Chat control");
});

test("phone drops the global status bar entirely", async () => {
  const app = await read("../src/App.tsx");
  assert.match(app, /shellMode !== "phone" && <StatusBar \/>/, "StatusBar is not mounted on phone");
});
