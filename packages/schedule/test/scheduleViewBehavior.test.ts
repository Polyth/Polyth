import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { ScheduleTaskDto } from "@polyth/session/web-api";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => {},
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject,
  applyProjectUpsert,
  beginProjectListRequest,
  publishProjectList,
} = await import("../../../apps/web/src/store.ts");
const { default: PlannerView } = await import("../widgets/PlannerView.tsx");
const { resolveScheduleProjectId } = await import("../widgets/scheduleData.ts");

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function mounted(component: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
    await delay(20);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const response = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function resetRegistry(): void {
  const ticket = beginProjectListRequest();
  publishProjectList(ticket, []);
  activateProject(null);
}

function seedProject(id: string, name: string): void {
  applyProjectUpsert({ id, name, path: `/tmp/${id}`, createdAt: 1 });
}

function taskFor(projectId: string, prompt: string): ScheduleTaskDto {
  return {
    id: `${projectId}-task`,
    projectId,
    prompt,
    kind: "every",
    everyMinutes: 5,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: Date.now() + 60_000,
    runs: 0,
  };
}

test("resolveScheduleProjectId follows active, override, and recovery rules", () => {
  const projects = [
    { id: "a", name: "Alpha", path: "/a", createdAt: 1 },
    { id: "b", name: "Beta", path: "/b", createdAt: 1 },
  ];
  assert.equal(resolveScheduleProjectId(projects, "a", null), "a");
  assert.equal(resolveScheduleProjectId(projects, null, null), "");
  assert.equal(resolveScheduleProjectId(projects, "a", "b"), "b");
  assert.equal(resolveScheduleProjectId(projects, "a", "missing"), "a");
  assert.equal(resolveScheduleProjectId(projects, null, "missing"), "a");
});

test("PlannerView shows EmptyState when the registry has no projects", async () => {
  resetRegistry();
  globalThis.fetch = async () => response([]);

  const view = await mounted(createElement(PlannerView));
  assert.match(view.container.textContent ?? "", /No projects yet/i);
  assert.equal(view.container.querySelector(".planner-task"), null);
  await view.unmount();
});

test("PlannerView loads the global schedule list without requiring an active project", async () => {
  resetRegistry();
  seedProject("sched-a", "Alpha");
  seedProject("sched-b", "Beta");
  const listCalls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/schedule/preview")) {
      return response({ runs: [Date.now() + 60_000], description: "every 60 min" });
    }
    if (url === "/api/schedule" || url.startsWith("/api/schedule?")) {
      listCalls.push(url);
      return response([taskFor("sched-b", "global task")]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mounted(createElement(PlannerView));
  await act(async () => { await delay(40); });
  assert.ok(listCalls.some((url) => url === "/api/schedule"), "global list is requested without a project filter");
  assert.match(view.container.textContent ?? "", /global task/);
  assert.match(view.container.textContent ?? "", /All projects/i);
  await view.unmount();
});
