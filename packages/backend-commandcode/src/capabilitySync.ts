import { readFile } from "node:fs/promises";
import type { HarnessContext } from "@polyth/contracts";
import {
  acknowledgeCapabilityApplication,
  captureCapabilityLaunch,
  provisioningTarget,
  releaseCapabilityLaunch,
} from "@polyth/harness-runtime";
import { commandCodeOverlays } from "./provisioner.ts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "./rpc.ts";

type BindingMutation = {
  operationId?: unknown;
  mutationKind?: unknown;
};

type StagedProjection = NonNullable<ReturnType<typeof commandCodeOverlays.peek>>;

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

const commandCodeAgentEvent = (message: CommandCodeWorkerEvent): Record<string, unknown> | undefined => {
  if (message.type !== "commandcode-record") return undefined;
  const record = message.record && typeof message.record === "object" && !Array.isArray(message.record)
    ? message.record as Record<string, unknown>
    : undefined;
  if (record?.type !== "event") return undefined;
  return record.event && typeof record.event === "object" && !Array.isArray(record.event)
    ? record.event as Record<string, unknown>
    : undefined;
};

export function createCommandCodeCapabilitySync(context: HarnessContext, rpc: CommandCodeRpc): CommandCodeRpc {
  const projections = new Map<string, StagedProjection>();
  const failedToolMods = new Set<string>();
  const target = () => provisioningTarget(context, "commandcode", {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
  });

  const settle = (staged: StagedProjection) => {
    const overlay = staged.value;
    if (overlay.promptCapabilityIds.length) {
      acknowledgeCapabilityApplication({
        target: target(),
        desiredRevision: staged.desiredRevision,
        capabilityIds: overlay.promptCapabilityIds,
        outcome: "unverifiable",
        reason: "Command Code admitted the turn with the transient appendSystemPrompt Mod; model consumption has no authoritative readback",
        evidence: { stage: "staged", source: "Command Code --mod appendSystemPrompt" },
      });
    }
    if (overlay.skillCapabilityIds.length) {
      acknowledgeCapabilityApplication({
        target: target(),
        desiredRevision: staged.desiredRevision,
        capabilityIds: overlay.skillCapabilityIds,
        outcome: "unverifiable",
        reason: "Command Code admitted the turn with the documented --skill path; native skill discovery has no headless readback",
        evidence: { stage: "staged", source: "Command Code --skill" },
      });
    }
    if (overlay.toolCapabilityIds.length) {
      acknowledgeCapabilityApplication({
        target: target(),
        desiredRevision: staged.desiredRevision,
        capabilityIds: overlay.toolCapabilityIds,
        outcome: "unverifiable",
        reason: "Command Code admitted the transient addTool Mod; individual tool invocability is confirmed only when its private bridge receives a call",
        evidence: { stage: "staged", source: "Command Code --mod addTool" },
      });
    }
  };

  const observeToolInvocation = (message: CommandCodeWorkerEvent) => {
    if (message.type !== "polyth-tool-invoked") return;
    const operationId = typeof message.operationId === "string" ? message.operationId : "";
    const toolName = typeof message.toolName === "string" ? message.toolName : "";
    const staged = operationId ? projections.get(operationId) : undefined;
    if (!staged || !toolName || failedToolMods.has(operationId)) return;
    const capabilityId = Object.entries(staged.value.toolNames ?? {})
      .find(([, name]) => name === toolName)?.[0];
    if (!capabilityId || !staged.value.toolCapabilityIds.includes(capabilityId)) return;
    acknowledgeCapabilityApplication({
      target: target(),
      desiredRevision: staged.desiredRevision,
      capabilityIds: [capabilityId],
      outcome: "applied",
      evidence: { stage: "invocable", source: "Command Code Mod tool bridge invocation" },
    });
  };

  const observeToolModFailure = (message: CommandCodeWorkerEvent) => {
    const operationId = typeof message.operationId === "string" ? message.operationId : "";
    if (!operationId || failedToolMods.has(operationId)) return;
    const event = commandCodeAgentEvent(message);
    if (event?.type !== "mod_error" || event.modId !== "mod:polyth-tools") return;
    const staged = projections.get(operationId);
    if (!staged || !staged.value.toolCapabilityIds.length) return;
    failedToolMods.add(operationId);
    acknowledgeCapabilityApplication({
      target: target(),
      desiredRevision: staged.desiredRevision,
      capabilityIds: staged.value.toolCapabilityIds,
      outcome: "failed",
      reason: "Command Code rejected the transient Polyth tool Mod; a native tool collision or Mod registration failure occurred",
    });
  };

  const clearProjection = (operationId: string) => {
    projections.delete(operationId);
    failedToolMods.delete(operationId);
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

      const operationId = typeof command.operationId === "string" ? command.operationId : "";
      if (operationId) projections.set(operationId, staged);
      const launchTarget = provisioningTarget(context, "commandcode");
      captureCapabilityLaunch({ target: launchTarget, desiredRevision: staged.desiredRevision });
      const overlay = staged.value;
      const projected = {
        ...command,
        ...(overlay.promptModFile ? { capabilityModPath: overlay.promptModFile } : {}),
        ...(overlay.skillRoot ? { skillRoots: [overlay.skillRoot] } : {}),
        ...(overlay.toolModFile && overlay.toolBridge
          ? { toolModPath: overlay.toolModFile, toolBridge: overlay.toolBridge }
          : {}),
      };

      try {
        const result = await rpc.request<T>(projected, timeoutMs);
        const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
        const admitted = typeof resultRecord?.nativeSessionId === "string" && resultRecord.nativeSessionId.length > 0
          || await exactTurnReceipt(command.bindingPath, command.operationId);
        if (admitted) settle(staged);
        return result;
      } catch (error) {
        const admitted = await exactTurnReceipt(command.bindingPath, command.operationId);
        if (admitted) settle(staged);
        const code = (error as { code?: string }).code;
        if (!admitted && (code === "runtime-rejected" || code === "busy" || code === "unsupported")) {
          if (operationId) clearProjection(operationId);
          releaseCapabilityLaunch({ target: launchTarget, desiredRevision: staged.desiredRevision });
        }
        throw error;
      }
    },
    receipt: (operationId, nativeId) => rpc.receipt(operationId, nativeId),
    onEvent(callback) {
      return rpc.onEvent((message) => {
        observeToolModFailure(message);
        observeToolInvocation(message);
        if (message.type === "turn-exit" && typeof message.operationId === "string") {
          clearProjection(message.operationId);
        }
        callback(message);
      });
    },
    onClose(callback) {
      return rpc.onClose(() => {
        projections.clear();
        failedToolMods.clear();
        callback();
      });
    },
    close: () => rpc.close(),
  };
}
