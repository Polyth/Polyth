import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
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

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject,
  applyProjectUpsert,
  beginProjectListRequest,
  getState,
  publishProjectList,
} = await import("../../../apps/web/src/store.ts");
const { default: AgentsPage } = await import("../widgets/AgentsPage.tsx");
const { offerAgentSeed } = await import("../widgets/agentSeed.ts");
const { resolveScheduleProjectId } = await import("../widgets/scheduleData.ts");
const { switchCadenceMode } = await import("../widgets/PlannerScheduleFields.tsx");
const { recurrenceSummary } = await import("../widgets/plannerShared.ts");
const { cadenceToView, viewToCadence } = await import("../src/cadenceView.ts");
const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");

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

/** The agents' page as the host shows it: navigation in and out of it goes
 *  through the host, which here just changes the page's resource. */
function agentsPage(start: string | null = null) {
  const opened: Array<{ resource: string | null; projectId?: string }> = [];
  const sessions: string[] = [];
  let navigate: (resource: string | null) => void = () => {};
  const host = {
    ui: { Slot: () => null },
    navigation: {
      openPage: (_id: string, resource?: string | null, options?: { projectId?: string }) => {
        opened.push({ resource: resource ?? null, ...(options?.projectId ? { projectId: options.projectId } : {}) });
        navigate(resource ?? null);
        return true;
      },
      closePage: () => navigate(null),
    },
    conversation: { openSession: async (id: string) => { sessions.push(id); } },
  } as unknown as WebPackageHost;
  function Harness() {
    const [resource, setResource] = useState<string | null>(start);
    navigate = setResource;
    return createElement(AgentsPage, { host, resource });
  }
  return { element: createElement(Harness), opened, sessions, go: (resource: string | null) => navigate(resource) };
}

const response = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function resetRegistry(): void {
  localStorage.removeItem("polyth.agents.advancedSettings");
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

test("a daily time reads as every day, whichever way it was written, and a written cron is never rewritten", () => {
  const written = { kind: "cron" as const, expression: "0 1 * * *", timeZone: "UTC" };
  assert.equal(recurrenceSummary(written), "Every day · 01:00", "not a custom schedule at 1:00");
  assert.equal(recurrenceSummary(written, { includeTime: false }), "Every day");
  assert.equal(recurrenceSummary({ kind: "cron", expression: "30 6 * * 0,1,2,3,4,5,6", timeZone: "UTC" }), "Every day · 06:30");
  assert.deepEqual(viewToCadence(cadenceToView(written)), written, "a no-op save keeps the expression");
  assert.equal(recurrenceSummary({ kind: "cron", expression: "0 9 * * 1", timeZone: "UTC" }), "Every week · Mon · 09:00");
  assert.match(recurrenceSummary({ kind: "cron", expression: "*/5 9-17 * * *", timeZone: "UTC" }), /^Custom schedule/);
});

test("switching Weekly or Monthly back to Once keeps the chosen clock", () => {
  const weekly = { mode: "weekly" as const, days: [2], hour: 7, minute: 45, timeZone: "UTC" };
  for (const from of [weekly, { mode: "monthly" as const, dayOfMonth: 9, hour: 7, minute: 45, timeZone: "UTC" }]) {
    const once = switchCadenceMode(from, "once");
    assert.equal(once.mode, "once");
    const at = new Date(once.mode === "once" ? once.at : 0);
    assert.deepEqual([at.getHours(), at.getMinutes()], [7, 45]);
    assert.ok(at.getTime() > Date.now(), "the next occurrence is in the future");
  }
});


const buttonNamed = (root: ParentNode, name: string | RegExp): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
    const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });

/** Settings start simple; the switch shows the advanced parts. */
async function showAdvanced(root: ParentNode): Promise<void> {
  const toggle = root.querySelector<HTMLButtonElement>('.agent-advanced-switch [role="switch"]')!;
  if (toggle.getAttribute("aria-checked") !== "true") await act(async () => { toggle.click(); await delay(10); });
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
}

