import { readFile } from "node:fs/promises";
import type { HarnessContext } from "@polyth/contracts";
import {
  acknowledgeCapabilityApplication,
  captureCapabilityLaunch,
  provisioningTarget,
  releaseCapabilityLaunch,
} from "@polyth/harness-runtime";
import { commandCodeOverlays } from "./provisioner.ts";
import type { CommandCodeRpc } from "./rpc.ts";

type BindingMutation = {
  operationId?: unknown;
  mutationKind?: unknown;
};

const exactTurnReceipt = async (bindingPath: unknown, operationId: unknown): Promise<boolean> => {
  if (typeof bindingPath !== "string" || !bindingPath || typeof operationId !== "string" || !operationId) return false;
  try {
    const state = JSON.parse(await readFile(bindingPath, "utf8")) as { acceptedMutations?: BindingMutation[]; acceptedOperations?: unknown[] };
    if (Array.isArray(state.acceptedMutations)) {
      return state.acceptedMutations.some((entry) =>
        entry?.operationId === operationId && entry?.mutationKind === "turn-submit");
    }
    return Array.isArray(state.acceptedOperations) && state.acceptedOperations.includes(operationId);
  } catch {
    return false;
  }
};

export function createCommandCodeCapabilitySync(context: HarnessContext, rpc: CommandCodeRpc): CommandCodeRpc {
  const settle = (staged: NonNullable<ReturnType<typeof commandCodeOverlays.peek>>) => {
    const target = provisioningTarget(context, "commandcode", {
      authorityId: rpc.authorityId,
      generation: rpc.generation,
    });
    const overlay = staged.value;
    if (overlay.promptCapabilityIds.length) {
      acknowledgeCapabilityApplication({
        target,
        desiredRevision: staged.desiredRevision,
        capabilityIds: overlay.promptCapabilityIds,
        outcome: "unverifiable",
        reason: "Command Code admitted the turn with the transient appendSystemPrompt Mod; model consumption has no authoritative readback",
        evidence: { stage: "staged", source: "Command Code --mod appendSystemPrompt" },
      });
    }
    if (overlay.skillCapabilityIds.length) {
      acknowledgeCapabilityApplication({
        target,
        desiredRevision: staged.desiredRevision,
        capabilityIds: overlay.skillCapabilityIds,
        outcome: "unverifiable",
        reason: "Command Code admitted the turn with the documented --skill path; native skill discovery has no headless readback",
        evidence: { stage: "staged", source: "Command Code --skill" },
      });
    }
  };

  return {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
    get receipts() { return rpc.receipts; },
    get releasedAuthorities() { return rpc.releasedAuthorities; },
    async request<T>(command, timeoutMs) {
      if (command.type !== "start_turn") return rpc.request<T>(command, timeoutMs);
      const staged = commandCodeOverlays.peek(context, "commandcode");
      if (!staged) return rpc.request<T>(command, timeoutMs);

      const launchTarget = provisioningTarget(context, "commandcode");
      captureCapabilityLaunch({ target: launchTarget, desiredRevision: staged.desiredRevision });
      const overlay = staged.value;
      const projected = {
        ...command,
        ...(overlay.promptModFile ? { capabilityModPath: overlay.promptModFile } : {}),
        ...(overlay.skillRoot ? { skillRoots: [overlay.skillRoot] } : {}),
      };

      try {
        const result = await rpc.request<T>(projected, timeoutMs);
        const record = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
        const admitted = typeof record?.nativeSessionId === "string" && record.nativeSessionId.length > 0
          || await exactTurnReceipt(command.bindingPath, command.operationId);
        if (admitted) settle(staged);
        return result;
      } catch (error) {
        const admitted = await exactTurnReceipt(command.bindingPath, command.operationId);
        if (admitted) settle(staged);
        const code = (error as { code?: string }).code;
        if (!admitted && (code === "runtime-rejected" || code === "busy" || code === "unsupported")) {
          releaseCapabilityLaunch({ target: launchTarget, desiredRevision: staged.desiredRevision });
        }
        throw error;
      }
    },
    receipt: (operationId, nativeId) => rpc.receipt(operationId, nativeId),
    onEvent: (callback) => rpc.onEvent(callback),
    onClose: (callback) => rpc.onClose(callback),
    close: () => rpc.close(),
  };
}
