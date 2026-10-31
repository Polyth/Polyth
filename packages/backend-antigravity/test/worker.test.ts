import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { ANTIGRAVITY_WORKER_SOURCE } from "../src/workerSource.ts";

const FAKE_AGY = `import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const at = args.indexOf("--conversation");
const id = at >= 0 ? args[at + 1] : "native-a";
const permission_mode = args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review";
process.stdout.write(JSON.stringify({ event: "init", conversation_id: id, init: { cwd: process.cwd(), model: "fixture-gemini", permission_mode } }) + "\\n");
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const input = JSON.parse(line);
  if (input?.message?.content === "bye") process.exit(0);
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: id, step_index: 0, state: "DONE", step_type: "user_input" } }) + "\\n");
  if (input?.message?.content === "limited") {
    process.stderr.write('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","http_status":429,"retryable":true,"message":"Individual quota reached. Resets in 2h."}\\n');
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: id, status: "ERROR", response: "", error: "Agent execution terminated due to error.", num_turns: 2 } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "ok", num_turns: 1 } }) + "\\n");
});
`;

const LATE_INIT_AGY = `import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const at = args.indexOf("--conversation");
const id = at >= 0 ? args[at + 1] : "native-a";
const permission_mode = args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review";
const init = JSON.stringify({ event: "init", conversation_id: id, init: { cwd: process.cwd(), model: "fixture-gemini", permission_mode } });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const input = JSON.parse(line);
  if (input?.event === "user" && input.message && !Object.prototype.hasOwnProperty.call(input.message, "content")) {
    process.stdout.write(init + "\\n");
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: id, status: "ERROR", response: "", error: "stream input user message has no content", duration_seconds: 0, num_turns: 0 } }) + "\\n");
    process.exit(1);
  }
  process.stdout.write(init + "\\n");
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: id, step_index: 0, state: "DONE", step_type: "user_input" } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "ok", num_turns: 1 } }) + "\\n");
});
`;

