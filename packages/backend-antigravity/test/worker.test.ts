import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { ANTIGRAVITY_WORKER_SOURCE } from "../src/workerSource.ts";

const FAKE_AGY = `import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const at = args.indexOf("--conversation");
const id = at >= 0 ? args[at + 1] : "native-a";
const permission_mode = args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review";
process.stdout.write(JSON.stringify({ event: "init", conversation_id: id, init: { cwd: process.cwd(), model: "fixture-gemini", permission_mode } }) + "\\n");
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  JSON.parse(line);
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: id, step_index: 0, state: "DONE", step_type: "user_input" } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "ok", num_turns: 1 } }) + "\\n");
});
`;

function frameReader(child: ChildProcess) {
  const queued: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
    const frame = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  return () => queued.length
    ? Promise.resolve(queued.shift()!)
    : new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker frame timed out")), 2_000);
        waiters.push((value) => { clearTimeout(timer); resolve(value); });
      });
}

test("owned worker replaces only the idle native leg when Auto-Approve changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerFile = join(root, "worker.mjs");
  const fakeFile = join(root, "fake-agy.mjs");
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(workerFile, ANTIGRAVITY_WORKER_SOURCE),
    writeFile(fakeFile, FAKE_AGY),
  ]);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const worker = spawn(process.execPath, [workerFile], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  worker.stderr!.resume();
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  const next = frameReader(worker);
  const reviewArgs = [fakeFile, "--input-format", "stream-json", "--output-format", "stream-json"];
  worker.stdin!.write(JSON.stringify({
    event: "polyth_launch",
    command: process.execPath,
    args: reviewArgs,
    mode: "review",
  }) + "\n");
  const initial = await next();
  assert.equal((initial.init as Record<string, unknown>).permission_mode, "request-review");

  const input = { event: "user", message: { content: "hello" } };
  worker.stdin!.write(JSON.stringify({ event: "polyth_user", args: reviewArgs, mode: "review", input }) + "\n");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const autoArgs = [...reviewArgs, "--conversation", "native-a", "--dangerously-skip-permissions"];
  worker.stdin!.write(JSON.stringify({ event: "polyth_user", args: autoArgs, mode: "auto", input }) + "\n");
  const reinit = await next();
  assert.equal(reinit.event, "polyth_reinit");
  const native = (reinit.polyth_reinit as Record<string, unknown>).init as Record<string, unknown>;
  assert.equal(native.permission_mode, "always-proceed");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const closed = new Promise<number | null>((resolve) => worker.once("close", resolve));
  worker.stdin!.end();
  assert.equal(await closed, 0);
});
