import { resolve } from "node:path";
import type { HarnessCapabilityApplicationReceipt } from "@polyth/contracts";
import { acknowledgeCapabilityApplication } from "@polyth/harness-runtime";
import { peekOpenCodeLaunchOverlay, type OpenCodeLaunchOverlay } from "./provisioner.ts";
import type { RuntimeLifecycle } from "./runtime.ts";

interface OpenCodeCapabilityContext {
  spaceId?: string;
  projectId: string;
  cwd: string;
}

interface OpenCodeCapabilityDelivery {
  peek(context: OpenCodeCapabilityContext): OpenCodeLaunchOverlay | undefined;
  acknowledge(receipt: HarnessCapabilityApplicationReceipt): void;
}

const appendCapabilityText = (text: string, projection: string): string =>
  text.trim() ? `${text}\n\n${projection}` : projection;

/**
 * OpenCode V1 and V2 do not share a reliable project-instruction config path.
 * Keep canonical Polyth text outside vendor config and bind the exact staged
 * revision to each admitted prompt. MCP and native skills remain launch-time.
 */
export function configureOpenCodeCapabilityDelivery(
  lifecycle: RuntimeLifecycle,
  context: OpenCodeCapabilityContext,
  capabilities: OpenCodeCapabilityDelivery = {
    peek: peekOpenCodeLaunchOverlay,
    acknowledge: acknowledgeCapabilityApplication,
  },
): void {
  const submit = lifecycle.submit.bind(lifecycle);
  lifecycle.submit = async (binding, operationId) => {
    const staged = capabilities.peek(context);
    const projection = staged?.prompt;
    const outcome = await submit({
      ...binding,
      ...(projection?.text
        ? { text: appendCapabilityText(binding.text, projection.text) }
        : {}),
    }, operationId);

    if (outcome.kind === "confirmed" && staged && projection?.capabilityIds.length) {
      capabilities.acknowledge({
        target: {
          spaceId: context.spaceId ?? "",
          projectId: context.projectId,
          cwd: resolve(context.cwd),
          harnessId: "opencode",
          authorityId: binding.session.authorityId,
          generation: binding.session.generation,
        },
        desiredRevision: staged.desiredRevision,
        capabilityIds: projection.capabilityIds,
        outcome: "unverifiable",
        reason: "OpenCode accepted the prompt text projection; native model consumption is not observable",
      });
    }
    return outcome;
  };
}