// CLI 1.2.10 defers init until stdin, but the leg stays alive after the probe.
// The worker must not write a real prompt into it; it relaunches instead.
const PROBE_STAYS_AGY = `import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const at = args.indexOf("--conversation");
const id = at >= 0 ? args[at + 1] : "native-a";
const permission_mode = args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review";
const init = JSON.stringify({ event: "init", conversation_id: id, init: { cwd: process.cwd(), model: "fixture-gemini", permission_mode } });
let probed = false;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const input = JSON.parse(line);
  if (!probed && input?.event === "user" && input.message && !Object.prototype.hasOwnProperty.call(input.message, "content")) {
    probed = true;
    process.stdout.write(init + "\\n");
    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: id, status: "ERROR", response: "", error: "stream input user message has no content", num_turns: 0 } }) + "\\n");
    return;
  }
  process.stdout.write(init + "\\n");
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

async function startWorker(t: TestContext, agySource = FAKE_AGY) {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerFile = join(root, "worker.mjs");
  const fakeFile = join(root, "fake-agy.mjs");
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(workerFile, ANTIGRAVITY_WORKER_SOURCE),
    writeFile(fakeFile, agySource),
  ]);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // Keep the deferred-init probe from adding real seconds to the test, but stay
  // above Node's own child-process startup so a spontaneous init can win.
  env.POLYTH_ANTIGRAVITY_PROBE_DELAY_MS = "250";
  const worker = spawn(process.execPath, [workerFile], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  worker.stderr!.resume();
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  return {
    worker,
    fakeFile,
    next: frameReader(worker),
    write: (control: Record<string, unknown>) => worker.stdin!.write(JSON.stringify(control) + "\n"),
  };
}

test("owned worker replaces only the idle native leg when the launch bypass changes", async (t) => {
  const { worker, fakeFile, next, write } = await startWorker(t);
  const reviewArgs = [fakeFile, "--input-format", "stream-json", "--output-format", "stream-json"];
  write({
    event: "polyth_launch",
    command: process.execPath,
    args: reviewArgs,
    mode: "review",
  });
  const initial = await next();
  assert.equal((initial.init as Record<string, unknown>).permission_mode, "request-review");

  const input = { event: "user", message: { content: "hello" } };
  worker.stdin!.write(JSON.stringify({ event: "polyth_user", args: reviewArgs, mode: "review", input }) + "\n");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const autoArgs = [...reviewArgs, "--dangerously-skip-permissions", "--conversation", "native-a"];
  worker.stdin!.write(JSON.stringify({ event: "polyth_user", args: autoArgs, mode: "auto", input }) + "\n");
  const reinit = await next();
  assert.equal(reinit.event, "polyth_reinit");
  const native = (reinit.polyth_reinit as Record<string, unknown>).init as Record<string, unknown>;
  assert.equal(native.permission_mode, "always-proceed");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const limited = { event: "user", message: { content: "limited" } };
  worker.stdin!.write(JSON.stringify({ event: "polyth_user", args: autoArgs, mode: "auto", input: limited }) + "\n");
  const limitedFrames = [await next(), await next(), await next()];
  assert.equal(limitedFrames.some((frame) => frame.event === "step_update"), true);
  assert.deepEqual(limitedFrames.find((frame) => frame.event === "polyth_native_error"), {
    event: "polyth_native_error",
    polyth_native_error: {
      status: "RESOURCE_EXHAUSTED",
      http_status: 429,
      retryable: true,
      message: "Individual quota reached. Resets in 2h.",
    },
  });
  assert.equal(limitedFrames.some((frame) => frame.event === "result"), true);

  const closed = new Promise<number | null>((resolve) => worker.once("close", resolve));
  worker.stdin!.end();
  assert.equal(await closed, 0);
});

test("initialization probe obtains init when the CLI waits for stdin", async (t) => {
  const { worker, fakeFile, next, write } = await startWorker(t, LATE_INIT_AGY);
  const launchArgs = [fakeFile, "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];
  write({ event: "polyth_launch", command: process.execPath, args: launchArgs, mode: "auto" });

  // The probe result is consumed before init is exposed; the native leg exits
  // without a model turn, and the worker remains available for the first turn.
  assert.equal((await next()).event, "init");
  assert.equal((await next()).event, "polyth_native_closed");

  const input = { event: "user", message: { content: "hello" } };
  const resumeArgs = [...launchArgs, "--conversation", "native-a"];
  write({ event: "polyth_user", args: resumeArgs, mode: "auto", input });
  assert.equal((await next()).event, "polyth_reinit");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const closed = new Promise<number | null>((resolve) => worker.once("close", resolve));
  worker.stdin!.end();
  assert.equal(await closed, 0);
});

test("a spontaneous init is forwarded without a probe and the leg serves the first turn", async (t) => {
  const { worker, fakeFile, next, write } = await startWorker(t);
  const launchArgs = [fakeFile, "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];
  write({ event: "polyth_launch", command: process.execPath, args: launchArgs, mode: "auto" });

  // The CLI emits its own init before the grace period ends; no throwaway
  // probe leg is started and no native close is reported.
  assert.equal((await next()).event, "init");
  const input = { event: "user", message: { content: "hello" } };
  write({ event: "polyth_user", args: launchArgs, mode: "auto", input });
  // The healthy leg takes the prompt directly; no replacement initialization.
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const closed = new Promise<number | null>((resolve) => worker.once("close", resolve));
  worker.stdin!.end();
  assert.equal(await closed, 0);
});

test("a real prompt replaces a still-open probe leg instead of being written into it", async (t) => {
  const { worker, fakeFile, next, write } = await startWorker(t, PROBE_STAYS_AGY);
  const launchArgs = [fakeFile, "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];
  write({ event: "polyth_launch", command: process.execPath, args: launchArgs, mode: "auto" });
  assert.equal((await next()).event, "init");

  const input = { event: "user", message: { content: "hello" } };
  const resumeArgs = [...launchArgs, "--conversation", "native-a"];
  write({ event: "polyth_user", args: resumeArgs, mode: "auto", input });
  assert.equal((await next()).event, "polyth_reinit");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const closed = new Promise<number | null>((resolve) => worker.once("close", resolve));
  worker.stdin!.end();
  assert.equal(await closed, 0);
});

test("owned worker survives a stopped or exited native leg and relaunches the recorded conversation", async (t) => {
  const { worker, fakeFile, next, write } = await startWorker(t);
  const launchArgs = [fakeFile, "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];
  write({ event: "polyth_launch", command: process.execPath, args: launchArgs, mode: "auto" });
  assert.equal((await next()).event, "init");
  const resumeArgs = [...launchArgs, "--conversation", "native-a"];
  const input = { event: "user", message: { content: "hello" } };

  // A stop releases the native tree only; the worker keeps the authority's
  // containment boundary so the session is not stranded.
  write({ event: "polyth_stop" });
  assert.equal((await next()).event, "polyth_released");
  assert.equal(worker.exitCode, null);

  write({ event: "polyth_user", args: resumeArgs, mode: "auto", input });
  const resumed = await next();
  assert.equal(resumed.event, "polyth_reinit");
  assert.equal((resumed.polyth_reinit as Record<string, unknown>).conversation_id, "native-a");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  // A native leg that exits on its own is reported, not fatal, and the next
  // turn relaunches the same conversation.
  write({ event: "polyth_user", args: resumeArgs, mode: "auto", input: { event: "user", message: { content: "bye" } } });
  assert.equal((await next()).event, "polyth_native_closed");
  write({ event: "polyth_user", args: resumeArgs, mode: "auto", input });
  assert.equal((await next()).event, "polyth_reinit");
  assert.equal((await next()).event, "step_update");
  assert.equal((await next()).event, "result");

  const closed = new Promise<number | null>((resolve) => worker.once("close", resolve));
  worker.stdin!.end();
  assert.equal(await closed, 0);
});
