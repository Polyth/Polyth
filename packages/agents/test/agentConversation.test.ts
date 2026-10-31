// An agent's conversation: the sessions it talked in, where the person's next
// message goes, and the composer that sends it — mounted for real.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { ScheduleRunDto, ScheduleTaskDto } from "@polyth/session/web-api";
import type { SessionProjection } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { PendingMessage } from "../widgets/agentThreads.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  File: dom.File,
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
const { activateProject, applyProjectUpsert, beginProjectListRequest, getState, publishProjectList } = await import("../../../apps/web/src/store.ts");
const { default: AgentsPage } = await import("../widgets/AgentsPage.tsx");
const { default: AgentSessionChip } = await import("../widgets/AgentSessionChip.tsx");
const { conversationDays, agentConversations } = await import("../widgets/agentThreads.ts");
const { threadChoice } = await import("../widgets/AgentComposer.tsx");

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

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();
const run = (over: Partial<ScheduleRunDto> & { runId: string; ago: number }): ScheduleRunDto => {
  const { ago, ...rest } = over;
  return { startedAt: now - ago, finishedAt: now - ago + 2 * MIN, status: "ok", trigger: "schedule", ...rest };
};

/** A fresh agent: every wake gets its own session; the person's replies go on
 *  in the session they answer. */
function watcher(over: Partial<ScheduleTaskDto> = {}): ScheduleTaskDto {
  return {
    id: "agent-w", projectId: "pr-home", title: "Watcher", prompt: "Watch the services.", kind: "every", everyMinutes: 60,
    enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: null, runs: 3, target: { mode: "new-session-per-run" },
    seenAt: now, history: [], ...over,
  };
}

const kindsOf = (task: ScheduleTaskDto, pending: PendingMessage[] = []) =>
  conversationDays(task, task.seenAt, pending).flatMap((day) => day.threads.map((thread) => ({
    session: thread.sessionId ?? (thread.loose ? "loose" : "none"),
    opening: thread.opening?.kind ?? "-",
    items: thread.items.map((item) => item.kind === "report" ? item.run.runId
      : item.kind === "quiet" ? `quiet×${item.runs.length}`
        : item.kind === "you" ? `you${item.pending ? `(${item.pending})` : ""}` : item.kind),
  })));

test("lone wakes read as one stream; the person's reply turns a report into a conversation", () => {
  const task = watcher({
    history: [
      run({ runId: "r4", ago: 10 * MIN, trigger: "manual", input: "Why?", sessionId: "s-b", continued: true, signal: "update", headline: "Because" }),
      run({ runId: "r3", ago: 30 * MIN, sessionId: "s-b", signal: "alert", headline: "Disk 91%" }),
      run({ runId: "r2", ago: 50 * MIN, sessionId: "s-a2", signal: "quiet" }),
      run({ runId: "r1", ago: 70 * MIN, sessionId: "s-a1", signal: "quiet" }),
    ],
  });
  assert.deepEqual(kindsOf(task), [
    { session: "loose", opening: "-", items: ["quiet×2"] },
    { session: "s-b", opening: "start", items: ["r3", "you", "r4"] },
  ], "two quiet wakes in sessions of their own fold together; the answered alert opens a conversation");
});

