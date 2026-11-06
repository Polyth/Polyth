import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EVENT_SOURCES, SESSION_ATTENTION_SERVICE, type AgentEventPublication } from "@polyth/plugins";
import type { SessionOrigin } from "@polyth/contracts";
import {
  ALERT_CLEAR_MS, askPrompt, createMonitoringAlerts, decideDispatch, INCIDENT_CHAT_LIMIT, MONITORING_ORIGIN, newAlerts,
} from "../src/alerts.ts";
import { INCIDENT_QUIET_MS } from "../src/incidents.ts";
import type { MonitoringPolicy, MonitoringSnapshot } from "../src/contracts.ts";

const snapshot = (warnings: MonitoringSnapshot["warnings"], over: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot => ({
  host: { projectId: "p", name: "db-1", kind: "ssh", supported: true, fileTailsAvailable: false, hostLogsAvailable: true, canEditPolicy: false, machineId: "ssh-1", processesAvailable: true },
  sampledAt: 0,
  metrics: { hostname: "db-1", platform: "linux", cpuCount: 4, load: [9.5, 6, 4], memoryTotal: 100, memoryAvailable: 7, uptimeSeconds: 1 },
  services: [{ unit: "postgres.service", state: "failed" }, { unit: "nginx.service", state: "active" }],
  servicesAvailable: true,
  warnings,
  ...over,
});

test("only warnings that newly appear become alerts", () => {
  assert.deepEqual(newAlerts(["memory"], snapshot(["memory", "load", "service"])).map((alert) => [alert.type, alert.title, alert.text]), [
    ["load-high", "Load is high on db-1", "5-minute load 6.00 on 4 CPUs."],
    ["service-down", "Service down on db-1", "postgres.service (failed)"],
  ]);
  assert.deepEqual(newAlerts(["memory", "load"], snapshot(["load"])), []);
});

test("a full disk alerts with its mount and what is left", () => {
  const metrics = { ...snapshot([]).metrics, disks: [{ mount: "/data", size: 100 * 1024 ** 3, used: 91 * 1024 ** 3, available: 9 * 1024 ** 3 }] };
  assert.deepEqual(newAlerts([], snapshot(["disk"], { metrics })).map((alert) => [alert.type, alert.title, alert.text]), [
    ["disk-high", "Disk is almost full on db-1", "/data is 91% full, 9.0 GiB left."],
  ]);
  assert.deepEqual(decideDispatch({ alert: { type: "disk-high" }, access: { metrics: false, services: true, logs: true, processes: true }, subscribed: false, claimedElsewhere: false }),
    { action: "none", reason: "denied" }, "disk readings are metrics");
});

test("a warning seen again inside its clearing window is not a new alert", () => {
  const now = 30 * 60_000;
  assert.deepEqual(newAlerts([], snapshot(["load"]), { load: now - ALERT_CLEAR_MS + 1 }, now), []);
  assert.deepEqual(newAlerts([], snapshot(["load"]), { load: now - ALERT_CLEAR_MS }, now).map((alert) => alert.type), ["load-high"]);
  assert.deepEqual(newAlerts([], snapshot(["load"]), {}, now).map((alert) => alert.type), ["load-high"]);
});

test("the source samples only subscribed projects, treats the first sample as a baseline and respects agent access", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "monitoring-alerts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const published: AgentEventPublication[] = [];
  let subscribed = [{ spaceId: "s", projectId: "p" }];
  let warnings: MonitoringSnapshot["warnings"] = ["memory"];
  let access = { metrics: true, services: false, logs: false, processes: false };
  let samples = 0;
  const registered: string[] = [];
  const sources = {
    register: (source: { id: string }) => { registered.push(source.id); return { dispose() {} }; },
    publish: (event: AgentEventPublication) => published.push(event),
    subscribed: () => subscribed,
  };
  const host = {
    systemSpaceContext: (spaceId: string) => ({ spaceId }),
    spaceStorage: (space: { spaceId: string }) => ({ root: join(dir, space.spaceId), packageDir: (id: string) => join(dir, space.spaceId, "packages", id), path: (relative: string) => join(dir, space.spaceId, relative) }),
    services: { get: (key: { id: string }) => key.id === AGENT_EVENT_SOURCES.id ? sources : undefined },
    projects: { list: async () => [] },
  };
  const service = {
    policy: async () => ({ agentAccess: access }) as unknown as MonitoringPolicy,
    snapshot: async () => { samples += 1; return snapshot(warnings); },
  };
  const alerts = createMonitoringAlerts(host as never, service as never, 60_000);
  alerts.start();
  {
    await alerts.tick();
    assert.deepEqual(registered, ["monitoring"]);
    assert.equal(published.length, 0, "a warning already present at the first sample is not news");
    warnings = ["memory", "load", "service"];
    await alerts.tick();
    assert.deepEqual(published.map((event) => [event.type, event.spaceId, event.projectId]), [["load-high", "s", "p"]],
      "service-down needs the services grant");
    access = { metrics: false, services: false, logs: false, processes: false };
    warnings = [];
    await alerts.tick();
    warnings = ["memory"];
    await alerts.tick();
    assert.equal(published.length, 1, "without any agent grant nothing is sampled or published");
    const before = samples;
    subscribed = [];
    await alerts.tick();
    assert.equal(samples, before, "no listeners, no sampling");
  }
  alerts.stop();
});