/** A fake server: GET list, preview, create, draft. Records every write. */
function fakeServer(initial: ScheduleTaskDto[] = [], draft?: unknown) {
  const tasks = [...initial];
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.includes("/api/schedule/preview")) return response({ runs: [Date.now() + 3_600_000], description: "weekly" });
    if (url === "/api/schedule/draft") {
      writes.push({ url, body });
      return draft ? response(draft) : response({ error: "draft-unusable", message: "The model's answer could not be used." }, 502);
    }
    if (url === "/api/schedule" && init?.method === "POST") {
      writes.push({ url, body });
      const triggers = (body.eventTriggers ?? []) as Array<{ id: string; kind: string }>;
      const webhookTokens = Object.fromEntries(triggers.filter((trigger) => trigger.kind === "webhook").map((trigger) => [trigger.id, "tok_" + "x".repeat(40)]));
      const created = { ...taskFor(String(body.projectId), String(body.prompt)), ...body, id: `agent-${tasks.length + 1}`, runs: 0,
        eventTriggers: triggers.map((trigger) => trigger.kind === "webhook" ? { ...trigger, hasToken: true } : trigger) } as ScheduleTaskDto;
      tasks.push(created);
      return response({ ...created, webhookTokens });
    }
    const patched = /^\/api\/schedule\/([^/?]+)$/.exec(url);
    if (patched && init?.method === "PATCH") {
      writes.push({ url, body });
      const index = tasks.findIndex((task) => task.id === patched[1]);
      const before = tasks[index]!;
      const triggers = (body.eventTriggers ?? before.eventTriggers ?? []) as Array<{ id: string; kind: string }>;
      const known = new Set((before.eventTriggers ?? []).map((trigger) => trigger.id));
      const webhookTokens = Object.fromEntries(triggers
        .filter((trigger) => trigger.kind === "webhook" && !known.has(trigger.id))
        .map((trigger) => [trigger.id, "tok_" + "y".repeat(40)]));
      const updated = { ...before, ...body, eventTriggers: triggers.map((trigger) => trigger.kind === "webhook" ? { ...trigger, hasToken: true } : trigger) } as ScheduleTaskDto;
      tasks[index] = updated;
      return response({ ...updated, webhookTokens });
    }
    if (url.endsWith("/context")) {
      if (init?.method === "POST") { writes.push({ url, body }); return response({ ok: true }); }
      return response({
        mode: "rolling", rotateAt: 0.6, whenFull: "new-session",
        session: { id: "ses-1", title: "Agent session", status: "idle", fraction: 0.42, usedTokens: 84_000, limitTokens: 200_000, telemetry: "native" },
        layers: { charter: 320, journal: 180, wake: 40 },
        cache: { telemetry: "measured", ttlMs: 300_000, lastActivityAt: Date.now() - 60_000,
          runs: [{ runId: "r2", at: Date.now() - 60_000, input: 500, read: 8_000, write: 1_500, ratio: 0.8 }] },
        warm: { reason: "wait", ttlMs: 300_000, pings: 3, pingCost: 0.36, coldCost: 1.15, nextPingAt: Date.now() + 180_000, pings24h: 2 },
      });
    }
    if (url === "/api/schedule/script-test") {
      writes.push({ url, body });
      return response({ events: 1, result: { ok: true, decision: { action: "run", note: "Deploy api failed" }, ms: 3 } });
    }
    if (url === "/api/schedule/sources") {
      return response([{ id: "monitoring", label: "Monitoring", types: [{ id: "memory-high", label: "Memory is high" }] }]);
    }
    if (url === "/api/schedule/trigger-preview") {
      writes.push({ url, body });
      return response({ events: 4, wakes: 2, samples: [], recent: [
        { at: Date.now() - 60_000, text: "Session “Deploy staging” failed — exit 1", matched: true },
        { at: Date.now() - 120_000, text: "Session “Docs” completed", matched: false, reason: "outcome" },
        { at: Date.now() - 180_000, text: "Session “Docs” failed", matched: false, reason: "filter", filter: { field: "title", op: "contains", value: "deploy" } },
      ] });
    }
    if (url.includes("/permission")) {
      writes.push({ url, body });
      return response({ ok: true });
    }
    if (url === "/api/schedule" || url.startsWith("/api/schedule?")) return response({ tasks, loopErrors: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  return { writes, tasks };
}

test("the agents' page asks for a project when the registry is empty", async () => {
  resetRegistry();
  fakeServer();
  const page = agentsPage();
  const view = await mounted(page.element);
  assert.match(view.container.textContent ?? "", /No projects yet/i);
  assert.equal(view.container.querySelector(".agents-home-row"), null);
  await view.unmount();
});

test("the agents' home lists every agent by project with its last word; templates wait in the empty state", async () => {
  resetRegistry();
  seedProject("ag-a", "Alpha");
  seedProject("ag-b", "Beta");
  fakeServer([{ ...taskFor("ag-b", "Watch the build."), title: "Build watcher", description: "Keeps CI green." }]);
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  const sections = [...view.container.querySelectorAll(".agents-section")];
  assert.deepEqual(sections.map((section) => section.querySelector(".agents-section-title")!.textContent), ["Beta"],
    "agents are grouped under their project; a project without agents stays out");
  const row = sections[0]!.querySelector(".agents-home-row")!;
  assert.match(row.querySelector(".agents-home-name")!.textContent ?? "", /Build watcher/);
  assert.match(row.querySelector(".agents-home-line")!.textContent ?? "", /Keeps CI green\./, "its purpose until it reports");
  assert.match(row.querySelector(".agents-home-state")!.textContent ?? "", /Next (today|tomorrow)/i);
  assert.doesNotMatch(view.container.textContent ?? "", /Nightly release captain/, "templates do not crowd a home that has agents");
  await view.unmount();

  fakeServer();
  const empty = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  assert.match(empty.container.textContent ?? "", /Agents keep working while you don't/);
  assert.ok(buttonNamed(empty.container, /Nightly release captain/), "the empty home offers the templates");
  await empty.unmount();
});

test("a template becomes an active agent in two interactions, and its page opens", async () => {
  resetRegistry();
  seedProject("ag-tpl", "Templates");
  activateProject("ag-tpl");
  const server = fakeServer();
  const page = agentsPage();
  const view = await mounted(page.element);
  await act(async () => { await delay(30); });

  await act(async () => { buttonNamed(view.container, /Nightly release captain/)!.click(); await delay(20); });
  assert.equal(page.opened.at(-1)?.resource, "new", "a new agent opens on its own page");
  const name = view.container.querySelector<HTMLInputElement>(".agent-section[data-section=identity] input");
  assert.equal(name?.value, "Nightly release captain", "the template fills the form");
  assert.equal(view.container.querySelector(".agents-bar-title")?.textContent, "Nightly release captain", "the page is titled by the draft");
  assert.equal(document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA", false,
    "no field takes focus on open");
  assert.equal(view.container.querySelectorAll(".agent-section-head, .agent-event-toggle, .agent-section-body[hidden]").length, 0,
    "no section folds: every field is in view");
  assert.ok(view.container.querySelector(".agent-section[data-section=wakes] .agent-section-lead"), "each section says what it decides");

  await act(async () => { buttonNamed(view.container, "Activate")!.click(); await delay(30); });
  const created = server.writes.find((write) => write.url === "/api/schedule")!;
  assert.equal(created.body.title, "Nightly release captain");
  assert.equal(created.body.enabled, true);
  assert.equal(created.body.projectId, "ag-tpl");
  assert.deepEqual(created.body.target, { mode: "dedicated-session" }, "templates default to the rolling context");
  assert.equal(created.body.pauseAfterFailures, 2, "the template's own run settings apply");
  assert.match(String(created.body.prompt), /unmerged/i);
  assert.deepEqual(page.opened.at(-1), { resource: "agent-1", projectId: "ag-tpl" }, "the new agent's page opens");
  await act(async () => { await delay(20); });
  assert.equal(view.container.querySelector(".agent-head-name")?.textContent, "Nightly release captain");
  assert.ok(view.container.querySelector(".agent-conversation"), "on its conversation");
  await view.unmount();
});

test("the nightly release captain template is nightly, activatable, and charters unmerged review with subagents", async () => {
  resetRegistry();
  seedProject("ag-cap", "Captain");
  activateProject("ag-cap");
  const server = fakeServer();
  const page = agentsPage();
  const view = await mounted(page.element);
  await act(async () => { await delay(30); });

  await act(async () => { buttonNamed(view.container, /Nightly release captain/)!.click(); await delay(20); });
  const name = view.container.querySelector<HTMLInputElement>(".agent-section[data-section=identity] input");
  assert.equal(name?.value, "Nightly release captain", "the template fills the form");
  assert.equal(buttonNamed(view.container, "Activate")?.disabled, false,
    "the template draft is activatable without editing anything");

  await act(async () => { buttonNamed(view.container, "Activate")!.click(); await delay(30); });
  const created = server.writes.find((write) => write.url === "/api/schedule")!;
  assert.equal(created.body.title, "Nightly release captain");
  assert.equal(created.body.enabled, true);
  assert.deepEqual(created.body.target, { mode: "dedicated-session" }, "it keeps one rolling nightly conversation");
  assert.equal(created.body.manualOnly, false, "it wakes on a schedule, not only by hand");
  const cadence = created.body.cadence as { kind: string; expression: string; timeZone: string };
  assert.equal(cadence.kind, "cron");
  assert.equal(cadence.expression, "30 2 * * 0,1,2,3,4,5,6",
    "it runs every night, because the nightly channel builds every day");
  assert.equal(created.body.catchUp, "once", "a night missed while the host was down still runs before the build");
  assert.equal(created.body.overlapPolicy, "skip");
  assert.deepEqual(created.body.budget, { runsPerDay: 2 }, "the nightly run plus one manual retry");
  assert.equal(created.body.pauseAfterFailures, 2);
  assert.deepEqual(created.body.approvals, { timeoutMinutes: 20, onTimeout: "reject" },
    "an unanswered request at night is declined so the run still reports by morning");
  assert.equal(created.body.notify, "updates", "every nightly report reaches the person");
  const charter = String(created.body.prompt);
  assert.match(charter, /unmerged/i, "the charter reviews unmerged work, not only merged pull requests");
  assert.match(charter, /agent\.spawn/, "the charter delegates through Polyth subagents");
  assert.match(charter, /git push origin master/, "the charter pushes verified master for the nightly release");
  assert.match(charter, /nightly (build|release)/i, "the charter prepares the nightly build and release");
  await view.unmount();
});

test("drafting from a description pre-fills the form, and missing fields explain why Activate is off", async () => {
  resetRegistry();
  seedProject("ag-draft", "Drafts");
  activateProject("ag-draft");
  const server = fakeServer([], {
    name: "Morning digest",
    description: "Summarises the repo.",
    charter: "You summarise what changed overnight and report risks.",
    icon: "docs",
    schedule: { kind: "cron", expression: "30 8 * * 1-5", timeZone: "UTC" },
    context: "rolling",
  });
  const view = await mounted(agentsPage("new").element);
  await act(async () => { await delay(30); });

  const describe = view.container.querySelector<HTMLTextAreaElement>(".agents-start textarea")!;
  assert.notEqual(document.activeElement, describe, "the description field does not grab focus");
  const draftButton = buttonNamed(view.container, "Draft the agent")!;
  assert.equal(draftButton.disabled, true, "nothing to draft from yet");
  await act(async () => { typeInto(describe, "Every morning summarise the repo"); await delay(0); });
  await act(async () => { buttonNamed(view.container, "Draft the agent")!.click(); await delay(30); });

  const request = server.writes.find((write) => write.url === "/api/schedule/draft")!;
  assert.equal(request.body.projectId, "ag-draft");
  assert.equal(request.body.description, "Every morning summarise the repo");
  assert.match(view.container.textContent ?? "", /Drafted from your description/);
  const name = view.container.querySelector<HTMLInputElement>(".agent-section[data-section=identity] input")!;
  assert.equal(name.value, "Morning digest");

  await act(async () => { typeInto(name, ""); await delay(0); });
  assert.equal(buttonNamed(view.container, "Activate")!.disabled, true);
  assert.match(view.container.querySelector(".agent-footer")?.textContent ?? "", /Give the agent a name/);
  assert.equal(server.writes.filter((write) => write.url === "/api/schedule").length, 0, "nothing was saved");
  await view.unmount();
});

test("an unusable draft says so and offers to fill the agent in by hand", async () => {
  resetRegistry();
  seedProject("ag-fail", "Fails");
  activateProject("ag-fail");
  fakeServer();
  const view = await mounted(agentsPage("new").element);
  await act(async () => { await delay(30); });
  await act(async () => { typeInto(view.container.querySelector(".agents-start textarea")!, "Watch the deploys"); await delay(0); });
  await act(async () => { buttonNamed(view.container, "Draft the agent")!.click(); await delay(30); });
  assert.match(view.container.textContent ?? "", /could not be used/);
  await act(async () => { buttonNamed(view.container, "Fill in by hand")!.click(); await delay(10); });
  const charter = view.container.querySelector<HTMLTextAreaElement>(".agent-charter textarea, textarea.agent-charter")!;
  assert.equal(charter.value, "Watch the deploys", "the description becomes the starting instructions");
  await view.unmount();
});

test("Make agent from a chat opens the start page for that conversation and drafts from it", async () => {
  resetRegistry();
  seedProject("ag-chat", "Chats");
  const server = fakeServer();
  const page = agentsPage();
  const view = await mounted(page.element);
  await act(async () => { await delay(30); });
  await act(async () => {
    offerAgentSeed({ projectId: "ag-chat", sessionId: "ses-1", sessionTitle: "Fix flaky tests" });
    await delay(10);
  });
  assert.deepEqual(page.opened.at(-1), { resource: "new", projectId: "ag-chat" }, "the start page opens in the chat's project");
  assert.match(view.container.textContent ?? "", /From the conversation “Fix flaky tests”/);
  const draftButton = buttonNamed(view.container, "Draft the agent")!;
  assert.equal(draftButton.disabled, false, "the conversation alone is enough to draft from");
  await act(async () => { draftButton.click(); await delay(30); });
  const request = server.writes.find((write) => write.url === "/api/schedule/draft")!;
  assert.equal(request.body.sessionId, "ses-1");
  assert.equal(request.body.projectId, "ag-chat");
  await view.unmount();
});

test("the day of month can be cleared while typing in the wake section", async () => {
  resetRegistry();
  seedProject("ag-month", "Monthly");
  activateProject("ag-month");
  fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Dependency watch/)!.click(); await delay(20); });
  const wakes = view.container.querySelector(".agent-section[data-section=wakes]")!;
  const monthly = [...wakes.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Monthly");
  await act(async () => { monthly?.click(); await delay(0); });
  const day = wakes.querySelector<HTMLInputElement>("input.planner-day-input")!;
  await act(async () => { typeInto(day, ""); await delay(0); });
  assert.equal(day.value, "", "a cleared field stays empty instead of snapping to 1");
  await act(async () => { typeInto(day, "5"); await delay(0); });
  assert.equal(day.value, "5");
  await view.unmount();
});