test("a conversation another one interrupted comes back with a hollow cap, and one that goes on past midnight has none", () => {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(22, 0, 0, 0);
  const late = now - yesterday.getTime();
  const task = watcher({
    history: [
      run({ runId: "r5", ago: 5 * MIN, trigger: "manual", input: "And now?", sessionId: "s-b", continued: true }),
      run({ runId: "r4", ago: 20 * MIN, trigger: "manual", input: "Other topic", sessionId: "s-c", fresh: "asked", headline: "Sure" }),
      run({ runId: "r3", ago: late - 30 * MIN, trigger: "manual", input: "Go on", sessionId: "s-b", continued: true, headline: "Done" }),
      run({ runId: "r2", ago: late, sessionId: "s-b", headline: "Night report" }),
    ],
  });
  const days = conversationDays(task, task.seenAt);
  const shape = days.map((day) => day.threads.map((thread) => `${thread.sessionId}:${thread.opening?.kind ?? "-"}`));
  const today = shape.at(-1)!;
  assert.equal(shape.length, 2, "yesterday and today");
  assert.deepEqual(shape[0], ["s-b:start"]);
  // Just after midnight the two newest runs may straddle the day label.
  if (new Date(now - 25 * MIN).getDate() === new Date(now).getDate()) {
    assert.deepEqual(today, ["s-c:start", "s-b:resume"], "a new conversation the person asked for, then the first one again");
  }
  const asked = days.at(-1)!.threads.find((thread) => thread.sessionId === "s-c")!;
  assert.equal(asked.opening?.kind === "start" && asked.opening.run.fresh, "asked", "the head can say why it is new");
  const resumed = days.at(-1)!.threads.at(-1)!;
  assert.equal(resumed.opening?.kind === "resume" && resumed.opening.since, now - late, "since when it has gone on");

  const rolling = watcher({
    target: { mode: "dedicated-session" },
    history: [
      run({ runId: "b2", ago: 10 * MIN, sessionId: "s-r", trigger: "heartbeat", signal: "update", headline: "Morning" }),
      run({ runId: "b1", ago: late, sessionId: "s-r", headline: "Evening" }),
    ],
  });
  const rollingDays = conversationDays(rolling, rolling.seenAt);
  assert.equal(rollingDays.at(-1)!.threads[0]!.opening, undefined, "the rolling conversation just goes on past the day label");
});

test("messages on their way land where the next message goes: on in the conversation, or a new one", () => {
  const history = [
    run({ runId: "r2", ago: 10 * MIN, trigger: "manual", input: "Why?", sessionId: "s-b", continued: true, headline: "Because" }),
    run({ runId: "r1", ago: 30 * MIN, sessionId: "s-b", headline: "Disk 91%" }),
  ];
  const continuing = watcher({ history, followUp: { sessionId: "s-b", at: now - 8 * MIN, until: now + HOUR } });
  assert.deepEqual(kindsOf(continuing, [{ text: "And the logs?", at: now }]).at(-1),
    { session: "s-b", opening: "start", items: ["r1", "you", "r2", "you(sending)"] });
  const fresh = watcher({ history, followUp: { reason: "idle" } });
  assert.deepEqual(kindsOf(fresh, [{ text: "New topic", at: now }]).at(-1),
    { session: "none", opening: "upcoming", items: ["you(sending)"] });
  const queued = watcher({
    history: [{ runId: "r3", startedAt: now - MIN, status: "running", trigger: "manual", input: "Check", sessionId: "s-b", continued: true }, ...history],
    followUp: { sessionId: "s-b", at: now - MIN, until: now + HOUR },
    queued: [{ text: "Also the backups", at: now - 10_000, sessionId: "s-b" }],
  });
  assert.deepEqual(kindsOf(queued, [{ text: "Also the backups", at: now - 10_000 }]).at(-1)!.items.slice(-3), ["you", "live", "you(queued)"],
    "the server's queue holds it behind the run at work; the page's own copy is not shown twice");
  assert.equal(kindsOf(queued, [{ text: "backups", at: now }]).at(-1)!.items.at(-1), "you(sending)",
    "a message is not taken as queued because another one contains its words");
});

test("a message the server queued stays where the server fixed it, even if the agent would now go elsewhere", () => {
  const task = watcher({
    history: [
      { runId: "r2", startedAt: now - MIN, status: "running", trigger: "schedule", sessionId: "s-b" },
      run({ runId: "r1", ago: 3 * HOUR, trigger: "manual", input: "Why?", sessionId: "s-a", headline: "Because" }),
    ],
    // Since it queued, the agent's preview moved back to the older exchange.
    followUp: { sessionId: "s-a", at: now - 3 * HOUR, until: now + 5 * HOUR },
    queued: [{ text: "What does it show?", at: now - 20_000, sessionId: "s-b" }],
  });
  const last = kindsOf(task).at(-1)!;
  assert.equal(last.session, "s-b");
  assert.deepEqual(last.items.slice(-2), ["live", "you(queued)"]);
});

