import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement, Fragment, type ReactNode } from "react";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const GiB = 1024 ** 3;
const local = { projectId: "p1", name: "Polyth", kind: "local", machineId: "local", supported: true, fileTailsAvailable: true, hostLogsAvailable: true, canEditPolicy: true, processesAvailable: true };
const other = { ...local, projectId: "p3", name: "Site" };
const ssh = { ...local, projectId: "p2", name: "hunter", kind: "ssh", machineId: "ssh-1" };
const policy = (metrics = true) => ({ revision: 1, agentAccess: { metrics, services: true, logs: true, processes: false }, serviceUnits: [], logPaths: ["journal"], memoryWarningPercent: 85, loadWarningRatio: 1, diskWarningPercent: 90 });
const metrics = { hostname: "watcher", platform: "linux", cpuCount: 4, load: [6.11, 7.82, 7.24], memoryTotal: 23.4 * GiB, memoryAvailable: 13.7 * GiB, uptimeSeconds: 9 * 86400,
  disks: [{ mount: "/", size: 45 * GiB, used: 41 * GiB, available: 4.3 * GiB }], pressure: { cpu: 59.33, io: 0.99, memory: 0.04 } };
const snapshot = (warnings: string[]) => ({ host: local, sampledAt: Date.now(), warnings, services: [], servicesAvailable: true, metrics });

interface Answers { policy?: unknown; snapshot?: unknown; incident?: unknown; hosts?: unknown[]; asks?: string[]; logs?: string }

// The view's transport keeps the fetch it finds when it loads, so one stub
// answers from whichever test is running.
let current: Answers = {};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const answers = current;
  const url = new URL(String(input), "http://monitoring.test");
  const path = url.pathname;
  if (path.endsWith("/ask")) { answers.asks?.push(String(init?.method)); return Response.json({ sessionId: "chat-1", openedAt: 1 }); }
  if (path.endsWith("/snapshot") && answers.snapshot === "fail") return Response.json({ error: "unavailable", message: "Host probe failed" }, { status: 503 });
  const body = path.endsWith("/hosts") ? { items: answers.hosts ?? [local] }
    : path.endsWith("/policy") ? answers.policy ?? policy()
      : path.endsWith("/snapshot") ? answers.snapshot ?? snapshot([])
        : path.endsWith("/incident") ? { incident: answers.incident ?? null }
          : path.endsWith("/history") ? { range: "1h", stepMs: 60_000, points: [] }
            : path.endsWith("/processes") ? { sampledAt: 1, groups: [{ name: "Node", count: 3, cpus: 1.5, memory: GiB }] }
              : path.endsWith("/logs") ? { source: "journal", sampledAt: 1, content: answers.logs ?? "", truncated: false }
                : { items: [] };
  return Response.json(body);
}) as typeof fetch;

async function mount(t: test.TestContext, answers: Answers, locale = "en") {
  const window = new Window({ url: "http://monitoring.test" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  keys.forEach((key) => Object.defineProperty(globalThis, key, { value: key === "window" ? window : (window as never)[key], configurable: true }));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });
  current = answers;
  const opened: string[] = []; const settings: string[] = [];
  const Button = ({ children, onClick, variant, disabled, busy, iconStart: _icon, ...rest }: Record<string, unknown>) => createElement("button", { ...rest, "data-variant": variant ?? "quiet", disabled: disabled || busy, onClick }, children as ReactNode);
  const Tabs = ({ tabs, value, onChange, idBase }: { tabs: Array<{ id: string; label: string }>; value: string; onChange: (id: string) => void; idBase?: string }) =>
    createElement("div", { role: "tablist" }, tabs.map((tab) => createElement("button", { key: tab.id, role: "tab", id: idBase ? `${idBase}-tab-${tab.id}` : undefined, "aria-selected": tab.id === value, onClick: () => onChange(tab.id) }, tab.label)));
  const Menu = ({ entries, children }: { entries: Array<{ id: string; label: string; onSelect: () => void }>; children: (trigger: object) => ReactNode }) =>
    createElement(Fragment, null, children({ "data-menu": "" }), createElement("ul", null, entries.map((entry) => createElement("li", { key: entry.id }, createElement("button", { "data-entry": entry.id, onClick: entry.onSelect }, entry.label)))));
  const Select = () => createElement("select");
  const EmptyState = ({ title }: { title: string }) => createElement("p", null, title);
  const storeSnapshot = { activeProjectId: (answers.hosts?.[0] as { projectId?: string } | undefined)?.projectId ?? "p1" };
  const host = {
    store: { subscribe: () => () => {}, getSnapshot: () => storeSnapshot },
    ui: { locale: { get: () => locale }, icons: { chevronDown: () => null, chevronRight: () => null }, components: { Button, Tabs, Menu, Select, EmptyState, Textarea: () => null } },
    errors: { friendly: (action: string) => action },
    conversation: { openSession: async (id: string) => { opened.push(id); } },
    navigation: { openSettingsPage: (page: string) => { settings.push(page); } },
  };
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { MonitoringView } = await import("../widgets/MonitoringView.tsx");
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setImmediate(done)); }); };
  await act(async () => { root.render(createElement(MonitoringView as never, { host, active: true } as never)); });
  await settle();
  t.after(async () => {
    await act(async () => { root.unmount(); });
    await window.happyDOM.close();
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!); else Reflect.deleteProperty(globalThis, key); });
  });
  const buttons = () => [...container.querySelectorAll("button")];
  const click = async (name: string) => { const target = buttons().find((item) => item.textContent === name); assert.ok(target, `no button named ${name}`); await act(async () => { (target as unknown as HTMLElement).click(); }); await settle(); };
  return { text: () => container.textContent ?? "", container, buttons, click, settle, opened, settings };
}