test("an event wake is added from the menu, previews the last day and is saved with the agent", async () => {
  resetRegistry();
  seedProject("ag-ev", "Events");
  activateProject("ag-ev");
  const server = fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Troubleshooter/)!.click(); await delay(20); });

  const wakes = view.container.querySelector(".agent-section[data-section=wakes]")!;
  await act(async () => { buttonNamed(wakes, "Add a wake")!.click(); await delay(20); });
  const failed = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => /session in this project fails/.test(item.textContent ?? ""));
  assert.ok(failed, "the menu offers a session-failed wake");
  await act(async () => { failed!.click(); await delay(500); });

  const row = wakes.querySelector(".agent-event-wake")!;
  assert.match(row.textContent ?? "", /When a session in this project fails/);
  assert.match(row.querySelector('[role="status"]')?.textContent ?? "", /would have woken it 2 times \(4 events\)/);
  const preview = server.writes.find((write) => write.url === "/api/schedule/trigger-preview")!;
  assert.equal((preview.body.trigger as { kind: string }).kind, "session");

  await act(async () => { buttonNamed(view.container, "Activate")!.click(); await delay(30); });
  const created = server.writes.find((write) => write.url === "/api/schedule")!;
  assert.deepEqual(created.body.eventTriggers, [{
    id: "session-fails", kind: "session", on: ["failed"], pace: { quietMs: 60_000, coalesce: "latest", maxPerHour: 6 },
  }]);
  assert.equal(created.body.manualOnly, true, "the troubleshooter keeps waking only by hand and on events");
  await view.unmount();
});