test("the person's words are matched whole or as one of the messages a run joined", async () => {
  const { carries } = await import("../widgets/agentThreads.ts");
  const at = now - 5_000;
  const ran = (input: string) => ({ runId: "x", startedAt: now, status: "running" as const, input });
  assert.equal(carries(ran("ok"), { text: "ok", at }), true);
  assert.equal(carries(ran("look at it"), { text: "ok", at }), false, "another message that contains the words");
  assert.equal(carries(ran("First\n\nok"), { text: "ok", at }), true, "joined after another");
  assert.equal(carries(ran("ok\n\nSecond"), { text: "ok", at }), true, "joined before another");
  assert.equal(carries(ran("A\n\nok\n\nB"), { text: "ok", at }), true, "joined between two");
  assert.equal(carries({ ...ran("ok"), startedAt: at - 2 * MIN }, { text: "ok", at }), false, "an older run with the same words");
});

test("a waiting message goes where the person chose: a new conversation, or on in one that went quiet", () => {
  const history = [
    { runId: "r3", startedAt: now - MIN, status: "running" as const, trigger: "manual" as const, input: "Check", sessionId: "s-b", continued: true },
    run({ runId: "r1", ago: 30 * MIN, sessionId: "s-b", headline: "Disk 91%" }),
  ];
  const asked = watcher({
    history,
    followUp: { sessionId: "s-b", at: now - MIN, until: now + HOUR },
    queued: [{ text: "Unrelated: the certificates", at: now - 10_000, continuation: "new" }],
  });
  assert.deepEqual(kindsOf(asked).at(-1), { session: "none", opening: "upcoming", items: ["you(queued)"] },
    "asked for a new conversation, it does not sit in the one at work");
  const onPage = watcher({ history, followUp: { sessionId: "s-b", at: now - MIN, until: now + HOUR } });
  assert.deepEqual(kindsOf(onPage, [{ text: "Fresh start", at: now, continuation: "new" }]).at(-1),
    { session: "none", opening: "upcoming", items: ["you(sending)"] }, "the page's own copy too");

  const quiet = watcher({
    history: [run({ runId: "r1", ago: 10 * HOUR, trigger: "manual", input: "Why?", sessionId: "s-b", headline: "Because" })],
    followUp: { sessionId: "s-b", at: now - 10 * HOUR, until: now - 2 * HOUR },
  });
  assert.equal(kindsOf(quiet, [{ text: "And now?", at: now }]).at(-1)!.opening, "upcoming", "after a break: a new one");
  const goneOn = kindsOf(quiet, [{ text: "And now?", at: now, continuation: "continue" }]).at(-1)!;
  assert.equal(goneOn.session, "s-b", "asked to go on, it goes on in the quiet one");
  assert.equal(goneOn.items.at(-1), "you(sending)");
});

test("where the message goes: the agent's judgement, the person's choice, and what cannot be continued", () => {
  const live = { followUp: { sessionId: "s-b", at: now - 40 * MIN, until: now + HOUR } };
  assert.deepEqual(threadChoice(live, "auto", now), { target: "continue", canContinue: true, at: now - 40 * MIN });
  assert.equal(threadChoice(live, "new", now).target, "new", "the person may always start over");
  const lapsed = { followUp: { sessionId: "s-b", at: now - 9 * HOUR, until: now - HOUR } };
  assert.deepEqual(threadChoice(lapsed, "auto", now), { target: "new", canContinue: true, at: now - 9 * HOUR, reason: "idle" },
    "after a break the agent starts a new one, but the last one may still be continued");
  assert.equal(threadChoice(lapsed, "continue", now).target, "continue");
  const changed = { followUp: { reason: "instructions-changed" as const } };
  assert.deepEqual(threadChoice(changed, "continue", now), { target: "new", canContinue: false, reason: "instructions-changed" },
    "a conversation under old instructions cannot be continued");
});

