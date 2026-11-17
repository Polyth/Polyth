import test from "node:test";
import assert from "node:assert/strict";
import type { SpaceContext } from "@polyth/contracts";
import { normalizeActionInput, type CustomActionDto } from "../src/actionModel.ts";
import { createRunManager, localUrlFromOutput, type RunTerminals } from "../src/runManager.ts";
import { MAX_RUNNING_LISTED, runningActionsContributor } from "../src/turnContext.ts";

const space = (spaceId = "s1", userId = "u1"): SpaceContext => ({
  spaceId, spaceSlug: spaceId, userId, role: "owner", deployment: "local-trusted", storageDir: `/tmp/${spaceId}`,
});
const action = (id: string, name: string): CustomActionDto => ({
  id, ...normalizeActionInput({ name, command: "secret-command --token=abc" }), createdAt: 1, updatedAt: 1,
});

function harness() {
  const data = new Set<(id: string, data: string) => void>();
  const exits = new Set<(id: string, code: number | null) => void>();
  let n = 0;
  const terminals: RunTerminals = {
    async create() { return { id: `t${++n}` }; },
    async close(id) { for (const l of exits) l(id, null); },
    onData(cb) { data.add(cb); return { dispose: () => data.delete(cb) }; },
    onExit(cb) { exits.add(cb); return { dispose: () => exits.delete(cb) }; },
  };
  let clock = 0;
  let ids = 0;
  const runs = createRunManager({ terminals: () => terminals, startChat: async () => "x", now: () => clock, id: () => `r${++ids}`, maxRunning: 20 });
  const start = (sp: SpaceContext, name: string, projectId = "p1", actionId = name) =>
    runs.start({ space: sp, action: action(actionId, name), projectId, sessionId: null, cwd: "/repo" });
  return {
    runs, start,
    emit: (id: string, text: string) => { for (const l of data) l(id, text); },
    exit: (id: string) => { for (const l of exits) l(id, 0); },
    at: (ms: number) => { clock = ms; },
  };
}
const input = (spaceId = "s1", projectId = "p1", userId: string | undefined = "u1") => ({ space: space(spaceId), sessionId: "ses", projectId, userId, worktreePath: undefined });

test("nothing running gives no block, also without a run manager", async () => {
  const h = harness();
  assert.equal(await runningActionsContributor({ runs: () => h.runs })(input()), "");
  assert.equal(await runningActionsContributor({ runs: () => undefined })(input()), "");
});

test("two runs: one with a printed localhost URL, one without; no command or output leaks", async () => {
  const h = harness();
  h.at(0);
  await h.start(space(), "Dev server");
  await h.start(space(), "Tests");
  h.emit("t1", "\u001b[32mready\u001b[0m on http://0.0.0.0:5173/app, secret-output\n");
  const block = await runningActionsContributor({ runs: () => h.runs, now: () => 125_000 })(input()) as string;
  const lines = block.split("\n");
  assert.equal(lines[0], "<polyth-running-actions>");
  assert.ok(lines.includes("Dev server — running 2m — http://localhost:5173/app"), block);
  assert.ok(lines.includes("Tests — running 2m"), block);
  assert.equal(lines.at(-2), "Reuse these instead of starting another copy; ask before stopping one.");
  assert.equal(lines.at(-1), "</polyth-running-actions>");
  assert.ok(!/secret|token|abc/.test(block));
});

test("a foreign Space or project run and a finished run never appear", async () => {
  const h = harness();
  await h.start(space("s1"), "Mine");
  await h.start(space("s2"), "Foreign space");
  await h.start(space("s1"), "Other project", "p2");
  const done = await h.start(space("s1"), "Finished");
  h.exit("t4");
  assert.equal(done.run.status, "running");
  const block = await runningActionsContributor({ runs: () => h.runs })(input("s1", "p1")) as string;
  assert.match(block, /Mine/);
  assert.doesNotMatch(block, /Foreign space|Other project|Finished/);
  assert.equal(await runningActionsContributor({ runs: () => h.runs })(input("s3", "p1")), "");
});

test("at most 8 runs are listed", async () => {
  const h = harness();
  for (let i = 0; i < 11; i++) await h.start(space(), `Run ${i}`);
  const block = await runningActionsContributor({ runs: () => h.runs })(input()) as string;
  assert.equal(block.split("\n").length, MAX_RUNNING_LISTED + 3);
});

test("local URL parsing: last localhost-like URL only", () => {
  assert.equal(localUrlFromOutput("a http://localhost:3000 b http://127.0.0.1:4000/x."), "http://127.0.0.1:4000/x");
  assert.equal(localUrlFromOutput("see https://example.com:8080"), null);
  assert.equal(localUrlFromOutput(""), null);
});

test("another person's run in the same Space and project is not listed; no author means no block", async () => {
  const h = harness();
  await h.start(space("s1", "u1"), "Mine");
  await h.start(space("s1", "u2"), "Theirs");
  const contribute = runningActionsContributor({ runs: () => h.runs });
  const mine = await contribute(input("s1", "p1", "u1")) as string;
  assert.match(mine, /Mine/);
  assert.doesNotMatch(mine, /Theirs/);
  assert.match(await contribute(input("s1", "p1", "u2")) as string, /Theirs/);
  assert.equal(await contribute({ ...input("s1", "p1"), userId: undefined }), "");
  assert.equal(await contribute(input("s1", "p1", "u3")), "");
});
