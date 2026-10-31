// Settings → Permissions, Project settings → Approvals and the approval
// switch, mounted: the default level autosaves and only Full access asks
// (twice), projects pick their own level, members only read, new chats
// follow their project's default, and a chat with its own level can hand
// itself back to its default.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
// The DOM-typed view of the happy-dom document, so queries keep lib.dom types.
const doc = dom.document as unknown as Document;
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

type Level = "off" | "routine" | "all";
type Defaults = { level: Level; projects: Record<string, { level: Level }>; canEdit: boolean };
type AutoAccept = { setting: string; effective: boolean; level: Level; inherited: Level };

let defaults: Defaults = { level: "off", projects: {}, canEdit: true };
let autoAccept: Record<string, AutoAccept> = {};
const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost/");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (url.pathname === "/api/permissions/defaults") {
    if (method === "PUT") {
      writes.push({ method, path: url.pathname, body });
      defaults = { ...defaults, level: body.level as Level };
    }
    return json(defaults);
  }
  const project = url.pathname.match(/^\/api\/permissions\/defaults\/projects\/([^/]+)$/);
  if (project && method === "PUT") {
    writes.push({ method, path: url.pathname, body });
    const projects = { ...defaults.projects };
    if (body.level === "inherit") delete projects[decodeURIComponent(project[1]!)];
    else projects[decodeURIComponent(project[1]!)] = { level: body.level as Level };
    defaults = { ...defaults, projects };
    return json(defaults);
  }
  const session = url.pathname.match(/^\/api\/sessions\/([^/]+)\/permissions\/auto-accept$/);
  if (session) {
    const id = decodeURIComponent(session[1]!);
    if (method === "PATCH") writes.push({ method, path: url.pathname, body });
    return json(autoAccept[id] ?? { setting: "inherit", effective: false, level: "off", inherited: "off" });
  }
  return json({ message: "not found" }, 404);
}) as typeof fetch;

const { act, createElement, Fragment } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PermissionsSettingsPage } = await import("../widgets/PermissionsSettingsPage.tsx");
const { default: ProjectApprovals } = await import("../widgets/ProjectApprovals.tsx");
const { AutoApproveAction } = await import("../widgets/index.tsx");
const { loadApprovalDefaults } = await import("../widgets/approvalDefaults.ts");
const { resolveAlert, useAlert } = await import("../../../apps/web/src/alerts.ts");
const { beginProjectListRequest, publishProjectList, setSessions } = await import("../../../apps/web/src/store.ts");

const PROJECTS = [
  { id: "p1", name: "Alpha", path: "/work/alpha", spaceId: "s", createdAt: 1 },
  { id: "p2", name: "Beta", path: "/work/beta", spaceId: "s", createdAt: 2 },
];
publishProjectList(beginProjectListRequest(), PROJECTS as never);

const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};

