// The agent's page in place of Chat and its rows in the navigator, mounted for real.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { ScheduleRunDto, ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";

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
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject, applyProjectUpsert, beginProjectListRequest, publishProjectList } = await import("../../../apps/web/src/store.ts");
const { default: AgentsPage } = await import("../widgets/AgentsPage.tsx");
const { default: AgentNavSection } = await import("../widgets/AgentNavSection.tsx");
const { agentLive } = await import("../widgets/agentLive.ts");
const { conversationDays } = await import("../widgets/AgentConversation.tsx");
const { dayItems } = await import("../widgets/agentThreads.ts");
const { BotIcon, AssistIcon } = await import("../../../apps/web/src/components/ui/icons.ts");

/** The one lucide glyph inside a container, by its first path's data. */
function glyphPath(container: ParentNode): string {
  return container.querySelector("svg path")?.getAttribute("d") ?? "";
}

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function mounted(component: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(component); await delay(20); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const buttonNamed = (root: ParentNode, name: string | RegExp): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
    const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
}

const HOUR = 60 * 60_000;
const now = Date.now();
const run = (over: Partial<ScheduleRunDto> & { runId: string; ago: number }): ScheduleRunDto => {
  const { ago, ...rest } = over;
  return { startedAt: now - ago, finishedAt: now - ago + 120_000, status: "ok", trigger: "schedule", sessionId: "ses-1", ...rest };
};

function digest(over: Partial<ScheduleTaskDto> = {}): ScheduleTaskDto {
  return {
    id: "agent-1", projectId: "pr-home", title: "Morning digest", description: "Summarises the night.",
    prompt: "You summarise what changed overnight.", kind: "cron",
    cadence: { kind: "cron", expression: "30 8 * * 1-5", timeZone: "UTC" },
    enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: now + 10 * HOUR, runs: 4, lastRunAt: now - HOUR,
    target: { mode: "dedicated-session" }, lastSessionId: "ses-1",
    heartbeat: { everyMinutes: 30, activeFrom: 480, activeTo: 1320, timeZone: "UTC", checklist: "CI" },
    nextBeatAt: now + 20 * 60_000,
    notebook: "- prefers short reports",
    seenAt: now - 5 * HOUR,
    history: [
      run({ runId: "r4", ago: HOUR, signal: "alert", headline: "Build broken by PR #412",
        summary: "PR #412 failed `npm test` in the voice package.", remembered: ["the user owns PR #412"] }),
      run({ runId: "r3", ago: 2 * HOUR, trigger: "heartbeat", signal: "quiet" }),
      run({ runId: "r2", ago: 3 * HOUR, trigger: "heartbeat", signal: "quiet" }),
      run({ runId: "r1", ago: 6 * HOUR, signal: "update", headline: "3 commits landed",
        summary: "Rail drag fix, config prune, i18n.", feedback: { verdict: "down", note: "skip docs", at: now - 5 * HOUR, delivered: true } }),
    ],
    ...over,
  };
}

function fakeServer(tasks: ScheduleTaskDto[], answers: { run?: () => Promise<Response> } = {}) {
  const writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url === "/api/schedule" || url.startsWith("/api/schedule?")) return response({ tasks, loopErrors: [] });
    if (url === "/api/schedule/sources") return response([]);
    if (url.includes("/api/schedule/preview")) return response({ runs: [now + HOUR], description: "" });
    writes.push({ url, method, body });
    const id = url.split("/")[3]!;
    const task = tasks.find((item) => item.id === decodeURIComponent(id)) ?? tasks[0]!;
    if (url.endsWith("/seen")) return response({ ...task, seenAt: body.at });
    if (url.endsWith("/feedback")) return response(task);
    if (url.endsWith("/run")) return answers.run ? answers.run() : response(task);
    if (method === "PATCH") return response({ ...task, ...body, notebookEditedBy: "user", notebookUpdatedAt: now });
    if (url.endsWith("/context")) return response(null);
    return response({});
  }) as typeof fetch;
  return writes;
}

function resetRegistry(): void {
  publishProjectList(beginProjectListRequest(), []);
  activateProject(null);
  applyProjectUpsert({ id: "pr-home", name: "Home", path: "/tmp/pr-home", createdAt: 1 });
  activateProject("pr-home");
}

