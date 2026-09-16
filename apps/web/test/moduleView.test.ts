// UX-MODULE-STACK: every feature module — main-area workspace surfaces and
// right-rail panels alike — renders inside the one shared ModuleView frame.
// The frame owns the header, the single top-right close (closeAllModules),
// and the phone slide-in overlay. Feature packages no longer draw their own
// page header, "Back to chat" link, or bottom status/save bar.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import type { ComponentType } from "react";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

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

test("ModuleView renders the package-declared dock actions", async () => {
  const calls: string[] = [];
  const { container, unmount } = await mount(ModuleView, {
    id: "terminal", title: "Terminal",
    dockActions: [
      { edge: "bottom", label: "Dock below Chat", selected: true, onClick: () => calls.push("bottom") },
      { edge: "side", label: "Dock beside Chat", selected: false, onClick: () => calls.push("side") },
    ],
    onTogglePin: () => calls.push("generic-pin"),
    onClose: () => calls.push("close"),
  });
  try {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".module-view-head button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), [
      "Dock below Chat", "Dock beside Chat", "Close panel",
    ]);
    assert.equal(buttons[0]?.getAttribute("aria-pressed"), "true");
    assert.equal(buttons[1]?.getAttribute("aria-pressed"), "false");
    buttons.forEach((button) => button.click());
    assert.deepEqual(calls, ["bottom", "side", "close"]);
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

test("feature module views no longer draw their own page header", async () => {
  for (const rel of [
    "../../../packages/goals/widgets/GoalsView.tsx",
    "../../../packages/workflow/widgets/WorkflowView.tsx",
    "../../../packages/multirun/widgets/MultiRunView.tsx",
    "../../../packages/fusion/widgets/FusionView.tsx",
    "../../../packages/walkthrough/widgets/WalkthroughView.tsx",
    "../../../packages/schedule/widgets/PlannerView.tsx",
    "../../../packages/github/widgets/GithubView.tsx",
    "../../../packages/git/widgets/GitView.tsx",
    "../../../packages/files/widgets/EditorView.tsx",
    "../../../packages/terminal/widgets/TerminalView.tsx",
    "../../../packages/browser/widgets/PreviewView.tsx",
    "../../../packages/knowledge/widgets/KnowledgePanel.tsx",
    "../../../packages/knowledge/widgets/TracksPanel.tsx",
    "../../../packages/usage/widgets/usage/UsageDashboard.tsx",
  ]) {
    const src = await read(rel);
    assert.doesNotMatch(src, /className="view-title"/, `${rel} keeps no local page title`);
    assert.doesNotMatch(src, /className="view-sub"/, `${rel} keeps no local page subtitle`);
    assert.doesNotMatch(src, /className="view-page/, `${rel} leaves page layout to ModuleView`);
  }
});

test("the workflow view has no bottom save/status bar and no Back to chat button", async () => {
  const src = await read("../../../packages/workflow/widgets/WorkflowView.tsx");
  assert.doesNotMatch(src, /workflow-mobile-savebar/);
  assert.doesNotMatch(src, /workflow-back-chat/);
  assert.doesNotMatch(src, /workflow-page-header/);
});

test("each main-area surface registers a description for the shared header", async () => {
  const pairs: Array<[string, RegExp]> = [
    ["../../../packages/goals/widgets/index.tsx", /surfaces\.register\(\{[^}]*id: "goals"[^}]*description:/s],
    ["../../../packages/workflow/widgets/index.tsx", /surfaces\.register\(\{[\s\S]*?id: "workflow"[\s\S]*?description:/],
    ["../../../packages/multirun/widgets/index.tsx", /id: "multirun", title: "[^"]+", description:/],
    ["../../../packages/fusion/widgets/index.tsx", /id: "fusion", title: "[^"]+", description:/],
    ["../../../packages/walkthrough/widgets/index.tsx", /id: "walkthrough", title: "[^"]+", description:/],
    ["../../../packages/github/widgets/index.tsx", /id: "github", title: "[^"]+", description:/],
  ];
  for (const [rel, re] of pairs) {
    assert.match(await read(rel), re, `${rel} passes a description to its surface`);
  }
  const schedule = await read("../../../packages/schedule/widgets/index.tsx");
  const surface = schedule.match(/host\.surfaces\.register\(\{[\s\S]*?dock: "bottom"[\s\S]*?\}\s*\)/)?.[0] ?? "";
  assert.match(surface, /id: "schedule"/);
  assert.match(surface, /title: "Planner"/);
  assert.doesNotMatch(surface, /description:/, "Planner omits a ModuleView subtitle");
});

test("each package rail surface registers a description for the shared header", async () => {
  const pairs: Array<[string, RegExp]> = [
    ["../../../packages/files/widgets/index.tsx", /surfaces\.register\(\{[^}]*id: "files"[^}]*description:/s],
    ["../../../packages/git/widgets/index.tsx", /surfaces\.register\(\{[^}]*id: "git"[^}]*description:/s],
    ["../../../packages/terminal/widgets/index.tsx", /surfaces\.register\(\{[^}]*id: "terminal"[^}]*description:/s],
    ["../../../packages/browser/widgets/index.tsx", /surfaces\.register\(\{[^}]*id: "browser"[^}]*description:/s],
    ["../../../packages/knowledge/widgets/index.tsx", /surfaces\.register\(\{[^}]*id: "knowledge"[^}]*description:/s],
    ["../../../packages/usage/widgets/index.tsx", /surfaces\.register\(\{[\s\S]*?id: "usage"[\s\S]*?description:/],
  ];
  for (const [rel, re] of pairs) assert.match(await read(rel), re, `${rel} passes a description to its surface`);
});

test("styles.css realizes the phone module overlay: slide-in, opaque cover, one close", async () => {
  const css = await read("../src/styles.css");
  assert.match(css, /@keyframes module-slide-in\s*\{\s*from\s*\{\s*transform:\s*translateX\(100%\)/,
    "modules enter right-to-left");
  assert.match(css, /\.module-view--main\s*\{[^}]*position:\s*fixed[^}]*animation:\s*module-slide-in/s,
    "the main module view is a fixed slide-in layer on phone");
  assert.match(css, /\.module-view--main\s*\{[^}]*inset:\s*0/s,
    "the main module view covers the full phone viewport");
  assert.match(css, /\.rail-fullscreen,\s*\n\s*\.panel-sheet\s*\{[^}]*background:\s*var\(--bg\)[^}]*animation:\s*module-slide-in/s,
    "rail panels share the identical opaque slide-in cover on phone");
  assert.match(css, /padding-block-start:\s*calc\(60px \+ var\(--safe-top\)\)[\s\S]*?padding-block-end:\s*max\(var\(--safe-bottom\),\s*var\(--keyboard-inset\)\)/,
    "the shared module header clears the shell menu and the bottom safe area");
  assert.match(css, /var\(--app-background-image\)/,
    "mobile package windows use the selected app background");
  assert.match(css, /\.panel-sheet-backdrop\s*\{\s*display:\s*none;\s*\}/, "no dim backdrop on phone");
  assert.match(css, /\.pane-back\s*\{\s*display:\s*none;\s*\}/, "no secondary Back-to-chat affordance on phone");
  assert.match(css, /z-index:\s*calc\(var\(--z-shell\) \+ 1 \+ var\(--module-depth, 0\)\)/, "stacked rail panels layer above the composer");
});

test("ContextRail uses ModuleView rather than its own second header", async () => {
  const rail = await read("../src/components/ContextRail.tsx");
  assert.match(rail, /import ModuleView from "\.\/ui\/ModuleView\.ts"/);
  assert.match(rail, /<ModuleView[\s\S]*?variant="rail"/);
  assert.match(rail, /contentMode=\{isWorkspacePane \? "workspace" : "panel"\}/,
    "the core host chooses content behavior instead of packages");
  assert.doesNotMatch(rail, /className=\{`rail-head/, "the legacy rail header is gone");
  assert.doesNotMatch(rail, /pane-back/, "there is no rail-specific Back to Chat control");
});

test("phone drops the global status bar entirely", async () => {
  const app = await read("../src/App.tsx");
  assert.match(app, /shellMode !== "phone" && <StatusBar \/>/, "StatusBar is not mounted on phone");
});
