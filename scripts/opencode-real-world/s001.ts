/** OC-REAL-001: owned local runtime start from clean dirs; occupied first
 * port; stale invalid PID record. Real `opencode serve` children only. */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { readlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  createOpenCodeRuntimeLifecycle,
  createOwnedLocalEndpointLease,
} from "@polyth/backend-opencode";
import {
  applyScratchEnv,
  makeScratch,
  sleep,
  writeEvidence,
  writeVerdict,
  OPENCODE_VERSION,
} from "./lib.ts";

interface PidRecord {
  child: { pid: number };
}

const procAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const unhandled: string[] = [];
let phase = "init";
process.on("unhandledRejection", (reason) => {
  unhandled.push(`[${phase}] unhandledRejection: ${String(reason)}`);
});
process.on("uncaughtException", (error) => {
  unhandled.push(`[${phase}] uncaughtException: ${String(error)}`);
  console.error(`uncaught during phase=${phase}:`, String(error));
});

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-001");
  applyScratchEnv(scratch);
  const findings: Record<string, unknown> = {};
  const failures: string[] = [];

  // --- Case A: clean start ---
  phase = "case-a";
  const pidFileA = join(scratch.root, "pid-a.json");
  const leaseA = await createOwnedLocalEndpointLease({
    cwd: scratch.project,
    pidFile: pidFileA,
  });
  const startedAt = Date.now();
  const lifecycleA = await createOpenCodeRuntimeLifecycle({ lease: leaseA, protocol: "legacy" });
  const readyMs = Date.now() - startedAt;
  const endpointA = await lifecycleA.endpoint();
  const recordA = JSON.parse(await readFile(pidFileA, "utf8")) as PidRecord;
  const childPidA = recordA.child.pid;
  const childCwd = await readlink(`/proc/${childPidA}/cwd`).catch(() => "unreadable");
  findings.cleanStart = {
    readyMs,
    generation: endpointA.generation,
    url: endpointA.url,
    childPid: childPidA,
    childAlive: procAlive(childPidA),
    childCwd,
    cwdMatches: childCwd === scratch.project,
    pidRecordExists: existsSync(pidFileA),
  };
  if (endpointA.generation !== 1) failures.push("clean start generation != 1");
  if (childCwd !== scratch.project) failures.push(`child cwd mismatch: ${childCwd}`);
  await lifecycleA.dispose();
  await sleep(500);
  findings.cleanStartAfterDispose = {
    childAlive: procAlive(childPidA),
    pidRecordExists: existsSync(pidFileA),
  };
  if (procAlive(childPidA)) failures.push("child leaked after dispose");
  if (existsSync(pidFileA)) failures.push("pid record not removed on dispose");

  // --- Case B: occupied first port ---
  phase = "case-b";
  const blocker = createNetServer();
  const occupiedPort = await new Promise<number>((resolvePort) => {
    blocker.listen(0, "127.0.0.1", () => {
      const address = blocker.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });
  const pidFileB = join(scratch.root, "pid-b.json");
  let caseB: Record<string, unknown>;
  try {
    // The first spawn happens inside lease creation.
    const leaseB = await createOwnedLocalEndpointLease({
      cwd: scratch.project,
      port: occupiedPort,
      pidFile: pidFileB,
    });
    const lifecycleB = await createOpenCodeRuntimeLifecycle({ lease: leaseB, protocol: "legacy" });
    const endpointB = await lifecycleB.endpoint();
    const recordB = JSON.parse(await readFile(pidFileB, "utf8")) as PidRecord;
    const boundPort = Number(new URL(endpointB.url).port);
    caseB = {
      occupiedPort,
      boundPort,
      movedToFreePort: boundPort !== occupiedPort,
      childPid: recordB.child.pid,
      childAlive: procAlive(recordB.child.pid),
    };
    if (boundPort === occupiedPort) failures.push("lease claims to bind the occupied port");
    await lifecycleB.dispose();
    await sleep(500);
    (caseB as { childAliveAfterDispose?: boolean }).childAliveAfterDispose = procAlive(recordB.child.pid);
    if (procAlive(recordB.child.pid)) failures.push("case B child leaked");
  } catch (error) {
    caseB = {
      occupiedPort,
      error: String(error),
      code: (error as { code?: string }).code,
      analysis: "real 1.18.18 reports a bind collision as exit 1 + `ServeError: Unexpected error` with no EADDRINUSE/`address already in use` text, so BIND_COLLISION_RE never classifies it as port-in-use and the lease aborts instead of retrying a free port",
    };
    failures.push(`occupied-port start failed instead of retrying a free port: ${String(error).slice(0, 160)}`);
  } finally {
    blocker.close();
  }
  findings.occupiedFirstPort = caseB;

  // --- Case C: stale INVALID pid record pointing at an unrelated live process ---
  phase = "case-c";
  const decoy = spawn("sleep", ["300"], { stdio: "ignore" });
  await sleep(100);
  const pidFileC = join(scratch.root, "pid-c.json");
  await mkdir(dirname(pidFileC), { recursive: true });
  await writeFile(pidFileC, JSON.stringify({
    version: 1,
    ownerPid: 99999,
    ownerInstanceToken: "stale-token-oc-real-001",
    child: {
      pid: decoy.pid,
      startIdentity: "bogus-start-identity",
      executable: "/usr/bin/opencode-that-never-existed",
      command: "opencode serve --hostname 127.0.0.1 --port 1",
    },
  }));
  const leaseC = await createOwnedLocalEndpointLease({
    cwd: scratch.project,
    pidFile: pidFileC,
  });
  const lifecycleC = await createOpenCodeRuntimeLifecycle({ lease: leaseC, protocol: "legacy" });
  const endpointC = await lifecycleC.endpoint();
  const recordC = JSON.parse(await readFile(pidFileC, "utf8")) as PidRecord;
  findings.staleInvalidPidRecord = {
    decoyPid: decoy.pid,
    decoyStillAlive: procAlive(decoy.pid!),
    staleRecordReplaced: recordC.child.pid !== decoy.pid,
    newChildPid: recordC.child.pid,
    generation: endpointC.generation,
  };
  if (!procAlive(decoy.pid!)) failures.push("unrelated decoy process was signalled");
  if (recordC.child.pid === decoy.pid) failures.push("stale record not replaced");
  await lifecycleC.dispose();
  decoy.kill("SIGKILL");
  await sleep(300);
  if (procAlive(recordC.child.pid)) failures.push("case C child leaked");

  findings.failures = failures;
  findings.unhandledRejections = unhandled;
  await writeEvidence(scratch, "lifecycle-cases.json", findings);
  await writeVerdict(scratch, {
    id: "OC-REAL-001",
    verdict: failures.length === 0 ? "pass" : "fail",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy (forced)",
    observed: failures.length === 0
      ? `clean start ready in ${(findings.cleanStart as { readyMs: number }).readyMs}ms gen 1, exact cwd, pid record lifecycle correct; occupied port moved to free port; stale invalid pid record removed without signalling the unrelated process`
      : `failures: ${failures.join("; ")}`,
    expected: "one child ready inside deadline; stale record removed; collision retried on a free port with the collision child reaped; no unrelated PID signalled",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    evidence: [
      "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-001/lifecycle-cases.json",
    ],
    notes: "protocol forced to legacy because OC-REAL-026 shows auto selects disabled V2 on 1.18.18.",
  });
};

await main();
