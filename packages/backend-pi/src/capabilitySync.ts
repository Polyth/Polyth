import type { HarnessContext } from "@polyth/contracts";
import {
  acknowledgeCapabilityApplication,
  provisioningTarget,
} from "@polyth/harness-runtime";
import { piOverlays } from "./provisioner.ts";
import type { PiRpc, PiRpcEvent } from "./rpc.ts";

export function createPiCapabilitySync(context: HarnessContext, rpc: PiRpc): PiRpc {
  const staged = piOverlays.peek(context, "pi");
  if (!staged) return rpc;
  const target = provisioningTarget(context, "pi", {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
  });
  let discovered = false;
  const observe = (event: PiRpcEvent) => {
    if (
      !discovered
      && event.type === "extension_ui_request"
      && event.method === "setStatus"
      && event.statusKey === "polyth-tools"
      && event.statusText === "ready"
    ) {
      discovered = true;
      acknowledgeCapabilityApplication({
        target,
        desiredRevision: staged.desiredRevision,
        capabilityIds: staged.value.toolCapabilityIds,
        outcome: "applied",
        evidence: { stage: "discovered", source: "Pi extension before_agent_start registration" },
      });
    }
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      const capabilityId = staged.value.toolNames[event.toolName];
      if (!capabilityId) return;
      acknowledgeCapabilityApplication({
        target,
        desiredRevision: staged.desiredRevision,
        capabilityIds: [capabilityId],
        outcome: "applied",
        evidence: { stage: "invocable", source: "Pi extension tool execution" },
      });
    }
  };
  return {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
    get receipts() { return rpc.receipts; },
    get releasedAuthorities() { return rpc.releasedAuthorities; },
    request: (command, timeoutMs) => rpc.request(command, timeoutMs),
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