test("a request waiting in an agent's run is answered above its message box, and from the home", async () => {
  resetRegistry();
  seedProject("ag-inbox", "Inbox");
  activateProject("ag-inbox");
  const waiting = {
    ...taskFor("ag-inbox", "Clean the build cache."),
    id: "agent-inbox", title: "Cache cleaner", runs: 1,
    history: [{
      runId: "r1", startedAt: Date.now() - 60_000, status: "running" as const, sessionId: "ses-9",
      waiting: [{ requestId: "req-1", kind: "permission" as const, title: "bash · rm -rf .cache", since: Date.now() - 30_000 }],
    }],
  };
  const server = fakeServer([waiting]);
  const view = await mounted(agentsPage("agent-inbox").element);
  await act(async () => { await delay(30); });
  const card = view.container.querySelector(".agent-dock .agent-request")!;
  assert.match(card.textContent ?? "", /Asks to run/);
  assert.equal(card.querySelector("code")!.textContent, "bash · rm -rf .cache");
  assert.match(view.container.querySelector(".agent-head-status")!.textContent ?? "", /Waiting for you/);
  await act(async () => { buttonNamed(card, "Allow once")!.click(); await delay(30); });
  const reply = server.writes.find((write) => write.url.includes("/permission"))!;
  assert.match(reply.url, /ses-9/);
  assert.match(reply.url + JSON.stringify(reply.body), /req-1/);
  assert.match(JSON.stringify(reply.body), /once/);
  await view.unmount();

  const home = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  const inbox = home.container.querySelector(".agents-home-request")!;
  assert.match(inbox.textContent ?? "", /Cache cleaner/);
  assert.match(inbox.textContent ?? "", /bash · rm -rf \.cache/);
  await act(async () => { buttonNamed(inbox, "Deny")!.click(); await delay(30); });
  assert.match(JSON.stringify(server.writes.at(-1)!.body), /reject/);
  await home.unmount();
});

