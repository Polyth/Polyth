import type { SessionProjection } from "@polyth/contracts";
import type { HandoffTarget } from "./client.ts";

export function resolveInitialHandoffTarget(input: {
  preferredTarget?: HandoffTarget;
  session: SessionProjection | null;
  availableTargets: ReadonlyArray<HandoffTarget>;
  fallbackTarget: HandoffTarget;
}): HandoffTarget {
  const working = input.session?.status === "working";
  let target = input.preferredTarget ?? input.fallbackTarget;
  if (working && target === "current-session") target = "queue";
  if (input.availableTargets.includes(target)) return target;
  let fallback = input.fallbackTarget;
  if (working && fallback === "current-session") fallback = "queue";
  if (input.availableTargets.includes(fallback)) return fallback;
  return input.availableTargets[0] ?? "new-session";
}
