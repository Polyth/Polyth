// The macOS/Windows harness authority: a crash fence that a Windows Job Object
// (polyth-job.exe) can lift with kernel proof instead of a reboot.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPortableHarnessAuthority,
  quoteWindowsArgument,
  releaseHarnessProcessExecution,
  windowsJobContainment,
  type WindowsJobController,
} from "../src/processAuthority.ts";

const directory = () => mkdtempSync(join(tmpdir(), "polyth-portable-authority-"));
const JOB_RE = /^Local\\polyth-runtime-[0-9a-f]{24}-[1-9][0-9]*$/;

/** A controller that records which jobs it was asked to end. */
const fakeJobs = (released = true) => {
  const asked: string[] = [];
  const jobs: WindowsJobController = {
    launch: (job, line) => ({ command: process.execPath, args: ["-e", ""], env: { JOB: job, LINE: line } }),
    release: async (job) => { asked.push(job); return released; },
  };
  return { jobs, asked };
};

/** An authority whose executor started and was then lost in a crash. */
const crashed = async (file: string, jobs: WindowsJobController | null) => {
  const authority = await createPortableHarnessAuthority(file, false, jobs);
  return { authority, state: JSON.parse(readFileSync(file, "utf8")) as { containment?: { job: string }; released: boolean } };
};