test("the dispatch decision: denial, agent ping, duplicate, handled incident, notification only, new chat", () => {
  const all = { metrics: true, services: true, logs: false, processes: false };
  const base = { access: all, subscribed: false, claimedElsewhere: false };
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "memory-high" }, access: { ...all, metrics: false } }), { action: "none", reason: "denied" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "service-down" }, access: { ...all, services: false }, subscribed: true }), { action: "none", reason: "denied" },
    "a subscriber does not lift the policy");
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, subscribed: true, claimedElsewhere: true }), { action: "ping" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, claimedElsewhere: true, incident: { sessionId: "x", open: true } }), { action: "none", reason: "duplicate" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, incident: { sessionId: "x", open: true } }), { action: "notify", sessionId: "x" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, incident: { sessionId: "x", open: false } }), { action: "none", reason: "handled" },
    "a closed incident chat is not reopened by a flapping warning");
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "service-down" } }), { action: "session" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, openIncidents: 2, incidentLimit: 2 }), { action: "none", reason: "limit" },
    "a full fleet of incident chats stops new ones");
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, openIncidents: 1, incidentLimit: 2 }), { action: "session" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, openIncidents: INCIDENT_CHAT_LIMIT }), { action: "none", reason: "limit" },
    "the package-wide default caps at INCIDENT_CHAT_LIMIT");
});

interface HarnessOptions {
  subscribed?: Array<{ spaceId: string; projectId: string }>;
  projects: Array<{ id: string; spaceId: string; hostname: string }>;
  limit?: number;
  /** Shared across two instances to model a restart. */
  dir?: string;
  sessions?: Map<string, { status: string }>;
}

