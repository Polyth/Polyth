// The background scan syncs every project's agent files once a minute. A scan
// that finds what the last one found must not rewrite the schedule document:
// with many projects that was the whole file, once per project, every minute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAgentFile, type AgentFileSpec } from "../src/agentFile.ts";
import { createScheduleService, type ScheduleRunner } from "../src/index.ts";
import { scanLoopsDir } from "../src/loops.ts";

const runner: ScheduleRunner = { async run() { return { sessionId: "s", markerSeq: 1 }; } };
const spec: AgentFileSpec = {
  id: "reviewer",
  name: "Reviewer",
  schedule: { cron: "0 9 * * *", timeZone: "UTC" },
  enabled: true,
  charter: "Review the open changes.",
};

function rig(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-loop-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
  const file = join(dir, "schedule.json");
  let clock = 1_000;
  const svc = createScheduleService({ file, runner, now: () => (clock += 60_000) });
  // Every save replaces the file atomically, so a new inode is a write.
  const written = (): number => statSync(file).ino;
  return { dir, svc, written, agentFile: (name: string) => join(dir, ".agents", "agents", name) };
}

test("an unchanged scan writes nothing; a changed one is saved", (t) => {
  const { dir, svc, written, agentFile } = rig(t);
  writeFileSync(agentFile("reviewer.md"), serializeAgentFile(spec));
  const scan = scanLoopsDir(dir);
  const agent = svc.syncLoops("prj", scan).tasks[0]!;
  // An agent that still waits for trust is re-observed by every scan; the
  // steady state is a trusted one.
  svc.trustLoopVersion(agent.id, "spc", scan[0]!);
  const first = written();

  for (let i = 0; i < 3; i++) assert.equal(svc.syncLoops("prj", scanLoopsDir(dir)).tasks.length, 1);
  svc.syncLoops("another-project", []);
  assert.equal(written(), first, "identical scans leave the document alone");

  writeFileSync(agentFile("reviewer.md"), serializeAgentFile({ ...spec, charter: "Review and summarize." }));
  const changed = svc.syncLoops("prj", scanLoopsDir(dir)).tasks[0]!;
  assert.notEqual(written(), first, "a changed file is saved");
  assert.ok(changed.pendingVersion, "and still waits for trust as before");
  const second = written();

  rmSync(agentFile("reviewer.md"));
  assert.equal(svc.syncLoops("prj", scanLoopsDir(dir)).tasks.length, 0);
  assert.notEqual(written(), second, "a removed file is saved");
});

test("a broken file is recorded once; a different error is saved", (t) => {
  const { dir, svc, written, agentFile } = rig(t);
  writeFileSync(agentFile("broken.md"), "---\nformat: agent/v9\n---\nx\n");
  const errors = svc.syncLoops("prj", scanLoopsDir(dir)).errors;
  assert.equal(errors.length, 1);
  const first = written();

  svc.syncLoops("prj", scanLoopsDir(dir));
  svc.syncLoops("prj", scanLoopsDir(dir));
  assert.equal(written(), first, "the same error seen again is not rewritten");

  writeFileSync(agentFile("broken.md"), "---\nformat: agent/v1\nname: Broken\n---\n   \n");
  svc.syncLoops("prj", scanLoopsDir(dir));
  assert.notEqual(written(), first, "a different error is saved");
});