test("pausing an agent shows Paused at once and restores it when the server refuses", async () => {
  resetRegistry();
  seedProject("ag-pause", "Pause");
  activateProject("ag-pause");
  fakeServer([{ ...taskFor("ag-pause", "Watch the queue."), id: "agent-pause", title: "Queue watcher", runs: 1, lastRunAt: Date.now() - 60_000 }]);
  const listed = globalThis.fetch;
  let refuse!: () => void;
  const pauses: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/pause")) {
      pauses.push(url);
      return new Promise<Response>((resolve) => { refuse = () => resolve(response({ error: "Scheduler is busy" }, 409)); });
    }
    return listed(input, init);
  }) as typeof fetch;
  const view = await mounted(agentsPage("agent-pause").element);
  const phase = () => view.container.querySelector(".agent-screen")?.getAttribute("data-phase");
  await act(async () => { await delay(30); });
  assert.equal(phase(), "idle");
  await act(async () => { buttonNamed(view.container, "Agent actions")!.click(); await delay(10); });
  const pause = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Pause wakes")!;
  await act(async () => { pause.click(); await delay(0); });
  assert.equal(phase(), "paused", "paused before the server answers");
  assert.ok(buttonNamed(view.container, "Resume"), "the lead action becomes Resume");
  await act(async () => { refuse(); await delay(30); });
  assert.equal(pauses.length, 1, "sent once");
  assert.equal(phase(), "idle", "restored after the refusal");
  assert.match(getState().uiError ?? "", /Scheduler is busy/);
  await view.unmount();
});

