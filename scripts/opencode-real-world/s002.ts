/** OC-REAL-002 (R+H): readiness paths succeed / fail / stall / recover against
 * REAL opencode serve through the local fault proxy. */
import { join } from "node:path";
import {
  createOpenCodeTransport,
  waitForRuntimeReady,
} from "@polyth/backend-opencode";
import {
  httpJson,
  makeScratch,
  spawnServe,
  startFaultProxy,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
} from "./lib.ts";

const READY_PATHS = /GET \/(global\/health|api\/health|agent|provider)/;

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-002");
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  const proxy = await startFaultProxy(serve.url, wire);
  const failures: string[] = [];
  const findings: Record<string, unknown> = {};
  try {
    const transport = () => createOpenCodeTransport({
      baseUrl: proxy.url,
      directory: scratch.project,
    });

    // Raw readiness path status codes against the real server.
    const rawStatuses: Record<string, number> = {};
    for (const path of ["/global/health", "/api/health", "/agent", "/provider"]) {
      const result = await httpJson(serve.url, "GET", `${path}?directory=${encodeURIComponent(scratch.project)}`);
      rawStatuses[path] = result.status;
    }
    findings.rawStatuses = rawStatuses;

    // 1. Healthy: all paths pass; ready fast.
    let start = Date.now();
    await waitForRuntimeReady(transport(), { startupDeadlineMs: 10_000, probeDeadlineMs: 1_000 });
    findings.healthyReadyMs = Date.now() - start;

    // 2. All readiness paths fail with 500: bounded startup failure.
    proxy.setRule(READY_PATHS, { kind: "error", status: 500 });
    start = Date.now();
    let failBounded = false;
    try {
      await waitForRuntimeReady(transport(), { startupDeadlineMs: 3_000, probeDeadlineMs: 500 });
      failures.push("ready succeeded although every readiness path returned 500");
    } catch (error) {
      const elapsed = Date.now() - start;
      failBounded = elapsed < 5_000;
      findings.allFail500 = { elapsed, error: String(error).slice(0, 200) };
      if (!failBounded) failures.push(`500-failure not bounded: ${elapsed}ms`);
    }

    // 3. All readiness paths stall (black hole): bounded startup failure.
    proxy.setRule(READY_PATHS, { kind: "black-hole" });
    start = Date.now();
    try {
      await waitForRuntimeReady(transport(), { startupDeadlineMs: 3_000, probeDeadlineMs: 500 });
      failures.push("ready succeeded although every readiness path stalled");
    } catch (error) {
      const elapsed = Date.now() - start;
      findings.allStall = { elapsed, error: String(error).slice(0, 200) };
      if (elapsed > 6_000) failures.push(`stall-failure not bounded: ${elapsed}ms`);
    }
    proxy.killActiveSockets();

    // 4. Partial: /global/health stalls but /api/health succeeds -> ready.
    proxy.setRule(/GET \/global\/health/, { kind: "black-hole" });
    start = Date.now();
    await waitForRuntimeReady(transport(), { startupDeadlineMs: 10_000, probeDeadlineMs: 500 });
    findings.globalStalledOthersOk = { readyMs: Date.now() - start };
    proxy.killActiveSockets();

    // 5. Recovery: stall everything, then clear the fault after 1.5s -> ready.
    proxy.setRule(READY_PATHS, { kind: "black-hole" });
    setTimeout(() => proxy.setRule(undefined), 1_500);
    start = Date.now();
    await waitForRuntimeReady(transport(), { startupDeadlineMs: 15_000, probeDeadlineMs: 500 });
    const recoveredMs = Date.now() - start;
    findings.recovery = { recoveredMs };
    if (recoveredMs < 1_000) failures.push("recovered before the fault cleared");
    proxy.killActiveSockets();

    findings.failures = failures;
    await writeEvidence(scratch, "readiness-cases.json", findings);
    await writeVerdict(scratch, {
      id: "OC-REAL-002",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy surface (readiness probes are protocol-independent)",
      observed: `raw statuses ${JSON.stringify(rawStatuses)}; healthy ready ${String(findings.healthyReadyMs)}ms; 500-fail bounded=${failBounded}; stall bounded; partial-path ready; recovery after fault clear ${recoveredMs}ms`,
      expected: "any valid 2xx proves readiness; every stall is bounded; recovery works",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-002/readiness-cases.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-002/wire.ndjson",
      ],
      notes: "Faults injected by a local HTTP proxy in front of REAL opencode serve 1.18.18. Half-live-generation check is covered at lease level by OC-REAL-001.",
    });
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