function harness(opts: HarnessOptions) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "monitoring-alerts-"));
  const clock = { time: 1_000_000 };
  const published: AgentEventPublication[] = [];
  const created: Array<{ spaceId: string; projectId: string; purpose?: string; title?: string; origin?: SessionOrigin }> = [];
  const sent: Array<{ id: string; text: string }> = [];
  const notified: Array<{ sessionId: string; statusText: string; key: string }> = [];
  const warnings = new Map<string, MonitoringSnapshot["warnings"]>();
  const access = new Map<string, MonitoringPolicy["agentAccess"]>();
  const sessions = opts.sessions ?? new Map<string, { status: string }>();
  const sources = {
    register: () => ({ dispose() {} }),
    publish: (event: AgentEventPublication) => published.push(event),
    subscribed: () => opts.subscribed ?? [],
  };
  const attention = { waitingForPerson() {}, notify: (sessionId: string, input: { statusText: string; key: string }) => notified.push({ sessionId, ...input }) };
  const host = {
    systemSpaceContext: (spaceId: string) => ({ spaceId }),
    spaceStorage: (space: { spaceId: string }) => ({
      root: join(dir, space.spaceId),
      packageDir: (id: string) => { const path = join(dir, space.spaceId, "packages", id); mkdirSync(path, { recursive: true }); return path; },
      path: (relative: string) => join(dir, space.spaceId, relative),
    }),
    services: { get: (key: { id: string }) => key.id === AGENT_EVENT_SOURCES.id ? sources : key.id === SESSION_ATTENTION_SERVICE.id ? attention : undefined },
    projects: { list: async () => opts.projects.map(({ id, spaceId }) => ({ id, spaceId })) },
    forSpace: (space: { spaceId: string }) => ({ sessions: {
      create: async (input: { projectId: string; purpose?: string; title?: string; origin?: SessionOrigin }) => {
        created.push({ spaceId: space.spaceId, ...input });
        const id = `chat-${created.length}`;
        sessions.set(id, { status: "idle" });
        return { id };
      },
      snapshot: async (id: string) => {
        const session = sessions.get(id);
        if (!session) throw Object.assign(new Error("session not found"), { code: "not-found" });
        return { id, status: session.status };
      },
      send: async (id: string, input: { text: string }) => { sent.push({ id, text: input.text }); return {}; },
    } }),
  };
  const service = {
    policy: async (_space: unknown, projectId: string) => ({ agentAccess: access.get(projectId) ?? { metrics: true, services: true, logs: false } }) as MonitoringPolicy,
    snapshot: async (_space: unknown, projectId: string) => {
      const project = opts.projects.find((item) => item.id === projectId)!;
      return snapshot(warnings.get(projectId) ?? [], { metrics: { ...snapshot([]).metrics, hostname: project.hostname } });
    },
  };
  const alerts = createMonitoringAlerts(host as never, service as never, 60_000, opts.limit, () => clock.time);
  return {
    alerts, published, created, sent, notified, warnings, access, dir, sessions, clock,
    advance: (ms: number) => { clock.time += ms; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a flapping warning is one episode on both the agent and the chat path", async (t) => {
  const ping = harness({ subscribed: [{ spaceId: "s", projectId: "p" }], projects: [{ id: "p", spaceId: "s", hostname: "db-1" }] });
  t.after(ping.cleanup);
  await ping.alerts.tick();
  ping.warnings.set("p", ["load"]);
  await ping.alerts.tick();
  assert.equal(ping.published.length, 1);
  ping.warnings.set("p", []);
  await ping.alerts.tick();
  ping.advance(5 * 60_000);
  ping.warnings.set("p", ["load"]);
  await ping.alerts.tick();
  assert.equal(ping.published.length, 1, "gone for five minutes: still the same episode");
  ping.warnings.set("p", []);
  await ping.alerts.tick();
  ping.advance(ALERT_CLEAR_MS + 60_000);
  ping.warnings.set("p", ["load"]);
  await ping.alerts.tick();
  assert.equal(ping.published.length, 2, "cleared for longer than ALERT_CLEAR_MS: a new episode");

  const chat = harness({ projects: [{ id: "p", spaceId: "s", hostname: "db-1" }] });
  t.after(chat.cleanup);
  await chat.alerts.tick();
  chat.warnings.set("p", ["memory"]);
  await chat.alerts.tick();
  chat.warnings.set("p", []);
  await chat.alerts.tick();
  chat.advance(5 * 60_000);
  chat.warnings.set("p", ["memory"]);
  await chat.alerts.tick();
  assert.equal(chat.created.length, 1);
  assert.equal(chat.notified.length, 1);
});

test("an unwatched project opens one sysadmin chat per incident and notifies once per warning episode", async (t) => {
  const h = harness({ projects: [{ id: "p", spaceId: "s", hostname: "db-1" }] });
  t.after(h.cleanup);
  await h.alerts.tick();
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.deepEqual(h.created, [{ spaceId: "s", projectId: "p", purpose: "sysadmin", title: "Service down on db-1", origin: MONITORING_ORIGIN }],
    "the incident chat is marked as Monitoring automation");
  assert.match(h.sent[0]!.text, /postgres\.service \(failed\)/);
  assert.deepEqual(h.notified, [{ sessionId: "chat-1", kind: "failed", statusText: "Service down on db-1", key: "monitoring:p:service-down" }]);
  await h.alerts.tick();
  await h.alerts.tick();
  assert.equal(h.notified.length, 1, "no repeat while the warning persists");
  h.warnings.set("p", ["service", "memory"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 1, "a second warning during the incident does not open another chat");
  assert.deepEqual(h.notified.map((item) => [item.sessionId, item.key]).at(-1), ["chat-1", "monitoring:p:memory-high"]);
  h.warnings.set("p", []);
  await h.alerts.tick();
  h.advance(INCIDENT_QUIET_MS + 60_000);
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 2, "after the quiet window a new incident may open a chat");
  assert.equal(h.notified.length, 3);
  assert.equal(h.published.length, 0);
});

test("a recurrence inside the incident window notifies the same chat without a new message", async (t) => {
  const h = harness({ projects: [{ id: "p", spaceId: "s", hostname: "db-1" }] });
  t.after(h.cleanup);
  await h.alerts.tick();
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 1);
  h.warnings.set("p", []);
  await h.alerts.tick();
  h.advance(30 * 60_000);
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 1, "the same incident, not a new chat");
  assert.equal(h.sent.length, 1, "no new message or turn on the incident chat");
  assert.deepEqual(h.notified.map((item) => item.sessionId), ["chat-1", "chat-1"]);
});