test("the agent's conversations are its sessions, newest first, with their runs", () => {
  const list = agentConversations(watcher({
    history: [
      { runId: "r3", startedAt: now - MIN, status: "running", sessionId: "s-b" },
      run({ runId: "r2", ago: 20 * MIN, sessionId: "s-b" }),
      run({ runId: "r1", ago: 3 * HOUR, sessionId: "s-a" }),
      { runId: "r0", startedAt: now - 4 * HOUR, finishedAt: now - 4 * HOUR, status: "skipped" },
    ],
  }));
  assert.deepEqual(list.map((item) => [item.sessionId, item.runs, item.live]), [["s-b", 2, true], ["s-a", 1, false]]);

  const named = agentConversations(watcher({
    history: [
      run({ runId: "r2", ago: 10 * MIN, trigger: "manual", input: "Why?\nShort, please", sessionId: "s-b", continued: true }),
      run({ runId: "r1", ago: 30 * MIN, sessionId: "s-b", headline: "Disk 91%" }),
      run({ runId: "r0", ago: HOUR, trigger: "manual", input: "\n  Check the backups  \nthen the logs", sessionId: "s-a" }),
      run({ runId: "q", ago: 2 * HOUR, sessionId: "s-q", signal: "quiet" }),
    ],
  }));
  assert.deepEqual(named.map((item) => item.topic), ["Disk 91%", "Check the backups", undefined],
    "a conversation is named by what it began with: the first headline or the person's first line");
});

test("a conversation's time names its day once", async () => {
  const { conversationWhen } = await import("../widgets/agentConversationsMenu.ts");
  const { getLocale } = await import("../../../apps/web/src/i18n/index.ts");
  const morning = new Date(now);
  morning.setDate(morning.getDate() - 3);
  morning.setHours(8, 20, 0, 0);
  const at = morning.getTime();
  const dateOf = (when: number) => new Date(when).toLocaleDateString(getLocale(), { day: "numeric", month: "short" });
  const count = (text: string, part: string) => text.split(part).length - 1;
  const range = conversationWhen({ startedAt: at, lastAt: at + 3 * HOUR }, now);
  assert.equal(count(range, dateOf(at)), 1, `one date in "${range}"`);
  assert.equal(conversationWhen({ startedAt: at, lastAt: at }, now).includes("–"), false, "a single run has no range");
  const nextDay = at + 24 * HOUR;
  const across = conversationWhen({ startedAt: at, lastAt: nextDay }, now);
  assert.ok(count(across, dateOf(at)) === 1 && count(across, dateOf(nextDay)) === 1, `a range across days names both: "${across}"`);
});

// ---- mounted ---------------------------------------------------------------------------

function resetRegistry(): void {
  publishProjectList(beginProjectListRequest(), []);
  activateProject(null);
  applyProjectUpsert({ id: "pr-home", name: "Home", path: "/tmp/pr-home", createdAt: 1 });
  activateProject("pr-home");
}

function fakeServer(tasks: ScheduleTaskDto[]) {
  const writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url === "/api/schedule" || url.startsWith("/api/schedule?")) return response({ tasks, loopErrors: [] });
    if (url === "/api/schedule/sources") return response([]);
    if (url.startsWith("/api/files/stat")) {
      const path = new URL(url, "http://x").searchParams.get("path") ?? "";
      return response({ path, kind: "file", size: 5, mime: "text/plain" });
    }
    writes.push({ url, method, body });
    if (url === "/api/files/upload") return response({ ok: true });
    const task = tasks.find((item) => url.includes(`/${item.id}/`)) ?? tasks[0]!;
    if (url.endsWith("/run") || url.endsWith("/stop") || url.endsWith("/seen")) return response(url.endsWith("/stop") ? { stopped: 1 } : task);
    return response({});
  }) as typeof fetch;
  return writes;
}

