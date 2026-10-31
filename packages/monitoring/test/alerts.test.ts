import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_EVENT_SOURCES, SESSION_ATTENTION_SERVICE, type AgentEventPublication } from "@polyth/plugins";
import { createMonitoringAlerts, decideDispatch, INCIDENT_CHAT_LIMIT, newAlerts } from "../src/alerts.ts";
import type { MonitoringPolicy, MonitoringSnapshot } from "../src/contracts.ts";

const snapshot = (warnings: MonitoringSnapshot["warnings"], over: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot => ({
  host: { projectId: "p", name: "db-1", kind: "ssh", supported: true, fileTailsAvailable: false, hostLogsAvailable: true, canEditPolicy: false },
  sampledAt: 0,
  metrics: { hostname: "db-1", platform: "linux", cpuCount: 4, load: [9.5, 6, 4], memoryTotal: 100, memoryAvailable: 7, uptimeSeconds: 1 },
  services: [{ unit: "postgres.service", state: "failed" }, { unit: "nginx.service", state: "active" }],
  servicesAvailable: true,
  warnings,
  ...over,
});

test("only warnings that newly appear become alerts", () => {
  assert.deepEqual(newAlerts(["memory"], snapshot(["memory", "load", "service"])).map((alert) => [alert.type, alert.title, alert.text]), [
    ["load-high", "Load is high on db-1", "1-minute load 9.50 on 4 CPUs."],
    ["service-down", "Service down on db-1", "postgres.service (failed)"],
  ]);
  assert.deepEqual(newAlerts(["memory", "load"], snapshot(["load"])), []);
});

test("the source samples only subscribed projects, treats the first sample as a baseline and respects agent access", async () => {
  const published: AgentEventPublication[] = [];
  let subscribed = [{ spaceId: "s", projectId: "p" }];
  let warnings: MonitoringSnapshot["warnings"] = ["memory"];
  let access = { metrics: true, services: false, logs: false };
  let samples = 0;
  const registered: string[] = [];
  const sources = {
    register: (source: { id: string }) => { registered.push(source.id); return { dispose() {} }; },
    publish: (event: AgentEventPublication) => published.push(event),
    subscribed: () => subscribed,
  };
  const host = {
    systemSpaceContext: (spaceId: string) => ({ spaceId }),
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
    access = { metrics: false, services: false, logs: false };
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

test("the dispatch decision: denial, agent ping, duplicate, notification only, new chat", () => {
  const all = { metrics: true, services: true, logs: false };
  const base = { access: all, subscribed: false, claimedElsewhere: false };
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "memory-high" }, access: { ...all, metrics: false } }), { action: "none", reason: "denied" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "service-down" }, access: { ...all, services: false }, subscribed: true }), { action: "none", reason: "denied" },
    "a subscriber does not lift the policy");
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, subscribed: true, claimedElsewhere: true }), { action: "ping" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, claimedElsewhere: true, incidentSessionId: "x" }), { action: "none", reason: "duplicate" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, incidentSessionId: "x" }), { action: "notify", sessionId: "x" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "service-down" } }), { action: "session" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, openIncidents: 2, incidentLimit: 2 }), { action: "none", reason: "limit" },
    "a full fleet of incident chats stops new ones");
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, openIncidents: 1, incidentLimit: 2 }), { action: "session" });
  assert.deepEqual(decideDispatch({ ...base, alert: { type: "load-high" }, openIncidents: INCIDENT_CHAT_LIMIT }), { action: "none", reason: "limit" },
    "the package-wide default caps at INCIDENT_CHAT_LIMIT");
});

