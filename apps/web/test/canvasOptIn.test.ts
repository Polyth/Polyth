// Canvas is opt-in. The header offers it only for projects that turned it on,
// and the two ways to turn it on are the header view-tabs editor and the
// per-project Canvas setting. Playground ships disabled for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const {
  getWorkspaceCanvasEnabled,
  setWorkspaceCanvasEnabledForProject,
  subscribeWorkspaceCanvasEnabled,
  setWorkspaceMode,
  setWorkspaceModeProject,
  workspaceCanvasEnabledForProject,
  workspaceCanvasStorageKey,
  getWorkspaceContentMode,
} = await import("../src/widgets/workspaceMode.ts");

test("canvas availability is a project-scoped opt-in that starts off", () => {
  setWorkspaceModeProject("canvas-project-a");
  assert.equal(workspaceCanvasStorageKey("canvas-project-a"), "polyth.canvasEnabled.v1.canvas-project-a");
  assert.notEqual(
    workspaceCanvasStorageKey("canvas-project-a"),
    workspaceCanvasStorageKey("canvas-project-b"),
  );
  // A project that never opted in offers no Canvas. Which of Chat/Canvas a
  // device is showing is a separate, device-local record.
  assert.equal(workspaceCanvasEnabledForProject("canvas-project-a"), false);
  assert.equal(getWorkspaceCanvasEnabled(), false);
});

test("entering canvas from any control opts the project in", () => {
  setWorkspaceModeProject("canvas-project-a");
  assert.equal(getWorkspaceContentMode(), "chat");
  setWorkspaceMode("widgets");

  assert.equal(getWorkspaceContentMode(), "widgets");
  assert.equal(getWorkspaceCanvasEnabled(), true);
  assert.equal(workspaceCanvasEnabledForProject("canvas-project-a"), true);
  assert.equal(dom.localStorage.getItem(workspaceCanvasStorageKey("canvas-project-a")), "true");

  // The opt-in is per project; another project is unaffected.
  assert.equal(workspaceCanvasEnabledForProject("canvas-project-b"), false);
});

test("withdrawing canvas while showing it returns to chat instead of stranding", () => {
  setWorkspaceModeProject("canvas-project-a");
  setWorkspaceMode("widgets");
  assert.equal(getWorkspaceContentMode(), "widgets");

  setWorkspaceCanvasEnabledForProject("canvas-project-a", false);
  assert.equal(getWorkspaceContentMode(), "chat");
  assert.equal(getWorkspaceCanvasEnabled(), false);
});

test("configuring an inactive project never rewrites the active one", () => {
  setWorkspaceModeProject("canvas-project-a");
  setWorkspaceMode("widgets");

  let notified = 0;
  const stop = subscribeWorkspaceCanvasEnabled(() => { notified += 1; });
  setWorkspaceCanvasEnabledForProject("canvas-project-b", true);
  stop();

  assert.equal(notified, 1);
  assert.equal(workspaceCanvasEnabledForProject("canvas-project-b"), true);
  // Project A opted in earlier and keeps exactly that; configuring B changed
  // neither A's opt-in nor the surface this device is showing.
  assert.equal(workspaceCanvasEnabledForProject("canvas-project-a"), true);
  assert.equal(getWorkspaceCanvasEnabled(), true);
  assert.equal(getWorkspaceContentMode(), "widgets");

  setWorkspaceModeProject("canvas-project-b");
  assert.equal(getWorkspaceCanvasEnabled(), true);
});

// The tab is a rendering decision of the view-tabs model: an unopted project
// must not draw the button, and a device already in Canvas keeps it so it
// can always switch back to Chat.
test("the header tab follows the opt-in and keeps canvas escapable", async () => {
  const { resolveViewTabs } = await import("../src/viewTabs.ts");
  const candidates = (offered: boolean) => [
    { id: "chat", label: "Chat", visibility: "layout" as const, offered: true, focused: false },
    { id: "canvas", label: "Canvas", visibility: "canvas" as const, offered, focused: false },
  ];
  const drawn = (offered: boolean, active: string) =>
    resolveViewTabs(candidates(offered), {}, active).filter((tab) => tab.drawn).map((tab) => tab.id);
  assert.deepEqual(drawn(false, "chat"), ["chat"]);
  assert.deepEqual(drawn(true, "chat"), ["chat", "canvas"]);
  assert.deepEqual(drawn(false, "canvas"), ["chat", "canvas"], "Canvas withdrawn while shown stays reachable");
  const header = source("../src/components/HeaderViewTabs.tsx");
  // A switch with a single tab offers no choice; Edit keeps it for its pencil.
  assert.match(header, /if \(drawn\.length < 2 && !editing\) return null;/);
});

test("the header view-tabs editor is the in-shell enable path", async () => {
  const viewTabs = source("../src/viewTabs.ts");
  assert.match(viewTabs, /if \(visibility === "canvas"\) setWorkspaceCanvasEnabled\(shown\);/);
  assert.match(source("../src/components/HeaderViewTabs.tsx"), /add: \(\) => model\.setShown\(tab\.id, true\)/);
  // The former ⋮ "More workspace tools" menu is gone.
  assert.doesNotMatch(source("../src/components/Header.tsx"), /More workspace tools|open:canvas/);
});

test("the projects page offers a per-project canvas toggle", () => {
  const pages = source("../src/components/settings/pages.tsx");
  // Settings rows emit data-settings-item from the shared Row itemId.
  assert.match(pages, /itemId="projects\.canvas"/);
  assert.match(pages, /function ProjectCanvasToggle\(\{ projectId \}: \{ projectId: string \}\)/);
  assert.match(pages, /setWorkspaceCanvasEnabledForProject\(projectId, next\)/);
  assert.match(source("../src/settings/registry.ts"), /id: "projects\.canvas", pageId: "projects"/);
});

test("the canvas opt-in travels with the project, unlike the current surface", () => {
  assert.match(source("../../../packages/contracts/src/index.ts"), /"canvasEnabled",/);
  const sync = source("../src/projectPresentationSync.ts");
  assert.match(sync, /"widgetLayout", "workspacePanel", "capabilityLayout", "canvasEnabled"/);
  assert.match(sync, /canvasEnabled: \(projectId\) => `polyth\.canvasEnabled\.v1\.\$\{projectId\}`/);
  // Which of Chat/Canvas a device shows stays device-local navigation state.
  assert.doesNotMatch(sync, /"workspaceMode",\s*"canvasEnabled"/);
});