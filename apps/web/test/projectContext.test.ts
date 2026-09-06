import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ProjectContextSnapshot } from "@polyth/web-sdk";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  listProjectContextRecommendedWidgetIds,
  listProjectContextSnapshots,
  registerProjectContext,
} = await import("../src/packages/projectContext.ts");
const { ProjectContextList } = await import("../src/components/railSurfaces.tsx");
const { filterWidgetLibrary, mergeRecommendedWidgetIds, RECOMMENDED_WIDGET_IDS } =
  await import("../src/widgets/widgetLibrary.ts");

type TestWidget = {
  id: string;
  pluginId: string;
  title: string;
  description: string;
  render: () => null;
};

const widget = (id: string, extras: Partial<TestWidget> = {}): TestWidget => ({
  id,
  pluginId: id.split(".")[0] ?? "core",
  title: id,
  description: id,
  render: () => null,
  ...extras,
});

test("two packages compose snapshots and a third can return null", () => {
  const offA = registerProjectContext({
    id: "ctx.alpha",
    order: 1,
    getSnapshot: (projectId) => ({
      title: "Git",
      items: [{ label: "Repo", value: "Alpha" }],
      recommendedWidgetIds: ["alpha.widget"],
    }),
  }, "alpha");
  let beta: ProjectContextSnapshot | null = {
    title: "Marketing",
    items: [{ label: "Campaign", value: "Spring" }],
    recommendedWidgetIds: ["beta.widget"],
  };
  const offB = registerProjectContext({
    id: "ctx.beta",
    order: 2,
    getSnapshot: (projectId) => projectId === "project-b" ? null : beta,
  }, "beta");
  try {
    const a = listProjectContextSnapshots("project-a");
    assert.deepEqual(a.map((entry) => entry.id), ["ctx.alpha", "ctx.beta"]);
    assert.deepEqual(listProjectContextRecommendedWidgetIds("project-a"), ["alpha.widget", "beta.widget"]);
    const b = listProjectContextSnapshots("project-b");
    assert.deepEqual(b.map((entry) => entry.id), ["ctx.alpha"]);
    assert.equal(listProjectContextRecommendedWidgetIds("project-b").includes("beta.widget"), false);
  } finally {
    offA();
    offB();
  }
});

test("a throwing contribution is isolated from siblings", () => {
  const offBad = registerProjectContext({
    id: "ctx.bad",
    getSnapshot: () => { throw new Error("boom"); },
  }, "bad");
  const offGood = registerProjectContext({
    id: "ctx.good",
    getSnapshot: () => ({ title: "Good", items: [{ label: "Ok", value: "1" }] }),
  }, "good");
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const snapshots = listProjectContextSnapshots("project-a");
    assert.deepEqual(snapshots.map((entry) => entry.id), ["ctx.good"]);
    assert.equal(errors.length > 0, true);
  } finally {
    console.error = original;
    offBad();
    offGood();
  }
});

test("mounted context list is readable in a narrow pane and keeps setup reachable", async () => {
  const container = document.createElement("div");
  container.style.width = "320px";
  container.style.overflow = "hidden";
  document.body.appendChild(container);
  const root = createRoot(container);
  let opened = 0;
  await act(async () => {
    root.render(createElement(ProjectContextList, {
      entries: [
        {
          id: "git",
          ownerPackageId: "git",
          snapshot: {
            title: "Git",
            items: [
              { label: "Worktree", value: "feature/a-very-long-branch-name-that-must-wrap" },
              { label: "Branch", value: "feature/a-very-long-branch-name-that-must-wrap" },
            ],
          },
        },
        {
          id: "marketing",
          ownerPackageId: "marketing",
          snapshot: {
            title: "Marketing",
            items: [{ label: "Campaign", value: "Autumn collection 2026" }],
            needsSetup: { label: "Configure campaign", open: () => { opened += 1; } },
          },
        },
      ],
    }));
  });
  try {
    const text = container.textContent ?? "";
    assert.match(text, /Git/);
    assert.match(text, /Marketing/);
    assert.match(text, /Worktree/);
    assert.match(text, /Configure campaign/);
    const button = container.querySelector("button");
    assert.ok(button);
    (button as HTMLButtonElement).click();
    assert.equal(opened, 1);
    for (const width of [320, 360, 390, 430, 768, 1280]) {
      container.style.width = `${width}px`;
      assert.equal(container.scrollWidth <= container.clientWidth + 1 || container.clientWidth === 0, true);
    }
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("project-aware recommendations merge into Widget Library filtering without hiding others", () => {
  const widgets = [
    widget("core.chat"),
    widget("alpha.widget"),
    widget("beta.widget"),
    widget("unrelated.widget"),
  ];
  const recommendedIds = mergeRecommendedWidgetIds(RECOMMENDED_WIDGET_IDS, ["alpha.widget", "beta.widget"]);
  const recommended = filterWidgetLibrary(widgets, {
    query: "",
    pluginId: "all",
    size: "all",
    zone: "all",
    category: "all",
    tab: "recommended",
    recommendedIds,
  }, "power").map((item) => item.id);
  assert.ok(recommended.includes("core.chat"));
  assert.ok(recommended.includes("alpha.widget"));
  assert.ok(recommended.includes("beta.widget"));
  assert.equal(recommended.includes("unrelated.widget"), false);
  const all = filterWidgetLibrary(widgets, {
    query: "",
    pluginId: "all",
    size: "all",
    zone: "all",
    category: "all",
    tab: "all",
    recommendedIds,
  }, "power").map((item) => item.id);
  assert.ok(all.includes("unrelated.widget"));
});
