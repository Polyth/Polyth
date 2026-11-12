// Package sections at the top of a project's list (`sidebar.project.leading`
// with `meta.navigatorSection`, e.g. agents): the list options hide them, and
// while the section's capability row is shown under New chat the section
// unfolds from that row instead of repeating in the project's list.
import test from "node:test";
import assert from "node:assert/strict";
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

const { act, createElement, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { setSidebarViewMode } = await import("../src/sidebarPrefs.ts");
const { setSidebarLayout } = await import("../src/sidebarLayout.ts");
const { registerCapability } = await import("../src/capabilities.ts");
const { registerSlot, listSlots } = await import("../src/slots.ts");
const { default: Sidebar } = await import("../src/components/Sidebar.tsx");
const {
  NAVIGATOR_ACTIONS_KEY, NAVIGATOR_SECTIONS_KEY, parseNavigatorSections, writeNavigatorActions,
} = await import("../src/navigatorState.ts");
const { excludedSections, navigatorSectionsOf } = await import("../src/components/sidebar/navigatorSections.ts");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id, createdAt: 1 });

for (const [id, label] of [["schedule", "Agents"], ["planner", "Planner"]] as const) {
  registerCapability({
    id, label, plainDescription: label, keywords: [], standardTier: "more", standardRank: 50,
    open: () => {}, available: () => true,
  });
}

let sectionHasContent = true;
function Section({ context }: { context: Record<string, unknown> }) {
  const report = context.reportContent as ((value: boolean) => void) | undefined;
  useEffect(() => { report?.(sectionHasContent); });
  if (!sectionHasContent) return null;
  return createElement("span", {
    className: "fixture-section",
    "data-placement": String(context.placement),
    "data-project": String(context.projectId),
    "data-folded": context.folded === true ? "" : undefined,
  }, context.folded === true ? "3" : "rows");
}
registerSlot("sidebar.project.leading", "fixture.agents", (context) => createElement(Section, { context }), 10, {
  navigatorSection: { label: () => "Agents", capability: "schedule" },
});
// A leading contribution without the meta is not a section: never moved or offered.
registerSlot("sidebar.project.leading", "fixture.plain", () => createElement("span", { className: "fixture-plain" }), 20);

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
const placements = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".fixture-section")]
  .map((node) => `${node.dataset.placement}${node.dataset.folded !== undefined ? ":folded" : ""}`);

function reset(): void {
  localStorage.removeItem(NAVIGATOR_ACTIONS_KEY);
  localStorage.removeItem(NAVIGATOR_SECTIONS_KEY);
  sectionHasContent = true;
  setSidebarViewMode("rail");
  setSidebarLayout({ collapsed: false });
}

test("stored section choices parse defensively", () => {
  assert.deepEqual(parseNavigatorSections(null), { hidden: [], folded: [] });
  assert.deepEqual(parseNavigatorSections("nope"), { hidden: [], folded: [] });
  assert.deepEqual(parseNavigatorSections("[1]"), { hidden: [], folded: [] });
  assert.deepEqual(
    parseNavigatorSections('{"hidden":["a","a",3,""],"folded":"x"}'),
    { hidden: ["a"], folded: [] },
  );
});

test("only contributions with meta.navigatorSection are sections; exclusion covers hidden and attached ones", () => {
  const sections = navigatorSectionsOf(listSlots("sidebar.project.leading"));
  assert.deepEqual(sections.map(({ id, label, capability }) => ({ id, label, capability })),
    [{ id: "fixture.agents", label: "Agents", capability: "schedule" }]);
  assert.deepEqual(excludedSections(sections, { hidden: [], folded: [] }, []), []);
  assert.deepEqual(excludedSections(sections, { hidden: [], folded: [] }, ["schedule"]), ["fixture.agents"]);
  assert.deepEqual(excludedSections(sections, { hidden: ["fixture.agents"], folded: [] }, []), ["fixture.agents"]);
});

test("with the Agents row shown, the section unfolds from it and leaves the project's list", async () => {
  reset();
  const { container, unmount } = await render();
  try {
    const item = container.querySelector<HTMLElement>(".sidebar-nav-actions > .sidebar-nav-item")!;
    assert.ok(item, "the Agents row owns the section");
    assert.equal(item.querySelector(".sidebar-nav-action")?.getAttribute("data-capability"), "schedule");
    assert.deepEqual(placements(container), ["action"], "drawn once, under the row, not again in the list");
    assert.equal(item.querySelector(".sidebar-nav-section .fixture-section")?.getAttribute("data-project"), "alpha");
    assert.ok(container.querySelector(".session-org .fixture-plain"), "a plain leading contribution stays in the list");

    const chevron = item.querySelector<HTMLElement>(".sidebar-nav-disclosure")!;
    assert.equal(chevron.getAttribute("aria-expanded"), "true", "unfolded by default");
    assert.equal(chevron.getAttribute("aria-controls"), item.querySelector(".sidebar-nav-section")?.id);
    await act(async () => { click(chevron); });
    assert.deepEqual(placements(container), ["action:folded"], "folded, only the summary, inside the row");
    assert.ok(item.querySelector(".sidebar-nav-action .sidebar-nav-summary .fixture-section"));
    assert.equal(item.querySelector(".sidebar-nav-section"), null);
    assert.deepEqual(JSON.parse(localStorage.getItem(NAVIGATOR_SECTIONS_KEY)!), { hidden: [], folded: ["fixture.agents"] });
    await act(async () => { click(item.querySelector(".sidebar-nav-disclosure")!); });
    assert.deepEqual(placements(container), ["action"]);
  } finally {
    await unmount();
  }
});

test("a section with nothing to show drops the row's chevron", async () => {
  reset();
  sectionHasContent = false;
  const { container, unmount } = await render();
  try {
    const item = container.querySelector<HTMLElement>(".sidebar-nav-item")!;
    assert.ok(item.hasAttribute("data-empty"));
    assert.equal(item.querySelector(".sidebar-nav-disclosure"), null);
  } finally {
    await unmount();
    sectionHasContent = true;
  }
});

test("without the Agents row the section sits in the project's list again", async () => {
  reset();
  writeNavigatorActions(["planner"]);
  const { container, unmount } = await render();
  try {
    assert.equal(container.querySelector(".sidebar-nav-item"), null);
    assert.deepEqual(placements(container), ["project"]);
    assert.ok(container.querySelector(".session-org .fixture-section"));
  } finally {
    await unmount();
    reset();
  }
});

test("the list options hide the section everywhere and bring it back", async () => {
  reset();
  const { container, unmount } = await render();
  try {
    const filter = () => container.querySelector<HTMLElement>(".sidebar-filter button")!;
    const entry = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
      .find((node) => node.textContent?.trim() === "Agents");
    await act(async () => { click(filter()); });
    assert.ok(entry(), "the section is offered by its own label");
    assert.equal(entry()!.getAttribute("aria-checked"), "true");
    await act(async () => { click(entry()!); });
    assert.deepEqual(placements(container), [], "hidden from the row and from every list");
    assert.equal(container.querySelector(".sidebar-nav-item"), null, "the Agents row is a plain row again");
    assert.deepEqual(JSON.parse(localStorage.getItem(NAVIGATOR_SECTIONS_KEY)!).hidden, ["fixture.agents"]);
    if (!entry()) await act(async () => { click(filter()); });
    await act(async () => { click(entry()!); });
    assert.deepEqual(placements(container), ["action"]);
  } finally {
    await unmount();
    reset();
  }
});
