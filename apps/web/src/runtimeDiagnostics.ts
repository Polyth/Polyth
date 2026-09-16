import type {
  PersistedRuntimeBinding,
  SessionDebugDto,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import type { PromptPrefixDiagnostics } from "./promptPrefixDiagnostics.ts";

export interface RuntimeDiagnosticFact {
  label: string;
  value: string;
}

const diagnosticStatus = (status: SessionProjection["status"]): string => {
  if (status === "epoch-pending") return "recovery-needed";
  if (status === "reconciling") return "reconnecting";
  return "healthy";
};

const countsFromEvents = (events: readonly SessionEvent[]): SessionDebugDto["counts"] => {
  let fencedOperations = 0;
  let unknownOperations = 0;
  for (const event of events) {
    if (event.type === "mutation/fenced") fencedOperations += 1;
    else if (event.type === "mutation/uncertainty-recorded") unknownOperations += 1;
  }
  return { fencedOperations, unknownOperations, heldForReview: 0 };
};

const lastReplacementReason = (events: readonly SessionEvent[]): string | undefined => {
  const marker = events.findLast((event) => event.type === "runtime/epoch-replaced");
  const reason = (marker?.data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" && reason ? reason : undefined;
};

export function uncertainRecoveryWarning(input: {
  events: readonly SessionEvent[];
  debug?: Pick<SessionDebugDto, "counts"> | null;
}): boolean {
  const counts = input.debug?.counts;
  if (
    counts
    && (
      counts.unknownOperations > 0
      || counts.fencedOperations > 0
      || counts.heldForReview > 0
    )
  ) {
    return true;
  }
  return input.events.some((event) => (
    event.type === "mutation/uncertainty-recorded" || event.type === "mutation/fenced"
  ) && (event.data as { mutationKind?: unknown }).mutationKind === "turn-submit");
}

export function runtimeDiagnosticFacts(input: {
  status: SessionProjection["status"];
  runtimeControl?: SessionProjection["runtimeControl"];
  binding?: PersistedRuntimeBinding;
  events: readonly SessionEvent[];
  debug?: SessionDebugDto | null;
  promptPrefix?: PromptPrefixDiagnostics | null;
}): RuntimeDiagnosticFact[] {
  const counts = input.debug?.counts ?? countsFromEvents(input.events);
  const epoch = input.debug?.runtimeBinding?.epoch ?? input.binding?.epoch ?? 0;
  const control = input.debug?.endpoint?.control.kind
    ?? input.runtimeControl;
  const reason = input.debug?.lastEpochReplaced?.reason
    ?? lastReplacementReason(input.events);
  const plan = input.debug?.recoveryPlan;
  const facts: RuntimeDiagnosticFact[] = [
    { label: "Engine", value: "OpenCode" },
    { label: "Mode", value: input.runtimeControl ?? "unknown" },
    { label: "Epoch", value: String(epoch) },
    { label: "Status", value: diagnosticStatus(input.status) },
  ];
  if (control) facts.push({ label: "Control", value: control });
  facts.push(
    { label: "Fenced operations", value: String(counts.fencedOperations) },
    { label: "Unknown operations", value: String(counts.unknownOperations) },
    { label: "Held for review", value: String(counts.heldForReview) },
  );
  if (reason) facts.push({ label: "Last replacement", value: reason });
  if (plan) {
    facts.push({ label: "Omitted messages", value: String(plan.omittedMessages) });
    if (plan.sectionsCapped.length > 0) {
      facts.push({ label: "Capped sections", value: plan.sectionsCapped.join(", ") });
    }
  }
  if (input.promptPrefix) {
    facts.push(
      { label: "Prompt prefix", value: input.promptPrefix.identity },
      { label: "Capability bundle", value: input.promptPrefix.bundleRevision },
      { label: "Prefix coverage", value: input.promptPrefix.coverage },
      { label: "Prefix contributors", value: String(input.promptPrefix.contributorCount) },
    );
    const visible = input.promptPrefix.contributors.slice(0, 24);
    for (const contributor of visible) {
      facts.push({
        label: `Prefix · ${contributor.id}`,
        value: `${contributor.kind} · ${contributor.revision}`,
      });
    }
    if (input.promptPrefix.contributors.length > visible.length) {
      facts.push({
        label: "Prefix contributors omitted",
        value: String(input.promptPrefix.contributors.length - visible.length),
      });
    }
  }
  return facts;
}
