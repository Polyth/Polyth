import { resolve } from "node:path";
import type {
  AgentRuntime,
  HarnessCapabilityApplicationReceipt,
  HarnessContext,
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