function fakeHost(projections: Record<string, Partial<SessionProjection>> = {}) {
  const opened: Array<{ pageId: string; resource: string | null }> = [];
  const host = {
    ui: { Slot: () => null },
    store: { subscribe: () => () => {}, getSnapshot: () => ({ activePage: null }) },
    navigation: {
      openPage: (pageId: string, resource?: string | null) => { opened.push({ pageId, resource: resource ?? null }); return true; },
      closePage: () => {},
    },
    conversation: { openSession: async () => {} },
    sessions: {
      get: (id: string) => projections[id] as SessionProjection | undefined,
      subscribe: () => () => {},
    },
  } as unknown as WebPackageHost;
  return { host, opened };
}

const answered = () => watcher({
  history: [
    run({ runId: "r2", ago: 30 * MIN, trigger: "manual", input: "Is the disk fine?", sessionId: "s-b", continued: true, headline: "It is" }),
    run({ runId: "r1", ago: HOUR, sessionId: "s-b", signal: "alert", headline: "Disk 91%" }),
  ],
  followUp: { sessionId: "s-b", at: now - 28 * MIN, until: now + 7 * HOUR },
});

test("the composer says the message goes on in the conversation, and sends a new one when asked", async () => {
  resetRegistry();
  localStorage.clear();
  const writes = fakeServer([answered()]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  const chip = () => view.container.querySelector<HTMLButtonElement>(".agent-thread-chip")!;
  assert.equal(chip().dataset.target, "continue");
  assert.match(chip().textContent ?? "", /Continues from \d\d:\d\d/);
  assert.ok(view.container.querySelector('.agent-thread[data-opening="start"] .agent-thread-head'), "the answered alert opens a conversation");

  await act(async () => { chip().click(); await delay(10); });
  const fresh = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => /Start a new conversation/.test(item.textContent ?? ""))!;
  await act(async () => { fresh.click(); await delay(10); });
  assert.equal(chip().dataset.target, "new");
  const box = view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  await act(async () => { typeInto(box, "Something else"); await delay(0); });
  await act(async () => { view.container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
  assert.deepEqual(writes.find((write) => write.url.endsWith("/run"))!.body, { input: "Something else", continuation: "new" });
  assert.equal(chip().dataset.target, "continue", "the next message is the agent's call again");
  await view.unmount();
});

test("files pasted into the box are uploaded to the inbox and sent with the words", async () => {
  resetRegistry();
  localStorage.clear();
  const writes = fakeServer([answered()]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  const box = view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  const file = new window.File(["hello"], "notes.txt", { type: "text/plain" }) as unknown as File;
  const paste = new window.Event("paste", { bubbles: true, cancelable: true }) as unknown as Event & { clipboardData: unknown };
  Object.defineProperty(paste, "clipboardData", { value: { files: [file], getData: () => "" } });
  await act(async () => { box.dispatchEvent(paste); await delay(40); });
  const upload = writes.find((write) => write.url === "/api/files/upload")!;
  assert.match(String(upload.body.path), /^_inbox\/.+-notes\.txt$/);
  assert.match(view.container.querySelector(".agent-composer-files")?.textContent ?? "", /notes\.txt/, "the file shows as a pill");
  await act(async () => { view.container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
  const sent = writes.find((write) => write.url.endsWith("/run"))!;
  const files = sent.body.attachments as Array<{ name: string; path: string; kind: string }>;
  assert.equal(sent.body.input, undefined, "a message may be files alone");
  assert.deepEqual(files.map((item) => [item.name, item.kind]), [["notes.txt", "file"]]);
  assert.equal(files[0]!.path, upload.body.path);
  await view.unmount();
});

test("a long paste goes as a text file, so the box never holds more than the agent keeps", async () => {
  resetRegistry();
  localStorage.clear();
  const writes = fakeServer([answered()]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  const box = view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  assert.equal(box.maxLength, 8_000);
  const log = Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n");
  const paste = new window.Event("paste", { bubbles: true, cancelable: true }) as unknown as Event & { clipboardData: unknown };
  Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: (kind: string) => kind === "text/plain" ? log : "" } });
  await act(async () => { box.dispatchEvent(paste); await delay(40); });
  assert.equal(paste.defaultPrevented, true);
  const upload = writes.find((write) => write.url === "/api/files/upload")!;
  assert.match(String(upload.body.path), /^_inbox\/.+-pasted-context\.txt$/);
  assert.equal(box.value, "", "the words went into the file, not the box");
  await view.unmount();
});

test("the box keeps its draft per agent, and ↑ in an empty box brings back the last message", async () => {
  resetRegistry();
  localStorage.clear();
  fakeServer([answered()]);
  const { host } = fakeHost();
  let view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  let box = view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  await act(async () => { box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }) as unknown as Event); await delay(0); });
  assert.equal(box.value, "Is the disk fine?");
  await act(async () => { typeInto(box, "Half a thought"); await delay(0); });
  await view.unmount();
  view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  box = view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  assert.equal(box.value, "Half a thought", "the unsent words wait for the person");
  await view.unmount();
});

