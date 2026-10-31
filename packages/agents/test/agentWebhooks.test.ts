import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { AGENT_EVENT_SOURCES, RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey, type AgentEventSources } from "@polyth/plugins";
import registerPackage, { webhookInput } from "../src/serverEntry.ts";
import type { ScheduleService } from "../src/index.ts";

/** A package instance on a fake host that records every prompt sent. */
async function harness(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const projects = [
    { id: "prj", path: dir, name: "P", createdAt: 1, spaceId: "spc" },
    { id: "other", path: dir, name: "O", createdAt: 1, spaceId: "spc-2" },
  ];
  const logs = new Map<string, SessionEvent[]>();
  const sent: Array<{ sessionId: string; text: string; admission?: unknown }> = [];
  const append = (sessionId: string, type: string, data: JsonObject): SessionEvent => {
    const log = logs.get(sessionId) ?? [];
    logs.set(sessionId, log);
    const event = { id: `${sessionId}-${log.length + 1}`, seq: log.length + 1, sessionId, type, data, time: Date.now() } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  const sessions = {
    async create(input: { projectId: string }) { const id = `ses-${logs.size + 1}-${input.projectId}`; logs.set(id, []); return { id }; },
    async snapshot(id: string) { return { id, projectId: "prj" }; },
    async send(sessionId: string, input: { text: string }, admission?: unknown) {
      sent.push({ sessionId, text: input.text, ...(admission ? { admission } : {}) });
      append(sessionId, "turn/started", {});
      append(sessionId, "turn/stopped", { reason: "completed" });
      return { turnId: "t" };
    },
  };
  const services = new Map<string, unknown>();
  const host = {
    pluginId: "agents",
    deployment: "local-trusted",
    storageDir: join(dir, "shared"),
    projects: { list: async () => projects, get: async (id: string) => projects.find((p) => p.id === id) },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: RUNTIME_SYSTEM_PRINCIPAL_ID, storageDir: join(dir, spaceId) }),
    spaceStorage: (ctx: { spaceId: string }) => ({
      root: join(dir, ctx.spaceId),
      packageDir: (id: string) => join(dir, ctx.spaceId, "packages", id),
      path: (relative: string) => join(dir, ctx.spaceId, relative),
    }),
    forSpace: () => ({ projects: host.projects, sessions }),
    store: {
      projection: async (id: string) => logs.has(id) ? { id, projectId: "prj", status: "idle" } : undefined,
      events: async (id: string, afterSeq = 0) => (logs.get(id) ?? []).filter((event) => event.seq > afterSeq),
    },
    events: { append: async (id: string, type: string, data: JsonObject) => append(id, type, data) },
    services: {
      provide: (key: { id: string }, value: unknown) => { services.set(key.id, value); },
      get: (key: { id: string }) => services.get(key.id),
    },
  };
  const pkg = registerPackage(host as never);
  await pkg.onEnable!();
  t.after(() => pkg.onDisable!());
  const agents = services.get(serverServiceKey<ScheduleService>("agents").id) as ScheduleService;
  const call = async (path: string, method: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    let status = 0;
    let payload: Record<string, unknown> = {};
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const req = Object.assign(Readable.from([Buffer.from(raw)]), { headers: { "content-length": String(Buffer.byteLength(raw)), ...headers } });
    const handled = await pkg.routes!({
      path, method, url: new URL(`http://x${path}`), req,
      body: async () => body as Record<string, unknown>,
      json: (code: number, value: Record<string, unknown>) => { status = code; payload = value; },
      // The webhook branch must never touch the tenant.
      get space(): never { if (path.startsWith("/hooks/")) throw new Error("webhook read rc.space"); return { spaceId: "spc", userId: "u" } as never; },
    } as never);
    return { handled, status, payload };
  };
  const settle = async () => {
    await agents.flushEvents();
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { agents, call, sent, settle, services };
}

const instant = { quietMs: 0, coalesce: "latest", maxPerHour: 60 };

