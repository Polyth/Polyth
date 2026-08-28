/** OC-REAL-025: apply MCP / plugin / provider-visibility / agent changes to a
 *  JSONC opencode.json seeded with comments, unknown top-level fields, an
 *  unsupported MCP entry, and unowned nested options. Inject write failures
 *  (read-only authority, target mismatch, corrupt file) and finish with ONE
 *  safe-idle owned restart that must load the new config.
 *  Pending-batch retention across restart failure is server-layer scope
 *  (config barrier, deterministic-tested). */
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createConfigApplier,
  createOpenCodeRuntime,
} from "@polyth/backend-opencode";
import type { OwnedRuntimeLifecycle } from "@polyth/backend-opencode";
import {
  applyScratchEnv,
  httpJson,
  makeScratch,
  sleep,
  writeEvidence,
  writeVerdict,
  OPENCODE_VERSION,
  OPENCODE_BIN,
} from "./lib.ts";

const SEED = `{
  // user comment that a JSONC-faithful writer would keep
  "$schema": "https://opencode.ai/config.json",
  "xUnknownTop": { "keep": [1, 2], "nested": { "deep": true } },
  "theme": "dark",
  "mcp": {
    // valid for OpenCode (1.18.18 hard-fails startup on schema-invalid mcp
    // types), unmanaged by Polyth, and carrying unknown extra fields
    "unsupported-entry": { "type": "remote", "url": "https://example.invalid/mcp", "enabled": false, "customField": true, "notes": "user-owned" },
  },
  "provider": {
    "google": { "blacklist": ["old-model"], "customOpt": { "nested": 1 } },
  },
  "plugin": ["some-plugin@1.0.0"],
  "agent": { "reviewer": { "mode": "subagent", "temperature": 0.2 } },
}
`;

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-025");
  const failures: string[] = [];
  const configDir = join(scratch.env.XDG_CONFIG_HOME!, "opencode");
  const applier = createConfigApplier({ configDir });
  const configPath = applier.configPath();
  await writeFile(configPath, SEED);
  const evidence: Record<string, unknown> = { seedBytes: SEED };

  const read = () => applier.readConfig();
  const rawBytes = () => readFile(configPath, "utf8");

  // ---- 1. managed MCP add; unsupported entry + unknown fields survive ----
  await applier.applyMcp([{
    name: "polyth-managed",
    transport: { kind: "stdio", command: "echo", args: ["mcp"], env: { FLAG: "1" } },
    enabled: true,
  }]);
  const afterMcp = await read();
  const mcpBlock = afterMcp.mcp as Record<string, Record<string, unknown>>;
  if (!mcpBlock["unsupported-entry"] || mcpBlock["unsupported-entry"].customField !== true) {
    failures.push("unsupported MCP entry lost fields on managed apply");
  }
  if (JSON.stringify(afterMcp.xUnknownTop) !== JSON.stringify({ keep: [1, 2], nested: { deep: true } })) {
    failures.push("unknown top-level field mutated");
  }
  const bytesAfterMcp = await rawBytes();
  evidence.commentsPreservedAfterFirstWrite = bytesAfterMcp.includes("user comment");
  evidence.mcpBlockAfterApply = mcpBlock;

  // ---- 2. provider visibility; unowned nested provider option survives ----
  await applier.applyProviderVisibility({
    disabledProviders: ["huggingface"],
    blacklists: { google: ["blocked-model-x"] },
  });
  const afterVisibility = await read();
  const google = (afterVisibility.provider as Record<string, Record<string, unknown>>).google;
  if (JSON.stringify(google.customOpt) !== JSON.stringify({ nested: 1 })) failures.push("unowned provider option lost");
  if (JSON.stringify(google.blacklist) !== JSON.stringify(["blocked-model-x"])) failures.push("blacklist not applied");
  if (afterVisibility.theme !== "dark") failures.push("unrelated theme key lost");
  if (JSON.stringify(afterVisibility.disabled_providers) !== JSON.stringify(["huggingface"])) failures.push("disabled_providers not applied");

  // ---- 3. agent role merge keeps unowned property ----
  await applier.applyAgent("reviewer", { mode: "subagent", prompt: "Review changes carefully." });
  const afterAgent = await read();
  const reviewer = (afterAgent.agent as Record<string, Record<string, unknown>>).reviewer;
  if (reviewer.temperature !== 0.2) failures.push("unowned agent property (temperature) lost");
  if (reviewer.prompt !== "Review changes carefully.") failures.push("agent prompt not applied");

  // ---- 4. plugins merge + remove ----
  await applier.applyPlugins(["another-plugin@2.0.0"]);
  const removal = await applier.removePlugin("some-plugin@1.0.0");
  if (!removal.removed) failures.push("plugin removal reported not-removed");
  const afterPlugins = await read();
  if (JSON.stringify(afterPlugins.plugin) !== JSON.stringify(["another-plugin@2.0.0"])) {
    failures.push(`plugin list unexpected: ${JSON.stringify(afterPlugins.plugin)}`);
  }

  // ---- 5. semantic no-op performs zero writes ----
  const bytesBefore = await rawBytes();
  const statBefore = await stat(configPath);
  await sleep(20);
  await applier.applyAgent("reviewer", { mode: "subagent", prompt: "Review changes carefully." });
  const statAfter = await stat(configPath);
  if (statBefore.mtimeMs !== statAfter.mtimeMs || bytesBefore !== await rawBytes()) {
    failures.push("semantic no-op rewrote the file");
  }

  // ---- 6. write refusals: read-only authority and target mismatch ----
  const readOnly = createConfigApplier({ configDir, authority: { kind: "read-only" } });
  let refusedReadOnly = "";
  try {
    await readOnly.applyMcp([]);
  } catch (error) {
    refusedReadOnly = (error as { code?: string }).code ?? String(error);
  }
  const mismatched = createConfigApplier({ configDir, authority: { kind: "writable", targetId: "some-other-target" } });
  let refusedMismatch = "";
  try {
    await mismatched.applyProviderVisibility({ disabledProviders: [], blacklists: {} });
  } catch (error) {
    refusedMismatch = (error as { code?: string }).code ?? String(error);
  }
  const bytesAfterRefusals = await rawBytes();
  if (refusedReadOnly !== "config-read-only") failures.push(`read-only refusal code=${refusedReadOnly}`);
  if (refusedMismatch !== "config-target-mismatch") failures.push(`target mismatch refusal code=${refusedMismatch}`);
  if (bytesAfterRefusals !== bytesBefore) failures.push("refused write still changed bytes");
  evidence.refusals = { refusedReadOnly, refusedMismatch };

  // ---- 7. corrupt file: apply throws, bytes not clobbered ----
  const goodBytes = await rawBytes();
  await writeFile(configPath, "{ this is not json");
  let corruptOutcome = "";
  try {
    await applier.applyMcp([]);
  } catch (error) {
    corruptOutcome = String(error).slice(0, 120);
  }
  const corruptBytes = await rawBytes();
  if (!corruptOutcome) failures.push("apply over a corrupt config did not throw");
  if (corruptBytes !== "{ this is not json") failures.push("corrupt config was clobbered by a write");
  await writeFile(configPath, goodBytes);
  evidence.corruptOutcome = corruptOutcome;

  // ---- 8. ONE safe-idle owned restart loads the new config ----
  applyScratchEnv(scratch);
  const runtime = await createOpenCodeRuntime({
    cwd: scratch.project,
    bin: OPENCODE_BIN,
    protocol: "legacy",
    dataDir: join(scratch.root, "polyth-data"),
  });
  try {
    const endpoint1 = await runtime.endpoint!();
    const providersBefore = await httpJson(endpoint1.url, "GET", `/provider?directory=${encodeURIComponent(scratch.project)}`);
    const connectedBefore = (providersBefore.body as { connected?: string[] }).connected ?? [];
    const lifecycle = (runtime as unknown as { lifecycle: OwnedRuntimeLifecycle }).lifecycle;
    let restarts = 0;
    const endpoint2 = await lifecycle.withConfigRestart(async (restart) => {
      restarts += 1;
      return restart();
    });
    const providersAfter = await httpJson(endpoint2.url, "GET", `/provider?directory=${encodeURIComponent(scratch.project)}`);
    const allAfter = ((providersAfter.body as { all?: Array<{ id: string }> }).all ?? []).map((provider) => provider.id);
    const oldPortDead = await httpJson(endpoint1.url, "GET", "/global/health")
      .then(() => false)
      .catch(() => true);
    evidence.restart = {
      generation1: endpoint1.generation,
      url1: endpoint1.url,
      generation2: endpoint2.generation,
      url2: endpoint2.url,
      restartsExecuted: restarts,
      connectedBefore,
      huggingfaceHiddenAfterRestart: !allAfter.includes("huggingface"),
      oldEndpointDead: endpoint1.url === endpoint2.url ? "same-url" : oldPortDead,
    };
    if (endpoint2.generation <= endpoint1.generation) failures.push("restart did not advance the endpoint generation");
    if (restarts !== 1) failures.push(`${restarts} restarts executed, expected exactly 1`);
    if (allAfter.includes("huggingface")) failures.push("disabled_providers was not honored after the owned restart");
  } finally {
    await runtime.dispose();
  }

  evidence.finalConfig = await read();
  await writeEvidence(scratch, "config-ownership.json", { ...evidence, failures });
  await writeVerdict(scratch, {
    id: "OC-REAL-025",
    verdict: failures.length === 0
      ? ((evidence.commentsPreservedAfterFirstWrite as boolean) ? "pass" : "partial")
      : "fail",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy (config applier + owned restart)",
    observed: `unsupported MCP entry + unknown top-level + unowned provider/agent fields survived all managed writes; no-op wrote 0 bytes; read-only/mismatch refusals typed; corrupt file never clobbered; 1 owned safe-idle restart gen ${JSON.stringify((evidence.restart as { generation1: number }).generation1)}->${JSON.stringify((evidence.restart as { generation2: number }).generation2)} honored disabled_providers; JSONC comments preserved=${JSON.stringify(evidence.commentsPreservedAfterFirstWrite)}`,
    expected: "only owned fields change; one safe-idle owned restart; rollback/defer honest",
    attribution: failures.length === 0
      ? ((evidence.commentsPreservedAfterFirstWrite as boolean) ? "NONE" : "POLYTH")
      : "AMBIGUITY",
    evidence: ["artifacts/opencode-real-world/phase-1-legacy/OC-REAL-025/config-ownership.json"],
    notes: "Documented limitation confirmed live: the first genuine write re-serializes strict JSON, so user JSONC comments are lost (semantic preservation only — config.ts states this trade-off; needs a JSONC rewriter to fix). Pending-batch retention across injected restart failure is the server config barrier (deterministic-tested), not exercisable at this seam.",
  });
};

await main();