function harness(opts: { subscribed?: Array<{ spaceId: string; projectId: string }>; projects: Array<{ id: string; spaceId: string; hostname: string }>; limit?: number }) {
  const published: AgentEventPublication[] = [];
  const created: Array<{ spaceId: string; projectId: string; purpose?: string; title?: string }> = [];
  const sent: Array<{ id: string; text: string }> = [];
  const notified: Array<{ sessionId: string; statusText: string; key: string }> = [];
  const warnings = new Map<string, MonitoringSnapshot["warnings"]>();
  const access = new Map<string, MonitoringPolicy["agentAccess"]>();
  const sources = {
    register: () => ({ dispose() {} }),
    publish: (event: AgentEventPublication) => published.push(event),
    subscribed: () => opts.subscribed ?? [],
  };
  const attention = { waitingForPerson() {}, notify: (sessionId: string, input: { statusText: string; key: string }) => notified.push({ sessionId, ...input }) };
  const host = {
    systemSpaceContext: (spaceId: string) => ({ spaceId }),
    services: { get: (key: { id: string }) => key.id === AGENT_EVENT_SOURCES.id ? sources : key.id === SESSION_ATTENTION_SERVICE.id ? attention : undefined },
    projects: { list: async () => opts.projects.map(({ id, spaceId }) => ({ id, spaceId })) },
    forSpace: (space: { spaceId: string }) => ({ sessions: {
      create: async (input: { projectId: string; purpose?: string; title?: string }) => { created.push({ spaceId: space.spaceId, ...input }); return { id: `chat-${created.length}` }; },
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
  const alerts = createMonitoringAlerts(host as never, service as never, 60_000, opts.limit);
  return { alerts, published, created, sent, notified, warnings, access };
}

test("an unwatched project opens one sysadmin chat per incident and notifies once per warning episode", async () => {
  const h = harness({ projects: [{ id: "p", spaceId: "s", hostname: "db-1" }] });
  await h.alerts.tick();
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.deepEqual(h.created, [{ spaceId: "s", projectId: "p", purpose: "sysadmin", title: "Service down on db-1" }]);
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
  h.warnings.set("p", ["service"]);
  await h.alerts.tick();
  assert.equal(h.created.length, 2, "cleared, then re-armed: a new incident");
  assert.equal(h.notified.length, 3);
  assert.equal(h.published.length, 0);
});

test("a subscribed agent is pinged instead of opening a chat, and claims the host for its Space", async () => {
  const h = harness({ subscribed: [{ spaceId: "s", projectId: "a" }], projects: [{ id: "b", spaceId: "s", hostname: "db-1" }, { id: "a", spaceId: "s", hostname: "db-1" }] });
  await h.alerts.tick();
  h.warnings.set("a", ["load"]);
  h.warnings.set("b", ["load"]);
  await h.alerts.tick();
  assert.deepEqual(h.published.map((event) => [event.type, event.projectId]), [["load-high", "a"]]);
  assert.equal(h.created.length, 0, "the sibling project on the same host stays quiet");
  assert.equal(h.notified.length, 0, "the agent's own notify policy tells the person");
});

test("projects sharing a host in one Space open one chat; another Space is told separately", async () => {
  const h = harness({ projects: [{ id: "p1", spaceId: "s", hostname: "web" }, { id: "p2", spaceId: "s", hostname: "web" }, { id: "q", spaceId: "t", hostname: "web" }] });
  await h.alerts.tick();
  for (const id of ["p1", "p2", "q"]) h.warnings.set(id, ["memory"]);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => [item.spaceId, item.projectId]), [["s", "p1"], ["t", "q"]]);
  assert.equal(h.notified.length, 2);
});

test("the global incident-chat limit stops new chats until capacity frees up", async () => {
  const h = harness({ limit: 2, projects: [
    { id: "p1", spaceId: "s", hostname: "a" },
    { id: "p2", spaceId: "t", hostname: "b" },
    { id: "p3", spaceId: "s", hostname: "c" },
  ] });
  await h.alerts.tick();
  for (const id of ["p1", "p2", "p3"]) h.warnings.set(id, ["memory"]);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => item.projectId), ["p1", "p2"], "only the first episodes open chats");
  assert.deepEqual(h.notified.map((item) => item.sessionId), ["chat-1", "chat-2"]);
  assert.equal(h.sent.length, 2, "the warning past the cap gets no chat and no message");
  assert.equal(h.published.length, 0);

  // Clearing one incident frees exactly one slot; the suppressed warning is not replayed.
  h.warnings.set("p1", []);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => item.projectId), ["p1", "p2"], "capacity is not spent retroactively");
  h.warnings.set("p3", []);
  await h.alerts.tick();
  h.warnings.set("p3", ["memory"]);
  await h.alerts.tick();
  assert.deepEqual(h.created.map((item) => item.projectId), ["p1", "p2", "p3"], "a cleared incident frees its slot for the next one");
  assert.equal(h.notified.length, 3);
});

test("a warning the policy does not grant spawns no work and tells nobody", async () => {
  const h = harness({ subscribed: [{ spaceId: "s", projectId: "p" }], projects: [{ id: "p", spaceId: "s", hostname: "db-1" }, { id: "o", spaceId: "s", hostname: "other" }] });
  h.access.set("p", { metrics: true, services: false, logs: false });
  h.access.set("o", { metrics: false, services: true, logs: false });
  await h.alerts.tick();
  h.warnings.set("p", ["service"]);
  h.warnings.set("o", ["memory", "load"]);
  await h.alerts.tick();
  assert.deepEqual([h.published.length, h.created.length, h.sent.length, h.notified.length], [0, 0, 0, 0]);
});
