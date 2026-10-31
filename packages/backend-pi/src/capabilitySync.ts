import type { HarnessContext } from "@polyth/contracts";
import {
  acknowledgeCapabilityApplication,
  provisioningTarget,
} from "@polyth/harness-runtime";
import { piOverlays } from "./provisioner.ts";
import type { PiRpc, PiRpcEvent } from "./rpc.ts";

const appendCapabilityText = (text: string, projection: string): string =>
  text.trim() ? `${text}\n\n${projection}` : projection;

export function createPiCapabilitySync(context: HarnessContext, rpc: PiRpc, harnessId = "pi"): PiRpc {
  const launchStaged = piOverlays.peek(context, harnessId);
  const target = provisioningTarget(context, harnessId, {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
  });
  let discovered = false;
  const observe = (event: PiRpcEvent) => {
    if (
      launchStaged
      && launchStaged.value.toolCapabilityIds.length
      && !discovered
      && event.type === "extension_ui_request"
      && event.method === "setStatus"
      && event.statusKey === "polyth-tools"
      && event.statusText === "ready"
    ) {
      discovered = true;
      acknowledgeCapabilityApplication({
        target,
        desiredRevision: launchStaged.desiredRevision,
        capabilityIds: launchStaged.value.toolCapabilityIds,
        outcome: "applied",
        evidence: { stage: "discovered", source: "Pi extension before_agent_start registration" },
      });
    }
    if (launchStaged && event.type === "tool_execution_start" && typeof event.toolName === "string") {
      const capabilityId = launchStaged.value.toolNames[event.toolName];
      if (!capabilityId) return;
      acknowledgeCapabilityApplication({
        target,
        desiredRevision: launchStaged.desiredRevision,
        capabilityIds: [capabilityId],
        outcome: "applied",
        evidence: { stage: "invocable", source: "Pi extension tool execution" },
      });
    }
  };
  const request = async <T = unknown>(
    command: Record<string, unknown> & { type: string },
    timeoutMs?: number,
  ): Promise<T> => {
    if (command.type !== "prompt" || typeof command.message !== "string") {
      return rpc.request<T>(command, timeoutMs);
    }
    const staged = piOverlays.peek(context, harnessId);
    const projection = staged?.value.prompt;
    if (!staged || !projection?.text || !projection.capabilityIds.length) {
      return rpc.request<T>(command, timeoutMs);
    }
    const result = await rpc.request<T>({
      ...command,
      message: appendCapabilityText(command.message, projection.text),
    }, timeoutMs);
    acknowledgeCapabilityApplication({
      target,
      desiredRevision: staged.desiredRevision,
      capabilityIds: projection.capabilityIds,
      outcome: "unverifiable",
      reason: "Pi accepted the prompt text projection; native model consumption is not observable",
      evidence: { stage: "staged", source: "Pi RPC prompt text projection" },
    });
    return result;
  };
  return {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
    get receipts() { return rpc.receipts; },
    get releasedAuthorities() { return rpc.releasedAuthorities; },
    request,
    receipt: (operationId, nativeId) => rpc.receipt(operationId, nativeId),
    onEvent(callback) {
      return rpc.onEvent((event) => {
        observe(event);
        callback(event);
      });
    },
    onClose: (callback) => rpc.onClose(callback),
    close: () => rpc.close(),
  };
}
