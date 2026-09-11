import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window();
let mobileViewport = false;
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({
    matches: mobileViewport,
    media,
    addEventListener() {},
    removeEventListener() {},
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { openSettingsPage, setOverlay } = await import("../src/store.ts");
const { registerSlot } = await import("../src/slots.ts");
const { default: SettingsView } = await import("../src/components/SettingsView.tsx");

function HarnessPage({ settingsTarget }: { settingsTarget?: { itemId?: string; sectionId?: string } }) {
  return createElement("div", { "data-settings-target": true }, `${settingsTarget?.itemId ?? ""}/${settingsTarget?.sectionId ?? ""}`);
}

test("settings aliases redirect to the canonical page and mounted navigation updates targets", async () => {
  const offHarness = registerSlot(
    "settings.pages",
    "test.harnesses",
    (props) => createElement(HarnessPage, { settingsTarget: props.settingsTarget as { itemId?: string; sectionId?: string } | undefined }),
    10,
    { pageId: "harnesses", label: "Harnesses", group: "Engineering" },
  );
  const offAlias = registerSlot(
    "settings.pages",
    "test.opencode",
    () => null,
    11,
    {
      pageId: "opencode",
      label: "OpenCode",
      group: "Engineering",
      nav: false,
      redirect: { pageId: "harnesses", target: { itemId: "opencode", sectionId: "providers-models" } },
    },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    openSettingsPage("opencode");
    await act(async () => { root.render(createElement(SettingsView)); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(container.querySelector(".settings-page-harnesses") !== null, true);
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/providers-models");

    await act(async () => {
      openSettingsPage("harnesses", { itemId: "opencode", sectionId: "runtime" });
    });
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/runtime");
    await act(async () => {
      openSettingsPage("harnesses", { itemId: "opencode", sectionId: "roles" });
    });
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/roles");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offAlias();
    offHarness();
    setOverlay(null);
  }
});

test("nested settings deep links open the page stage on mobile", async () => {
  mobileViewport = true;
  const offHarness = registerSlot(
    "settings.pages",
    "test.mobile-harnesses",
    (props) => createElement(HarnessPage, { settingsTarget: props.settingsTarget as { itemId?: string; sectionId?: string } | undefined }),
    10,
    { pageId: "harnesses", label: "Harnesses", group: "Engineering" },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    openSettingsPage("harnesses/opencode/roles");
    await act(async () => { root.render(createElement(SettingsView)); });
    assert.equal(container.querySelector(".settings-mobile-page") !== null, true);
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/roles");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offHarness();
    setOverlay(null);
    mobileViewport = false;
  }
});

test("navigation requests before mount preserve the latest target", async () => {
  const offHarness = registerSlot(
    "settings.pages",
    "test.pre-mount-harnesses",
    (props) => createElement(HarnessPage, { settingsTarget: props.settingsTarget as { itemId?: string; sectionId?: string } | undefined }),
    10,
    { pageId: "harnesses", label: "Harnesses", group: "Engineering" },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    openSettingsPage("harnesses", { itemId: "opencode", sectionId: "providers-models" });
    openSettingsPage("harnesses", { itemId: "opencode", sectionId: "runtime" });
    await act(async () => { root.render(createElement(SettingsView)); });
    assert.equal(container.querySelector("[data-settings-target]")?.textContent, "opencode/runtime");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    offHarness();
    setOverlay(null);
  }
});
