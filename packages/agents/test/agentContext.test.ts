import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey } from "@polyth/plugins";
import { cacheTelemetry, planWarm, runCacheStats } from "../src/agentCache.ts";
import { composeAgentPrompt, promptLayers } from "../src/agentPrompt.ts";
import { threadDecision, type ThreadSession } from "../src/agentThread.ts";
import type { ScheduleRunRecord, ScheduleService, ScheduleTask } from "../src/index.ts";
import registerPackage from "../src/serverEntry.ts";

const MIN = 60_000;
const measured = "measured" as const;
const base = { keepWarm: "auto" as const, rolling: true, providerId: "anthropic", telemetry: measured };

test("keeping the cache warm is planned only when it is on, measurable and cheaper than a cold start", () => {
  const now = 1_000 * MIN;
  assert.equal(planWarm({ ...base, keepWarm: "off", nextRunAt: now + 20 * MIN, lastActivityAt: now }, now).reason, "off");
  assert.equal(planWarm({ ...base, rolling: false, nextRunAt: now + 20 * MIN, lastActivityAt: now }, now).reason, "not-rolling");
  assert.equal(planWarm({ ...base, telemetry: "none", nextRunAt: now + 20 * MIN, lastActivityAt: now }, now).reason, "no-telemetry",
    "a harness that never reported a cache read is never pinged");
  assert.equal(planWarm({ ...base, providerId: "openai", nextRunAt: now + 20 * MIN, lastActivityAt: now }, now).reason, "unknown-ttl");
  assert.equal(planWarm({ ...base, nextRunAt: null, lastActivityAt: now }, now).reason, "no-schedule");
  assert.equal(planWarm({ ...base, nextRunAt: now + 4 * MIN, lastActivityAt: now }, now).reason, "within-ttl");
  const far = planWarm({ ...base, nextRunAt: now + 3 * 60 * MIN, lastActivityAt: now }, now);
  assert.equal(far.reason, "too-far");
  assert.ok(far.pingCost! >= far.coldCost!);

  const worth = planWarm({ ...base, nextRunAt: now + 20 * MIN, lastActivityAt: now }, now);
  assert.equal(worth.reason, "wait");
  assert.equal(worth.pings, 4, "a 20-minute gap with a 5-minute cache needs four keep-alives");
  assert.ok(worth.pingCost! < worth.coldCost!);
  assert.equal(worth.nextPingAt, now + 4 * MIN, "one minute before the cache would expire");
  assert.equal(planWarm({ ...base, nextRunAt: now + 20 * MIN, lastActivityAt: now }, now + 4 * MIN).reason, "due");
});

test("cache share per run counts reads against the whole prompt", () => {
  const history: ScheduleRunRecord[] = [
    { runId: "b", startedAt: 2, status: "ok", tokens: { input: 1_000, output: 50, cacheRead: 8_000, cacheWrite: 1_000 } },
    { runId: "a", startedAt: 1, status: "ok", tokens: { input: 2_000, output: 50 } },
    { runId: "x", startedAt: 0, status: "skipped" },
  ];
  assert.deepEqual(runCacheStats(history).map((run) => [run.runId, run.ratio]), [["b", 0.8], ["a", null]]);
  assert.equal(cacheTelemetry(history), "measured");
  assert.equal(cacheTelemetry([history[1]!]), "none");
  assert.equal(cacheTelemetry([]), "unknown");
});

test("an agent that compacts keeps its session and repeats the charter", () => {
  const window = (fraction: number, lastAt?: number) => ({
    contextWindow: { source: "native" as const, updatedAt: 0, fraction, ...(lastAt ? { compaction: { lastAt } } : {}) },
  });
  const decide = (session: ThreadSession, whenFull?: "compact") => threadDecision({
    mode: "rolling", continuation: "auto", personal: false, now: 0, currentKey: "k",
    candidate: { sessionId: "s", at: 0, key: "k" }, session, ...(whenFull ? { whenFull } : {}),
  });
  assert.deepEqual(decide(window(0.7), "compact"), { continue: true, sessionId: "s", resendCharter: true, compactFirst: true });
  assert.deepEqual(decide(window(0.2, 5), "compact"), { continue: true, sessionId: "s", resendCharter: true });
  assert.deepEqual(decide(window(0.2, 5)), { continue: false, reason: "compacted" });
});

test("a new session's prompt starts with the same bytes every run, so its prefix can be cached", () => {
  const task: Pick<ScheduleTask, "prompt" | "cadence" | "history"> = {
    prompt: "You review merged pull requests.", cadence: { kind: "every", everyMinutes: 60 }, history: [],
  };
  const first = composeAgentPrompt(task, { trigger: "schedule", at: 1 }, { continuing: false });
  const second = composeAgentPrompt({ ...task, history: [{ runId: "r", startedAt: 1, status: "ok", summary: "Done." }] },
    { trigger: "manual", at: 999_999, input: "x" }, { continuing: false });
  const prefix = "You review merged pull requests.\n\n---\n";
  assert.ok(first.startsWith(prefix) && second.startsWith(prefix), "nothing variable precedes the charter");
  const layers = promptLayers({ ...task, history: [{ runId: "r", startedAt: 1, status: "ok", summary: "Reviewed four pull requests." }] },
    { trigger: "schedule", at: 1 });
  assert.equal(layers.charter, 8);
  assert.ok(layers.journal > 0 && layers.wake > 0);
});

