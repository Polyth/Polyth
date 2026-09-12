import { resolve } from "node:path";
import type {
  AgentRuntime,
  HarnessCapabilityApplicationReceipt,
  HarnessContext,
  HarnessProvisioningTarget,
  RuntimeEndpoint,
} from "@polyth/contracts";
import { acknowledgeCapabilityApplication } from "@polyth/harness-runtime";
import { peekOpenCodeLaunchOverlay, type OpenCodeLaunchOverlay } from "./provisioner.ts";

type OpenCodeCapabilityContext = Pick<HarnessContext, "spaceId" | "projectId" | "cwd">;

interface OpenCodeCapabilityDelivery {
  peek(context: OpenCodeCapabilityContext): OpenCodeLaunchOverlay | undefined;
  acknowledge(receipt: HarnessCapabilityApplicationReceipt): void;
}

const configured = new WeakSet<AgentRuntime>();

const enabledMcpNames = (overlay: OpenCodeLaunchOverlay): Array<[string, string]> => {
  const names = Object.entries(overlay.mcpNames ?? {});
  if (!names.length || !overlay.configContent.trim()) return names;
  try {
    const config = JSON.parse(overlay.configContent) as { mcp?: Record<string, { enabled?: boolean }> };
    return names.filter(([, name]) => config.mcp?.[name]?.enabled !== false);
  } catch {
    return names;
  }
};

/** Read only from the captured physical generation. No probe invokes user tools. */
export async function verifyOpenCodeCapabilities(
  overlay: OpenCodeLaunchOverlay,
  target: HarnessProvisioningTarget,
  read: (path: string) => Promise<unknown>,
  acknowledge: (receipt: HarnessCapabilityApplicationReceipt) => void = acknowledgeCapabilityApplication,
): Promise<void> {
  const receipt = (ids: string[], outcome: HarnessCapabilityApplicationReceipt["outcome"],
    reason: string, evidence: HarnessCapabilityApplicationReceipt["evidence"]) => {
    if (ids.length) acknowledge({ target, desiredRevision: overlay.desiredRevision, capabilityIds: ids, outcome, reason, evidence });
  };
  const skills = overlay.skills ?? [];
  if (skills.length) {
    try {
      const result = await read("/skill");
      if (!Array.isArray(result)) throw new Error("unsupported skill listing");
      for (const skill of skills) {
        const found = result.some((row) => row && typeof row === "object"
          && row.name === skill.name && row.location === skill.path);
        receipt([skill.capabilityId], found ? "applied" : "failed",
          found ? "Native OpenCode skill discovered at the expected private path" : "Native OpenCode skill missing or shadowed",
          { stage: found ? "discovered" : "staged", source: "opencode:/skill" });
      }
    } catch {
      receipt(skills.map((skill) => skill.capabilityId), "unverifiable", "OpenCode native skill listing unavailable",
        { stage: "staged", source: "opencode:launch" });
    }
  }
  // Native Polyth tools keep the scoped callback bridge in the launch config as
  // an explicitly disabled transport/debug entry. It is not supposed to appear
  // connected in OpenCode and must therefore not be treated as a failed MCP.
  const servers = enabledMcpNames(overlay);
  if (servers.length) {
    try {
      const result = await read("/mcp");
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("unsupported MCP status");
      for (const [id, name] of servers) {
        const state = (result as Record<string, { status?: string }>)[name]?.status;
        const connected = state === "connected";
        receipt([id], connected ? "applied" : "failed",
          connected ? "OpenCode reports MCP connected; tool invocation has not been verified" : "OpenCode did not report MCP connected",
          { stage: connected ? "connected" : "staged", source: "opencode:/mcp" });
      }
    } catch {
      receipt(servers.map(([id]) => id), "unverifiable", "OpenCode MCP status unavailable",
        { stage: "staged", source: "opencode:launch" });
    }
  }
}

const appendCapabilityText = (text: string, projection: string): string =>
  text.trim() ? `${text}\n\n${projection}` : projection;

const sameEndpoint = (
  left: RuntimeEndpoint | undefined,
  right: RuntimeEndpoint | undefined,
): left is RuntimeEndpoint =>
  Boolean(left && right)
  && left!.authorityId === right!.authorityId
  && left!.generation === right!.generation;

/**
 * OpenCode V1 and V2 do not share a reliable project-instruction config path.
 * Keep canonical Polyth text outside vendor config and decorate the canonical
 * turn admission path instead. The first user text remains first, the exact
 * staged revision is captured before admission, and a receipt is emitted only
 * when the same runtime generation accepted the prompt. MCP and native skills
 * remain launch-time capabilities.
 */
export function configureOpenCodeCapabilityDelivery(
  runtime: AgentRuntime,
  context: OpenCodeCapabilityContext,
  capabilities: OpenCodeCapabilityDelivery = {
    peek: peekOpenCodeLaunchOverlay,
    acknowledge: acknowledgeCapabilityApplication,
  },
): void {
  if (configured.has(runtime)) return;
  configured.add(runtime);

  const endpoint = runtime.endpoint?.bind(runtime);
  const acknowledge = async (
    staged: OpenCodeLaunchOverlay | undefined,
    before: RuntimeEndpoint | undefined,
  ): Promise<void> => {
    const projection = staged?.prompt;
    if (!staged || !projection?.capabilityIds.length || !endpoint || !before) return;
    const after = await endpoint();
    if (!sameEndpoint(before, after)) return;
    capabilities.acknowledge({
      target: {
        spaceId: context.spaceId,
        projectId: context.projectId,
        cwd: resolve(context.cwd),
        harnessId: "opencode",
        authorityId: before.authorityId,
        generation: before.generation,
      },
      desiredRevision: staged.desiredRevision,
      capabilityIds: projection.capabilityIds,
      outcome: "unverifiable",
      reason: "OpenCode accepted the prompt text projection; native model consumption is not observable",
    });
  };

  const startTurn = runtime.startTurn.bind(runtime);
  runtime.startTurn = async (request) => {
    const staged = capabilities.peek(context);
    const projection = staged?.prompt;
    const before = endpoint ? await endpoint() : undefined;
    await startTurn({
      ...request,
      ...(projection?.text
        ? { text: appendCapabilityText(request.text, projection.text) }
        : {}),
    });
    await acknowledge(staged, before);
  };

  const startTurnOperation = runtime.startTurnOperation?.bind(runtime);
  if (startTurnOperation) {
    runtime.startTurnOperation = async (request, operationId) => {
      const staged = capabilities.peek(context);
      const projection = staged?.prompt;
      const before = endpoint ? await endpoint() : undefined;
      const outcome = await startTurnOperation({
        ...request,
        ...(projection?.text
          ? { text: appendCapabilityText(request.text, projection.text) }
          : {}),
      }, operationId);
      if (outcome.kind === "confirmed") await acknowledge(staged, before);
      return outcome;
    };
  }
}
