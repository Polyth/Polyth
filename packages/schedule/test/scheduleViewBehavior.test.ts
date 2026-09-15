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
  getState,
  publishProjectList,
  seedSessionCache,
  setModels,
} = await import("../../../apps/web/src/store.ts");
const { default: ScheduleView } = await import("../widgets/ScheduleView.tsx");
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

const pickProjectOption = async (root: ParentNode, optionLabel: string): Promise<void> => {
  await pickPickerOption(root, optionLabel, ".sched-project .picker-chip");
};

const clickByText = (container: ParentNode, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim().includes(text));
  assert.ok(button, `button containing "${text}" exists`);
  return button as HTMLButtonElement;
};

const setControlValue = (
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void => {
  const prototype = control instanceof dom.HTMLTextAreaElement
    ? dom.HTMLTextAreaElement.prototype
    : dom.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};

const pickPickerOption = async (root: ParentNode, optionLabel: string, selector = ".picker-chip"): Promise<void> => {
  const trigger = root.querySelector<HTMLButtonElement>(selector);
  assert.ok(trigger, `picker trigger ${selector} exists`);
  await act(async () => { trigger.click(); });
  const option = [...document.querySelectorAll(".picker-item")].find((el) =>
    el.querySelector(".palette-label")?.textContent?.trim() === optionLabel);
  assert.ok(option, `picker option "${optionLabel}" exists`);
  await act(async () => { (option as HTMLElement).click(); });
};

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

test("ScheduleView shows EmptyState when the registry has no projects", async () => {
  resetRegistry();
  globalThis.fetch = async () => response([]);

  const view = await mounted(createElement(ScheduleView));
  assert.match(view.container.textContent ?? "", /No project selected/i);
  assert.equal(view.container.querySelector(".sched-form"), null, "create form stays hidden");
  await view.unmount();
});

test("ScheduleView loads picked project tasks when no active project is set", async () => {
  resetRegistry();
  seedProject("sched-a", "Alpha");
  seedProject("sched-b", "Beta");
  const listCalls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/schedule/preview")) {
      return response({ runs: [Date.now() + 60_000], description: "every 60 min" });
    }
    if (url.includes("/api/schedule?projectId=")) {
      const projectId = new URL(url, "http://127.0.0.1").searchParams.get("projectId") ?? "";
      listCalls.push(projectId);
      return response([taskFor(projectId, `tasks for ${projectId}`)]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mounted(createElement(ScheduleView));
  assert.ok(view.container.querySelector(".sched-project"), "project select is visible");
  assert.equal(listCalls.length, 0, "no list call before a project is selected");
  const rescanBeforePick = clickByText(view.container, "Rescan loops");
  assert.equal(rescanBeforePick.disabled, true, "rescan stays disabled until a project is selected");
  const createBeforePick = clickByText(view.container, "Create schedule");
  assert.equal(createBeforePick.disabled, true, "create stays disabled until a project is selected");

  await pickProjectOption(view.container, "Beta");
  await act(async () => { await delay(30); });

  assert.deepEqual(listCalls, ["sched-b"]);
  assert.match(view.container.textContent ?? "", /tasks for sched-b/);

  const createButton = clickByText(view.container, "Create schedule") as HTMLButtonElement;
  assert.equal(createButton.disabled, true, "create stays disabled without prompt and cadence");
  await view.unmount();
});

test("ScheduleView defaults to activeProjectId and keeps user override across unrelated store ticks", async () => {
  resetRegistry();
  seedProject("sched-active", "Active One");
  seedProject("sched-other", "Other Two");
  activateProject("sched-active");
  const listCalls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/schedule/preview")) {
      return response({ runs: [Date.now() + 60_000], description: "every 60 min" });
    }
    if (url.includes("/api/schedule?projectId=")) {
      const projectId = new URL(url, "http://127.0.0.1").searchParams.get("projectId") ?? "";
      listCalls.push(projectId);
      return response([taskFor(projectId, `tasks for ${projectId}`)]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mounted(createElement(ScheduleView));
  await act(async () => { await delay(30); });
  assert.ok(listCalls.includes("sched-active"), "initial load follows activeProjectId");

  await pickProjectOption(view.container, "Other Two");
  await act(async () => { await delay(30); });
  assert.ok(listCalls.includes("sched-other"), "user override switches list target");

  setModels([]);
  assert.equal(getState().activeProjectId, "sched-active", "active project stays unchanged");
  await act(async () => { await delay(30); });

  const projectChip = view.container.querySelector(".sched-project .picker-chip-text");
  assert.match(projectChip?.textContent ?? "", /Other Two/, "override survives unrelated store tick");
  await view.unmount();
});

test("ScheduleView switches projects without stale list responses or cross-project sessions", async () => {
  resetRegistry();
  seedProject("sched-a", "Alpha");
  seedProject("sched-b", "Beta");
  seedSessionCache({
    id: "session-a",
    projectId: "sched-a",
    title: "Alpha session",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  seedSessionCache({
    id: "session-b",
    projectId: "sched-b",
    title: "Beta session",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/schedule/preview")) {
      return response({ runs: [Date.now() + 60_000], description: "every 60 min" });
    }
    if (url.includes("/api/schedule?projectId=sched-a")) {
      await delay(150);
      return response([taskFor("sched-a", "alpha task")]);
    }
    if (url.includes("/api/schedule?projectId=sched-b")) {
      return response([taskFor("sched-b", "beta task")]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mounted(createElement(ScheduleView));
  try {
    await pickProjectOption(view.container, "Alpha");
    await pickProjectOption(view.container, "Beta");
    await act(async () => { await delay(30); });

    assert.match(view.container.textContent ?? "", /beta task/);
    assert.doesNotMatch(view.container.textContent ?? "", /alpha task/);

    await act(async () => { await delay(200); });
    assert.doesNotMatch(view.container.textContent ?? "", /alpha task/, "stale Alpha response must not overwrite Beta");

    const targetPickers = [...view.container.querySelectorAll(".view-toolbar-row .picker-chip")]
      .filter((chip) => !chip.closest(".sched-project"));
    assert.ok(targetPickers[0], "target picker exists");
    await act(async () => { targetPickers[0]!.click(); });
    const targetOption = [...document.querySelectorAll(".picker-item")].find((el) =>
      el.querySelector(".palette-label")?.textContent?.trim() === "Existing session");
    assert.ok(targetOption, "existing-session target option exists");
    await act(async () => { (targetOption as HTMLElement).click(); await delay(10); });

    const sessionTrigger = [...view.container.querySelectorAll(".view-toolbar-row .picker-chip")]
      .filter((chip) => !chip.closest(".sched-project"))[1];
    assert.ok(sessionTrigger, "session picker exists");
    await act(async () => { sessionTrigger.click(); });
    const sessionLabels = [...document.querySelectorAll(".picker-item .palette-label")]
      .map((el) => el.textContent?.trim());
    assert.deepEqual(sessionLabels, ["Pick a session…", "Beta session"]);
  } finally {
    await view.unmount();
  }
});

test("ScheduleView create posts the selected project id", async () => {
  resetRegistry();
  seedProject("sched-create", "Create Project");
  let createBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/schedule/preview")) {
      return response({ runs: [Date.now() + 60_000], description: "every 60 min" });
    }
    if (url.includes("/api/schedule?projectId=")) {
      return response([]);
    }
    if (url === "/api/schedule" && init?.method === "POST") {
      createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return response(taskFor("sched-create", String(createBody.prompt ?? "")));
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mounted(createElement(ScheduleView));
  try {
    await pickProjectOption(view.container, "Create Project");
    await act(async () => { await delay(20); });

    const prompt = view.container.querySelector("textarea");
    assert.ok(prompt);
    await act(async () => {
      setControlValue(prompt as HTMLTextAreaElement, "ship nightly summary");
      await delay(10);
    });

    const everyTab = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Every");
    assert.ok(everyTab, "Every cadence tab exists");
    await act(async () => { everyTab.click(); await delay(300); });

    const createButton = clickByText(view.container, "Create schedule") as HTMLButtonElement;
    assert.equal(createButton.disabled, false, "create enables once project, prompt, and cadence are valid");
    await act(async () => { createButton.click(); await delay(30); });

    assert.equal(createBody?.projectId, "sched-create");
  } finally {
    await view.unmount();
  }
});
