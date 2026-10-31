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
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
const browseUrls: string[] = [];
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/browse")) {
      browseUrls.push(url);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          path: "/Users/demo",
          parent: "/Users",
          home: "/Users/demo",
          entries: [{ name: "polyth", path: "/Users/demo/polyth", hidden: false }],
        }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({}),
      text: async () => "",
    };
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ProjectFolderDialog, folderCrumbs } = await import("../src/components/ProjectFolderDialog.tsx");

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

async function mount(props: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ProjectFolderDialog, { onClose: () => {}, ...props }));
  });
  await flush();
  return {
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const key = async (target: Element, init: KeyboardEventInit) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  await flush();
};
const click = async (target: Element | null) => {
  assert.ok(target, "click target exists");
  await act(async () => { (target as HTMLElement).click(); });
  await flush();
};

test("mounted Add/Open dialog has no project classification control", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ProjectFolderDialog, { onClose: () => {} }));
  });
  try {
    const text = document.body.textContent ?? "";
    assert.match(text, /Open a project|Open project/);
    assert.doesNotMatch(text, /Project type/);
    assert.doesNotMatch(text, /General|Write|Research|Plan & Coordinate|Design & Explore|Build & Debug/);
    assert.equal(document.body.querySelector("select"), null);
    assert.ok(document.body.querySelector(".folder-open-btn"));
    assert.equal(document.body.querySelector(".folder-type-row"), null);
    assert.equal(document.body.querySelector(".project-type-controls"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("opening the picker focuses the folder list, never a text field", async () => {
  const view = await mount();
  try {
    // A focused text field would summon the software keyboard on phones.
    const active = document.activeElement;
    assert.ok(active?.classList.contains("folder-list"), `initial focus is the folder list, got ${active?.className}`);
    assert.ok(!document.body.querySelector("input.folder-path"), "the typed-path field is not mounted until requested");
    assert.ok(!document.body.querySelector("input:focus, textarea:focus"), "no text field holds focus");
    assert.ok(document.body.querySelector(".folder-crumbs [aria-current=location]"), "the location bar shows breadcrumbs");
  } finally {
    await view.unmount();
  }
});

test("typing a path is opt-in and Escape returns to the breadcrumbs", async () => {
  let closes = 0;
  const view = await mount({ onClose: () => { closes += 1; } });
  try {
    await click(document.body.querySelector(".folder-crumbs-edit"));
    const input = document.body.querySelector<HTMLInputElement>("input.folder-path");
    assert.ok(input, "the typed-path field replaces the breadcrumbs");
    assert.equal(input.value, "/Users/demo");
    assert.ok(document.activeElement === input, `an explicit request focuses the field, got ${document.activeElement?.className}`);
    await key(input, { key: "Escape" });
    assert.ok(!document.body.querySelector("input.folder-path"), "Escape leaves path typing");
    assert.equal(closes, 0, "Escape in the field does not close the picker");
    assert.ok(document.activeElement?.classList.contains("folder-list"), "Escape hands focus back to the list");

    // "/" typed in the list starts a fresh absolute path; Mod+L edits the current one.
    await key(document.body.querySelector(".folder-list")!, { key: "/" });
    assert.equal(document.body.querySelector<HTMLInputElement>("input.folder-path")?.value, "/");
    await key(document.body.querySelector("input.folder-path")!, { key: "Escape" });
    await key(document.body.querySelector(".folder-list")!, { key: "l", ctrlKey: true });
    assert.equal(document.body.querySelector<HTMLInputElement>("input.folder-path")?.value, "/Users/demo");
  } finally {
    await view.unmount();
  }
});

test("hidden folders are a pro option in the location bar's options menu", async () => {
  const view = await mount();
  try {
    assert.ok(!document.body.querySelector("[role=switch]"), "no always-visible hidden-files switch");
    await click(document.body.querySelector(".folder-location .folder-options"));
    const item = Array.from(document.body.querySelectorAll("[role=menuitemcheckbox]"))
      .find((entry) => entry.textContent?.includes("Show hidden folders"));
    assert.ok(item, "the options menu carries the hidden-folders switch");
    assert.equal(item.getAttribute("aria-checked"), "false");
    browseUrls.length = 0;
    await click(item);
    assert.ok(browseUrls.some((url) => url.includes("hidden=true")), "toggling reloads the list with hidden folders");
    assert.ok(document.body.querySelector(".folder-options[data-active]"), "the trigger marks the non-default view");
  } finally {
    await view.unmount();
  }
});

test("the primary action names its target and Back appears only for multi-step hosts", async () => {
  let back = 0;
  const plain = await mount();
  try {
    assert.equal(document.body.querySelector(".folder-open-btn")?.textContent, "Open “demo”");
    assert.ok(!document.body.querySelector(".folder-back"), "no Back without a previous step");
    assert.ok(!document.body.querySelector(".folder-up-action, .folder-cols, .folder-legend"), "redundant chrome is gone");
  } finally {
    await plain.unmount();
  }
  const stepped = await mount({ onBack: () => { back += 1; } });
  try {
    await click(document.body.querySelector(".folder-back"));
    assert.equal(back, 1);
  } finally {
    await stepped.unmount();
  }
});

test("ways to add share the bottom bar with the primary action", async () => {
  const view = await mount();
  try {
    const foot = document.body.querySelector(".folder-foot");
    assert.ok(foot?.querySelector(".folder-source-row .folder-new-folder"));
    assert.ok(foot?.querySelector(":scope > .folder-open-btn"));
  } finally {
    await view.unmount();
  }
});

test("breadcrumbs collapse home to ~ and understand root and drive paths", () => {
  assert.deepEqual(folderCrumbs("/home/max/code", "/home/max"), [
    { label: "~", path: "/home/max" },
    { label: "code", path: "/home/max/code" },
  ]);
  assert.deepEqual(folderCrumbs("/srv/app/", "/home/max"), [
    { label: "/", path: "/" },
    { label: "srv", path: "/srv" },
    { label: "app", path: "/srv/app" },
  ]);
  assert.deepEqual(folderCrumbs("/", "/home/max"), [{ label: "/", path: "/" }]);
  // A sibling that merely shares the home prefix is not inside home.
  assert.equal(folderCrumbs("/home/maxine", "/home/max")[0]?.label, "/");
  assert.deepEqual(folderCrumbs("C:\\Users\\max\\src", "C:\\Users\\max"), [
    { label: "~", path: "C:\\Users\\max" },
    { label: "src", path: "C:\\Users\\max\\src" },
  ]);
  assert.deepEqual(folderCrumbs("D:\\data", "C:\\Users\\max"), [
    { label: "D:", path: "D:\\" },
    { label: "data", path: "D:\\data" },
  ]);
});

test("Escape collapses an open source panel before it closes the picker", async () => {
  const { registerSlot } = await import("../src/slots.ts");
  const { default: SlotHost } = await import("../src/components/slots/SlotHost.ts");
  const { default: GitProjectSource } = await import("../../../packages/git/widgets/GitProjectSource.tsx");
  const host = { ui: { Slot: (props: Parameters<typeof SlotHost>[0]) => createElement(SlotHost, props) }, navigation: { openSettingsPage() {} } };
  const off = registerSlot("project.create.options", "git-clone-project", (props) => createElement(GitProjectSource, { ...props, host }), 20);
  let closes = 0;
  const view = await mount({ onClose: () => { closes += 1; } });
  try {
    await click(document.body.querySelector(".git-clone-source"));
    const url = document.body.querySelector(".git-clone-panel input");
    assert.ok(url, "the clone panel is open");
    await key(url, { key: "Escape" });
    assert.ok(!document.body.querySelector(".git-clone-panel"), "the first Escape collapses the panel");
    assert.equal(closes, 0, "the first Escape does not close the picker");
    await key(document.body.querySelector(".folder-list")!, { key: "Escape" });
    assert.equal(closes, 1, "the next Escape closes the picker");
  } finally {
    await view.unmount();
    off();
  }
});

test("representative dialog/editor ignores Escape during IME composition", async () => {
  const { registerSlot } = await import("../src/slots.ts");
  const { default: SlotHost } = await import("../src/components/slots/SlotHost.ts");
  const { default: GitProjectSource } = await import("../../../packages/git/widgets/GitProjectSource.tsx");
  const host = { ui: { Slot: (props: Parameters<typeof SlotHost>[0]) => createElement(SlotHost, props) }, navigation: { openSettingsPage() {} } };
  const off = registerSlot("project.create.options", "git-clone-project", (props) => createElement(GitProjectSource, { ...props, host }), 20);
  let closes = 0;
  const view = await mount({ onClose: () => { closes += 1; } });
  try {
    await click(document.body.querySelector(".git-clone-source"));
    const url = document.body.querySelector(".git-clone-panel input");
    assert.ok(url, "the clone panel is open");
    // Escape with isComposing: true should be ignored
    await key(url, { key: "Escape", isComposing: true });
    assert.ok(document.body.querySelector(".git-clone-panel"), "composing Escape does not collapse panel");
    assert.equal(closes, 0, "composing Escape does not close dialog");

    // Escape with keyCode 229 should also be ignored
    await key(url, { key: "Escape", keyCode: 229 });
    assert.ok(document.body.querySelector(".git-clone-panel"), "keyCode 229 Escape does not collapse panel");
    assert.equal(closes, 0, "keyCode 229 Escape does not close dialog");

    // Normal Escape then collapses the panel
    await key(url, { key: "Escape" });
    assert.ok(!document.body.querySelector(".git-clone-panel"), "uncomposed Escape collapses panel");
    assert.equal(closes, 0);
  } finally {
    await view.unmount();
    off();
  }
});