async function mount(element: ReturnType<typeof createElement>) {
  const container = doc.createElement("div");
  doc.body.append(container);
  const root = createRoot(container);
  const AlertProbe = () => createElement("output", { "data-alert": "" }, useAlert()?.title ?? "");
  const render = async (next: ReturnType<typeof createElement>) => {
    await act(async () => root.render(createElement(Fragment, null, next, createElement(AlertProbe))));
    await flush();
  };
  await render(element);
  return {
    container,
    render,
    alert: () => container.querySelector("[data-alert]")?.textContent ?? "",
    radio: (level: string) => container.querySelector<HTMLButtonElement>(`.approval-choice[data-level="${level}"]`)!,
    checked: () => container.querySelector(`.approval-choice[aria-checked="true"]`)?.getAttribute("data-level"),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const answer = async (value: boolean) => {
  await act(async () => { resolveAlert(value); });
  await flush();
};
const click = async (target: HTMLElement) => {
  await act(async () => { target.click(); });
  await flush();
};

test("the default level autosaves; only Full access asks, and twice", async () => {
  defaults = { level: "off", projects: {}, canEdit: true };
  writes.length = 0;
  const view = await mount(createElement(PermissionsSettingsPage));
  try {
    assert.equal(view.container.querySelectorAll(".approval-choice").length, 3);
    assert.equal(view.checked(), "off");

    // Auto-approve: no warning, saved at once.
    await click(view.radio("routine"));
    assert.equal(view.alert(), "");
    assert.deepEqual(writes, [{ method: "PUT", path: "/api/permissions/defaults", body: { level: "routine" } }]);
    assert.equal(view.checked(), "routine");
    assert.match(view.container.textContent ?? "", /Saved/);

    // Full access: declining either warning changes nothing.
    await click(view.radio("all"));
    assert.match(view.alert(), /Turn on Full access for every chat\?/);
    await answer(false);
    await click(view.radio("all"));
    await answer(true);
    assert.match(view.alert(), /Last warning/);
    await answer(false);
    assert.equal(writes.length, 1);
    assert.equal(view.checked(), "routine");

    await click(view.radio("all"));
    await answer(true);
    await answer(true);
    assert.deepEqual(writes.at(-1)?.body, { level: "all" });
    assert.match(view.container.textContent ?? "", /Full access is the default/);

    // Going back to asking needs no confirmation.
    await click(view.radio("off"));
    assert.equal(view.alert(), "");
    assert.deepEqual(writes.at(-1)?.body, { level: "off" });
    assert.doesNotMatch(view.container.textContent ?? "", /Full access is the default/);
  } finally {
    await view.unmount();
  }
});

test("arrow keys move between levels without choosing one", async () => {
  defaults = { level: "off", projects: {}, canEdit: true };
  writes.length = 0;
  const view = await mount(createElement(PermissionsSettingsPage));
  try {
    const group = view.container.querySelector<HTMLElement>(".approval-choices")!;
    assert.equal(view.radio("off").tabIndex, 0, "one tab stop: the chosen level");
    assert.equal(view.radio("all").tabIndex, -1);
    view.radio("off").focus();
    for (const key of ["ArrowDown", "ArrowDown"]) {
      await act(async () => { group.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
    }
    // Compare identities as a boolean: a failing assert on DOM nodes makes
    // Node inspect the whole document.
    assert.ok(doc.activeElement === view.radio("all"), "focus reached Full access");
    assert.deepEqual(writes, [], "moving focus picked nothing");
    assert.equal(view.alert(), "");
  } finally {
    await view.unmount();
  }
});

test("still-asks lists what Auto-approve leaves for a person", async () => {
  defaults = { level: "routine", projects: {}, canEdit: true };
  const view = await mount(createElement(PermissionsSettingsPage));
  try {
    const details = view.container.querySelector(".approval-still-asks")!;
    assert.match(details.querySelector("summary")?.textContent ?? "", /What Auto-approve still asks about/);
    const items = [...details.querySelectorAll("li")].map((item) => item.textContent);
    assert.ok(items.includes("Runs with elevated privileges"));
    assert.ok(items.includes("Sends local data to another host"));
    assert.ok(!items.includes("Outside the task"), "the Judgment hold is not a risk reason");
  } finally {
    await view.unmount();
  }
});

test("each project shows the level its chats start from and can choose its own", async () => {
  defaults = { level: "routine", projects: { p2: { level: "off" } }, canEdit: true };
  writes.length = 0;
  const view = await mount(createElement(PermissionsSettingsPage));
  const chip = (projectId: string) =>
    view.container.querySelector<HTMLButtonElement>(`[data-approval-project="${projectId}"] .picker-select .picker-chip`)!;
  const pick = async (projectId: string, label: string) => {
    await click(chip(projectId));
    const option = [...doc.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent?.includes(label));
    assert.ok(option, `option ${label}`);
    await click(option);
  };
  try {
    assert.equal(view.container.querySelectorAll("[data-approval-project]").length, 2);
    assert.match(chip("p1").textContent ?? "", /Space default \(Auto-approve\)/);
    assert.match(chip("p2").textContent ?? "", /Ask for each action/);

    // Full access for one project: two warnings that name it.
    await pick("p1", "Full access");
    assert.match(view.alert(), /Turn on Full access in Alpha\?/);
    await answer(true);
    assert.match(view.alert(), /nothing in Alpha will ask again/);
    await answer(true);
    assert.deepEqual(writes.at(-1), { method: "PUT", path: "/api/permissions/defaults/projects/p1", body: { level: "all" } });

    // Back to the Space's level: no warning when it is not Full access.
    await pick("p2", "Space default");
    assert.equal(view.alert(), "");
    assert.deepEqual(writes.at(-1), { method: "PUT", path: "/api/permissions/defaults/projects/p2", body: { level: "inherit" } });
    assert.match(chip("p2").textContent ?? "", /Space default \(Auto-approve\)/);
  } finally {
    await view.unmount();
  }
});

test("a member reads the defaults but cannot change them", async () => {
  defaults = { level: "routine", projects: { p1: { level: "all" } }, canEdit: false };
  const view = await mount(createElement(PermissionsSettingsPage));
  try {
    assert.equal(view.container.querySelectorAll('[role="radio"]').length, 0);
    assert.equal(view.container.querySelector(".picker-select"), null);
    const text = view.container.textContent ?? "";
    assert.match(text, /Only the instance owner can change approval defaults\./);
    // The level in force reads as a statement, with what it means.
    const summary = view.container.querySelector(".approval-choices.is-static");
    assert.equal(summary?.querySelector(".approval-choice-title")?.textContent, "Auto-approve");
    assert.match(summary?.querySelector(".approval-choice-detail")?.textContent ?? "", /High-risk actions always ask/);
    assert.equal(view.container.querySelector('[data-approval-project="p1"] .approval-project-value')?.textContent, "Full access");
    assert.equal(view.container.querySelector('[data-approval-project="p2"] .approval-project-value')?.textContent, "Space default (Auto-approve)");
  } finally {
    await view.unmount();
  }
});

test("Project settings → Approvals follows the Space or picks a level", async () => {
  defaults = { level: "off", projects: {}, canEdit: true };
  writes.length = 0;
  let back = 0;
  const view = await mount(createElement(ProjectApprovals, { project: PROJECTS[1] as never, onBack: () => { back += 1; } }));
  try {
    const choices = [...view.container.querySelectorAll<HTMLButtonElement>(".approval-choice")];
    assert.equal(choices.length, 4);
    assert.equal(choices[0]!.getAttribute("aria-checked"), "true", "a project without a level follows the Space");
    assert.match(choices[0]!.textContent ?? "", /Use the Space default.*Currently Ask for each action/);
    await click(choices[2]!);
    assert.deepEqual(writes.at(-1), { method: "PUT", path: "/api/permissions/defaults/projects/p2", body: { level: "routine" } });
    assert.equal(choices[2]!.getAttribute("aria-checked"), "true");
    await click(choices[0]!);
    assert.deepEqual(writes.at(-1)?.body, { level: "inherit" });
    const backButton = [...view.container.querySelectorAll("button")].find((item) => item.textContent?.includes("Back"))!;
    await click(backButton);
    assert.equal(back, 1);
  } finally {
    await view.unmount();
  }
});

const draftContext = (over: Record<string, unknown>) => ({
  projectId: "p1", sessionId: null, editing: false, instanceId: "composer-auto-approve", config: {}, updateConfig: () => {},
  ...over,
});

test("a new chat follows its project's default until a level is picked, and can go back to it", async () => {
  defaults = { level: "off", projects: { p1: { level: "routine" } }, canEdit: true };
  await loadApprovalDefaults(true);
  const chosen: string[] = [];
  const setDraftAutoApprove = (setting: string) => chosen.push(setting);
  const view = await mount(createElement(AutoApproveAction, { context: draftContext({ setDraftAutoApprove }) as never }));
  const button = () => view.container.querySelector<HTMLButtonElement>(".composer-auto-approve")!;
  const reset = () => doc.querySelector<HTMLButtonElement>(".approval-level-reset");
  try {
    assert.ok(button().classList.contains("on"), "the project's Auto-approve shows");
    assert.ok(!button().classList.contains("full"));
    assert.match(button().title, /Follows the default/);
    await click(button());
    assert.equal(reset(), null, "nothing to go back to");
    await click(button());

    // A level picked for the draft: "Use default" hands it back.
    await view.render(createElement(AutoApproveAction, {
      context: draftContext({ setDraftAutoApprove, autoApproveOn: false, autoApproveAll: false }) as never,
    }));
    assert.ok(!button().classList.contains("on"));
    assert.match(button().title, /Chosen for this chat/);
    await click(button());
    assert.equal(reset()?.getAttribute("aria-label"), "Use the default: Auto-approve");
    await click(reset()!);
    assert.deepEqual(chosen, ["inherit"]);

    // Another project falls back to the Space's level.
    await view.render(createElement(AutoApproveAction, { context: draftContext({ projectId: "p2", setDraftAutoApprove }) as never }));
    assert.ok(!button().classList.contains("on"));
  } finally {
    await view.unmount();
  }
});

test("a chat with its own level goes back to its default, asking first when that is Full access", async () => {
  defaults = { level: "all", projects: {}, canEdit: true };
  await loadApprovalDefaults(true);
  writes.length = 0;
  autoAccept = { s1: { setting: "off", effective: false, level: "off", inherited: "all" } };
  setSessions("p1", [
    { id: "s1", projectId: "p1", title: "Own", status: "idle", createdAt: 1, updatedAt: 1, autoAccept: false, autoAcceptAll: false, autoAcceptSetting: "off" },
    { id: "s2", projectId: "p1", title: "Follows", status: "idle", createdAt: 1, updatedAt: 1, autoAccept: true, autoAcceptAll: true },
    { id: "s3", projectId: "p1", parentId: "s2", title: "Child", status: "idle", createdAt: 1, updatedAt: 1, autoAccept: true, autoAcceptAll: false, autoAcceptSetting: "on" },
  ] as never);
  const header = (sessionId: string) => createElement(AutoApproveAction, { context: draftContext({ sessionId }) as never, side: "down" });
  const view = await mount(header("s1"));
  const button = () => view.container.querySelector<HTMLButtonElement>(".composer-auto-approve")!;
  const reset = () => doc.querySelector<HTMLButtonElement>(".approval-level-reset");
  try {
    await click(button());
    assert.equal(reset()?.getAttribute("aria-label"), "Use the default: Full access");
    await click(reset()!);
    assert.match(view.alert(), /Turn on Full access\?/);
    await answer(false);
    assert.deepEqual(writes, [], "declined: the chat keeps its own level");

    await click(button());
    await click(reset()!);
    await answer(true);
    assert.deepEqual(writes, [{ method: "PATCH", path: "/api/sessions/s1/permissions/auto-accept", body: { setting: "inherit" } }]);

    // A chat that follows its default has nothing to go back to.
    await view.render(header("s2"));
    await click(button());
    assert.equal(reset(), null);
    await click(button());

    // A subagent goes back to its parent chat.
    await view.render(header("s3"));
    await click(button());
    assert.equal(reset()?.getAttribute("aria-label"), "Use the parent chat's level");
  } finally {
    await view.unmount();
  }
});