/** The host as an agent's page and its rows see it. */
function fakeHost(over: { activePage?: { pageId: string; resource: string | null } | null } = {}) {
  const opened: Array<{ pageId: string; resource: string | null; projectId?: string }> = [];
  const sessions: string[] = [];
  const listeners = new Set<() => void>();
  let snapshot = { activePage: over.activePage ?? null };
  const host = {
    ui: { Slot: () => null },
    store: {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getSnapshot: () => snapshot,
    },
    navigation: {
      openPage: (pageId: string, resource?: string | null, options?: { projectId?: string }) => {
        opened.push({ pageId, resource: resource ?? null, ...(options?.projectId ? { projectId: options.projectId } : {}) });
        snapshot = { activePage: { pageId, resource: resource ?? null } };
        for (const listener of listeners) listener();
        return true;
      },
      closePage: () => {},
    },
    conversation: { openSession: async (id: string) => { sessions.push(id); } },
  } as unknown as WebPackageHost;
  return { host, opened, sessions };
}

test("live state: what needs the person first, then work, then news", () => {
  const task = digest();
  const live = agentLive(task);
  assert.equal(live.phase, "alert", "an unread alert outranks an idle agent");
  assert.equal(live.unread, 1, "the update was read before; quiet checks are never news");
  assert.equal(live.nextWake?.kind, "heartbeat", "the next beat comes before the next scheduled run");
  const waiting = agentLive(digest({
    history: [{ runId: "r9", startedAt: now, status: "running", sessionId: "s", waiting: [{ requestId: "q", kind: "permission", title: "bash", since: now }] }, ...task.history!],
  }));
  assert.equal(waiting.phase, "needs-you");
  assert.equal(agentLive(digest({ enabled: false })).phase, "alert", "news stays news while paused");
  assert.equal(agentLive(digest({ enabled: false, history: [], seenAt: undefined })).phase, "paused");
  const tripped = { reason: "failures" as const, message: "Stopped after 2 failed runs", at: now };
  assert.equal(agentLive(digest({ tripped })).phase, "stopped");
  assert.equal(agentLive(digest({ tripped, history: [{ runId: "r10", startedAt: now, status: "running" }, ...task.history!] })).phase, "working",
    "a stopped agent run by hand is working, never Stopped beside its Stop button");
});

test("the conversation reads oldest first: your words before their run, quiet checks folded, New before the first unread", () => {
  const asked = run({ runId: "r5", ago: 30 * 60_000, trigger: "manual", input: "Check PR #412 again", signal: "update", headline: "Rechecked" });
  const days = conversationDays(digest({ history: [asked, ...digest().history!] }), now - 5 * HOUR);
  const kinds = days.flatMap((day) => dayItems(day).map((item) =>
    item.kind === "quiet" ? `quiet×${item.runs.length}` : item.kind === "report" ? item.run.runId : item.kind === "you" ? `you:${item.text}` : item.kind));
  assert.deepEqual(kinds.filter((kind) => kind !== "new").slice(-5), ["r1", "quiet×2", "r4", "you:Check PR #412 again", "r5"]);
  assert.equal(kinds[kinds.indexOf("r4") - 1], "new", "New sits right before the first report the person has not read");
  const pending = conversationDays(digest(), now, [{ text: "And the docs?", at: now }]);
  const last = dayItems(pending.at(-1)!).at(-1)!;
  assert.equal(last.kind === "you" && last.pending, "sending", "a message on its way shows at the end");
});