test("a webhook wake shows its URL once after saving, and integration sources are offered", async () => {
  resetRegistry();
  seedProject("ag-hook", "Hooks");
  activateProject("ag-hook");
  fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Troubleshooter/)!.click(); await delay(20); });
  const wakes = () => view.container.querySelector(".agent-section[data-section=wakes]")!;
  await act(async () => { buttonNamed(wakes(), "Add a wake")!.click(); await delay(20); });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  assert.ok(items.some((item) => /When Monitoring reports/.test(item.textContent ?? "")), "registered sources are offered");
  await act(async () => { items.find((item) => /webhook is called/.test(item.textContent ?? ""))!.click(); await delay(20); });
  assert.match(wakes().textContent ?? "", /The URL appears once you save the agent\./);

  await act(async () => { buttonNamed(view.container, "Activate")!.click(); await delay(40); });
  // The new agent's page opens on Settings so the one-time URL is in view.
  const settings = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Settings")!;
  assert.equal(settings.getAttribute("aria-selected"), "true");
  assert.ok(view.container.querySelector(".agent-section[data-section=wakes] .agent-hook"), "the one-time URL is on the page");
  const hook = view.container.querySelector(".agent-hook")!;
  assert.match(hook.querySelector("code")!.textContent ?? "", /\/hooks\/schedule\/tok_x{40}$/);
  assert.match(hook.textContent ?? "", /shown only once/);
  await view.unmount();
});

test("Memory shows the notebook and context and cost: occupancy, layers, cache share and the keep-warm decision", async () => {
  resetRegistry();
  seedProject("ag-ctx", "Context");
  activateProject("ag-ctx");
  const server = fakeServer([{ ...taskFor("ag-ctx", "You keep CI green."), id: "agent-ctx", title: "CI keeper", target: { mode: "dedicated-session" } }]);
  const view = await mounted(agentsPage("agent-ctx").element);
  await act(async () => { await delay(30); });
  const tab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === "Memory")!;
  await act(async () => { tab.click(); await delay(40); });
  assert.match(view.container.querySelector(".agent-memory-context .agents-section-title")?.textContent ?? "", /Context and cost/);
  const panel = view.container.querySelector(".agent-context")!;
  const text = panel.textContent ?? "";
  assert.match(text, /42% of the context used · 84,000 \/ 200,000 · new session at 60%/);
  assert.match(text, /Instructions ≈320/);
  assert.match(text, /80% from cache on average/);
  assert.match(text, /about 5 min after use · probably still warm now/);
  assert.match(text, /3 keep-alives \(≈0\.36× the instructions' input price\) cost less than a cold start \(≈1\.15×\)/);
  assert.match(text, /2 keep-alives in 24 h/);
  await act(async () => { buttonNamed(panel, "Start a new session next run")!.click(); await delay(30); });
  const action = server.writes.find((write) => write.url.endsWith("/context"))!;
  assert.deepEqual(action.body, { action: "new-session" });
  assert.match(panel.textContent ?? "", /The next run starts a new session\./);
  await view.unmount();
});

test("Edit as a file mirrors the form both ways and blocks saving while the file is invalid", async () => {
  resetRegistry();
  seedProject("ag-file", "Files");
  activateProject("ag-file");
  fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Nightly release captain/)!.click(); await delay(20); });
  await showAdvanced(view.container);
  await act(async () => { buttonNamed(view.container, "Edit as a file")!.click(); await delay(10); });
  const text = view.container.querySelector<HTMLTextAreaElement>(".agent-file textarea")!;
  assert.match(text.value, /^---\nformat: agent\/v1\nid: nightly-release-captain\nname: Nightly release captain\n/);
  assert.match(text.value, /context: rolling/);
  assert.ok(buttonNamed(view.container, "Edit as a form"), "the way back to the form");

  await act(async () => { typeInto(text, text.value.replace("name: Nightly release captain", "name: Night shift")); await delay(10); });
  assert.equal(view.container.querySelector(".agent-file-error"), null);
  assert.equal(view.container.querySelector(".agents-bar-title")!.textContent, "Night shift", "the form follows the file");

  await act(async () => { typeInto(text, text.value.replace("context: rolling", "context: sideways")); await delay(10); });
  assert.match(view.container.querySelector(".agent-file-error")!.textContent ?? "", /context must be one of fresh, rolling/);
  assert.equal(buttonNamed(view.container, "Activate")!.disabled, true);
  assert.match(view.container.querySelector(".agent-footer")!.textContent ?? "", /Fix the agent file first/);
  await view.unmount();
});

