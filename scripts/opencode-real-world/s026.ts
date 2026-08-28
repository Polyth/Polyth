/** OC-REAL-026: protocol auto / forced legacy / forced v2 against real 1.18.18
 * dual-surface /doc. Uses Polyth's actual probe + adapters over the real wire. */
import { join } from "node:path";
import {
  createOpenCodeTransport,
  createProtocolAdapter,
  probeProtocol,
} from "@polyth/backend-opencode";
import type { RuntimeEndpoint, RuntimeSessionBinding } from "@polyth/contracts";
import {
  httpJson,
  makeScratch,
  spawnServe,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
} from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-026");
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  try {
    const doc = await httpJson(serve.url, "GET", `/doc?directory=${encodeURIComponent(scratch.project)}`, undefined, undefined);
    const paths = Object.keys((doc.body as { paths?: Record<string, unknown> }).paths ?? {});
    const legacyPaths = paths.filter((p) => /\/session\/\{[^}]+\}\/(prompt_async|message)$/.test(p));
    const v2Paths = paths.filter((p) => p.startsWith("/api/"));
    const health = {
      global: await httpJson(serve.url, "GET", "/global/health", undefined, wire),
      api: await httpJson(serve.url, "GET", "/api/health", undefined, wire),
    };
    await writeEvidence(scratch, "doc-surface.json", {
      totalPaths: paths.length,
      legacyPromptPaths: legacyPaths,
      v2PathCount: v2Paths.length,
      v2PathSample: v2Paths.slice(0, 12),
      health: { global: health.global.body, api: health.api.body },
    });

    const results: Record<string, unknown> = {};
    for (const selection of ["auto", "legacy", "v2"] as const) {
      const transport = createOpenCodeTransport({
        baseUrl: serve.url,
        directory: scratch.project,
      });
      const endpoint: RuntimeEndpoint = {
        authorityId: `oc-real-026-${selection}`,
        continuity: "generation-only",
        generation: 1,
        url: serve.url,
        location: { directory: scratch.project },
        control: { kind: "borrowed", source: "external" },
        config: { kind: "read-only" },
        authentication: {
          kind: "basic-env",
          usernameEnv: "OPENCODE_SERVER_USERNAME",
          passwordEnv: "OPENCODE_SERVER_PASSWORD",
        },
      };
      const probe = await probeProtocol(transport, endpoint);
      let adapterProtocol: string;
      let createOutcome: unknown;
      let sseGated: string | undefined;
      try {
        const adapter = await createProtocolAdapter({ protocol: selection, transport, endpoint });
        adapterProtocol = adapter.protocol;
        sseGated = adapter.eventStreamPath() === undefined ? "no-event-stream-path" : adapter.eventStreamPath();
        const binding: RuntimeSessionBinding = {
          canonicalSessionId: `canonical-${selection}`,
          authorityId: endpoint.authorityId,
          generation: endpoint.generation,
          continuity: endpoint.continuity,
          location: endpoint.location,
        };
        createOutcome = await adapter.ensureSession(binding, `oc-real-026-${selection}-create`, `OC-REAL-026 ${selection}`);
      } catch (error) {
        adapterProtocol = "startup-failure";
        createOutcome = { startupError: String(error), code: (error as { code?: string }).code };
      }
      results[selection] = {
        probeSelected: probe.protocol,
        probeLegacyPromptPaths: probe.legacyPromptPaths,
        adapterProtocol,
        eventStreamPath: sseGated,
        createOutcome,
      };
    }
    await writeEvidence(scratch, "protocol-matrix.json", results);

    const auto = results.auto as { adapterProtocol: string; createOutcome: { kind?: string; code?: string } };
    const legacy = results.legacy as { createOutcome: { kind?: string } };
    const v2 = results.v2 as { createOutcome: { kind?: string; code?: string } };
    const autoBroken = auto.adapterProtocol === "v2"
      && auto.createOutcome?.kind === "rejected"
      && auto.createOutcome?.code === "capability-unsupported";
    const legacyOk = legacy.createOutcome?.kind === "confirmed";
    await writeVerdict(scratch, {
      id: "OC-REAL-026",
      verdict: autoBroken ? "fail" : legacyOk ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: `auto->${auto.adapterProtocol}, forced legacy, forced v2`,
      observed: `auto selected ${auto.adapterProtocol}; auto create=${JSON.stringify(auto.createOutcome)}; forced-legacy create=${legacy.createOutcome?.kind}; forced-v2 create=${v2.createOutcome?.kind}/${v2.createOutcome?.code}`,
      expected: "auto must select an operational adapter or fail startup; must not select disabled V2 then reject core work",
      attribution: autoBroken ? "POLYTH" : legacyOk ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-026/doc-surface.json",
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-026/protocol-matrix.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-026/opencode.log",
      ],
      notes: "Known baseline defect: dual-surface /doc makes protocol:auto choose the disabled V2 adapter (protocol.ts hasV2ProtocolDocument precedence). Forced legacy is a diagnostic, not a waiver.",
    });
  } finally {
    await serve.stop();
  }
};

await main();
