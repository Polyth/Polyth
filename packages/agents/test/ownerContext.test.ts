import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessSelection, JsonObject, SessionEvent } from "@polyth/contracts";
import { RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey } from "@polyth/plugins";
import type { ScheduleService } from "../src/index.ts";
import registerPackage from "../src/serverEntry.ts";

// A schedule's runs act as its owner: create/send go through the owner's own
// Space context, so the owner's private assistant account works and someone
// else's is refused by the same session facade a person would hit.
async function harness(t: { after(fn: () => void): void }, members: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-schedule-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = { id: "prj", path: dir, name: "P", createdAt: 1, spaceId: "spc" };
  const logs = new Map<string, SessionEvent[]>();
  const calls: Array<{ op: string; as: string; harness?: string; author?: string; via?: string }> = [];
  const append = (sessionId: string, type: string, data: JsonObject): SessionEvent => {
    const log = logs.get(sessionId) ?? [];
    logs.set(sessionId, log);
    const event = { id: `${sessionId}-${log.length + 1}`, seq: log.length + 1, sessionId, type, data, time: Date.now() } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  // The session facade for one context: the owner's private login is usable
  // only by that owner (as accountPermissions.ts enforces on the server).
  const sessionsFor = (ctx: { userId: string }) => {
    const check = (selection?: HarnessSelection) => {
      if (selection?.mode === "pinned" && selection.harnessId === "claude-ida" && ctx.userId !== "u-ida") {
        throw Object.assign(new Error("This assistant account belongs to someone else"), { code: "forbidden" });
      }
    };
    return {
      async create(input: { harness?: HarnessSelection }) {
        check(input.harness);
        const id = `ses${logs.size + 1}`;
        logs.set(id, []);
        calls.push({ op: "create", as: ctx.userId, ...(input.harness?.mode === "pinned" ? { harness: input.harness.harnessId } : {}) });
        return { id };
      },
      async snapshot(id: string) { return { id, projectId: "prj" }; },
      async send(sessionId: string, input: { harness?: HarnessSelection }, admission?: { author?: { userId: string; via?: string } }) {
        check(input.harness);
        calls.push({
          op: "send", as: ctx.userId,
          ...(admission?.author ? { author: admission.author.userId, ...(admission.author.via ? { via: admission.author.via } : {}) } : {}),
        });
        append(sessionId, "turn/started", {});
        append(sessionId, "turn/stopped", { reason: "completed" });
        return { turnId: "t" };
      },
    };
  };
  const services = new Map<string, unknown>();
  const host = {
    pluginId: "agents",
    deployment: "local-trusted",
    storageDir: join(dir, "shared"),
    projects: { list: async () => [project], get: async (id: string) => id === project.id ? project : undefined },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: RUNTIME_SYSTEM_PRINCIPAL_ID, storageDir: join(dir, spaceId) }),
    personSpaceContext: (userId: string, spaceId: string) => members[spaceId]?.includes(userId)
      ? { spaceId, userId, storageDir: join(dir, spaceId) }
      : undefined,
    spaceStorage: (ctx: { spaceId: string }) => ({
      root: join(dir, ctx.spaceId),
      packageDir: (id: string) => join(dir, ctx.spaceId, "packages", id),
      path: (relative: string) => join(dir, ctx.spaceId, relative),
    }),
    forSpace: (ctx: { userId: string }) => ({ projects: host.projects, sessions: sessionsFor(ctx) }),
    store: {
      projection: async (id: string) => logs.has(id) ? { id, projectId: "prj", status: "idle", title: "Agent session" } : undefined,
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
  return { agents, calls, settled };
}

const ida = { mode: "pinned", harnessId: "claude-ida" } as const;

test("a schedule pinned to its owner's private profile runs as the owner", async (t) => {
  const { agents, calls, settled } = await harness(t, { spc: ["u-ida", "u-bob"] });
  const agent = agents.create({ projectId: "prj", spaceId: "spc", ownerUserId: "u-ida", prompt: "Check the build.", kind: "every", everyMinutes: 60, harness: ida });
  await agents.runNow(agent.id);
  await settled(agent.id);
  assert.equal(agents.runsOf(agent.id)[0]!.status, "ok");
  assert.deepEqual(calls, [
    { op: "create", as: "u-ida", harness: "claude-ida" },
    { op: "send", as: "u-ida", author: "u-ida", via: "schedule" },
  ]);
});

test("a schedule pinned to someone else's private profile fails", async (t) => {
  const { agents, calls, settled } = await harness(t, { spc: ["u-ida", "u-bob"] });
  const agent = agents.create({ projectId: "prj", spaceId: "spc", ownerUserId: "u-bob", prompt: "x", kind: "every", everyMinutes: 60, harness: ida });
  await agents.runNow(agent.id);
  await settled(agent.id);
  const run = agents.runsOf(agent.id)[0]!;
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /belongs to someone else/);
  assert.deepEqual(calls, []);
});

test("an owner who left the Space refuses the run with a recorded error; ownerless tasks keep the system context", async (t) => {
  const { agents, calls, settled } = await harness(t, { spc: ["u-bob"] });
  const departed = agents.create({ projectId: "prj", spaceId: "spc", ownerUserId: "u-ida", prompt: "x", kind: "every", everyMinutes: 60 });
  await agents.runNow(departed.id);
  await settled(departed.id);
  const run = agents.runsOf(departed.id)[0]!;
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /no longer a member of this Space/);
  assert.deepEqual(calls, [], "nothing was created or sent");

  const system = agents.create({ projectId: "prj", spaceId: "spc", prompt: "x", kind: "every", everyMinutes: 60 });
  await agents.runNow(system.id);
  await settled(system.id);
  assert.equal(agents.runsOf(system.id)[0]!.status, "ok");
  assert.deepEqual(calls, [{ op: "create", as: RUNTIME_SYSTEM_PRINCIPAL_ID }, { op: "send", as: RUNTIME_SYSTEM_PRINCIPAL_ID }]);
});
