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

const dataArray = (value: unknown): unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = (value as Record<string, unknown>).data;
  return Array.isArray(data) ? data : undefined;
};

const readInventory = async <T>(
  read: (path: string) => Promise<unknown>,
  path: string,
  parse: (value: unknown) => T | undefined,
): Promise<{ value: T; source: string }> => {
  const value = parse(await read(path));
  if (value === undefined) throw new Error(`invalid OpenCode capability inventory at ${path}`);
  return { value, source: `opencode:${path}` };
};

/** Read only from the captured physical generation. No probe invokes user tools. */
export async function verifyOpenCodeCapabilities(
  overlay: OpenCodeLaunchOverlay,
  target: HarnessProvisioningTarget,
  read: (path: string) => Promise<unknown>,
  acknowledge: (receipt: HarnessCapabilityApplicationReceipt) => void = acknowledgeCapabilityApplication,
  profile: "legacy" | "v2" = "legacy",
): Promise<void> {
  const receipt = (ids: string[], outcome: HarnessCapabilityApplicationReceipt["outcome"],
    reason: string, evidence: HarnessCapabilityApplicationReceipt["evidence"]) => {
    if (ids.length) acknowledge({ target, desiredRevision: overlay.desiredRevision, capabilityIds: ids, outcome, reason, evidence });
  };
  const skills = overlay.skills ?? [];
  if (skills.length) {
    try {
      const listed = await readInventory(read, profile === "v2" ? "/api/skill" : "/skill", dataArray);
      const result = listed.value;
      for (const skill of skills) {
        const found = result.some((row) => {
          const candidate = row && typeof row === "object" ? row as Record<string, unknown> : undefined;
          return candidate?.name === skill.name && candidate.location === skill.path;
        });
        receipt([skill.capabilityId], found ? "applied" : "failed",
          found ? "Native OpenCode skill discovered at the expected private path" : "Native OpenCode skill missing or shadowed",
          { stage: found ? "discovered" : "staged", source: listed.source });
      }
    } catch {
      receipt(skills.map((skill) => skill.capabilityId), "unverifiable", "OpenCode native skill listing unavailable",
        { stage: "staged", source: "opencode:launch" });
    }
  }
  const servers = Object.entries(overlay.mcpNames ?? {});
  if (servers.length) {
    try {
      const parse = (value: unknown) => {
        const v2 = dataArray(value);
        if (v2) return new Map(v2.flatMap((row) => row && typeof row === "object"
          && typeof (row as Record<string, unknown>).name === "string"
          ? [[(row as Record<string, unknown>).name as string, ((row as Record<string, unknown>).status as Record<string, unknown>)?.status] as const]
          : []));
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        return new Map(Object.entries(value as Record<string, unknown>).map(([name, row]) => [
          name,
          row && typeof row === "object" ? (row as Record<string, unknown>).status : undefined,
        ]));
      };
      let listed = await readInventory(read, profile === "v2" ? "/api/mcp" : "/mcp", parse);
      // V2 returns before MCP catalog discovery completes. Only retry its
      // explicit pending state; failed/disabled/auth-required are terminal.
      const deadline = Date.now() + 10_000;
      while (profile === "v2" && servers.some(([, name]) => listed.value.get(name) === "pending") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        listed = await readInventory(read, "/api/mcp", parse);
      }
      for (const [id, name] of servers) {
        const state = listed.value.get(name);
        const connected = state === "connected";
        receipt([id], connected ? "applied" : state === "pending" ? "unverifiable" : "failed",
          connected ? "OpenCode reports MCP connected; tool invocation has not been verified" : "OpenCode did not report MCP connected",
          { stage: connected ? "connected" : "staged", source: listed.source });
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