test("an archived or deleted incident chat is not reopened by a flapping warning", async (t) => {
  const h = harness({ projects: [{ id: "p", spaceId: "s", hostname: "db-1" }] });
  t.after(h.cleanup);
  await h.alerts.tick();
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  h.sessions.get("chat-1")!.status = "archived";
  h.warnings.set("p", []);
  await h.alerts.tick();
  h.advance(30 * 60_000);
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 1, "the person closed the chat; it stays closed");
  assert.equal(h.notified.length, 1);

  h.sessions.delete("chat-1");
  h.warnings.set("p", []);
  await h.alerts.tick();
  h.advance(30 * 60_000);
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 1, "a gone chat is closed, not a reason to open another");
  assert.equal(h.notified.length, 1);
});

test("a restart reuses the persisted incident chat instead of opening a duplicate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "monitoring-alerts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = new Map<string, { status: string }>();
  const projects = [{ id: "p", spaceId: "s", hostname: "db-1" }];
  const first = harness({ projects, dir, sessions });
  await first.alerts.tick();
  first.warnings.set("p", ["service"]);
  await first.alerts.tick();
  assert.equal(first.created.length, 1);
  assert.equal(first.sent.length, 1);
  const stored = JSON.parse(readFileSync(join(dir, "s", "packages/monitoring/incidents.json"), "utf8"));
  assert.deepEqual(stored, { v: 1, projects: { p: { sessionId: "chat-1", openedAt: first.clock.time, lastWarningAt: first.clock.time } } },
    "only ids and timestamps are persisted");
  first.alerts.stop();

  const second = harness({ projects, dir, sessions });
  second.warnings.set("p", ["service"]);
  await second.alerts.tick();
  assert.equal(second.created.length, 0, "the first sample after start is a baseline");
  second.warnings.set("p", []);
  await second.alerts.tick();
  second.advance(30 * 60_000);
  second.warnings.set("p", ["service"]);
  await second.alerts.tick();
  assert.equal(second.created.length, 0, "the persisted chat is still the project's incident");
  assert.equal(second.sent.length, 0);
  assert.deepEqual(second.notified.map((item) => item.sessionId), ["chat-1"]);
  second.alerts.stop();
});

test("a corrupt incidents file is empty state and never breaks a tick", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "monitoring-alerts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "s", "packages/monitoring/incidents.json");
  mkdirSync(join(dir, "s", "packages/monitoring"), { recursive: true });
  writeFileSync(file, "{not json");
  const h = harness({ projects: [{ id: "p", spaceId: "s", hostname: "db-1" }], dir });
  await h.alerts.tick();
  h.warnings.set("p", ["memory"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 1, "a damaged file does not block the incident chat");
  assert.equal(h.notified.length, 1);
});

test("a subscribed agent is pinged instead of opening a chat, and claims the host for its Space", async (t) => {
  const h = harness({ subscribed: [{ spaceId: "s", projectId: "a" }], projects: [{ id: "b", spaceId: "s", hostname: "db-1" }, { id: "a", spaceId: "s", hostname: "db-1" }] });
  t.after(h.cleanup);
  await h.alerts.tick();
  h.warnings.set("a", ["load"]);
  h.warnings.set("b", ["load"]);
  await h.alerts.tick();
  assert.deepEqual(h.published.map((event) => [event.type, event.projectId]), [["load-high", "a"]]);
  assert.equal(h.created.length, 0, "the sibling project on the same host stays quiet");
  assert.equal(h.notified.length, 0, "the agent's own notify policy tells the person");
});

test("projects sharing a host in one Space open one chat; another Space is told separately", async (t) => {
  const h = harness({ projects: [{ id: "p1", spaceId: "s", hostname: "web" }, { id: "p2", spaceId: "s", hostname: "web" }, { id: "q", spaceId: "t", hostname: "web" }] });
  t.after(h.cleanup);
  await h.alerts.tick();
  for (const id of ["p1", "p2", "q"]) h.warnings.set(id, ["memory"]);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => [item.spaceId, item.projectId]), [["s", "p1"], ["t", "q"]]);
  assert.equal(h.notified.length, 2);
});