test("without a job a crashed execution stays fenced until reboot", async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    const { state } = await crashed(file, null);
    assert.equal(state.containment, undefined);
    await assert.rejects(createPortableHarnessAuthority(file, false, null), (error: Error & { code?: string }) =>
      error.code === "outcome-unknown" && /explicitly released or the host is rebooted/.test(error.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a crashed execution whose job is gone lets the next generation start", async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    const { authority: first, state } = await crashed(file, fakeJobs().jobs);
    assert.match(state.containment!.job, JOB_RE);
    assert.equal(first.durable, true);
    const { jobs, asked } = fakeJobs(true);
    const next = await createPortableHarnessAuthority(file, false, jobs);
    assert.deepEqual(asked, [state.containment!.job], "only the crashed authority's own job is ended");
    assert.equal(next.generation, 2);
    assert.deepEqual(next.releasedAuthorities, [{ authorityId: first.authorityId, generation: 1 }]);
    const after = JSON.parse(readFileSync(file, "utf8")) as { containment: { job: string } };
    assert.notEqual(after.containment.job, state.containment!.job, "every generation gets its own job");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a job that cannot be verified as ended keeps the fence", async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    await crashed(file, fakeJobs().jobs);
    const before = readFileSync(file, "utf8");
    await assert.rejects(createPortableHarnessAuthority(file, false, fakeJobs(false).jobs), (error: Error & { code?: string }) =>
      error.code === "outcome-unknown" && /Windows job could not be verified/.test(error.message));
    assert.equal(readFileSync(file, "utf8"), before, "no new generation is published");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a state file naming another job is refused, never acted on", async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    await crashed(file, fakeJobs().jobs);
    const state = JSON.parse(readFileSync(file, "utf8")) as { containment: { job: string } };
    state.containment.job = "Local\\polyth-runtime-000000000000000000000000-1";
    writeFileSync(file, JSON.stringify(state));
    const { jobs, asked } = fakeJobs(true);
    await assert.rejects(createPortableHarnessAuthority(file, false, jobs), /malformed/);
    assert.deepEqual(asked, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("close ends the job and only then records the release", async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    const failing = fakeJobs(false);
    const authority = await createPortableHarnessAuthority(file, false, failing.jobs);
    const child = authority.spawn("tool.exe", ["a b"]);
    await new Promise((resolve) => child.once("exit", resolve));
    await assert.rejects(authority.close(), /did not end/);
    assert.equal((JSON.parse(readFileSync(file, "utf8")) as { released: boolean }).released, false);
    assert.equal(failing.asked.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("arguments are quoted the way Windows parses them back", () => {
  assert.equal(quoteWindowsArgument(""), '""');
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument("C:\\dir\\file"), "C:\\dir\\file");
  assert.equal(quoteWindowsArgument("two words"), '"two words"');
  assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArgument("C:\\with space\\"), '"C:\\with space\\\\"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
});

test("switching harness releases only through a verified job", { skip: process.platform === "linux" && "Linux uses supervisor receipts" }, async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    const { authority } = await crashed(file, fakeJobs().jobs);
    const binding = { authorityId: authority.authorityId, generation: authority.generation, epoch: 0, backendSessionId: "native-1" } as Parameters<typeof releaseHarnessProcessExecution>[1];
    const stale = await releaseHarnessProcessExecution(file, { ...binding, generation: 9 }, "op-0", fakeJobs().jobs);
    assert.equal(stale.kind, "rejected");
    const unverified = await releaseHarnessProcessExecution(file, binding, "op-1", fakeJobs(false).jobs);
    assert.equal(unverified.kind, "unknown");
    const released = await releaseHarnessProcessExecution(file, binding, "op-2", fakeJobs(true).jobs);
    assert.deepEqual(released, { kind: "confirmed", value: { authorityId: authority.authorityId, generation: 1, backendSessionId: "native-1" } });
    assert.equal((JSON.parse(readFileSync(file, "utf8")) as { released: boolean }).released, true);

    const plain = join(root, "plain.json");
    const { authority: uncontained } = await crashed(plain, null);
    const refused = await releaseHarnessProcessExecution(plain, { ...binding, authorityId: uncontained.authorityId }, "op-3", null);
    assert.equal(refused.kind, "rejected");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------- the real Windows boundary

const jobs = (process.platform === "win32" ? windowsJobContainment() : undefined) ?? null;
const windowsOnly = { skip: !jobs && "needs Windows and a built polyth-job.exe (npm run build:supervisor)" };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (condition: () => boolean, ms = 5_000) => {
  for (const started = Date.now(); Date.now() - started < ms;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
};
/** Starts a detached grandchild that never exits, records its PID, then stays. */
const treeScript = (pidFile: string) =>
  `const g=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e9)"],{detached:true,stdio:"ignore"});g.unref();require("fs").writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1e9)`;

test("a contained command keeps its pipes, arguments and exit code", windowsOnly, async () => {
  const root = directory();
  try {
    const authority = await createPortableHarnessAuthority(join(root, "authority.json"), false, jobs);
    const tricky = ["two words", 'say "hi"', "C:\\with space\\", "", "a\\\\b"];
    const child = authority.spawn(process.execPath, ["-e", "process.stdin.on('data',d=>{process.stdout.write(JSON.stringify([String(d),...process.argv.slice(1)]));process.exit(3)})", ...tricky]);
    let out = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stdin!.write("ping");
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 3);
    assert.deepEqual(JSON.parse(out), ["ping", ...tricky]);
    await authority.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a new generation ends a predecessor that is still running", windowsOnly, async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    const pidFile = join(root, "grandchild");
    const first = await createPortableHarnessAuthority(file, false, jobs);
    const child = first.spawn(process.execPath, ["-e", treeScript(pidFile)]);
    assert.ok(await until(() => existsSync(pidFile)));
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    // The first authority is lost without close(), as after a server restart.
    const next = await createPortableHarnessAuthority(file, false, jobs);
    assert.equal(next.generation, 2);
    assert.ok(await until(() => !alive(grandchild) && child.exitCode !== null), "the whole predecessor tree ended");
    await next.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("after the owning process crashes, the next owner starts without a reboot", windowsOnly, async () => {
  const root = directory();
  try {
    const file = join(root, "authority.json");
    const pidFile = join(root, "grandchild");
    const module = new URL("../src/processAuthority.ts", import.meta.url).href;
    // A stand-in for the Polyth server: it owns the authority and is then
    // killed outright, with no chance to close anything.
    const owner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      const { createHarnessProcessAuthority } = await import(${JSON.stringify(module)});
      const authority = await createHarnessProcessAuthority(${JSON.stringify(file)});
      authority.spawn(process.execPath, ["-e", ${JSON.stringify(treeScript(pidFile))}]).stdout.resume();
      setInterval(() => {}, 1e9);
    `], { stdio: "ignore" });
    assert.ok(await until(() => existsSync(pidFile), 15_000), "the owner started its executor");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    execFileSync("taskkill", ["/F", "/PID", String(owner.pid)]);
    assert.ok(await until(() => !alive(grandchild)), "the kernel ended the executor tree with its owner");
    const next = await createPortableHarnessAuthority(file, false, jobs);
    assert.equal(next.generation, 2);
    await next.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the helper refuses job names that are not Polyth's", windowsOnly, () => {
  const helper = join(import.meta.dirname, "..", "native", "bin", "win32", "polyth-job.exe");
  const refused = spawnSync(helper, ["terminate", "Local\\someone-else"], { encoding: "utf8" });
  assert.equal(refused.status, 64);
});