test("the conversation shows reports, folds quiet checks, marks what is new and learns from feedback", async () => {
  resetRegistry();
  const writes = fakeServer([digest()]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-1" }));
  await act(async () => { await delay(30); });

  assert.equal(view.container.querySelector(".agent-head-name")!.textContent, "Morning digest");
  assert.match(view.container.querySelector(".agent-head-status")!.textContent ?? "", /Next .* · Checks every 30 min 08:00–22:00|Checks every 30 min 08:00–22:00/i);
  const feed = view.container.querySelector(".agent-feed")!;
  const alert = feed.querySelector('.agent-report[data-signal="alert"]')!;
  assert.match(alert.querySelector(".agent-report-headline")!.textContent ?? "", /Build broken by PR #412/);
  assert.match(alert.textContent ?? "", /Needs attention/);
  assert.ok(alert.previousElementSibling?.classList.contains("agent-new"), "New sits right before the unread report");
  assert.match(alert.querySelector(".agent-report-notes")!.textContent ?? "", /Noted: the user owns PR #412/);
  assert.match(feed.querySelector(".agent-quiet-toggle")!.textContent ?? "", /Quiet checks: 2/);
  const update = [...feed.querySelectorAll(".agent-report")].find((entry) => /3 commits landed/.test(entry.textContent ?? ""))!;
  assert.match(update.textContent ?? "", /Heard/, "delivered feedback says so");
  assert.ok(update.compareDocumentPosition(alert) & 4, "older reports come first");

  await act(async () => { buttonNamed(alert, "Useful")!.click(); await delay(30); });
  const feedback = writes.find((write) => write.url.endsWith("/runs/r4/feedback"))!;
  assert.deepEqual(feedback.body, { verdict: "up" });

  await act(async () => { await delay(1_300); });
  const seen = writes.find((write) => write.url.endsWith("/seen"))!;
  assert.equal(seen.body.at, now - HOUR + 120_000, "the read mark moves to the newest report");
  assert.ok(view.container.querySelector(".agent-new"), "New stays while the page is open");
  await view.unmount();
});

test("writing to the agent starts a run with the words; its memory is editable", async () => {
  resetRegistry();
  const writes = fakeServer([digest()]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-1" }));
  await act(async () => { await delay(30); });

  const box = view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  assert.match(box.placeholder, /Morning digest/);
  assert.equal(document.activeElement === box, false, "the box does not grab focus on open");
  await act(async () => { typeInto(box, "Check PR #412 again"); await delay(0); });
  await act(async () => { view.container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
  const sent = writes.find((write) => write.url.endsWith("/run"))!;
  assert.deepEqual(sent.body, { input: "Check PR #412 again" });
  assert.match(view.container.querySelector(".agent-you[data-pending]")?.textContent ?? "", /Check PR #412 again/,
    "the words show at once, until their run carries them");

  const memoryTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Memory")!;
  await act(async () => { memoryTab.click(); await delay(20); });
  const text = view.container.querySelector<HTMLTextAreaElement>(".agent-memory-text")!;
  assert.equal(text.value, "- prefers short reports");
  assert.equal(buttonNamed(view.container, "Save"), undefined, "nothing to save yet");
  await act(async () => { typeInto(text, "- prefers short reports\n- ignore docs-only commits"); await delay(0); });
  await act(async () => { buttonNamed(view.container, "Save")!.click(); await delay(30); });
  const saved = writes.find((write) => write.method === "PATCH")!;
  assert.deepEqual(saved.body, { notebook: "- prefers short reports\n- ignore docs-only commits" });
  assert.match(view.container.querySelector(".agent-memory")!.textContent ?? "", /skip docs/, "past feedback is listed");
  await view.unmount();
});

/** A run request the server answers only when the test says so: admission of a
 *  run (a harness starting) can take seconds, and the feed already shows the
 *  person's words from the first poll of the running record. */
function heldRun() {
  let answer!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { answer = resolve; });
  return { held: () => held, answer };
}

test("the words leave the box the moment they are sent, not when the server admits the run", async () => {
  resetRegistry();
  const admission = heldRun();
  const tasks = [digest()];
  const writes = fakeServer(tasks, { run: admission.held });
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-1" }));
  try {
    await act(async () => { await delay(30); });
    const box = () => view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
    const submitButton = () => view.container.querySelector<HTMLButtonElement>(".agent-composer-send")!;
    await act(async () => { typeInto(box(), "Check PR #412 again"); await delay(0); });
    assert.equal(submitButton().disabled, false);
    await act(async () => { view.container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
    assert.equal(writes.filter((write) => write.url.endsWith("/run")).length, 1, "the request is on its way");
    assert.match(view.container.querySelector(".agent-you[data-pending]")?.textContent ?? "", /Check PR #412 again/,
      "the feed already carries the words");
    assert.equal(box().value, "", "so the box does not keep a second copy while the run is admitted");
    assert.equal(submitButton().disabled, true, "nothing is left to send");

    const asked: ScheduleRunDto = { runId: "r5", startedAt: Date.now(), status: "running", trigger: "manual", input: "Check PR #412 again", sessionId: "ses-1" };
    tasks[0] = digest({ history: [asked, ...digest().history!] });
    await act(async () => { admission.answer(response(tasks[0])); await delay(30); });
    assert.equal(box().value, "", "admission changes nothing in the box");
    const copies = [...view.container.querySelectorAll(".agent-you")].filter((bubble) => /Check PR #412 again/.test(bubble.textContent ?? ""));
    assert.equal(copies.length, 1, "and the words appear once in the feed, as the run's own message");
    assert.equal(copies[0]!.hasAttribute("data-pending"), false);
  } finally {
    admission.answer(response(digest()));
    await view.unmount();
  }
});

test("a refused message returns to the box, ahead of anything typed since", async () => {
  resetRegistry();
  const refusal = () => response({ error: "unavailable", message: "The agent could not start" }, 503);
  for (const typedSince of ["", "and the docs"]) {
    const admission = heldRun();
    fakeServer([digest()], { run: admission.held });
    const { host } = fakeHost();
    const view = await mounted(createElement(AgentsPage, { host, resource: "agent-1" }));
    try {
      await act(async () => { await delay(30); });
      const box = () => view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
      await act(async () => { typeInto(box(), "Check PR #412 again"); await delay(0); });
      await act(async () => { view.container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
      assert.equal(box().value, "");
      if (typedSince) await act(async () => { typeInto(box(), typedSince); await delay(0); });
      await act(async () => { admission.answer(refusal()); await delay(30); });
      assert.equal(box().value, typedSince ? `Check PR #412 again\n\n${typedSince}` : "Check PR #412 again",
        "no word is lost, and newer typing is never overwritten");
      assert.equal(view.container.querySelector(".agent-you[data-pending]"), null, "the words that were not sent leave the feed");
    } finally {
      admission.answer(refusal());
      await view.unmount();
    }
  }
});

test("a message refused after the person moved to another agent does not land in that agent's box", async () => {
  resetRegistry();
  const admission = heldRun();
  fakeServer([digest(), digest({ id: "agent-2", title: "CI keeper", createdAt: 2 })], { run: admission.held });
  const { host } = fakeHost();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const refusal = () => response({ error: "unavailable", message: "The agent could not start" }, 503);
  try {
    await act(async () => { root.render(createElement(AgentsPage, { host, resource: "agent-1" })); await delay(30); });
    const box = () => container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
    await act(async () => { typeInto(box(), "Check PR #412 again"); await delay(0); });
    await act(async () => { container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
    await act(async () => { root.render(createElement(AgentsPage, { host, resource: "agent-2" })); await delay(30); });
    assert.equal(container.querySelector(".agent-head-name")!.textContent, "CI keeper");
    await act(async () => { admission.answer(refusal()); await delay(30); });
    assert.equal(box().value, "", "the other agent's box is not a place for this agent's words");
  } finally {
    admission.answer(refusal());
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("agents sit above a project's chats: state marks, news, and a click opens the agent in place of Chat", async () => {
  resetRegistry();
  const working = digest({
    id: "agent-2", title: "CI keeper", createdAt: 2, seenAt: now,
    history: [{ runId: "w1", startedAt: now - 60_000, status: "running", sessionId: "ses-2" }],
  });
  const scheduledMessage = digest({ id: "agent-3", title: "Standup reminder", createdAt: 3, target: { mode: "existing-session", sessionId: "chat-1" } });
  fakeServer([digest(), working, scheduledMessage, digest({ id: "agent-4", projectId: "elsewhere", title: "Other project" })]);
  const { host, opened } = fakeHost();
  let navigated = 0;
  const view = await mounted(createElement(AgentNavSection, {
    host,
    context: { projectId: "pr-home", activeSessionId: "ses-2", onNavigate: () => { navigated += 1; } },
  }));
  await act(async () => { await delay(30); });
  const rows = () => [...view.container.querySelectorAll(".agent-nav-row")];
  assert.deepEqual(rows().map((row) => row.querySelector(".agent-nav-title")!.textContent), ["Morning digest", "CI keeper"],
    "only this project's agents; a scheduled message belongs to its chat");
  assert.equal(rows()[0]!.getAttribute("data-phase"), "alert");
  assert.ok(rows()[0]!.querySelector('.agent-nav-dot[data-tone="alert"]'), "unread alert: an amber dot leads the row");
  assert.ok(rows()[1]!.querySelector('.agent-mark[data-working]'), "a working agent shows its own glyph with the travelling arc");
  assert.ok(rows().every((row) => !row.classList.contains("active")), "nothing looks open before it is");

  await act(async () => { rows()[0]!.querySelector<HTMLButtonElement>(".agent-nav-btn")!.click(); await delay(10); });
  assert.deepEqual(opened, [{ pageId: "agents", resource: "agent-1", projectId: "pr-home" }]);
  assert.equal(navigated, 1, "a phone navigator gets out of the way");
  assert.ok(rows()[0]!.classList.contains("active"), "the open agent is the current row");
  assert.equal(rows()[0]!.querySelector(".agent-nav-btn")!.getAttribute("aria-current"), "page");
  assert.equal(rows()[1]!.classList.contains("active"), false);
  await view.unmount();
});

test("a working agent's clocks agree: its row, its status line and its live turn read the same second", async () => {
  resetRegistry();
  const startedAt = Date.now() - (2 * 60 + 42) * 1_000;
  fakeServer([digest({ seenAt: now, history: [{ runId: "w1", startedAt, status: "running", sessionId: "ses-2" }] })]);
  const { host } = fakeHost({ activePage: { pageId: "agents", resource: null } });
  const page = await mounted(createElement(AgentsPage, { host, resource: "agent-1" }));
  const nav = await mounted(createElement(AgentNavSection, { host, context: { projectId: "pr-home" } }));
  await act(async () => { await delay(30); });
  const clocks = () => [
    nav.container.querySelector(".agent-nav-meta")!.textContent,
    page.container.querySelector(".agent-live-time")!.textContent,
    /\d+:\d\d/.exec(page.container.querySelector(".agent-head-status")!.textContent ?? "")?.[0],
  ];
  assert.equal(new Set(clocks()).size, 1, `one clock: ${clocks().join(" / ")}`);
  assert.match(clocks()[0]!, /^02:4\d$/);
  await act(async () => { await delay(1_100); });
  assert.equal(new Set(clocks()).size, 1, "and they move together");
  assert.match(page.container.querySelector('.agent-head-status span[aria-hidden="true"]')?.textContent ?? "", /^Working · \d\d:\d\d$/,
    "the visible line ticks; the live region only hears that the agent works");
  assert.equal(page.container.querySelector(".agent-head-status .sr-only")?.textContent, "Working now");
  await nav.unmount();
  await page.unmount();
});

test("the agents group folds away, still says who waits or works, and Alt folds every project", async () => {
  resetRegistry();
  localStorage.clear();
  const waiting = digest({
    id: "agent-w", title: "Auditor",
    history: [{ runId: "x", startedAt: now, status: "running", sessionId: "s", waiting: [{ requestId: "q", kind: "permission", title: "git push", since: now }] }],
  });
  const tripped = digest({
    id: "agent-t", title: "Spender", seenAt: now,
    tripped: { reason: "budget", message: "Budget reached", at: now },
  });
  fakeServer([waiting, tripped, digest({ id: "agent-o", projectId: "pr-other", title: "Other" })]);
  const { host } = fakeHost();
  const home = await mounted(createElement(AgentNavSection, { host, context: { projectId: "pr-home" } }));
  const other = await mounted(createElement(AgentNavSection, { host, context: { projectId: "pr-other" } }));
  await act(async () => { await delay(30); });
  const toggle = (view: { container: HTMLElement }) => view.container.querySelector<HTMLButtonElement>(".agent-nav-toggle")!;
  assert.equal(toggle(home).getAttribute("aria-expanded"), "true");

  await act(async () => { toggle(home).click(); await delay(0); });
  assert.equal(toggle(home).getAttribute("aria-expanded"), "false");
  assert.equal(home.container.querySelector(".agent-nav-row"), null, "folded: no rows");
  assert.ok(home.container.querySelector('.agent-nav-summary .agent-nav-mark[data-mark="attention"]'), "the request still shows");
  assert.ok(home.container.querySelector('.agent-nav-summary .agent-nav-mark[data-mark="stopped"]'), "so does a stopped agent");
  assert.match(home.container.querySelector(".agent-nav-summary")!.textContent ?? "", /Waiting for you: 1, Stopped: 1/);
  // Folded, the other project still says its news is an alert.
  await act(async () => { toggle(other).click(); await delay(0); });
  assert.equal(other.container.querySelector(".agent-nav-summary .agent-nav-dot")?.getAttribute("data-tone"), "alert");
  await act(async () => { toggle(other).click(); await delay(0); });
  assert.equal(toggle(other).getAttribute("aria-expanded"), "true", "another project keeps its own choice");
  assert.match(localStorage.getItem("polyth.agents.navCollapsed.v1") ?? "", /pr-home/, "the choice is remembered");

  await act(async () => { toggle(home).dispatchEvent(new window.MouseEvent("click", { bubbles: true, altKey: true }) as unknown as Event); await delay(0); });
  assert.equal(toggle(home).getAttribute("aria-expanded"), "true");
  await act(async () => { toggle(other).dispatchEvent(new window.MouseEvent("click", { bubbles: true, altKey: true }) as unknown as Event); await delay(0); });
  assert.equal(toggle(home).getAttribute("aria-expanded"), "false", "Alt-click folds every project");
  assert.equal(toggle(other).getAttribute("aria-expanded"), "false");
  // And unfolds them all again.
  await act(async () => { toggle(home).dispatchEvent(new window.MouseEvent("click", { bubbles: true, altKey: true }) as unknown as Event); await delay(0); });
  assert.equal(toggle(other).getAttribute("aria-expanded"), "true");
  await home.unmount();
  await other.unmount();
  localStorage.clear();
});

test("an agent without an icon reads as a robot in the navigator, and a chosen glyph still wins", async () => {
  resetRegistry();
  // agent-1 has no `icon` (a legacy or freshly created agent): the default is
  // the robot, the same mark the Agents window carries. Idle, so its leading
  // column shows the glyph rather than a state mark.
  fakeServer([
    digest({ history: [], seenAt: now }),
    digest({ id: "agent-2", title: "Sparkle", createdAt: 2, icon: "assist", history: [], seenAt: now }),
  ]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentNavSection, { host, context: { projectId: "pr-home" } }));
  await act(async () => { await delay(30); });
  const rows = [...view.container.querySelectorAll(".agent-nav-row")];
  const lead = rows[0]!.querySelector(".agent-nav-glyph")!;
  // Compare against the real BotIcon / AssistIcon paths rendered here.
  const refs = await mounted(createElement("div", null,
    createElement(BotIcon),
    createElement(AssistIcon),
  ));
  const [botPath, assistPath] = [...refs.container.querySelectorAll("svg")].map((svg) => svg.querySelector("path")?.getAttribute("d") ?? "");
  assert.equal(rows.length, 2);
  assert.equal(glyphPath(lead), botPath, "an icon-less agent defaults to the robot");
  assert.notEqual(assistPath, botPath, "the sparkle is a different glyph");
  assert.equal(glyphPath(rows[1]!.querySelector(".agent-nav-glyph")!), assistPath, "an explicitly chosen glyph is kept");
  await refs.unmount();
  await view.unmount();
});

test("a right click on an agent opens its actions; a double click renames it in place", async () => {
  resetRegistry();
  const writes = fakeServer([digest()]);
  const { host, opened, sessions } = fakeHost();
  const view = await mounted(createElement(AgentNavSection, { host, context: { projectId: "pr-home" } }));
  await act(async () => { await delay(30); });
  const row = view.container.querySelector(".agent-nav-row")!;
  const openMenu = async () => {
    await act(async () => { row.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); await delay(10); });
  };
  await openMenu();
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const items = () => menuItems().map((item) => item.textContent);
  assert.deepEqual(items(), ["Run now", "Pause wakes", "Mark as read", "Rename", "Conversations1", "Settings", "Duplicate", "Delete agent"],
    "its sessions are one step away, though the session list leaves them out");
  await act(async () => { menuItems().find((item) => item.textContent === "Conversations1")!.click(); await delay(10); });
  const conversation = menuItems().find((item) => /Runs: 4/.test(item.textContent ?? ""));
  assert.ok(conversation, "every run of the rolling agent is one conversation");
  await act(async () => { conversation!.click(); await delay(10); });
  assert.deepEqual(sessions, ["ses-1"], "a conversation opens its session in Chat");
  await openMenu();
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Settings")!.click(); await delay(10); });
  assert.deepEqual(opened.at(-1), { pageId: "agents", resource: "agent-1", projectId: "pr-home" }, "Settings opens the agent's page");

  await act(async () => { row.querySelector<HTMLButtonElement>(".agent-nav-btn")!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }) as unknown as Event); await delay(10); });
  const input = view.container.querySelector<HTMLInputElement>(".agent-nav-rename")!;
  assert.equal(input.value, "Morning digest");
  await act(async () => { typeInto(input, "Night digest"); await delay(0); });
  await act(async () => { input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event); await delay(30); });
  const renamed = writes.find((write) => write.method === "PATCH")!;
  assert.deepEqual(renamed.body, { title: "Night digest" });
  await view.unmount();
});