test("the global incident-chat limit counts only chats inside their quiet window", async (t) => {
  const h = harness({ limit: 2, projects: [
    { id: "p1", spaceId: "s", hostname: "a" },
    { id: "p2", spaceId: "t", hostname: "b" },
    { id: "p3", spaceId: "s", hostname: "c" },
  ] });
  t.after(h.cleanup);
  await h.alerts.tick();
  for (const id of ["p1", "p2", "p3"]) h.warnings.set(id, ["memory"]);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => item.projectId), ["p1", "p2"], "only the first episodes open chats");
  assert.deepEqual(h.notified.map((item) => item.sessionId), ["chat-1", "chat-2"]);
  assert.equal(h.sent.length, 2, "the warning past the cap gets no chat and no message");
  assert.equal(h.published.length, 0);

  // Clearing a warning keeps the incident chat; only the quiet window frees its slot.
  h.warnings.set("p1", []);
  h.warnings.set("p2", []);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => item.projectId), ["p1", "p2"], "a cleared warning is not new capacity yet");
  h.advance(INCIDENT_QUIET_MS + 60_000);
  await h.alerts.tick();
  h.warnings.set("p3", []);
  await h.alerts.tick();
  h.advance(ALERT_CLEAR_MS + 60_000);
  h.warnings.set("p3", ["memory"]);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => item.projectId), ["p1", "p2", "p3"], "an expired incident frees its slot for the next one");
  assert.equal(h.notified.length, 3);
});

test("a warning the policy does not grant spawns no work and tells nobody", async (t) => {
  const h = harness({ subscribed: [{ spaceId: "s", projectId: "p" }], projects: [{ id: "p", spaceId: "s", hostname: "db-1" }, { id: "o", spaceId: "s", hostname: "other" }] });
  t.after(h.cleanup);
  h.access.set("p", { metrics: true, services: false, logs: false, processes: false });
  h.access.set("o", { metrics: false, services: true, logs: false, processes: false });
  await h.alerts.tick();
  h.warnings.set("p", ["service"]);
  h.warnings.set("o", ["memory", "load"]);
  await h.alerts.tick();
  assert.deepEqual([h.published.length, h.created.length, h.sent.length, h.notified.length], [0, 0, 0, 0]);
});

test("asking for a look opens one chat as the person, reuses it, and needs agent access", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "monitoring-ask-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const created: unknown[] = []; const sent: string[] = []; const spaces: unknown[] = [];
  let access = { metrics: false, services: false, logs: false, processes: false };
  let archived = false;
  const space = { spaceId: "s", userId: "person" } as never;
  const host = {
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: "system" }),
    spaceStorage: (item: { spaceId: string }) => ({ root: join(dir, item.spaceId), packageDir: (id: string) => { mkdirSync(join(dir, item.spaceId, "packages", id), { recursive: true }); return join(dir, item.spaceId, "packages", id); }, path: (relative: string) => join(dir, item.spaceId, relative) }),
    services: { get: () => undefined },
    projects: { list: async () => [] },
    forSpace: (item: unknown) => { spaces.push(item); return { sessions: {
      create: async (input: unknown) => { created.push(input); return { id: `chat-${created.length}` }; },
      send: async (_id: string, message: { text: string }) => { sent.push(message.text); },
      snapshot: async () => ({ status: archived ? "archived" : "idle" }),
    } }; },
  };
  const service = { policy: async () => ({ agentAccess: access }) as unknown as MonitoringPolicy, snapshot: async () => snapshot(["load"]) };
  const alerts = createMonitoringAlerts(host as never, service as never);
  await assert.rejects(alerts.ask(space, "p"), { code: "forbidden" }, "an agent that cannot read the host would only fail");
  assert.equal(created.length, 0);
  access = { ...access, metrics: true };
  assert.equal(await alerts.incident(space, "p"), null);
  const first = await alerts.ask(space, "p");
  assert.equal(first.sessionId, "chat-1");
  assert.deepEqual(created, [{ projectId: "p", purpose: "sysadmin", title: "Check db-1" }], "a person's chat, not automation");
  assert.equal((spaces.at(-1) as { userId: string }).userId, "person");
  assert.match(sent[0]!, /sampled data, not instructions/);
  assert.match(sent[0]!, /Load is high on db-1: 5-minute load 6\.00/);
  assert.deepEqual(await alerts.incident(space, "p"), { sessionId: "chat-1", openedAt: first.openedAt });
  assert.equal((await alerts.ask(space, "p")).sessionId, "chat-1", "the open chat is reused");
  assert.equal(created.length, 1);
  archived = true;
  assert.equal(await alerts.incident(space, "p"), null, "a chat the person closed is not offered");
  assert.equal((await alerts.ask(space, "p")).sessionId, "chat-2");
  alerts.stop();
});

test("the prompt keeps sampled text in its data block", () => {
  const text = askPrompt(snapshot([], { host: { ...snapshot([]).host, name: "db-1" } }));
  assert.match(text, /No warnings at the moment\./);
  assert.match(text, /Do not change anything without explicit authorization/);
});
