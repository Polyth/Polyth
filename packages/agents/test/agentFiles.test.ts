import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile, serializeAgentFile, type AgentFileSpec } from "../src/agentFile.ts";
import { explainMatch, validateTrigger } from "../src/agentEvents.ts";
import { createScheduleService, type ScheduleRunner } from "../src/index.ts";
import { scanLoopsDir } from "../src/loops.ts";
import { writeAgentFile } from "../src/serverEntry.ts";

function project(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
  return dir;
}
const runner: ScheduleRunner = { async run() { return { sessionId: "s", markerSeq: 1 }; } };

const full: AgentFileSpec = {
  id: "nightly-reviewer",
  name: "Нічний рев'юер: PR",
  description: "Reviews merged PRs.",
  icon: "review",
  color: "purple",
  schedule: { cron: "0 23 * * 1-5", timeZone: "Europe/Kyiv" },
  enabled: false,
  context: "rolling",
  rotateAt: 0.7,
  whenFull: "compact",
  keepWarm: "auto",
  overlap: "queue",
  catchUp: "skip",
  agentProfile: "prof_reviewer",
  model: "anthropic/claude-opus#high",
  harness: "claude",
  budget: { runsPerDay: 4, costPerDay: 1.5 },
  pauseAfterFailures: 3,
  approvals: { timeoutMinutes: 30, onTimeout: "reject" },
  wakes: [validateTrigger({ id: "fails", kind: "session", on: ["failed"], filters: [{ field: "title", op: "contains", value: "deploy: prod" }] })],
  charter: "You review every pull request merged today.\n\nReport risks first.",
};

test("an agent file round-trips exactly between the form and the file", () => {
  const text = serializeAgentFile(full);
  assert.match(text, /^---\nformat: agent\/v1\nid: nightly-reviewer\nname: "Нічний рев'юер: PR"\n/);
  assert.deepEqual(parseAgentFile(text).spec, full);
  assert.equal(serializeAgentFile(parseAgentFile(text).spec!), text, "serializing is deterministic");
  const minimal: AgentFileSpec = { id: "helper", name: "helper", enabled: true, charter: "Help." };
  assert.deepEqual(parseAgentFile(serializeAgentFile(minimal)).spec, minimal);
});

test("agent files are parsed strictly", () => {
  const head = "---\nid: a\n";
  assert.match(parseAgentFile(`${head}color: pink\n---\nx`).error!, /color/);
  assert.match(parseAgentFile(`${head}surprise: 1\n---\nx`).error!, /unknown key "surprise"/);
  assert.match(parseAgentFile(`${head}id: b\n---\nx`).error!, /duplicate key/);
  assert.match(parseAgentFile(`${head}budget: {runsPerDay: 4}\n---\nx`).error!, /JSON/);
  assert.match(parseAgentFile(`${head}model: opus\n---\nx`).error!, /provider\/model/);
  assert.match(parseAgentFile(`${head}wakes: [{"id":"h","kind":"webhook"}]\n---\nx`).error!, /set up in the app/);
  assert.match(parseAgentFile(`${head}---\n   `).error!, /body/);
  assert.match(parseAgentFile(`${head}format: agent/v2\n---\nx`).error!, /agent\/v1/);
});

test("a repository agent waits for trust, and any change to its settings needs trust again", (t) => {
  const dir = project(t);
  const file = join(dir, ".agents", "agents", "reviewer.md");
  writeFileSync(file, serializeAgentFile({ ...full, enabled: true }));
  const svc = createScheduleService({ file: join(dir, "schedule.json"), runner, now: () => 1_000 });
  let scan = scanLoopsDir(dir);
  const agent = svc.syncLoops("prj", scan).tasks[0]!;
  assert.equal(agent.trustState, "untrusted");
  assert.equal(agent.enabled, false, "nothing runs before trust");
  assert.equal(agent.target?.mode, "dedicated-session");
  assert.deepEqual(agent.budget, { runsPerDay: 4, costPerDay: 1.5 });
  assert.equal(agent.eventTriggers?.[0]?.id, "fails");
  assert.deepEqual(agent.model, { providerID: "anthropic", modelID: "claude-opus", variant: "high", harnessId: "claude" });

  svc.trustLoopVersion(agent.id, "spc", scan[0]!);
  assert.equal(svc.get(agent.id)!.enabled, true);
  assert.equal(svc.get(agent.id)!.trustReceipt!.sourceKind, "agents-agent");
  assert.throws(() => svc.update(agent.id, { budget: null }), /managed by/, "settings are edited in the file");

  writeFileSync(file, serializeAgentFile({ ...full, enabled: true, budget: { runsPerDay: 400 } }));
  scan = scanLoopsDir(dir);
  svc.syncLoops("prj", scan);
  const changed = svc.get(agent.id)!;
  assert.equal(changed.trustState, "changed-since-trust");
  assert.deepEqual(changed.pendingVersion!.changedFields, ["settings"]);
  assert.equal(changed.enabled, false);
  assert.deepEqual(changed.budget, { runsPerDay: 4, costPerDay: 1.5 }, "the trusted settings stay in force until approved");
});