test("the dry run lists the latest events and why each would or would not wake the agent", async () => {
  resetRegistry();
  seedProject("ag-dry", "Dry");
  activateProject("ag-dry");
  fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Troubleshooter/)!.click(); await delay(20); });
  const wakes = view.container.querySelector(".agent-section[data-section=wakes]")!;
  await act(async () => { buttonNamed(wakes, "Add a wake")!.click(); await delay(20); });
  const failed = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => /session in this project fails/.test(item.textContent ?? ""))!;
  await act(async () => { failed.click(); await delay(500); });
  assert.equal(wakes.querySelector(".agent-dry-run-events") === null, true, "simple settings keep to the one-line preview");
  await showAdvanced(view.container);
  const dry = wakes.querySelector(".agent-dry-run-events")!;
  const lines = [...dry.querySelectorAll("li")].map((li) => li.textContent ?? "");
  assert.match(lines[0]!, /Deploy staging.*would wake the agent/);
  assert.match(lines[1]!, /a different outcome/);
  assert.match(lines[2]!, /filtered out: Session title contains “deploy”/);
  await view.unmount();
});

test("a wake script is written, tested on recent events and saved with the wake", async () => {
  resetRegistry();
  seedProject("ag-script", "Scripts");
  activateProject("ag-script");
  const server = fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Troubleshooter/)!.click(); await delay(20); });
  const wakes = view.container.querySelector(".agent-section[data-section=wakes]")!;
  await act(async () => { buttonNamed(wakes, "Add a wake")!.click(); await delay(20); });
  const failed = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => /session in this project fails/.test(item.textContent ?? ""))!;
  await act(async () => { failed.click(); await delay(20); });
  await showAdvanced(view.container);
  await act(async () => { wakes.querySelector<HTMLButtonElement>(".agent-script-toggle")!.click(); await delay(10); });
  const editor = wakes.querySelector<HTMLTextAreaElement>(".agent-script textarea")!;
  assert.match(editor.placeholder, /return \{ action: "run"/, "the placeholder shows a working example");
  await act(async () => { typeInto(editor, 'return { action: "run", note: events[0].fields.title };'); await delay(10); });
  await act(async () => { buttonNamed(wakes, "Test on recent events")!.click(); await delay(30); });
  assert.match(wakes.querySelector(".agent-script-outcome")!.textContent ?? "", /Would wake the agent \(events: 1, 3 ms\) — Deploy api failed/);
  const tested = server.writes.find((write) => write.url === "/api/schedule/script-test")!;
  assert.equal((tested.body.trigger as { script: string }).script, 'return { action: "run", note: events[0].fields.title };');

  await act(async () => { buttonNamed(view.container, "Activate")!.click(); await delay(30); });
  const created = server.writes.find((write) => write.url === "/api/schedule")!;
  assert.equal((created.body.eventTriggers as Array<{ script?: string }>)[0]!.script, 'return { action: "run", note: events[0].fields.title };');
  await view.unmount();
});

test("backup models are added, ordered and saved; Full access is chosen with a warning", async () => {
  resetRegistry();
  seedProject("ag-backup", "Backups");
  activateProject("ag-backup");
  const server = fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Troubleshooter/)!.click(); await delay(20); });

  const identity = () => view.container.querySelector(".agent-section[data-section=identity]")!;
  assert.equal(buttonNamed(identity(), "Add backup model") === undefined, true, "backups are an advanced setting");
  await showAdvanced(view.container);
  await act(async () => { buttonNamed(identity(), "Add backup model")!.click(); await delay(20); });
  assert.equal(identity().querySelectorAll(".agent-backup").length, 1);
  assert.equal(buttonNamed(view.container, "Activate")!.disabled, true, "an empty backup blocks saving");
  assert.match(view.container.querySelector(".agent-footer")!.textContent ?? "", /Choose a model for every backup/);
  await act(async () => { buttonNamed(identity(), "Remove: Backup 1")!.click(); await delay(10); });
  assert.equal(identity().querySelectorAll(".agent-backup").length, 0);

  // Two complete backups through the file view, then reordered in the form.
  await act(async () => { buttonNamed(view.container, "Edit as a file")!.click(); await delay(10); });
  const text = view.container.querySelector<HTMLTextAreaElement>(".agent-file textarea")!;
  const backups = 'fallbackModels: [{"model":"openai/gpt-5","harness":"codex"},{"model":"anthropic/claude-sonnet","harness":"claude"}]';
  await act(async () => { typeInto(text, text.value.replace(/\n---\n/, `\n${backups}\n---\n`)); await delay(10); });
  assert.equal(view.container.querySelector(".agent-file-error"), null);
  await act(async () => { buttonNamed(view.container, "Edit as a form")!.click(); await delay(20); });
  assert.equal(identity().querySelectorAll(".agent-backup").length, 2);
  assert.equal(buttonNamed(identity(), "Move up: Backup 1")!.disabled, true);
  await act(async () => { buttonNamed(identity(), "Move down: Backup 1")!.click(); await delay(10); });

  const abilities = view.container.querySelector(".agent-section[data-section=skills]")!;
  const trigger = [...abilities.querySelectorAll<HTMLButtonElement>("button[aria-haspopup]")].find((button) => /Project default/.test(button.textContent ?? ""))!;
  await act(async () => { trigger.click(); await delay(20); });
  const full = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => /Full access/.test(option.textContent ?? ""));
  assert.ok(full, "Full access is offered");
  await act(async () => { full!.click(); await delay(20); });
  assert.match(abilities.textContent ?? "", /run any command, change files and use the network without asking/);

  await act(async () => { buttonNamed(view.container, "Activate")!.click(); await delay(30); });
  const created = server.writes.find((write) => write.url === "/api/schedule")!;
  assert.deepEqual(created.body.fallbackModels, [
    { providerID: "anthropic", modelID: "claude-sonnet", harnessId: "claude" },
    { providerID: "openai", modelID: "gpt-5", harnessId: "codex" },
  ]);
  assert.equal(created.body.permissions, "all");
  await view.unmount();
});