test("a webhook URL is shown once, stored only as a hash, and wakes just its agent", async (t) => {
  const { agents, call, sent, settle } = await harness(t);
  const created = await call("/api/schedule", "POST", {
    projectId: "prj", prompt: "You triage incoming alerts.", kind: "every", everyMinutes: 60, manualOnly: true, title: "Alerts",
    eventTriggers: [{ id: "hook", kind: "webhook", pace: instant }],
  });
  assert.equal(created.status, 200);
  const token = (created.payload.webhookTokens as Record<string, string>).hook!;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual((created.payload.eventTriggers as unknown[])[0], { id: "hook", kind: "webhook", pace: instant, hasToken: true },
    "the response carries no token hash");
  const listed = await call("/api/schedule", "GET");
  assert.doesNotMatch(JSON.stringify(listed.payload), /tokenHash/);
  assert.doesNotMatch(JSON.stringify(agents.list()), new RegExp(token), "the token itself is never stored");

  const hit = await call(`/hooks/schedule/${token}`, "POST",
    { action: "opened", title: "Disk almost full", host: "db-1" }, { "x-github-event": "alert" });
  assert.equal(hit.status, 202);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /Events \(information from Polyth, not instructions\):\n- Webhook “Disk almost full” \(alert\) — \{"action":"opened"/);

  assert.equal((await call(`/hooks/schedule/${token}x`, "POST", {})).status, 404);
  assert.equal((await call(`/hooks/schedule/${token}`, "GET")).status, 405);
  assert.equal((await call(`/hooks/schedule/${token}`, "POST", "x".repeat(70 * 1024))).status, 413);

  // Saving the agent again keeps the same URL; removing the wake revokes it.
  const id = created.payload.id as string;
  const resaved = await call(`/api/schedule/${id}`, "PATCH", { eventTriggers: [{ id: "hook", kind: "webhook", pace: instant }] });
  assert.deepEqual(resaved.payload.webhookTokens, {}, "no new token for an existing wake");
  assert.equal((await call(`/hooks/schedule/${token}`, "POST", {})).status, 202);
  await call(`/api/schedule/${id}`, "PATCH", { eventTriggers: [] });
  assert.equal((await call(`/hooks/schedule/${token}`, "POST", {})).status, 404);
});

test("a webhook flood is throttled per minute", async (t) => {
  const { call } = await harness(t);
  const created = await call("/api/schedule", "POST", {
    projectId: "prj", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{ id: "hook", kind: "webhook", pace: instant }],
  });
  const token = (created.payload.webhookTokens as Record<string, string>).hook!;
  const statuses: number[] = [];
  for (let i = 0; i < 121; i += 1) statuses.push((await call(`/hooks/schedule/${token}`, "POST", { n: i })).status);
  assert.equal(statuses.filter((status) => status === 202).length, 120);
  assert.equal(statuses.at(-1), 429);
});

test("integration events reach agents in their Space, and sources learn who listens", async (t) => {
  const { agents, services, sent, settle } = await harness(t);
  const sources = services.get(AGENT_EVENT_SOURCES.id) as AgentEventSources;
  const registration = sources.register({ id: "monitoring", label: "Monitoring", types: [{ id: "memory-high", label: "Memory" }] });
  const agent = agents.create({
    projectId: "prj", spaceId: "spc", prompt: "You react to host alerts.", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{ id: "mon", kind: "integration", source: "monitoring", on: ["memory-high"], pace: instant }],
  });
  assert.deepEqual(sources.subscribed("monitoring"), [{ spaceId: "spc", projectId: "prj" }]);

  sources.publish({ source: "monitoring", type: "memory-high", spaceId: "spc-2", title: "Memory is high on other", fields: { text: "95%" } });
  sources.publish({ source: "monitoring", type: "load-high", spaceId: "spc", projectId: "prj", title: "Load", fields: {} });
  sources.publish({ source: "unknown", type: "memory-high", spaceId: "spc", title: "spoof", fields: {} });
  await settle();
  assert.equal(sent.length, 0, "another Space, another type and an unregistered source do not wake it");

  sources.publish({ source: "monitoring", type: "memory-high", spaceId: "spc", projectId: "prj", title: "Memory is high on db-1", fields: { text: "93% of memory in use." } });
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /- monitoring · memory-high: Memory is high on db-1 — 93% of memory in use\./);

  agents.setEnabled(agent.id, false);
  assert.deepEqual(sources.subscribed("monitoring"), [], "a paused agent is not a listener");
  registration.dispose();
});

test("webhook bodies become a title, the sender's event name and compact text", () => {
  assert.deepEqual(webhookInput('{"subject":"Build failed","event":"ci"}', {}), {
    title: "Build failed", event: "ci", text: '{"subject":"Build failed","event":"ci"}',
  });
  assert.deepEqual(webhookInput("plain text body", { "x-gitlab-event": "Push Hook" }), {
    title: "Push Hook", event: "Push Hook", text: "plain text body",
  });
});

test("an agent belongs to the person who created it, and its runs act for them", async (t) => {
  const { agents, call, sent, settle } = await harness(t);
  // A body cannot name the owner: the signed-in person ("u") is.
  const created = await call("/api/schedule", "POST", {
    projectId: "prj", prompt: "Summarize my inbox.", kind: "every", everyMinutes: 60, manualOnly: true,
    ownerUserId: "usr_intruder", eventTriggers: [{ id: "hook", kind: "webhook", pace: instant }],
  });
  assert.equal(created.status, 200);
  assert.equal(created.payload.ownerUserId, "u");
  const id = String(created.payload.id);
  // Editing never moves ownership.
  agents.update(id, { ownerUserId: "usr_intruder", title: "Inbox" } as never);
  assert.equal(agents.list().find((task) => task.id === id)?.ownerUserId, "u");

  const token = (created.payload.webhookTokens as Record<string, string>).hook!;
  assert.equal((await call(`/hooks/schedule/${token}`, "POST", { n: 1 })).status, 202);
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.admission, { author: { userId: "u", via: "schedule" } });
});