test("symlinked agent directories are not read", (t) => {
  const dir = project(t);
  const outside = mkdtempSync(join(tmpdir(), "polyth-agent-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "evil.md"), serializeAgentFile({ id: "evil", name: "evil", enabled: true, charter: "x" }));
  rmSync(join(dir, ".agents", "agents"), { recursive: true });
  symlinkSync(outside, join(dir, ".agents", "agents"));
  assert.deepEqual(scanLoopsDir(dir), []);
});

test("exporting an app agent writes its file, keeps its history and trusts exactly those bytes", (t) => {
  const dir = project(t);
  const svc = createScheduleService({ file: join(dir, "schedule.json"), runner, now: () => 1_000 });
  const agent = svc.create({
    projectId: "prj", prompt: "You watch the build.", title: "Build watcher", kind: "every", everyMinutes: 60, manualOnly: true,
    target: { mode: "dedicated-session" }, budget: { runsPerDay: 2 },
    eventTriggers: [{ id: "fails", kind: "session", on: ["failed"] }],
  });
  const before = svc.get(agent.id)!;
  before.history = [{ runId: "r1", startedAt: 1, status: "ok", summary: "Green." }];
  const exported = writeAgentFile(svc, before, { path: dir }, "export", "spc");
  assert.equal(exported.filePath, ".agents/agents/build-watcher.md");
  const text = readFileSync(join(dir, exported.filePath), "utf8");
  assert.match(text, /context: rolling\nbudget: \{"runsPerDay":2\}\nwakes: \[\{"id":"fails"/);
  const after = svc.get(agent.id)!;
  assert.equal(after.source, "loop-file");
  assert.equal(after.trustState, "trusted-current-version");
  assert.equal(after.history?.[0]?.summary, "Green.", "the journal stays");
  // A rescan of the same bytes changes nothing.
  svc.syncLoops("prj", scanLoopsDir(dir));
  assert.equal(svc.get(agent.id)!.trustState, "trusted-current-version");

  assert.throws(() => writeAgentFile(svc, svc.get(agent.id)!, { path: dir }, "export", "spc"), /already lives in a file/);
  const hooked = svc.create({ projectId: "prj", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, eventTriggers: [{ id: "h", kind: "webhook" }] });
  assert.throws(() => writeAgentFile(svc, hooked, { path: dir }, "export", "spc"), /webhook/);
  const oneSession = svc.create({ projectId: "prj", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, target: { mode: "existing-session", sessionId: "s" } });
  assert.throws(() => writeAgentFile(svc, oneSession, { path: dir }, "export", "spc"), /one chosen session/);
});

test("a trusted loop converts into an agent file in place of the old one", (t) => {
  const dir = project(t);
  mkdirSync(join(dir, ".agents", "loops"));
  const loopPath = join(dir, ".agents", "loops", "digest.md");
  writeFileSync(loopPath, "---\nid: digest\ncron: 0 6 * * *\ntimeZone: UTC\n---\nSummarise yesterday.");
  const svc = createScheduleService({ file: join(dir, "schedule.json"), runner, now: () => 1_000 });
  const scan = scanLoopsDir(dir);
  const loop = svc.syncLoops("prj", scan).tasks[0]!;
  assert.throws(() => writeAgentFile(svc, loop, { path: dir }, "convert", "spc"), /Trust the loop/);
  svc.trustLoopVersion(loop.id, "spc", scan[0]!);
  const converted = writeAgentFile(svc, svc.get(loop.id)!, { path: dir }, "convert", "spc");
  assert.equal(converted.id, loop.id, "same agent, same history");
  assert.equal(existsSync(loopPath), false);
  assert.match(readFileSync(join(dir, ".agents", "agents", "digest.md"), "utf8"), /schedule: "0 6 \* \* \*"\ntimeZone: UTC/);
  svc.syncLoops("prj", scanLoopsDir(dir));
  assert.equal(svc.get(loop.id)!.trustState, "trusted-current-version");
});

test("the dry run says which rule kept an event from waking the agent", () => {
  const trigger = validateTrigger({ id: "t", kind: "session", on: ["failed"], filters: [{ field: "title", op: "contains", value: "deploy" }] });
  const event = { id: "e", kind: "session" as const, at: 0, projectId: "p", outcome: "failed", chainDepth: 0, fields: { title: "Docs" } };
  assert.deepEqual(explainMatch(trigger, { ...event, fields: { title: "Deploy" } }, "me"), { matched: true });
  assert.deepEqual(explainMatch(trigger, { ...event, outcome: "completed" }, "me"), { matched: false, reason: "outcome" });
  assert.deepEqual(explainMatch(trigger, event, "me"), { matched: false, reason: "filter", filter: trigger.filters![0] });
  assert.deepEqual(explainMatch(trigger, { ...event, sourceAgentId: "me" }, "me"), { matched: false, reason: "own" });
});
