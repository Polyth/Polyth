// Package windows as new-chat shortcuts: any package that opens a window can
// be pinned into the Shortcuts row, and its chip opens that window.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });

register("./tsxHooks.mjs", import.meta.url);
const starters = await import("../src/starters.ts");
const { openPackageWindow, windowPackages } = await import("../src/starterPackages.ts");
const { registerCapability } = await import("../src/capabilities.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: StarterPicker } = await import("../src/components/mobile/StarterPicker.tsx");
type Starter = import("../src/starters.ts").Starter;
type ResolvedCapability = import("../src/capabilities.ts").ResolvedCapability;
type CapabilityDescriptor = import("../src/capabilities.ts").CapabilityDescriptor;

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

function capability(id: string, extra: Partial<CapabilityDescriptor> = {}): ResolvedCapability {
  return {
    descriptor: {
      id,
      label: `${id} label`,
      plainDescription: `${id} description`,
      keywords: [],
      standardTier: "more",
      standardRank: 0,
      open: () => {},
      available: () => true,
      ...extra,
    },
    tier: "more",
    rank: 0,
  };
}

test("only launchable capabilities with a window are package shortcuts", () => {
  const resolved = [
    capability("session"),
    capability("git", { ownerPackageId: "git" }),
    capability("no-window", { ownerPackageId: "no-window" }),
    capability("offline", { ownerPackageId: "offline", available: () => false }),
    capability("hidden-route", { rail: false }),
    capability("workspace-edit"),
    capability("terminal", { ownerPackageId: "terminal" }),
  ];
  const destinations = new Set(["session", "git", "offline", "hidden-route", "workspace-edit", "terminal"]);
  assert.deepEqual(windowPackages(resolved, destinations), [
    { id: "git", label: "git label", description: "git description" },
    { id: "terminal", label: "terminal label", description: "terminal description" },
  ]);
});

test("a pinned package window resolves only while its package is present and is never suggested", () => {
  const prefs = { ...starters.STARTER_PREFS_DEFAULTS, pinned: ["package:git", "builtin:explore"] };
  const packages = [{ id: "git", label: "Git", description: "Branches and commits" }];

  const shown = starters.visibleStarters(prefs, starters.EMPTY_STARTER_CONTEXT, 3, { packages });
  assert.equal(shown[0]?.id, "package:git");
  assert.equal(shown[0]?.source, "package");
  assert.equal(shown[0]?.capabilityId, "git");
  assert.equal(shown[0]?.prompt, "", "a package shortcut never inserts a prompt");

  const absent = starters.visibleStarters(prefs, starters.EMPTY_STARTER_CONTEXT, 3);
  assert.ok(!absent.some((starter) => starter.id === "package:git"), "an unloaded package's chip stays out");

  const unpinned = starters.visibleStarters(starters.STARTER_PREFS_DEFAULTS, starters.EMPTY_STARTER_CONTEXT, 20, { packages });
  assert.ok(!unpinned.some((starter) => starter.source === "package"), "suggestions stay prompts");
});

test("the picker lists every package window in its own group, searchable by name", () => {
  const packages = [{ id: "git", label: "Git" }, { id: "terminal", label: "Terminal", description: "Shell" }];
  const groups = starters.starterCategories(starters.STARTER_PREFS_DEFAULTS, starters.EMPTY_STARTER_CONTEXT, { packages });
  const group = groups.find((candidate) => candidate.id === "packages");
  assert.deepEqual(group?.starters.map((starter) => starter.id), ["package:git", "package:terminal"]);
  assert.ok(starters.matchesStarter(group!.starters[1]!, "term"));
  assert.ok(!starters.starterCategories(starters.STARTER_PREFS_DEFAULTS, starters.EMPTY_STARTER_CONTEXT)
    .some((candidate) => candidate.id === "packages"), "no packages, no empty group");
});

test("opening a package shortcut uses the capability's own open and respects availability", () => {
  let opened = 0;
  let available = true;
  const dispose = registerCapability({
    ...capability("starter-test-window").descriptor,
    open: () => { opened++; },
    available: () => available,
  });
  try {
    assert.equal(openPackageWindow("starter-test-window"), true);
    assert.equal(opened, 1);
    available = false;
    assert.equal(openPackageWindow("starter-test-window"), false);
    assert.equal(openPackageWindow("missing-window"), false);
    assert.equal(opened, 1);
  } finally {
    dispose();
  }
});

test("hero chips and the picker open package windows instead of inserting a prompt", async () => {
  const [picker, surface] = await Promise.all([
    read("../src/components/mobile/StarterPicker.tsx"),
    read("../src/components/workspace/builtinSurfaces.tsx"),
  ]);
  assert.match(picker, /useWindowPackages\(\)/);
  assert.match(picker, /starter\.source === "package"\) \{\s*onOpenPackage\(starter\);\s*return;/);
  assert.match(surface, /visibleStarters\([^)]*\{ packages \}\)/);
  assert.match(surface, /if \(starter\.capabilityId\) \{[\s\S]*?openPackageWindow\(starter\.capabilityId\);\s*return;/);
  // Picking a window must not hand focus back to the composer underneath it.
  const onOpen = surface.slice(surface.indexOf("onOpenPackage="), surface.indexOf("onClose=", surface.indexOf("onOpenPackage=")));
  assert.match(onOpen, /setOverlay\(null\)/);
  assert.doesNotMatch(onOpen, /focusComposer/);
});

test("a registered package window shows in the picker, opens on pick, and pins as a chip", async () => {
  const disposeCapability = registerCapability({
    ...capability("starter-picker-window", { ownerPackageId: "starter-picker-window" }).descriptor,
    label: "Window Package",
  });
  const disposeSurface = registerSurface({
    id: "starter-picker-window", capabilityId: "starter-picker-window", title: "Window Package", order: 90, component: () => null,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const opened: Starter[] = [];
  const picked: Starter[] = [];
  try {
    await act(async () => {
      root.render(createElement(StarterPicker, {
        context: starters.EMPTY_STARTER_CONTEXT,
        onPick: (starter: Starter) => picked.push(starter),
        onOpenPackage: (starter: Starter) => opened.push(starter),
        onClose: () => {},
      }));
    });
    const row = [...document.querySelectorAll<HTMLElement>("[aria-label]")]
      .find((node) => node.getAttribute("aria-label") === "Open: Window Package");
    assert.ok(row, "the package window is listed with an Open label");
    const pin = [...document.querySelectorAll<HTMLButtonElement>("button.sheet-row-star")]
      .find((node) => node.getAttribute("aria-label")?.includes("Window Package"));
    assert.ok(pin, "the package window can be pinned");
    await act(async () => { pin!.click(); });
    assert.ok(starters.getStarterPrefs().pinned.includes("package:starter-picker-window"));
    await act(async () => { row!.click(); });
    assert.equal(opened[0]?.capabilityId, "starter-picker-window");
    assert.equal(picked.length, 0, "a window pick never inserts a prompt");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    disposeSurface();
    disposeCapability();
  }
});
