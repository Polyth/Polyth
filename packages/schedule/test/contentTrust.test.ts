import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLoopExecutionTrusted,
  createScheduleService,
  loopSemanticDigest,
  type ScheduleTask,
} from "../src/index.ts";
import type { LoopFileResult, LoopSpec } from "../src/loops.ts";

const loop = (prompt: string, patch: Partial<LoopSpec> = {}): LoopSpec => ({
  id: "nightly",
  title: "Nightly review",
  cron: "0 2 * * *",
  timeZone: "UTC",
  enabled: true,
  prompt,
  ...patch,
});

const file = (digest: string, spec: LoopSpec, path = "/repo/.agents/loops/nightly.md"): LoopFileResult => ({
  path,
  digest,
  loop: spec,
});

test("new repository loops are discovered but cannot execute before exact-version trust", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-loop-trust-new-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runs: string[] = [];
  const schedule = createScheduleService({
    file: join(dir, "schedule.json"),
    now: () => 1_700_000_000_000,
    runner: { async run(task) { runs.push(task.prompt); } },
  });
  const current = file("a".repeat(64), loop("new repository prompt"));

  const task = schedule.syncLoops("project-1", [current]).tasks[0]!;
  assert.equal(task.trustState, "untrusted");
  assert.equal(task.enabled, false);
  assert.equal(task.nextRunAt, null);
  assert.equal(task.pendingVersion?.sourceDigest, current.digest);
  await assert.rejects(
    () => schedule.runNow(task.id),
    (error: unknown) => (error as { code?: string }).code === "content-trust-required",
  );
  assert.deepEqual(runs, []);
});

test("changed loop keeps last approved executable snapshot until reapproval", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-loop-trust-change-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1_700_000_000_000;
  const runs: Array<{ prompt: string; digest?: string; scope?: string }> = [];
  const schedule = createScheduleService({
    file: join(dir, "schedule.json"),
    now: () => now,
    runner: {
      async run(task) {
        runs.push({
          prompt: task.prompt,
          digest: task.trustReceipt?.contentDigest,
          scope: task.trustReceipt?.approvalScope,
        });
      },
    },
  });
  const a = file("a".repeat(64), loop("approved A"));
  const task = schedule.syncLoops("project-1", [a]).tasks[0]!;
  schedule.trustLoopVersion(task.id, "space-1", a);
  await schedule.runNow(task.id);
  assert.deepEqual(runs.at(-1), {
    prompt: "approved A",
    digest: a.digest,
    scope: "current-version",
  });

  now += 1_000;
  const b = file("b".repeat(64), loop("pending B", {
    title: "Changed title",
    cron: "5 3 * * *",
    agentProfile: "reviewer",
  }));
  const changed = schedule.syncLoops("project-1", [b]).tasks[0]!;
  assert.equal(changed.trustState, "changed-since-trust");
  assert.equal(changed.enabled, false);
  assert.equal(changed.nextRunAt, null);
  assert.equal(changed.prompt, "approved A", "repository bytes must not mutate the approved executable snapshot");
  assert.equal(changed.title, "Nightly review");
  assert.equal(changed.agentProfile, undefined);
  assert.equal(changed.trustReceipt?.contentDigest, a.digest);
  assert.equal(changed.sourceDigest, b.digest);
  assert.deepEqual(
    new Set(changed.pendingVersion?.changedFields),
    new Set(["prompt", "title", "schedule", "agentProfile"]),
  );

  const beforeTick = runs.length;
  await schedule.tick();
  assert.equal(runs.length, beforeTick, "blocked repository content cannot fire from the clock");
  await assert.rejects(
    () => schedule.runNow(task.id),
    (error: unknown) => (error as { code?: string }).code === "content-trust-required",
  );

  await schedule.runLoopVersionOnce(task.id, "space-1", b);
  assert.deepEqual(runs.at(-1), {
    prompt: "pending B",
    digest: b.digest,
    scope: "once",
  });
  const afterOnce = schedule.get(task.id)!;
  assert.equal(afterOnce.prompt, "approved A");
  assert.equal(afterOnce.trustReceipt?.contentDigest, a.digest);
  assert.equal(afterOnce.trustState, "changed-since-trust");
  assert.equal(afterOnce.enabled, false);

  const trustedB = schedule.trustLoopVersion(task.id, "space-1", b);
  assert.equal(trustedB.prompt, "pending B");
  assert.equal(trustedB.title, "Changed title");
  assert.equal(trustedB.agentProfile, "reviewer");
  assert.equal(trustedB.trustReceipt?.contentDigest, b.digest);
  assert.equal(trustedB.trustReceipt?.semanticDigest, loopSemanticDigest(b.loop!));
  assert.equal(trustedB.pendingVersion, undefined);
});

test("trust is invalidated by source identity and execution-time digest changes", () => {
  const a = file("a".repeat(64), loop("A"));
  const task: ScheduleTask = {
    id: "task-1",
    projectId: "project-1",
    prompt: "A",
    title: a.loop!.title,
    kind: "cron",
    cadence: { kind: "cron", expression: a.loop!.cron, timeZone: a.loop!.timeZone },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runs: 0,
    source: "loop-file",
    sourcePath: a.path,
    sourceDigest: a.digest,
    loopId: a.loop!.id,
    trustState: "trusted-current-version",
    trustReceipt: {
      version: 1,
      spaceId: "space-1",
      projectId: "project-1",
      sourceKind: "agents-loop",
      sourceIdentity: a.path,
      contentDigest: a.digest,
      semanticDigest: loopSemanticDigest(a.loop!),
      approvalScope: "current-version",
      approvedAt: 1,
    },
  };

  assert.doesNotThrow(() => assertLoopExecutionTrusted(task, a, "space-1"));
  const changedBytes = file("b".repeat(64), loop("B"));
  assert.throws(
    () => assertLoopExecutionTrusted(task, changedBytes, "space-1"),
    (error: unknown) => (error as { code?: string }).code === "content-trust-changed",
  );
  const renamed = file(a.digest, a.loop!, "/repo/.agents/loops/renamed.md");
  assert.throws(
    () => assertLoopExecutionTrusted(task, renamed, "space-1"),
    (error: unknown) => (error as { code?: string }).code === "content-trust-changed",
  );
  assert.throws(
    () => assertLoopExecutionTrusted(task, a, "space-2"),
    (error: unknown) => (error as { code?: string }).code === "content-trust-required",
  );
});

test("legacy managed tasks migrate fail-closed instead of inheriting implicit trust", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-loop-trust-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = join(dir, "schedule.json");
  const legacy: ScheduleTask = {
    id: "legacy",
    projectId: "project-1",
    prompt: "legacy prompt",
    kind: "cron",
    cadence: { kind: "cron", expression: "0 2 * * *", timeZone: "UTC" },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runs: 0,
    source: "loop-file",
    sourcePath: "/repo/.agents/loops/nightly.md",
    sourceDigest: "a".repeat(64),
    loopId: "nightly",
  };
  writeFileSync(storage, JSON.stringify({ v: 2, tasks: [legacy], loopErrors: {} }));

  const schedule = createScheduleService({
    file: storage,
    now: () => 1_700_000_000_000,
    runner: { async run() {} },
  });
  const migrated = schedule.get("legacy")!;
  assert.equal(migrated.trustState, "untrusted");
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.nextRunAt, null);
  const persisted = JSON.parse(readFileSync(storage, "utf8")) as { v?: number };
  assert.equal(persisted.v, 3);
});