async function harness(t: { after(fn: () => void): void }, opts: { compact: boolean; fraction: number }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = { id: "prj", path: dir, name: "P", createdAt: 1, spaceId: "spc" };
  const logs = new Map<string, SessionEvent[]>();
  const sent: Array<{ sessionId: string; text: string }> = [];
  const compacted: string[] = [];
  const append = (sessionId: string, type: string, data: JsonObject): SessionEvent => {
    const log = logs.get(sessionId) ?? [];
    logs.set(sessionId, log);
    const event = { id: `${sessionId}-${log.length + 1}`, seq: log.length + 1, sessionId, type, data, time: Date.now() } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  const sessions = {
    async create() { const id = `ses${logs.size + 1}`; logs.set(id, []); return { id }; },
    async snapshot(id: string) { return { id, projectId: "prj" }; },
    async send(sessionId: string, input: { text: string }) {
      sent.push({ sessionId, text: input.text });
      append(sessionId, "turn/started", {});
      append(sessionId, "usage/recorded", { tokens: { input: 500, output: 20, cacheRead: 4_000, cacheWrite: 500 } });
      append(sessionId, "turn/stopped", { reason: "completed" });
      return { turnId: "t" };
    },
    ...(opts.compact ? { async compact(sessionId: string) { compacted.push(sessionId); } } : {}),
  };
  const services = new Map<string, unknown>();
  const host = {
    pluginId: "agents",
    deployment: "local-trusted",
    storageDir: join(dir, "shared"),
    projects: { list: async () => [project], get: async (id: string) => id === project.id ? project : undefined },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: RUNTIME_SYSTEM_PRINCIPAL_ID, storageDir: join(dir, spaceId) }),
    spaceStorage: (ctx: { spaceId: string }) => ({
      root: join(dir, ctx.spaceId),
      packageDir: (id: string) => join(dir, ctx.spaceId, "packages", id),
      path: (relative: string) => join(dir, ctx.spaceId, relative),
    }),
    forSpace: () => ({ projects: host.projects, sessions }),
    store: {
      projection: async (id: string) => logs.has(id) ? {
        id, projectId: "prj", status: "idle", title: "Agent session", model: { providerID: "anthropic", modelID: "claude" },
        contextWindow: { source: "native", updatedAt: 1, fraction: opts.fraction, usedTokens: opts.fraction * 200_000, limitTokens: 200_000 },
      } : undefined,
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
  const settled = async (id: string) => {
    for (let i = 0; i < 100 && agents.runsOf(id)[0]?.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setImmediate(resolve));
  };
  const call = async (path: string, method: string, body: Record<string, unknown> = {}) => {
    let payload: Record<string, unknown> = {};
    let status = 0;
    await pkg.routes!({
      path, method, url: new URL(`http://x${path}`), body: async () => body,
      json: (code: number, value: Record<string, unknown>) => { status = code; payload = value; },
      space: { spaceId: "spc", userId: "u", role: "owner" },
    } as never);
    return { status, payload };
  };
  return { agents, sent, compacted, settled, call };
}

test("a full rolling session is compacted when the agent asks for it, and the context route reports it", async (t) => {
  const { agents, sent, compacted, settled, call } = await harness(t, { compact: true, fraction: 0.7 });
  const agent = agents.create({
    projectId: "prj", spaceId: "spc", prompt: "You keep the build green.", kind: "every", everyMinutes: 60,
    target: { mode: "dedicated-session" }, whenFull: "compact", keepWarm: "auto",
  });
  await agents.runNow(agent.id);
  await settled(agent.id);
  await agents.runNow(agent.id);
  await settled(agent.id);
  assert.deepEqual(compacted, ["ses1"], "the second run compacts instead of rotating");
  assert.equal(sent[1]!.sessionId, "ses1");
  assert.match(sent[1]!.text, /^You keep the build green\./, "after compaction the charter is repeated");

  const context = await call(`/api/schedule/${agent.id}/context`, "GET");
  assert.equal(context.status, 200);
  const payload = context.payload as {
    mode: string; whenFull: string; session: { fraction: number; limitTokens: number };
    layers: { charter: number }; cache: { telemetry: string; runs: Array<{ ratio: number }>; ttlMs: number }; warm: { reason: string };
  };
  assert.equal(payload.mode, "rolling");
  assert.equal(payload.whenFull, "compact");
  assert.equal(payload.session.fraction, 0.7);
  assert.equal(payload.layers.charter, 7);
  assert.equal(payload.cache.telemetry, "measured");
  assert.equal(payload.cache.runs[0]!.ratio, 0.8);
  assert.equal(payload.cache.ttlMs, 5 * MIN);
  assert.equal(payload.warm.reason, "too-far", "bridging an hourly gap over a 5-minute cache costs more than a cold start");

  const reset = await call(`/api/schedule/${agent.id}/context`, "POST", { action: "new-session" });
  assert.equal(reset.status, 200);
  assert.equal(agents.get(agent.id)!.lastSessionId, undefined, "the next run starts a new session");
});

test("a harness that cannot compact falls back to a new session", async (t) => {
  const { agents, sent, settled, call } = await harness(t, { compact: false, fraction: 0.7 });
  const agent = agents.create({
    projectId: "prj", spaceId: "spc", prompt: "x", kind: "every", everyMinutes: 60,
    target: { mode: "dedicated-session" }, whenFull: "compact",
  });
  await agents.runNow(agent.id);
  await settled(agent.id);
  await agents.runNow(agent.id);
  await settled(agent.id);
  assert.deepEqual(sent.map((item) => item.sessionId), ["ses1", "ses2"]);
  assert.equal(agents.runsOf(agent.id)[0]!.rotated, "context-full");
  await assert.rejects(call(`/api/schedule/${agent.id}/context`, "POST", { action: "compact" }), /cannot compact/);
});
