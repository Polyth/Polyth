import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }),
});

const pkg = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: `${name} description`, enabled: true, category: "tools",
  projectAffinity: { directions: ["engineering"], recommended: true }, ...extra,
});
const PACKAGES = [
  pkg("git", "Git"),
  pkg("recap", "Recap"),
  pkg("session-import", "Session Import"),
  pkg("ssh", "SSH Remotes"),
  pkg("terminal", "Terminal", { enabled: false }),
  pkg("shell-core", "Shell core", { core: true }),
];
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const body = String(input).includes("/api/packages") ? { packages: PACKAGES } : {};
    return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerCapability, railLauncherPackageIds } = await import("../src/capabilities.ts");
const { default: ProjectCompositionEditor, configurableProjectPackages } = await import("../src/components/ProjectCompositionEditor.tsx");

const capability = (id: string, ownerPackageId: string | undefined, rail?: boolean) => ({
  id, ownerPackageId, rail, label: id, plainDescription: id, keywords: [],
  standardTier: "more" as const, standardRank: 0, open: () => {}, available: () => true,
});

test("only packages that own a rail launcher are rail-configurable", () => {
  const owners = railLauncherPackageIds([
    { ownerPackageId: "git" },
    { ownerPackageId: "recap", rail: false },
    { ownerPackageId: undefined },
    { ownerPackageId: "terminal", rail: true },
  ]);
  assert.deepEqual([...owners].sort(), ["git", "terminal"]);
  // Terminal owns a launcher but is disabled globally; core never shows.
  const ids = configurableProjectPackages(PACKAGES as never, new Set(["git", "terminal", "shell-core"])).map((p) => p.id);
  assert.deepEqual(ids, ["git"]);
});

test("the workspace accordion lists rail packages and keeps stale choices removable", async () => {
  const off = [
    registerCapability(capability("git", "git")),
    // A background helper registered for search only: never on a rail.
    registerCapability(capability("recap", "recap", false)),
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const value = { version: 1 as const, directions: ["engineering" as const], packageOverrides: { "session-import": "include" as const } };
  let latest: unknown = value;
  try {
    await act(async () => {
      root.render(createElement(ProjectCompositionEditor, { value, onChange: (next: unknown) => { latest = next; } }));
    });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const chips = [...container.querySelectorAll(".project-composition-chips span")].map((chip) => chip.textContent);
    assert.deepEqual(chips, ["Git"], "recommendations only name packages that can appear on a rail");

    await act(async () => { container.querySelector<HTMLElement>(".project-composition-disclosure")!.click(); });
    const choiceRows = [...container.querySelectorAll(".project-package-row:not(.is-missing) strong")].map((row) => row.textContent);
    assert.deepEqual(choiceRows, ["Git"], "no Show/Hide for helpers, settings-only, disabled or core packages");
    assert.ok(!container.textContent?.includes("Disabled globally"));

    const stale = [...container.querySelectorAll(".project-package-row.is-missing strong")].map((row) => row.textContent);
    assert.deepEqual(stale, ["Session Import"], "an earlier choice stays visible by name so it can be removed");
    await act(async () => { container.querySelector<HTMLElement>(".project-package-row.is-missing button")!.click(); });
    assert.deepEqual((latest as typeof value).packageOverrides, {}, "Remove returns the package to Auto");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    off.forEach((dispose) => dispose());
  }
});