test("nothing in the box crosses to another agent, and a message refused after the person moved on waits in its own agent's draft", async () => {
  resetRegistry();
  localStorage.clear();
  const first = answered();
  const second = watcher({ id: "agent-x", title: "Other", history: [] });
  let refuse!: () => void;
  const refused = new Promise<void>((resolve) => { refuse = resolve; });
  const plain = fakeServer([first, second]);
  const serve = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/schedule/agent-w/run") {
      await refused;
      return response({ error: "busy" }, 409);
    }
    return serve(input, init);
  }) as typeof fetch;
  const { host } = fakeHost();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(AgentsPage, { host, resource: "agent-w" })); await delay(30); });
  const box = () => container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  await act(async () => { typeInto(box(), "Hello A"); await delay(0); });
  await act(async () => { container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(10); });
  assert.equal(box().value, "", "the box empties while the server admits it");

  await act(async () => { root.render(createElement(AgentsPage, { host, resource: "agent-x" })); await delay(30); });
  assert.equal(box().value, "");
  const send = container.querySelector<HTMLButtonElement>(".agent-composer-send")!;
  assert.notEqual(send.getAttribute("aria-busy"), "true", "the other agent's send is not shown as in flight here");

  await act(async () => { refuse(); await delay(30); });
  const { readAgentDraft } = await import("../widgets/AgentComposer.tsx");
  assert.equal(readAgentDraft("agent-w"), "Hello A", "the refused words wait for the person on their agent");
  assert.equal(readAgentDraft("agent-x"), "");
  await act(async () => { root.render(createElement(AgentsPage, { host, resource: "agent-w" })); await delay(30); });
  assert.equal(box().value, "Hello A");
  await act(async () => { root.unmount(); });
  container.remove();
  void plain;
});

