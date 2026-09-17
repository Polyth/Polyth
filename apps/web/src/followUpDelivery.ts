import type { ModelRef } from "@polyth/contracts";

/** Mid-turn follow-up that must reach the agent immediately. Queue stays a
 *  separate path; this only chooses between live steering and stop+send. */
export function immediateFollowUpDelivery(input: {
  requested: "steer" | "interrupt";
  steering: boolean;
  executionChanged: boolean;
  hasAttachments: boolean;
  hasCommand: boolean;
}): "steer" | "interrupt" {
  if (input.requested === "interrupt") return "interrupt";
  if (!input.steering || input.executionChanged || input.hasAttachments || input.hasCommand) {
    return "interrupt";
  }
  return "steer";
}

/** True when the next turn cannot continue the in-flight execution identity. */
export function executionSelectionChanged(
  current: { model?: ModelRef; agent?: string } | null | undefined,
  next: { model?: ModelRef; agent?: string; harness?: unknown },
): boolean {
  if (next.harness) return true;
  if (next.model) {
    const previous = current?.model;
    if (!previous) return true;
    if (previous.providerID !== next.model.providerID || previous.modelID !== next.model.modelID) {
      return true;
    }
    if ((previous.variant ?? "") !== (next.model.variant ?? "")) return true;
  }
  if (next.agent !== undefined && next.agent !== (current?.agent ?? undefined)) return true;
  return false;
}