test("a warning leads with what is wrong, in numbers, with one primary action", async (t) => {
  const asks: string[] = [];
  const view = await mount(t, { snapshot: snapshot(["load", "disk"]), asks });
  assert.match(view.text(), /2 things need a look/);
  assert.match(view.text(), /Disk is 91% full, 4\.3 GiB left\./);
  assert.match(view.text(), /Load is over its limit\. It is easing\./);
  assert.match(view.text(), /1\.96×/);
  const primary = view.buttons().filter((item) => item.getAttribute("data-variant") === "primary");
  assert.deepEqual(primary.map((item) => item.textContent), ["Ask an agent to look"], "accent goes to the action, not to a tab");
  await view.click("Ask an agent to look");
  assert.deepEqual(asks, ["POST"]);
  assert.deepEqual(view.opened, ["chat-1"]);
});

test("the numbers are live by default: no checkbox, Refresh or Rules tab to find", async (t) => {
  const view = await mount(t, { snapshot: snapshot([]) });
  assert.match(view.text(), /All good/);
  assert.match(view.text(), /Live/);
  assert.equal(view.container.querySelector("input[type=checkbox]"), null);
  assert.equal(view.buttons().some((item) => item.textContent === "Refresh"), false);
  assert.deepEqual([...view.container.querySelectorAll("[role=tablist]")][0]!.textContent, "OverviewLogs");
  assert.equal(view.buttons().some((item) => item.getAttribute("data-variant") === "primary"), false, "nothing to do, nothing loud");
  await view.click("What agents can readMetrics, Services, Logs");
  assert.deepEqual(view.settings, ["monitoring"]);
});

test("an open incident chat is offered instead of starting another", async (t) => {
  const view = await mount(t, { snapshot: snapshot(["load"]), incident: { sessionId: "chat-9", openedAt: Date.now() } });
  assert.match(view.text(), /An agent has been on this since/);
  assert.equal(view.buttons().some((item) => item.textContent === "Ask an agent to look"), false);
  await view.click("Open the agent's chat");
  assert.deepEqual(view.opened, ["chat-9"]);
});

test("without agent access an administrator is pointed at the permission", async (t) => {
  const view = await mount(t, { snapshot: snapshot(["load"]), policy: policy(false) });
  assert.equal(view.buttons().some((item) => item.textContent === "Ask an agent to look"), false);
  await view.click("Let agents read this host");
  assert.deepEqual(view.settings, ["monitoring"]);
});

test("an unreachable host says so instead of showing nothing", async (t) => {
  const view = await mount(t, { snapshot: "fail" });
  assert.match(view.text(), /Can't reach Polyth/);
  assert.match(view.text(), /Host probe failed/);
  assert.match(view.text(), /Try again/);
  assert.match(view.text(), /Offline/);
});

test("the picker lists machines, and logs can show just the problems", async (t) => {
  const view = await mount(t, { hosts: [local, other, ssh], snapshot: snapshot([]), logs: "2026-11-04T21:00:07+0000 watcher kernel: oom-kill: task=chrome\n2026-11-04T21:00:08+0000 watcher cron[1]: finished\n" });
  assert.deepEqual([...view.container.querySelectorAll("[data-entry]")].map((item) => item.getAttribute("data-entry")), ["local", "ssh-1"], "two machines, not three projects");
  await view.click("Logs");
  assert.match(view.text(), /kernel: oom-kill/);
  assert.match(view.text(), /cron\[1\]: finished/);
  await view.click("Problems · 1");
  assert.match(view.text(), /kernel: oom-kill/);
  assert.doesNotMatch(view.text(), /cron\[1\]/);
  assert.doesNotMatch(view.text(), /2026-11-04T/, "the timestamp moved to its own column");
});

test("Ukrainian reads from the inline text, including the new phrases", async (t) => {
  const view = await mount(t, { snapshot: snapshot(["disk"]) }, "uk");
  assert.match(view.text(), /Диск майже заповнений/);
  assert.match(view.text(), /Огляд/);
});