test("settings start simple and the advanced switch shows memory, limits and backups; the choice is remembered", async () => {
  resetRegistry();
  seedProject("ag-simple", "Simple");
  activateProject("ag-simple");
  fakeServer();
  const view = await mounted(agentsPage().element);
  await act(async () => { await delay(30); });
  await act(async () => { buttonNamed(view.container, /Nightly release captain/)!.click(); await delay(20); });
  const sections = () => [...view.container.querySelectorAll(".agent-section")].map((section) => section.getAttribute("data-section"));
  assert.deepEqual(sections(), ["identity", "charter", "wakes", "reports", "skills"]);
  assert.equal(buttonNamed(view.container, "Edit as a file") === undefined, true, "the file view is an advanced tool");
  assert.ok(buttonNamed(view.container, "Show advanced settings"), "simple settings end on what more there is");
  await act(async () => { buttonNamed(view.container, "Show advanced settings")!.click(); await delay(10); });
  assert.deepEqual(sections(), ["identity", "charter", "wakes", "reports", "skills", "context", "budget"]);
  assert.ok(buttonNamed(view.container, "Edit as a file"));
  assert.equal(localStorage.getItem("polyth.agents.advancedSettings"), "1");
  await view.unmount();
});

test("a saved webhook wake whose address is gone gets a new one, and unsaved edits stay unsaved", async () => {
  resetRegistry();
  seedProject("ag-renew", "Renew");
  activateProject("ag-renew");
  const hooked = {
    ...taskFor("ag-renew", "React to deploys."), id: "agent-renew", title: "Deploy watcher", runs: 1, manualOnly: true,
    eventTriggers: [{ id: "webhook", kind: "webhook" as const, hasToken: true, pace: { quietMs: 60_000, coalesce: "latest" as const, maxPerHour: 6 } }],
  };
  const server = fakeServer([hooked]);
  const view = await mounted(agentsPage("agent-renew").element);
  await act(async () => { await delay(30); });
  const tab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === "Settings")!;
  await act(async () => { tab.click(); await delay(20); });
  const hook = () => view.container.querySelector(".agent-hook")!;
  assert.match(hook().textContent ?? "", /shown only once/);
  assert.match(hook().textContent ?? "", /POST/, "it says how to call the address");

  const name = view.container.querySelector<HTMLInputElement>(".agent-section[data-section=identity] input")!;
  await act(async () => { typeInto(name, "Deploy guard"); await delay(0); });
  await act(async () => { buttonNamed(hook(), "Get a new address")!.click(); await delay(10); });
  await act(async () => { resolveAlert(true); await delay(30); });
  const patch = server.writes.find((write) => write.url === "/api/schedule/agent-renew")!;
  assert.deepEqual(Object.keys(patch.body), ["eventTriggers"], "only the wakes are saved");
  const sent = (patch.body.eventTriggers as Array<{ id: string; hasToken?: boolean }>)[0]!;
  assert.equal(sent.id, "webhook-r2", "a new id issues a new address");
  assert.equal(sent.hasToken, undefined);
  assert.match(hook().querySelector("code")!.textContent ?? "", /\/hooks\/schedule\/tok_y{40}$/);
  assert.equal(name.value, "Deploy guard", "the unsaved name is still there");
  assert.match(view.container.querySelector(".agent-footer")?.textContent ?? "", /Unsaved changes/i);
  await view.unmount();
});
