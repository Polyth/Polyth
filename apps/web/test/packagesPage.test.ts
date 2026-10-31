import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

interface Fixture {
  id: string;
  name: string;
  description: string;
  core: boolean;
  enabled: boolean;
  category?: string;
  hasSettings?: boolean;
  maturity?: "in-progress" | "beta";
}

const PACKAGES: Fixture[] = [
  { id: "git", name: "Git", description: "Source control", core: false, enabled: true, category: "engineering" },
  { id: "dictation", name: "Voice & Dictation", description: "Speech input", core: false, enabled: false, category: "workspace", maturity: "in-progress" },
  { id: "terraform", name: "Terraform", description: "Infrastructure plans", core: false, enabled: true, category: "engineering", maturity: "beta" },
  { id: "files", name: "Files", description: "Workspace files", core: true, enabled: true, category: "workspace" },
];

async function mountPage(options: { failPatch?: (id: string) => boolean } = {}) {
  const dom = new Window();
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    // The category select (Picker) positions its popover on the next frame.
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  const state = PACKAGES.map((item) => ({ ...item, hasSettings: item.hasSettings ?? false }));
  const patches: Array<{ id: string; enabled: boolean }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/packages-manifest.json")) return new Response(JSON.stringify({ packages: [] }));
    // The page also probes for data left by removed packages; there is none here.
    if (url.endsWith("/api/packages/residue")) return new Response(JSON.stringify({ residue: [] }));
    const patch = url.match(/\/api\/packages\/([^/?]+)$/);
    if (patch && init?.method === "PATCH") {
      const id = decodeURIComponent(patch[1]!);
      const enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
      patches.push({ id, enabled });
      if (options.failPatch?.(id)) {
        return new Response(JSON.stringify({ error: "The package registry is read-only right now." }), { status: 409 });
      }
      const item = state.find((entry) => entry.id === id)!;
      item.enabled = enabled;
      return new Response(JSON.stringify(item));
    }
    assert.ok(!init?.method || init.method === "GET", `unexpected ${init?.method} ${url}`);
    return new Response(JSON.stringify({ packages: state }));
  };
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: PackagesPage } = await import("../src/components/settings/PackagesPage.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(createElement(PackagesPage)); });
  const rows = () => [...container.querySelectorAll(".package-row")].map((row) => row.getAttribute("data-package-id"));
  const click = async (element: object | null | undefined) => {
    assert.ok(element, "expected a clickable element");
    await act(async () => { (element as { click(): void }).click(); });
  };
  const button = (text: string | RegExp) => [...container.querySelectorAll("button")]
    .find((candidate) => typeof text === "string" ? candidate.textContent?.trim().startsWith(text) : text.test(candidate.textContent ?? ""));
  const search = async (value: string) => act(async () => {
    const input = container.querySelector("input[type=search]")!;
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  };
  return { dom, container, rows, click, button, search, settle, patches, state, cleanup, act, createElement };
}

test("package search matches names and descriptions without changing enabled state", async () => {
  const page = await mountPage();
  const { registerSlot } = await import("../src/slots.ts");
  let removeLibrary = () => {};
  await page.act(async () => {
    removeLibrary = registerSlot("settings.packages.content", "test.library", () => page.createElement("div", { "data-package-library": true }, "Installer"));
  });
  try {
    await page.settle();
    assert.equal(page.container.querySelector("[data-package-library]")?.textContent, "Installer");
    await page.act(async () => { removeLibrary(); });
    assert.equal(page.container.querySelector("[data-package-library]"), null);
    // Alphabetical inside each section: optional first, then core.
    assert.deepEqual(page.rows(), ["git", "terraform", "dictation", "files"]);
    await page.search("speech");
    assert.deepEqual(page.rows(), ["dictation"]);
    assert.match(page.container.querySelector(".package-row .settings-list-title")!.textContent!, /Voice/);
    assert.equal(page.container.querySelector("mark.settings-list-match")?.textContent, "Speech");
    assert.equal(page.container.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "false");
    // Every word must match, in any field (here: name + category label).
    await page.search("git engineering");
    assert.deepEqual(page.rows(), ["git"]);
    await page.search("no-such-package");
    assert.deepEqual(page.rows(), []);
    assert.match(page.container.textContent!, /No packages match/);
    await page.click(page.button("Clear filters"));
    assert.equal(page.rows().length, 4);
    assert.equal(page.patches.length, 0, "search is local and must not mutate packages");
  } finally {
    removeLibrary();
    await page.cleanup();
  }
});

test("status and category filters narrow the list and show faceted counts", async () => {
  const page = await mountPage();
  try {
    const status = page.container.querySelector('.seg[aria-label="Filter by status"]')!;
    const counts = () => [...status.querySelectorAll("button")].map((item) => item.textContent);
    // Core packages are always on: "On" counts them, "Off" never does.
    assert.deepEqual(counts(), ["All4", "On3", "Off1"]);
    await page.click(page.button(/^Off\d/));
    assert.deepEqual(page.rows(), ["dictation"]);
    await page.click(page.button(/^All\d/));
    // Categories are one compact select whose options carry their counts.
    await page.click(page.container.querySelector(".packages-category .picker-chip"));
    const option = [...page.dom.document.querySelectorAll('[role="option"]')]
      .find((item) => item.querySelector(".palette-label")?.textContent === "Engineering");
    assert.equal(option?.querySelector(".palette-meta")?.textContent, "2");
    await page.click(option);
    assert.deepEqual(page.rows(), ["git", "terraform"]);
    // Status counts follow the chosen category.
    assert.deepEqual(counts(), ["All2", "On2", "Off0"]);
    await page.click(page.button(/^Off\d/));
    assert.deepEqual(page.rows(), []);
    assert.match(page.container.textContent!, /No packages match/);
    await page.click(page.button("Clear filters"));
    assert.equal(page.rows().length, 4);
    assert.equal(status.querySelector("button.on")?.textContent, "All4");
  } finally {
    await page.cleanup();
  }
});

test("toggling a package applies it in place and a failure restores the row with its reason", async () => {
  const page = await mountPage({ failPatch: (id) => id === "terraform" });
  try {
    const switchFor = (id: string) => page.container.querySelector(`[data-package-id="${id}"] [role="switch"]`);
    await page.click(switchFor("dictation"));
    await page.settle();
    assert.deepEqual(page.patches, [{ id: "dictation", enabled: true }]);
    assert.equal(switchFor("dictation")!.getAttribute("aria-checked"), "true");
    assert.match(page.container.textContent!, /Voice & Dictation enabled/);

    await page.click(switchFor("terraform"));
    await page.settle();
    assert.equal(switchFor("terraform")!.getAttribute("aria-checked"), "true", "a refused change restores the confirmed state");
    const error = page.container.querySelector('[data-package-id="terraform"] .settings-list-error');
    assert.match(error?.textContent ?? "", /Couldn't disable Terraform\. The package registry is read-only right now\./);
    // Core packages offer no switch.
    assert.equal(switchFor("files"), null);
    assert.match(page.container.querySelector('[data-package-id="files"]')!.textContent!, /Always on/);
  } finally {
    await page.cleanup();
  }
});

test("preview packages carry a badge, and warn while enabled; stable ones do not", async () => {
  const page = await mountPage();
  try {
    const badge = (id: string) => page.container.querySelector(`[data-package-id="${id}"] .package-maturity`);
    const notice = (id: string) => page.container.querySelector(`[data-package-id="${id}"] .settings-list-notice`);
    assert.equal(badge("dictation")?.textContent, "In progress");
    assert.equal(badge("terraform")?.textContent, "Beta");
    assert.equal(badge("git"), null);
    assert.match(notice("terraform")?.textContent ?? "", /not well tested/);
    assert.equal(notice("dictation"), null, "a disabled preview package shows only its badge");
    assert.equal(notice("git"), null);
    await page.click(page.container.querySelector('[data-package-id="dictation"] [role="switch"]'));
    await page.settle();
    assert.match(notice("dictation")?.textContent ?? "", /unfinished \(alpha\)/);
  } finally {
    await page.cleanup();
  }
});

test("selection mode applies a bulk change only to packages that need it", async () => {
  const page = await mountPage();
  try {
    assert.equal(page.container.querySelector(".settings-list-select"), null, "checkboxes appear only in selection mode");
    await page.click(page.button("Select"));
    assert.equal(page.container.querySelectorAll(".settings-list-select").length, 3, "core packages are not selectable");
    const selectAll = page.container.querySelector(".packages-bulk-all input");
    await page.click(selectAll);
    assert.match(page.container.querySelector(".packages-bulkbar")!.textContent!, /Selected: 3/);
    assert.equal(page.button("Enable 1")?.disabled, false);
    await page.click(page.button("Disable 2"));
    await page.settle();
    assert.deepEqual(page.patches, [{ id: "git", enabled: false }, { id: "terraform", enabled: false }]);
    assert.match(page.container.textContent!, /Packages disabled: 2/);
    assert.match(page.container.querySelector(".packages-bulkbar")!.textContent!, /Selected: 0/);
    // With nothing selected the actions read as plain verbs, not "Enable 0".
    assert.equal(page.button("Enable")?.disabled, true);
    await page.click(page.button("Done"));
    assert.equal(page.container.querySelector(".packages-bulkbar"), null);
  } finally {
    await page.cleanup();
  }
});

test("contributions list under the page toolbar, count toward it and can take the page over", async () => {
  const page = await mountPage();
  const { registerSlot } = await import("../src/slots.ts");
  const seen: Array<{ query: unknown; status: unknown; category: unknown }> = [];
  let context: Record<string, unknown> = {};
  let remove = () => {};
  await page.act(async () => {
    remove = registerSlot("settings.packages.content", "test.library", (received) => {
      context = received;
      seen.push({ query: received.packagesQuery, status: received.packagesStatus, category: received.packagesCategory });
      return page.createElement("div", { "data-package-library": true }, "Added");
    });
  });
  try {
    await page.settle();
    const report = context.reportPackageMatches as (owner: string, matches: { all: number; enabled: number; disabled: number }) => void;
    const setDetail = context.setPackageDetailOpen as (owner: string, open: boolean) => void;
    assert.equal(typeof report, "function");
    assert.equal(typeof setDetail, "function");
    await page.act(async () => { report("test.library", { all: 2, enabled: 1, disabled: 1 }); });
    const status = page.container.querySelector('.seg[aria-label="Filter by status"]')!;
    assert.deepEqual([...status.querySelectorAll("button")].map((item) => item.textContent), ["All6", "On4", "Off2"]);

    // The contribution filters by the page's search; its matches keep the
    // single "nothing matches" state away while it still shows something.
    await page.search("nothing-built-in");
    assert.deepEqual(seen.at(-1), { query: "nothing-built-in", status: "all", category: null });
    assert.deepEqual(page.rows(), []);
    assert.doesNotMatch(page.container.textContent!, /No packages match/);
    await page.act(async () => { report("test.library", { all: 0, enabled: 0, disabled: 0 }); });
    assert.match(page.container.textContent!, /No packages match/);
    await page.search("");

    // A detail view hides the page's own toolbar and lists until it closes.
    await page.act(async () => { setDetail("test.library", true); });
    assert.equal(page.container.querySelector(".packages-toolbar"), null);
    assert.deepEqual(page.rows(), []);
    assert.equal(page.container.querySelector("[data-package-library]")?.textContent, "Added");
    await page.act(async () => { setDetail("test.library", false); });
    assert.ok(page.container.querySelector(".packages-toolbar"));
    assert.equal(page.rows().length, 4);
  } finally {
    remove();
    await page.cleanup();
  }
});
