import type { ModelDescriptor, SessionProjection } from "@polyth/contracts";
import { resolveModelPresentation } from "@polyth/models/presentation";

export function formatTokenEstimate(tokens: number): string {
  if (tokens < 1000) return `≈${tokens}`;
  const rounded = tokens >= 10_000
    ? `${Math.round(tokens / 1000)}k`
    : `${(tokens / 1000).toFixed(1)}k`;
  return `≈${rounded}`;
}

export function deriveSessionTargetLabel(
  session: SessionProjection | null,
  harnessName: string | null,
  models: readonly ModelDescriptor[],
): string | null {
  if (!session) return null;
  const harnessLabel = harnessName ?? session.resolvedHarnessId ?? "Agent";
  const modelLabel = session.model
    ? resolveModelPresentation(session.model, models, session.resolvedHarnessId).name
    : null;
  const status = session.status === "working" ? "Working" : session.status === "waiting" ? "Waiting" : "Idle";
  return modelLabel ? `${harnessLabel} · ${modelLabel} · ${status}` : `${harnessLabel} · ${status}`;
}

export function dockPasteTargetName(input: {
  providerId: string;
  providerName: string;
  tabTitle?: string | null;
}): string {
  if (input.providerId === "custom" && input.tabTitle?.trim()) return input.tabTitle.trim();
  return input.providerName;
}
