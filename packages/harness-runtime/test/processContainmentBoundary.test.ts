import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProcessContainmentBoundary, releaseProcessContainmentRecord, type ProcessContainmentController } from "../src/authority.ts";

test("an unsubmitted unit cannot prove release while its launcher can still run", async () => {
  let state: "active" | "empty" = "empty";
  let releases = 0;
  const controller: ProcessContainmentController = {
    create: () => ({ kind: "systemd-user-scope", unit: "test-owned.scope", bootId: "test-boot" }),
    launch: (_scope, command, args) => ({ command, args: [...args] }),
    status: async () => state,
    release: async () => { releases += 1; return true; },
  };
  const boundary = createProcessContainmentBoundary(controller)!;
  boundary.launch("test-shell", []);
  const closing = boundary.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(releases, 0, "not-found before launch admission is not release proof");
  state = "active";
  await closing;
  assert.equal(releases, 1);
  await boundary.close();
  assert.equal(releases, 1, "successful release is idempotent");
});

test("failed containment release remains retryable and a stopped launcher permits empty-unit proof", async () => {
  let released = false;
  const boundary = createProcessContainmentBoundary({
    create: () => ({ kind: "systemd-user-scope", unit: "test-owned.scope", bootId: "test-boot" }),
    launch: (_scope, command, args) => ({ command, args: [...args] }),
    status: async () => released ? "empty" : "active",
    release: async () => released,
  })!;
  boundary.launch("test-shell", []);
  await assert.rejects(boundary.close(), { code: "outcome-unknown" });
  boundary.launcherExited();
  released = true;
  await boundary.close();
  assert.throws(() => boundary.launch("another-shell", []), { code: "conflict" });
});

test("Linux kernel containment releases a background descendant after its shell exits", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-terminal-kernel-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "authority.json");
  const boundary = createProcessContainmentBoundary(undefined, { file });
  if (!boundary) { context.skip("Linux systemd user containment is unavailable"); return; }
  const launch = boundary.launch("/bin/sh", ["-c", "sleep 30 & echo $!; exit 0"]);
  // The fixture's scope is a sibling of the test-runner service, so explicitly
  // bound that exact owned unit as well. No provider or ambient process runs.
  const commandIndex = launch.args.indexOf("/bin/sh");
  assert.ok(commandIndex > 0);
  launch.args.splice(commandIndex, 0, "--property=MemoryMax=64M", "--property=MemorySwapMax=0",
    "--property=CPUQuota=25%", "--property=TasksMax=8", "--property=RuntimeMaxSec=8s");
  const child = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid !== undefined) boundary.launcherStarted!(child.pid);
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += String(chunk).slice(0, 4096 - output.length); });
  child.stderr.on("data", (chunk) => { errors += String(chunk).slice(0, 4096 - errors.length); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => { boundary.launcherExited(); resolve(code); });
    });
    assert.equal(code, 0, errors);
    const pid = Number(output.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1, "fixture reports only its own background child");
    // Recovery creates no replacement executor and does not need the live
    // boundary handle to terminate the recorded scope.
    await releaseProcessContainmentRecord(file);
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    assert.ok(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "), "background process cannot keep executing after verified scope release");
  } finally {
    await boundary.close();
  }
});

test("persisted containment recovers the exact authority and rejects unresolved admission or a forged unit", async (context) => {
  if (process.platform !== "linux") { context.skip("Linux boot identity fixture"); return; }
  const root = await mkdtemp(join(tmpdir(), "polyth-terminal-proof-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "authority.json");
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  let state: "active" | "empty" = "empty";
  const releases: string[] = [];
  const controller: ProcessContainmentController = {
    create: (proof) => ({ kind: "systemd-user-scope", bootId,
      unit: `polyth-runtime-${createHash("sha256").update(proof.authorityId).digest("hex").slice(0, 24)}-${proof.generation}.scope` }),
    launch: (_scope, command, args) => ({ command, args: [...args] }),
    status: async () => state,
    release: async (scope) => { releases.push(scope.unit); return true; },
  };
  const boundary = createProcessContainmentBoundary(controller, { file })!;
  boundary.launch("fixture", []);
  boundary.launcherStarted!(process.pid);
  await assert.rejects(releaseProcessContainmentRecord(file, controller), { code: "outcome-unknown" });
  assert.equal(releases.length, 0, "an empty unit with a live unadmitted launcher must not be released");
  const original = await readFile(file, "utf8");
  const record = JSON.parse(original);
  record.containment.unit = "polyth-runtime-000000000000000000000000-1.scope";
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(releaseProcessContainmentRecord(file, controller), { code: "outcome-unknown" });
  assert.equal(releases.length, 0);
  await writeFile(file, original);
  state = "active";
  await releaseProcessContainmentRecord(file, controller);
  assert.equal(releases[0], JSON.parse(original).containment.unit);
  assert.equal(JSON.parse(await readFile(file, "utf8")).released, true);
  await releaseProcessContainmentRecord(file, controller);
  assert.equal(releases.length, 1);

  const oldBoot = { ...JSON.parse(original), containment: { ...JSON.parse(original).containment, bootId: randomUUID() } };
  await writeFile(file, JSON.stringify(oldBoot));
  await releaseProcessContainmentRecord(file, { ...controller, release: async () => { throw new Error("old boot must not signal a current unit"); } });
  assert.equal(JSON.parse(await readFile(file, "utf8")).released, true);
});
