import type {
  PersistedRuntimeBinding,
  SessionDebugDto,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import type { PromptPrefixDiagnostics } from "./promptPrefixDiagnostics.ts";
import { tr } from "./i18n/index.ts";

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
    { label: tr("runtimeRecovery.factEngine"), value: "OpenCode" },
    { label: tr("runtimeRecovery.factMode"), value: input.runtimeControl ?? "unknown" },
    { label: tr("runtimeRecovery.factEpoch"), value: String(epoch) },
    { label: tr("runtimeRecovery.factStatus"), value: diagnosticStatus(input.status) },
  ];
  if (control) facts.push({ label: tr("runtimeRecovery.factControl"), value: control });
  facts.push(
    { label: tr("runtimeRecovery.factFencedOperations"), value: String(counts.fencedOperations) },
    { label: tr("runtimeRecovery.factUnknownOperations"), value: String(counts.unknownOperations) },
    { label: tr("queuedmessagelist.heldForReview"), value: String(counts.heldForReview) },
  );
  if (reason) facts.push({ label: tr("runtimeRecovery.factLastReplacement"), value: reason });
  if (plan) {
    facts.push({ label: tr("runtimeRecovery.factOmittedMessages"), value: String(plan.omittedMessages) });
    if (plan.sectionsCapped.length > 0) {
      facts.push({ label: tr("runtimeRecovery.factCappedSections"), value: plan.sectionsCapped.join(", ") });
    }
  }
  if (input.promptPrefix) {
    facts.push(
      { label: tr("runtimeRecovery.factPromptPrefix"), value: input.promptPrefix.identity },
      { label: tr("runtimeRecovery.factCapabilityBundle"), value: input.promptPrefix.bundleRevision },
      { label: tr("runtimeRecovery.factPrefixCoverage"), value: input.promptPrefix.coverage },
      { label: tr("runtimeRecovery.factPrefixContributors"), value: String(input.promptPrefix.contributorCount) },
    );
    const visible = input.promptPrefix.contributors.slice(0, 24);
    for (const contributor of visible) {
      facts.push({
        label: tr("runtimeRecovery.factPrefixEntry", { id: contributor.id }),
        value: `${contributor.kind} · ${contributor.revision}`,
      });
    }
    if (input.promptPrefix.contributors.length > visible.length) {
      facts.push({
        label: tr("runtimeRecovery.factPrefixContributorsOmitted"),
        value: String(input.promptPrefix.contributors.length - visible.length),
      });
    }
  }
  return facts;
}