test("a wake script's note says what woke the agent; it never speaks as the person", async () => {
  resetRegistry();
  localStorage.clear();
  const task = watcher({
    history: [run({
      runId: "e1", ago: 10 * MIN, trigger: "event", note: "db-2 disk at 93%", events: ["Monitoring: memory-high"],
      sessionId: "s-e", signal: "alert", headline: "Disk almost full",
    })],
  });
  assert.ok(!kindsOf(task).some((thread) => thread.items.some((item) => item.startsWith("you"))), "no bubble of the person's");
  fakeServer([task]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  assert.equal(view.container.querySelectorAll(".agent-you").length, 0);
  assert.equal(view.container.querySelector(".agent-report-wake-note")?.textContent, "Wake script: db-2 disk at 93%");
  await view.unmount();
});

test("a message the waiting run cannot carry comes back to the box, with why in the person's words", async () => {
  resetRegistry();
  localStorage.clear();
  fakeServer([answered()]);
  const serve = globalThis.fetch;
  const refusals = [
    { error: "payload-too-large", message: "Your messages waiting for this agent would pass 8000 characters together." },
    { error: "conflict", message: "A one-off run of this loop's file version waits for the run in progress." },
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/schedule/agent-w/run") {
      const body = refusals.shift()!;
      return response(body, body.error === "conflict" ? 409 : 413);
    }
    return serve(input, init);
  }) as typeof fetch;
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  const box = () => view.container.querySelector<HTMLTextAreaElement>(".agent-composer textarea")!;
  await act(async () => { typeInto(box(), "And the backups?"); await delay(0); });
  await act(async () => { view.container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
  assert.equal(box().value, "And the backups?", "the refused words are back in the box");
  assert.equal(getState().uiError, "Too much already waits for the next run. Send this once it has started.");
  await act(async () => { view.container.querySelector<HTMLFormElement>(".agent-composer")!.requestSubmit(); await delay(30); });
  assert.equal(box().value, "And the backups?");
  assert.equal(getState().uiError, "A one-off run of this version waits for the current run. Send your message once it has started.");
  await view.unmount();
});

test("while the agent works, its step shows at the end of its conversation, a message waits for it, and Stop ends it", async () => {
  resetRegistry();
  localStorage.clear();
  const task = answered();
  task.history = [{
    runId: "r3", startedAt: now - 70_000, status: "running", trigger: "manual", input: "Check the logs", sessionId: "s-b", continued: true,
    activity: { kind: "tool", tool: "Bash", input: { command: "journalctl -u polyth --since today" }, at: now - 2_000 }, steps: 4,
  }, ...task.history!];
  const writes = fakeServer([task]);
  const { host } = fakeHost();
  const view = await mounted(createElement(AgentsPage, { host, resource: "agent-w" }));
  await act(async () => { await delay(30); });
  const liveTurn = view.container.querySelector('.agent-thread[data-live] .agent-live')!;
  assert.ok(liveTurn, "the run at work closes its conversation");
  assert.ok(liveTurn.querySelector('.agent-mark[data-working]'), "its glyph has the travelling arc");
  assert.match(liveTurn.textContent ?? "", /Steps: 4/);
  assert.match(liveTurn.querySelector(".agent-live-line")?.textContent ?? "", /journalctl|Shell/, "the step reads as the chat's live line");
  assert.equal(view.container.querySelector(".agent-composer-send")!.getAttribute("aria-label"), "Send when the current run ends");
  await act(async () => { view.container.querySelector<HTMLButtonElement>(".agent-composer-stop")!.click(); await delay(30); });
  assert.ok(writes.some((write) => write.url.endsWith("/stop")), "Stop in the composer stops the run");
  await view.unmount();
});

test("an agent's session opened in Chat names its agent in the header; an ordinary chat shows nothing", async () => {
  resetRegistry();
  fakeServer([answered()]);
  const { host, opened } = fakeHost({ "s-b": { id: "s-b", purpose: "agent" }, "chat-1": { id: "chat-1" } });
  const agentSession = await mounted(createElement(AgentSessionChip, { host, sessionId: "s-b" }));
  await act(async () => { await delay(30); });
  const chip = agentSession.container.querySelector<HTMLButtonElement>(".agent-chip")!;
  assert.match(chip.textContent ?? "", /Watcher/);
  await act(async () => { chip.click(); await delay(10); });
  assert.deepEqual(opened.at(-1), { pageId: "agents", resource: "agent-w" }, "the way back to the agent");
  await agentSession.unmount();
  const ordinary = await mounted(createElement(AgentSessionChip, { host, sessionId: "chat-1" }));
  await act(async () => { await delay(30); });
  assert.equal(ordinary.container.innerHTML, "");
  await ordinary.unmount();
});
