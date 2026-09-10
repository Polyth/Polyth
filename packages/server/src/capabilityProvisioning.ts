// Canonical capability desired-state + per-target application state.
// Packages contribute through the registry; harness providers project.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync, redactSecrets } from "@polyth/plugins";
import type {
  AgentCapabilityContributionRegistry,
  AgentCapabilityDescriptor,
  CapabilitySecretResolver,
  HarnessCapabilityApplicationReceipt,
  HarnessCapabilityEvidenceStage,
  HarnessCapabilityRecord,
  HarnessCapabilityStatusDto,
  HarnessCapabilityTargetLifetime,
  HarnessContext,
  HarnessProvider,
  HarnessProvisioningTarget,
  HarnessRegistry,
  JsonObject,
} from "@polyth/contracts";
import {
  capabilityRevision,
  desiredBundleRevision,
  harnessProviderById,
  overlayKey,
  planHarnessCapabilities,
  provisioningTarget,
  provisioningTargetKey,
  semanticCapabilityRevision,
  setCapabilityLaunchSink,
  setCapabilityReceiptSink,
} from "@polyth/harness-runtime";
import type { BehaviorService } from "./behavior.ts";
import type { McpConfigService, McpProjectionState } from "./mcp.ts";
import { AGENT_TOOLS_MCP_NAME, type AgentToolBridge } from "./agentTools.ts";

export interface InstructionProvisionState {
  provisioned: boolean;
  contributions: string[];
  verification?: "applied" | "unverifiable";
}

/** Physical-runtime create paths must reconcile through an exact registry
 * lookup (`HarnessRegistry.get` / `harnessProviderById`), never
 * `registry.resolve()` — resolve() probes every candidate harness, and a
 * probe that reads through the same physical-acquire key it is being called
 * from deadlocks. */
export async function reconcilePinnedHarness(
  controller: CapabilityProvisioningController,
  harnesses: HarnessRegistry,
  harnessId: string,
  context: HarnessContext,
): Promise<HarnessCapabilityStatusDto> {
  const provider = harnessProviderById(harnesses, harnessId);
  return controller.reconcile(provider, context);
}

export interface CapabilityProvisioningController {
  reconcile(provider: HarnessProvider, context: HarnessContext): Promise<HarnessCapabilityStatusDto>;
  reconcileAll(context: HarnessContext): Promise<HarnessCapabilityStatusDto[]>;
  reconcileSpace(space: { spaceId: string }): Promise<HarnessCapabilityStatusDto[]>;
  reconcileAllActiveTargets(): Promise<HarnessCapabilityStatusDto[]>;
  status(context: HarnessContext, harnessId?: string): HarnessCapabilityStatusDto[];
  desired(context: HarnessContext): Promise<AgentCapabilityDescriptor[]>;
  acknowledge(receipt: HarnessCapabilityApplicationReceipt): void;
  captureLaunch(input: {
    spaceId: string;
    projectId: string;
    cwd: string;
    harnessId: string;
    sessionId?: string;
    desiredRevision: string;
  }): void;
  releaseLaunch(input: {
    spaceId: string;
    projectId: string;
    cwd: string;
    harnessId: string;
    sessionId?: string;
    desiredRevision: string;
  }): void;
  release(context: HarnessContext, harnessId?: string): void;
  instructionState(context: HarnessContext, harnessId?: string): Promise<InstructionProvisionState>;
  dispose(): void;
}

interface StoredStatus {
  target: HarnessProvisioningTarget;
  desiredRevision: string;
  records: HarnessCapabilityRecord[];
  durable: boolean;
}

interface CapabilityGenerationLease {
  targetKey: string;
  authorityId?: string;
  generation?: number;
  revision: string;
  captured?: boolean;
  toolToken?: string;
  resourceRoot?: string;
}

const PENDING_RESTART_REASON = "Harness runtime restart required to apply this capability revision";
const PENDING_RESTART_REMOVAL_REASON = "Harness runtime restart required to drop this capability";

const logicalTargetKey = (
  context: HarnessContext,
  harnessId: string,
  lifetime: HarnessCapabilityTargetLifetime,
): string => {
  const sessionId = lifetime === "physical-runtime" ? "" : (context.sessionId ?? "");
  return JSON.stringify([context.spaceId, context.projectId, context.cwd, harnessId, sessionId]);
};

const RETIRED_TRANSPORT = { kind: "stdio" as const, command: "_", args: [] as string[], envKeys: [] as string[] };
const instructionId = "polyth.behavior";
const mcpId = (id: string) => `polyth.mcp.${id}`;
const projectScopeId = (context: HarnessContext): string | undefined =>
  context.projectId && context.projectId !== "__default__" ? context.projectId : undefined;
const restartSensitive = (record: Pick<HarnessCapabilityRecord, "mutability">): boolean =>
  record.mutability === "requires-restart";

const sanitize = (record: HarnessCapabilityRecord): HarnessCapabilityRecord => {
  const reason = record.reason
    ? redactSecrets(record.reason.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")).slice(0, 280)
    : undefined;
  const evidence = record.evidence && evidenceStage(record.evidence.stage)
    && typeof record.evidence.source === "string" && record.evidence.source.trim().length > 0
    ? {
      stage: record.evidence.stage,
      source: redactSecrets(record.evidence.source.trim().replace(/Bearer\s+\S+/gi, "Bearer [redacted]")).slice(0, 280),
    }
    : undefined;
  const { evidence: _evidence, ...withoutEvidence } = record;
  return {
    ...withoutEvidence,
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
  };
};

const evidenceStage = (value: unknown): value is HarnessCapabilityEvidenceStage =>
  value === "staged" || value === "discovered" || value === "connected" || value === "invocable";

const positiveEvidenceRequired = (record: Pick<HarnessCapabilityRecord, "capabilityId" | "kind" | "mode">): boolean =>
  !record.capabilityId.startsWith("polyth.mcp.retired.")
  && record.mode !== "prompt"
  && record.mode !== "unsupported"
  && (record.kind === "mcp-server" || record.kind === "skill" || record.kind === "tool");

const promptEvidenceRequired = (record: Pick<HarnessCapabilityRecord, "mode">): boolean =>
  record.mode === "prompt";

const evidenceRank = (stage: HarnessCapabilityEvidenceStage): number =>
  ({ staged: 0, discovered: 1, connected: 2, invocable: 3 }[stage]);

const minimumEvidenceStage = (record: Pick<HarnessCapabilityRecord, "kind">): HarnessCapabilityEvidenceStage =>
  record.kind === "tool" ? "invocable" : record.kind === "mcp-server" ? "connected" : "discovered";

const sufficientEvidence = (
  record: Pick<HarnessCapabilityRecord, "capabilityId" | "kind" | "mode">,
  evidence: { stage: HarnessCapabilityEvidenceStage } | undefined,
): boolean => Boolean(evidence && positiveEvidenceRequired(record)
  && evidenceRank(evidence.stage) >= evidenceRank(minimumEvidenceStage(record)));

const honestRecord = (record: HarnessCapabilityRecord): HarnessCapabilityRecord => {
  const clean = sanitize(record);
  if (clean.status !== "applied" || sufficientEvidence(clean, clean.evidence)) return clean;
  if (promptEvidenceRequired(clean)) {
    return { ...clean, status: "unverifiable", reason: clean.reason ?? "Prompt projection was staged; native model consumption is not observable" };
  }
  if (positiveEvidenceRequired(clean)) {
    return { ...clean, status: "unverifiable", reason: clean.reason ?? "Capability application lacks sufficient authoritative evidence" };
  }
  return clean;
};

const stagePendingRecord = (record: HarnessCapabilityRecord): HarnessCapabilityRecord =>
  (record.status === "pending" || record.status === "pending-restart")
    && record.mode !== "unsupported" && !record.evidence
    ? { ...record, evidence: { stage: "staged", source: "polyth:provisioning" } }
    : record;

const rankId = (id: string): string => {
  if (id === instructionId) return "0";
  if (id.startsWith("polyth.")) return `1:${id}`;
  return `2:${id}`;
};

const isDurableApplicationState = (
  _lifetime: HarnessCapabilityTargetLifetime,
  _context: HarnessContext,
): boolean => false;

const targetOf = (
  context: HarnessContext,
  harnessId: string,
  lifetime: HarnessCapabilityTargetLifetime,
): HarnessProvisioningTarget => {
  if (lifetime === "physical-runtime") {
    const { sessionId: _sessionId, ...rest } = context;
    return provisioningTarget(rest, harnessId);
  }
  return provisioningTarget(context, harnessId);
};

const sameLogicalTarget = (
  left: HarnessProvisioningTarget,
  right: HarnessProvisioningTarget,
): boolean =>
  left.spaceId === right.spaceId
  && left.projectId === right.projectId
  && left.cwd === right.cwd
  && left.harnessId === right.harnessId
  && (left.sessionId ?? "") === (right.sessionId ?? "");

const promoteRestartIfLive = (
  previous: HarnessCapabilityRecord[] | undefined,
  next: HarnessCapabilityRecord[],
  liveGeneration: boolean,
): HarnessCapabilityRecord[] => {
  const mapped = next.map((record) => {
    const prior = previous?.find((row) => row.capabilityId === record.capabilityId);
    if (
      record.status === "pending"
      && restartSensitive(record)
      && liveGeneration
      && prior
      && (prior.status === "applied" || prior.status === "unverifiable")
      && prior.appliedRevision === record.desiredRevision
    ) {
      return {
        ...record,
        status: prior.status,
        ...(prior.appliedRevision ? { appliedRevision: prior.appliedRevision } : {}),
        ...(prior.reason ? { reason: prior.reason } : {}),
        ...(prior.evidence ? { evidence: prior.evidence } : {}),
      };
    }
    if (record.capabilityId.startsWith("polyth.mcp.retired.") && liveGeneration) {
      if (prior?.status === "applied" || prior?.status === "unverifiable") {
        return {
          ...record,
          status: prior.status,
          ...(prior.appliedRevision ? { appliedRevision: prior.appliedRevision } : {}),
          ...(prior.reason ? { reason: prior.reason } : { reason: record.reason }),
        };
      }
      return { ...record, status: "pending-restart" as const, reason: PENDING_RESTART_REASON };
    }
    if (record.status !== "pending" || !restartSensitive(record) || !liveGeneration) return record;
    if (prior?.appliedRevision === record.desiredRevision && prior.status !== "pending-restart") return record;
    return { ...record, status: "pending-restart" as const, reason: PENDING_RESTART_REASON };
  });
  if (!liveGeneration || !previous) return mapped;
  const nextIds = new Set(mapped.map((row) => row.capabilityId));
  const removals = previous.flatMap((prior) => {
    if (!restartSensitive(prior) || nextIds.has(prior.capabilityId)) return [];
    if (prior.status === "unsupported" || prior.status === "failed") return [];
    return [{ ...prior, status: "pending-restart" as const, reason: PENDING_RESTART_REMOVAL_REASON }];
  });
  return [...mapped, ...removals];
};

const mergePendingRevision = (
  previous: HarnessCapabilityRecord[] | undefined,
  next: HarnessCapabilityRecord[],
): HarnessCapabilityRecord[] =>
  next.map((record) => {
    if (record.status !== "pending" && record.status !== "pending-restart") return record;
    const prior = previous?.find((row) => row.capabilityId === record.capabilityId);
    const appliedRevision = prior?.appliedRevision;
    const copy = { ...record };
    delete copy.appliedRevision;
    // A newer capability revision must not inherit positive evidence from the
    // prior revision. Evidence supplied for this fresh record remains valid.
    if (prior && prior.desiredRevision !== record.desiredRevision) delete copy.evidence;
    return appliedRevision ? { ...copy, appliedRevision } : copy;
  });

export function createCapabilityProvisioningController(opts: {
  contributions: AgentCapabilityContributionRegistry;
  harnesses: HarnessRegistry;
  behavior: BehaviorService;
  mcp: McpConfigService;
  file: string;
  tools?: AgentToolBridge;
  toolsEndpoint?: () => string;
  contributionAllowed?: (owner: string, context: HarnessContext) => boolean;
  /** Generic physical-runtime restart hook. Shared code never chooses a harness. */
  onCapabilityRestartRequired?: (input: {
    context: HarnessContext;
    harnessId: string;
    desiredRevision: string;
  }) => void;
  /** Generic settlement hook for an admitted physical-runtime revision. */
  onCapabilityRevisionSettled?: (input: {
    spaceId: string;
    projectId: string;
    cwd: string;
    harnessId: string;
    desiredRevision: string;
  }) => void;
  /** @deprecated Composition compatibility; use onCapabilityRestartRequired. */
  onOpenCodeCapabilityRestart?: (context: HarnessContext, desiredRevision: string) => void;
  /** @deprecated Composition compatibility; use onCapabilityRevisionSettled. */
  onOpenCodeCapabilitySettled?: (input: {
    spaceId: string;
    projectId: string;
    cwd: string;
    desiredRevision: string;
  }) => void;
}): CapabilityProvisioningController {
  mkdirSync(dirname(opts.file), { recursive: true });
  let statuses: StoredStatus[] = [];
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      statuses = (raw as Array<StoredStatus & {
        spaceId?: string;
        harnessId?: string;
        projectId?: string;
        sessionId?: string;
      }>).flatMap((row) => {
        if (row && typeof row === "object" && "records" in row) {
          if (row.target?.harnessId) {
            const explicitDurable = typeof row.durable === "boolean";
            const durable = explicitDurable ? row.durable === true : false;
            if (!durable) return [];
            return [{ ...row, durable: true, records: row.records }];
          }
          if (row.spaceId && row.harnessId) {
            return [{
              target: { spaceId: row.spaceId, projectId: row.projectId ?? "", cwd: "", harnessId: row.harnessId },
              desiredRevision: row.desiredRevision,
              records: row.records,
              durable: true,
            }];
          }
        }
        return [];
      });
    }
  } catch {
    statuses = [];
  }

  const persist = () => {
    try {
      const durable = statuses.filter((row) => row.durable);
      atomicWriteSync(opts.file, `${JSON.stringify(durable, null, 2)}\n`);
    } catch {
      // Status is diagnostic. A persist failure must not fail session create.
    }
  };

  const remembered = new Map<string, {
    context: HarnessContext;
    harnessId: string;
    lifetime: HarnessCapabilityTargetLifetime;
    cleanup?: (context: HarnessContext, keepRevisions: readonly string[]) => void;
  }>();
  const leasesByTarget = new Map<string, CapabilityGenerationLease[]>();
  const activeTokens = new Map<string, { revision: string; targetKey: string }>();
  const reconcileSlots = new Map<string, { dirty: boolean; promise: Promise<HarnessCapabilityStatusDto> }>();
  const leasesFor = (targetKey: string): CapabilityGenerationLease[] => leasesByTarget.get(targetKey) ?? [];

  const referencedTokens = (): Set<string> => {
    const out = new Set<string>();
    for (const leases of leasesByTarget.values()) for (const lease of leases) if (lease.toolToken) out.add(lease.toolToken);
    return out;
  };
  const keepRevisionsFor = (targetKey: string): string[] =>
    [...new Set(leasesFor(targetKey).map((lease) => lease.revision).filter(Boolean))];
  const revokeUnreferencedTokens = (): void => {
    const keep = referencedTokens();
    for (const [token] of [...activeTokens.entries()]) {
      if (keep.has(token)) continue;
      opts.tools?.revoke(token);
      activeTokens.delete(token);
    }
  };

  const retiredAuthorities = new Map<string, Set<string>>();
  const retireAuthority = (targetKey: string, authorityId: string): void => {
    const retired = retiredAuthorities.get(targetKey) ?? new Set<string>();
    retired.add(authorityId);
    retiredAuthorities.set(targetKey, retired);
  };

  const upsertStagedLease = (targetKey: string, revision: string): CapabilityGenerationLease => {
    const leases = leasesFor(targetKey);
    const exact = leases.find((lease) => lease.generation === undefined && lease.revision === revision);
    if (exact) return exact;
    for (let i = leases.length - 1; i >= 0; i--) {
      const row = leases[i]!;
      if (row.generation === undefined && !row.captured && row.revision !== revision) leases.splice(i, 1);
    }
    const lease: CapabilityGenerationLease = { targetKey, revision };
    leases.push(lease);
    leasesByTarget.set(targetKey, leases);
    revokeUnreferencedTokens();
    return lease;
  };

  const launchContext = (input: {
    spaceId: string; projectId: string; cwd: string; harnessId: string; sessionId?: string; desiredRevision: string;
  }): { targetKey: string; revision: string } => ({
    targetKey: logicalTargetKey({
      spaceId: input.spaceId,
      projectId: input.projectId,
      cwd: input.cwd,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }, input.harnessId, input.sessionId ? "session" : "physical-runtime"),
    revision: input.desiredRevision,
  });

  const captureLaunch = (input: {
    spaceId: string; projectId: string; cwd: string; harnessId: string; sessionId?: string; desiredRevision: string;
  }): void => {
    if (!input.desiredRevision) return;
    const { targetKey, revision } = launchContext(input);
    const leases = leasesFor(targetKey);
    let lease = leases.find((row) => row.generation === undefined && row.revision === revision)
      ?? leases.find((row) => row.revision === revision);
    if (!lease) {
      lease = { targetKey, revision };
      leases.push(lease);
      leasesByTarget.set(targetKey, leases);
    }
    lease.captured = true;
  };

  const releaseLaunch = (input: {
    spaceId: string; projectId: string; cwd: string; harnessId: string; sessionId?: string; desiredRevision: string;
  }): void => {
    if (!input.desiredRevision) return;
    const { targetKey, revision } = launchContext(input);
    const leases = leasesFor(targetKey);
    const lease = leases.find((row) => row.revision === revision && row.captured && row.generation === undefined);
    if (!lease) return;
    const hasOtherUnbound = leases.some((row) => row !== lease && row.generation === undefined);
    if (hasOtherUnbound) {
      const index = leases.indexOf(lease);
      if (index >= 0) leases.splice(index, 1);
      if (!leases.length) leasesByTarget.delete(targetKey);
    } else {
      lease.captured = false;
    }
    revokeUnreferencedTokens();
  };

  const bindLeaseGeneration = (
    targetKey: string,
    revision: string,
    authorityId?: string,
    generation?: number,
    currentDesired?: string,
  ): void => {
    const leases = leasesFor(targetKey);
    let lease = generation !== undefined
      ? leases.find((row) => row.generation === generation && (!authorityId || row.authorityId === authorityId))
      : undefined;
    if (!lease) lease = leases.find((row) => row.generation === undefined && row.revision === revision);
    if (!lease) {
      lease = { targetKey, revision };
      leases.push(lease);
      leasesByTarget.set(targetKey, leases);
    }
    const previousAuthority = lease.authorityId;
    lease.revision = revision;
    if (authorityId) lease.authorityId = authorityId;
    if (generation !== undefined) {
      lease.generation = generation;
      lease.captured = true;
      for (let i = leases.length - 1; i >= 0; i--) {
        const row = leases[i]!;
        if (row !== lease && row.generation !== undefined) {
          if (row.authorityId && row.authorityId !== (authorityId ?? lease.authorityId)) retireAuthority(targetKey, row.authorityId);
          leases.splice(i, 1);
        }
      }
      if (previousAuthority && authorityId && previousAuthority !== authorityId) retireAuthority(targetKey, previousAuthority);
      if (!currentDesired || revision === currentDesired) {
        for (let i = leases.length - 1; i >= 0; i--) {
          const row = leases[i]!;
          if (row !== lease && row.generation === undefined && !row.captured) leases.splice(i, 1);
        }
      }
    }
    revokeUnreferencedTokens();
  };

  const releaseLeases = (targetKey: string, dropStaged = true): void => {
    if (dropStaged) {
      leasesByTarget.delete(targetKey);
      retiredAuthorities.delete(targetKey);
    } else {
      const staged = leasesFor(targetKey).filter((lease) => lease.generation === undefined);
      if (staged.length) leasesByTarget.set(targetKey, staged);
      else leasesByTarget.delete(targetKey);
    }
    revokeUnreferencedTokens();
  };

  const remember = (
    context: HarnessContext,
    harnessId: string,
    lifetime: HarnessCapabilityTargetLifetime,
    cleanup?: (context: HarnessContext, keepRevisions: readonly string[]) => void,
  ): void => {
    const entry = { context, harnessId, lifetime, ...(cleanup ? { cleanup } : {}) };
    if (lifetime === "physical-runtime") {
      const durable = { ...context };
      delete durable.sessionId;
      remembered.set(`runtime:${context.spaceId}:${context.projectId}:${context.cwd}:${harnessId}`, { ...entry, context: durable });
      return;
    }
    if (context.sessionId) {
      remembered.set(`session:${context.spaceId}:${context.sessionId}:${harnessId}`, entry);
      return;
    }
    remembered.set(`sessionless:${context.spaceId}:${context.projectId}:${context.cwd}:${harnessId}`, entry);
  };

  const replaceRecords = (
    target: HarnessProvisioningTarget,
    desiredRevision: string,
    next: HarnessCapabilityRecord[],
    durable: boolean,
  ): HarnessCapabilityRecord[] => {
    const previousRow = statuses.find((row) => provisioningTargetKey(row.target) === provisioningTargetKey(target))
      ?? statuses.find((row) => sameLogicalTarget(row.target, target));
    const storedTarget = target.authorityId || target.generation !== undefined ? target : previousRow?.target ?? target;
    const previousRecords = previousRow?.records.map(honestRecord);
    const records = promoteRestartIfLive(
      previousRecords,
      mergePendingRevision(previousRecords, next),
      storedTarget.generation !== undefined,
    ).map(honestRecord).map(stagePendingRecord);
    statuses = [
      ...statuses.filter((row) => row !== previousRow && !sameLogicalTarget(row.target, storedTarget)
        && provisioningTargetKey(row.target) !== provisioningTargetKey(storedTarget)),
      { target: storedTarget, desiredRevision, records, durable },
    ];
    persist();
    return records;
  };

  const desired = async (
    context: HarnessContext,
    mcpSnapshot?: McpProjectionState,
  ): Promise<AgentCapabilityDescriptor[]> => {
    const descriptors: AgentCapabilityDescriptor[] = [];
    const text = await opts.behavior.effectiveText();
    descriptors.push({
      id: instructionId,
      kind: "instruction",
      owner: "polyth",
      scope: "deployment",
      revision: capabilityRevision(text),
      title: "Global behavior",
      text,
    });
    if (context.space) {
      const projection = mcpSnapshot ?? opts.mcp.projection(context.space, projectScopeId(context));
      for (const server of projection.servers) {
        const descriptor: Extract<AgentCapabilityDescriptor, { kind: "mcp-server" }> = {
          id: mcpId(server.id),
          kind: "mcp-server",
          owner: "polyth",
          scope: server.projectId ? "project" : "space",
          spaceId: context.spaceId,
          ...(server.projectId ? { projectId: server.projectId } : {}),
          revision: String(server.revision),
          name: server.name,
          enabled: server.enabled,
          transport: server.transport,
          ...(server.raw ? { raw: server.raw as JsonObject } : {}),
        };
        descriptors.push({ ...descriptor, revision: semanticCapabilityRevision(descriptor) });
      }
      for (const tomb of projection.tombstones) {
        const descriptor: Extract<AgentCapabilityDescriptor, { kind: "mcp-server" }> = {
          id: `polyth.mcp.retired.${tomb.name}`,
          kind: "mcp-server",
          owner: "polyth",
          scope: tomb.projectId ? "project" : "space",
          spaceId: context.spaceId,
          ...(tomb.projectId ? { projectId: tomb.projectId } : {}),
          revision: `retired:${tomb.revision}`,
          name: tomb.name,
          enabled: false,
          transport: RETIRED_TRANSPORT,
        };
        descriptors.push({ ...descriptor, revision: semanticCapabilityRevision(descriptor) });
      }
    }
    descriptors.push(...opts.contributions.resolve(context).filter((descriptor) =>
      descriptor.owner === "polyth" || opts.contributionAllowed?.(descriptor.owner, context) !== false));
    return descriptors.sort((a, b) => rankId(a.id).localeCompare(rankId(b.id)) || a.id.localeCompare(b.id));
  };

  const unsupportedResult = (items: AgentCapabilityDescriptor[], reason: string): HarnessCapabilityRecord[] =>
    items.map((capability) => ({
      capabilityId: capability.id,
      kind: capability.kind,
      owner: capability.owner,
      desiredRevision: capability.revision,
      mode: "unsupported" as const,
      status: "unsupported" as const,
      mutability: "immutable" as const,
      reason,
    }));

  const failedResult = (
    items: Array<{ capability: AgentCapabilityDescriptor; mode: HarnessCapabilityRecord["mode"]; mutability: HarnessCapabilityRecord["mutability"] }>,
    reason: string,
  ): HarnessCapabilityRecord[] => items.map((item) => ({
    capabilityId: item.capability.id,
    kind: item.capability.kind,
    owner: item.capability.owner,
    desiredRevision: item.capability.revision,
    mode: item.mode,
    status: item.mode === "unsupported" ? "unsupported" as const : "failed" as const,
    mutability: item.mutability,
    reason: item.mode === "unsupported" ? "Harness does not support this capability" : reason,
  }));

  const revokeTools = (targetKey: string) => {
    for (const lease of leasesFor(targetKey)) {
      if (!lease.toolToken || lease.generation !== undefined || lease.captured) continue;
      opts.tools?.revoke(lease.toolToken);
      activeTokens.delete(lease.toolToken);
      delete lease.toolToken;
    }
    revokeUnreferencedTokens();
  };

  const runReconcile = async (provider: HarnessProvider, context: HarnessContext): Promise<HarnessCapabilityStatusDto> => {
    let lifetime: HarnessCapabilityTargetLifetime = "session";
    let target = targetOf(context, provider.descriptor.id, lifetime);
    let items: AgentCapabilityDescriptor[] = [];
    let planned: ReturnType<typeof planHarnessCapabilities>["items"] = [];
    try {
      const support = provider.provisioner ? await provider.provisioner.support(context) : undefined;
      lifetime = support?.targetLifetime ?? "session";
      remember(context, provider.descriptor.id, lifetime, provider.provisioner?.release
        ? (ctx, keepRevisions) => provider.provisioner!.release!(ctx, { keepRevisions }) : undefined);
      target = targetOf(context, provider.descriptor.id, lifetime);
      const durable = isDurableApplicationState(lifetime, context);
      const applyContext = lifetime === "physical-runtime" ? { ...context, sessionId: undefined } : context;
      const mcpSnapshot = applyContext.space
        ? opts.mcp.projection(applyContext.space, projectScopeId(applyContext))
        : undefined;
      items = await desired(applyContext, mcpSnapshot);
      const desiredRevision = desiredBundleRevision(items);
      if (!provider.provisioner || !support) {
        const next = unsupportedResult(items, "Harness has no capability provisioner");
        replaceRecords(target, desiredRevision, next, durable);
        return { harnessId: provider.descriptor.id, desiredRevision, records: next.map(sanitize), target };
      }
      const plan = planHarnessCapabilities(provider.descriptor.id, items, support, applyContext);
      planned = plan.items;
      const targetKey = logicalTargetKey(applyContext, provider.descriptor.id, lifetime);
      upsertStagedLease(targetKey, desiredRevision);
      let toolEnv: Record<string, string> = {};
      const mcpSupport = support.kinds["mcp-server"];
      const toolItems = plan.items.filter((item) => item.capability.kind === "tool" && item.mode === "mcp");
      if (!toolItems.length) revokeTools(targetKey);
      if (toolItems.length && mcpSupport && !context.remote && opts.tools && opts.toolsEndpoint) {
        const tools = toolItems.map((item) => item.capability)
          .filter((item): item is Extract<AgentCapabilityDescriptor, { kind: "tool" }> => item.kind === "tool");
        const revision = desiredBundleRevision(tools);
        const stagedLease = upsertStagedLease(targetKey, desiredRevision);
        let token = stagedLease.toolToken;
        const existing = token ? activeTokens.get(token) : undefined;
        if (!token || existing?.revision !== revision) {
          const toolScope = mcpSupport.configScope === "session"
            ? "session" : mcpSupport.configScope === "deployment" ? "deployment" : "project";
          token = opts.tools.mint({
            spaceId: context.spaceId,
            projectId: context.projectId,
            cwd: context.cwd,
            ...(toolScope === "session" && applyContext.sessionId ? { sessionId: applyContext.sessionId } : {}),
            tools,
          }).token;
          stagedLease.toolToken = token;
          activeTokens.set(token, { revision, targetKey });
          revokeUnreferencedTokens();
        }
        const stdio = opts.tools.stdioCommand(opts.toolsEndpoint(), token);
        toolEnv = stdio.env;
        const mcpMode = mcpSupport.modes.find((mode) => mode !== "unsupported") ?? "unsupported";
        plan.items.push({
          capability: {
            id: "polyth.agent-tools",
            kind: "mcp-server",
            owner: "polyth",
            scope: mcpSupport.configScope === "session"
              ? (applyContext.sessionId ? "session" : "project")
              : mcpSupport.configScope === "deployment" ? "deployment" : "project",
            revision,
            name: AGENT_TOOLS_MCP_NAME,
            enabled: true,
            transport: { kind: "stdio", command: stdio.command, args: stdio.args, envKeys: Object.keys(stdio.env) },
          },
          mode: mcpMode,
          mutability: mcpSupport.mutability,
        });
        planned = plan.items;
      }
      plan.keepRevisions = keepRevisionsFor(targetKey);
      const canonicalIds = new Set(mcpSnapshot?.servers.map((server) => mcpId(server.id)) ?? []);
      const secrets: CapabilitySecretResolver = {
        mcpSecrets(serverId) {
          if (serverId === "polyth.agent-tools") return { ...toolEnv };
          if (!mcpSnapshot || !canonicalIds.has(serverId)) return {};
          return mcpSnapshot.secretsFor(serverId.slice("polyth.mcp.".length));
        },
      };
      const result = await provider.provisioner.apply(applyContext, plan, secrets);
      const records = replaceRecords(target, desiredRevision, result.records, durable);
      const storedTarget = statuses.find((row) =>
        provisioningTargetKey(row.target) === provisioningTargetKey(target) || sameLogicalTarget(row.target, target))?.target ?? target;
      if (
        lifetime === "physical-runtime"
        && records.some((row) => row.status === "pending-restart")
        && storedTarget.generation !== undefined
      ) {
        if (opts.onCapabilityRestartRequired) {
          opts.onCapabilityRestartRequired({ context: applyContext, harnessId: provider.descriptor.id, desiredRevision });
        } else {
          opts.onOpenCodeCapabilityRestart?.(applyContext, desiredRevision);
        }
      }
      return { harnessId: provider.descriptor.id, desiredRevision, records, target: storedTarget };
    } catch (error) {
      remember(context, provider.descriptor.id, lifetime, provider.provisioner?.release
        ? (ctx, keepRevisions) => provider.provisioner!.release!(ctx, { keepRevisions }) : undefined);
      target = targetOf(context, provider.descriptor.id, lifetime);
      if (!items.length) {
        try { items = await desired(context); } catch { items = []; }
      }
      const desiredRevision = desiredBundleRevision(items);
      const reason = sanitize({
        capabilityId: instructionId,
        kind: "instruction",
        owner: "polyth",
        desiredRevision: desiredRevision || "unknown",
        mode: "unsupported",
        status: "failed",
        mutability: "immutable",
        reason: (error as Error).message,
      }).reason ?? "Harness capability probe failed";
      const next = planned.length ? failedResult(planned, reason)
        : unsupportedResult(items, reason.length ? reason : "Harness capability probe failed");
      if (!planned.length && next.length === 0) {
        next.push({
          capabilityId: instructionId,
          kind: "instruction",
          owner: "polyth",
          desiredRevision: desiredRevision || "unknown",
          mode: "unsupported",
          status: "failed",
          mutability: "immutable",
          reason,
        });
      }
      replaceRecords(target, desiredRevision, next, isDurableApplicationState(lifetime, context));
      return { harnessId: provider.descriptor.id, desiredRevision, records: next.map(sanitize), target };
    }
  };

  const reconcile = async (provider: HarnessProvider, context: HarnessContext): Promise<HarnessCapabilityStatusDto> => {
    let lifetime: HarnessCapabilityTargetLifetime = "session";
    try {
      const support = provider.provisioner ? await provider.provisioner.support(context) : undefined;
      lifetime = support?.targetLifetime ?? "session";
    } catch {
      lifetime = "session";
    }
    const key = logicalTargetKey(context, provider.descriptor.id, lifetime);
    const existing = reconcileSlots.get(key);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const slot: { dirty: boolean; promise: Promise<HarnessCapabilityStatusDto> } = {
      dirty: false,
      promise: Promise.resolve(undefined as unknown as HarnessCapabilityStatusDto),
    };
    slot.promise = (async () => {
      try {
        let result: HarnessCapabilityStatusDto;
        for (;;) {
          slot.dirty = false;
          result = await runReconcile(provider, context);
          if (slot.dirty) continue;
          if (reconcileSlots.get(key) === slot) reconcileSlots.delete(key);
          if (!slot.dirty) return result;
          reconcileSlots.set(key, slot);
        }
      } finally {
        if (reconcileSlots.get(key) === slot) reconcileSlots.delete(key);
      }
    })();
    reconcileSlots.set(key, slot);
    return slot.promise;
  };

  const acknowledge = (receipt: HarnessCapabilityApplicationReceipt): void => {
    if (!receipt.target.spaceId || !receipt.target.harnessId) return;
    const exact = statuses.find((item) => provisioningTargetKey(item.target) === provisioningTargetKey(receipt.target));
    const logical = statuses.find((item) => sameLogicalTarget(item.target, receipt.target));
    const row = exact ?? logical;
    if (!row) return;
    if (row.target.spaceId !== receipt.target.spaceId || row.target.harnessId !== receipt.target.harnessId) return;
    if (row.target.projectId !== receipt.target.projectId || row.target.cwd !== receipt.target.cwd) return;
    const lifetime = row.target.sessionId ? "session" : "physical-runtime";
    const targetKey = logicalTargetKey({
      spaceId: row.target.spaceId,
      projectId: row.target.projectId,
      cwd: row.target.cwd,
      ...(row.target.sessionId ? { sessionId: row.target.sessionId } : {}),
    }, row.target.harnessId, lifetime);
    const storedGen = row.target.generation;
    const receiptGen = receipt.target.generation;
    const storedAuth = row.target.authorityId;
    const receiptAuth = receipt.target.authorityId;
    if (receiptAuth && retiredAuthorities.get(targetKey)?.has(receiptAuth)) return;
    if (storedAuth && receiptAuth && storedAuth === receiptAuth) {
      if (storedGen !== undefined && (receiptGen === undefined || receiptGen < storedGen)) return;
    } else if (storedAuth && receiptAuth && storedAuth !== receiptAuth) {
      if (receiptGen === undefined) return;
    } else if (storedGen !== undefined && (receiptGen === undefined || receiptGen < storedGen)) return;
    const matchesCurrentBundle = !receipt.desiredRevision || receipt.desiredRevision === row.desiredRevision;
    const ids = new Set(receipt.capabilityIds);
    const generationChanged = receipt.outcome !== "failed"
      && receiptGen !== undefined
      && (storedGen === undefined || receiptGen !== storedGen || (receiptAuth !== undefined && receiptAuth !== storedAuth));
    const resetForGeneration = (record: HarnessCapabilityRecord): HarnessCapabilityRecord => {
      if (!generationChanged || record.capabilityId.startsWith("polyth.mcp.retired.")) return record;
      if (record.status === "pending-restart") {
        const { evidence: _evidence, ...withoutEvidence } = record;
        return stagePendingRecord(withoutEvidence);
      }
      if (record.status !== "applied" && record.status !== "unverifiable") return record;
      const { evidence: _evidence, ...withoutEvidence } = record;
      return stagePendingRecord({
        ...withoutEvidence,
        status: "pending",
        reason: "Awaiting evidence from the current runtime generation",
      });
    };
    const receiptEvidence = receipt.evidence && evidenceStage(receipt.evidence.stage)
      && typeof receipt.evidence.source === "string" && receipt.evidence.source.trim().length > 0
      ? {
        stage: receipt.evidence.stage,
        source: redactSecrets(receipt.evidence.source.trim().replace(/Bearer\s+\S+/gi, "Bearer [redacted]")).slice(0, 280),
      }
      : undefined;
    const outcomeFor = (record: HarnessCapabilityRecord): HarnessCapabilityApplicationReceipt["outcome"] => {
      if (receipt.outcome !== "applied") return receipt.outcome;
      // Prompt delivery only proves that text was staged. Native MCP/skill
      // admission needs an explicit observation before it can be green.
      if (promptEvidenceRequired(record)) return "unverifiable";
      if (positiveEvidenceRequired(record) && !sufficientEvidence(record, receiptEvidence)) return "unverifiable";
      return "applied";
    };
    const reasonFor = (record: HarnessCapabilityRecord, outcome: HarnessCapabilityApplicationReceipt["outcome"]): string | undefined => {
      if (receipt.reason) return receipt.reason;
      if (outcome !== "unverifiable" || receipt.outcome !== "applied") return record.reason;
      if (promptEvidenceRequired(record)) return "Prompt projection was staged; native model consumption is not observable";
      if (positiveEvidenceRequired(record)) return "Capability application lacks sufficient authoritative evidence";
      return record.reason;
    };
    const settleNegativeAdmission = (records: HarnessCapabilityRecord[]): HarnessCapabilityRecord[] => {
      const retiredIds = new Set(records
        .filter((record) => record.capabilityId.startsWith("polyth.mcp.retired."))
        .map((record) => record.capabilityId.slice("polyth.mcp.retired.".length)));
      return records.flatMap((record) => {
        if (record.capabilityId.startsWith("polyth.mcp.retired.")) {
          return [sanitize({
            ...record,
            status: receipt.outcome,
            appliedRevision: record.desiredRevision,
            reason: record.reason ?? "Retired from Polyth desired state",
          })];
        }
        if (
          record.status === "pending-restart"
          && record.capabilityId.startsWith("polyth.mcp.")
          && retiredIds.has(record.capabilityId.slice("polyth.mcp.".length))
        ) return [];
        if (
          record.status === "pending-restart"
          && restartSensitive(record)
          && record.reason === PENDING_RESTART_REMOVAL_REASON
        ) return [];
        return [record];
      });
    };
    if (receipt.outcome !== "failed") {
      if (!matchesCurrentBundle && generationChanged) row.records = row.records.map(resetForGeneration);
      bindLeaseGeneration(targetKey, receipt.desiredRevision || row.desiredRevision, receiptAuth, receiptGen, row.desiredRevision);
      if (storedAuth && receiptAuth && storedAuth !== receiptAuth) retireAuthority(targetKey, storedAuth);
      row.target = {
        ...row.target,
        ...receipt.target,
        spaceId: row.target.spaceId,
        projectId: row.target.projectId,
        cwd: row.target.cwd,
        harnessId: row.target.harnessId,
        ...(row.target.sessionId && !receipt.target.sessionId ? { sessionId: row.target.sessionId } : {}),
      };
      if (receipt.desiredRevision) {
        const settled = {
          spaceId: row.target.spaceId,
          projectId: row.target.projectId,
          cwd: row.target.cwd,
          harnessId: row.target.harnessId,
          desiredRevision: receipt.desiredRevision,
        };
        if (opts.onCapabilityRevisionSettled) {
          opts.onCapabilityRevisionSettled(settled);
        } else if (lifetime === "physical-runtime") {
          const { harnessId: _harnessId, ...legacy } = settled;
          opts.onOpenCodeCapabilitySettled?.(legacy);
        }
      }
    }
    if (receipt.outcome !== "failed" && !matchesCurrentBundle) {
      persist();
      return;
    }
    if (receipt.outcome !== "failed" && ids.size === 0) {
      if (matchesCurrentBundle) row.records = settleNegativeAdmission(row.records);
      if (generationChanged) row.records = row.records.map(resetForGeneration);
      persist();
      return;
    }
    const materializedKey = provisioningTargetKey(row.target);
    statuses = statuses.filter((item) => item === row || provisioningTargetKey(item.target) !== materializedKey);
    if (receipt.outcome !== "failed" && matchesCurrentBundle) row.records = settleNegativeAdmission(row.records);
    row.records = row.records.flatMap((record) => {
      if (ids.size && !ids.has(record.capabilityId)) {
        return [resetForGeneration(record)];
      }
      if (record.status === "unsupported" || record.status === "failed") return [record];
      if (receipt.outcome === "failed") {
        if (!matchesCurrentBundle) return [record];
        const { evidence: _evidence, ...withoutEvidence } = record;
        return [sanitize({ ...withoutEvidence, status: "failed", reason: receipt.reason ?? record.reason })];
      }
      const outcome = outcomeFor(record);
      const { evidence: _previousEvidence, ...withoutEvidence } = record;
      return [sanitize({
        ...withoutEvidence,
        status: outcome,
        appliedRevision: record.desiredRevision,
        reason: reasonFor(record, outcome),
        ...(receiptEvidence ? { evidence: receiptEvidence } : {}),
      })];
    });
    persist();
  };

  const disposeReceiptSink = setCapabilityReceiptSink(acknowledge);
  const disposeLaunchSink = setCapabilityLaunchSink((event) => {
    if (event.outcome === "failed") releaseLaunch({ ...event.target, desiredRevision: event.desiredRevision });
    else captureLaunch({ ...event.target, desiredRevision: event.desiredRevision });
  });

  const matchesSessionRelease = (
    row: { spaceId: string; projectId: string; cwd: string; sessionId?: string; harnessId?: string },
    context: HarnessContext,
    harnessId?: string,
  ): boolean => {
    if (harnessId && row.harnessId && row.harnessId !== harnessId) return false;
    return Boolean(context.sessionId && row.spaceId === context.spaceId && row.sessionId === context.sessionId);
  };

  const matchesPhysicalRelease = (
    row: { spaceId: string; projectId: string; cwd: string; sessionId?: string; harnessId?: string },
    context: HarnessContext,
    harnessId?: string,
  ): boolean => {
    if (harnessId && row.harnessId && row.harnessId !== harnessId) return false;
    return row.spaceId === context.spaceId && row.projectId === context.projectId && row.cwd === context.cwd && !row.sessionId;
  };

  const release = (context: HarnessContext, harnessId?: string): void => {
    const sessionRelease = Boolean(context.sessionId);
    const dropped: Array<{
      harnessId: string;
      lifetime: HarnessCapabilityTargetLifetime;
      cleanup?: (context: HarnessContext, keepRevisions: readonly string[]) => void;
    }> = [];
    for (const [key, entry] of [...remembered.entries()]) {
      if (harnessId && entry.harnessId !== harnessId) continue;
      if (sessionRelease) {
        if (entry.lifetime === "physical-runtime") continue;
        if (!matchesSessionRelease({ ...entry.context, harnessId: entry.harnessId }, context, harnessId)) continue;
      } else if (!matchesPhysicalRelease({ ...entry.context, harnessId: entry.harnessId }, context, harnessId)) continue;
      dropped.push({ harnessId: entry.harnessId, lifetime: entry.lifetime, cleanup: entry.cleanup });
      remembered.delete(key);
    }
    const providersById = new Map(opts.harnesses.providers().map((provider) => [provider.descriptor.id, provider]));
    for (const droppedEntry of dropped) {
      const releaseContext = droppedEntry.lifetime === "physical-runtime" ? { ...context, sessionId: undefined } : context;
      const targetKey = logicalTargetKey(releaseContext, droppedEntry.harnessId, droppedEntry.lifetime);
      releaseLeases(targetKey);
      const keepRevisions = keepRevisionsFor(targetKey);
      try {
        if (droppedEntry.cleanup) droppedEntry.cleanup(releaseContext, keepRevisions);
        else providersById.get(droppedEntry.harnessId)?.provisioner?.release?.(releaseContext, { keepRevisions });
      } catch {
        // Overlay cleanup must not fail session delete.
      }
    }
    statuses = statuses.filter((row) => {
      if (harnessId && row.target.harnessId !== harnessId) return true;
      const lifetime = dropped.find((item) => item.harnessId === row.target.harnessId)?.lifetime
        ?? (row.target.sessionId ? "session" : "physical-runtime");
      if (sessionRelease) {
        if (lifetime === "physical-runtime") return true;
        return !(row.target.spaceId === context.spaceId && row.target.sessionId === context.sessionId);
      }
      return !matchesPhysicalRelease(row.target, context, harnessId);
    });
    persist();
  };

  const instructionState = async (context: HarnessContext, harnessId?: string): Promise<InstructionProvisionState> => {
    const desiredRevision = capabilityRevision(await opts.behavior.effectiveText());
    const rows = statuses.filter((row) => {
      if (row.target.spaceId !== context.spaceId || row.target.projectId !== context.projectId) return false;
      if (harnessId && row.target.harnessId !== harnessId) return false;
      const lifetime = [...remembered.values()].find((entry) => entry.harnessId === row.target.harnessId)?.lifetime
        ?? (row.target.sessionId ? "session" : "physical-runtime");
      if (lifetime === "physical-runtime") return !row.target.sessionId && row.target.cwd === context.cwd;
      if (context.sessionId) return row.target.sessionId === context.sessionId;
      return !row.target.sessionId;
    });
    const records = rows[0]?.records ?? [];
    const record = records.find((row) => row.capabilityId === instructionId);
    const live = record
      && (record.status === "applied" || record.status === "unverifiable")
      && record.appliedRevision === desiredRevision
      && record.desiredRevision === desiredRevision;
    return {
      provisioned: Boolean(live),
      contributions: records.filter((row) =>
        row.kind === "instruction"
        && (row.status === "applied" || row.status === "unverifiable")
        && row.appliedRevision === desiredRevision).map((row) => row.capabilityId),
      ...(live && (record.status === "applied" || record.status === "unverifiable") ? { verification: record.status } : {}),
    };
  };

  const reconcileRemembered = async (
    filter: (entry: { context: HarnessContext; harnessId: string }) => boolean,
  ): Promise<HarnessCapabilityStatusDto[]> => {
    const live = new Map(opts.harnesses.providers().map((provider) => [provider.descriptor.id, provider]));
    const out: HarnessCapabilityStatusDto[] = [];
    for (const [key, entry] of [...remembered.entries()]) {
      if (!filter(entry)) continue;
      const provider = live.get(entry.harnessId);
      if (!provider) {
        const releaseContext = entry.lifetime === "physical-runtime" ? { ...entry.context, sessionId: undefined } : entry.context;
        const targetKey = logicalTargetKey(releaseContext, entry.harnessId, entry.lifetime);
        releaseLeases(targetKey);
        try { entry.cleanup?.(releaseContext, keepRevisionsFor(targetKey)); } catch { /* provider is already gone */ }
        remembered.delete(key);
        statuses = statuses.filter((row) => row.target.harnessId !== entry.harnessId
          || row.target.spaceId !== entry.context.spaceId
          || row.target.projectId !== entry.context.projectId
          || row.target.cwd !== entry.context.cwd
          || (row.target.sessionId ?? "") !== (entry.context.sessionId ?? ""));
        continue;
      }
      out.push(await reconcile(provider, entry.context));
    }
    persist();
    return out;
  };

  return {
    reconcile,
    async reconcileAll(context) {
      const out: HarnessCapabilityStatusDto[] = [];
      for (const provider of opts.harnesses.providers()) out.push(await reconcile(provider, context));
      const seen = new Set(out.map((row) => `${row.harnessId}:${row.target?.spaceId}:${row.target?.projectId}:${row.target?.cwd}:${row.target?.sessionId ?? ""}`));
      const extra = await reconcileRemembered((entry) => {
        if (entry.context.spaceId !== context.spaceId) return false;
        const id = `${entry.harnessId}:${entry.context.spaceId}:${entry.context.projectId}:${entry.context.cwd}:${entry.context.sessionId ?? ""}`;
        return !seen.has(id);
      });
      return [...out, ...extra];
    },
    reconcileSpace(space) {
      return reconcileRemembered((entry) => entry.context.spaceId === space.spaceId);
    },
    reconcileAllActiveTargets() {
      return reconcileRemembered(() => true);
    },
    status(context, harnessId) {
      return opts.harnesses.providers()
        .filter((provider) => !harnessId || provider.descriptor.id === harnessId)
        .map((provider) => {
          const row = statuses.find((item) => {
            if (item.target.spaceId !== context.spaceId || item.target.harnessId !== provider.descriptor.id
              || item.target.projectId !== context.projectId || item.target.cwd !== context.cwd) return false;
            const lifetime = [...remembered.values()].find((entry) => entry.harnessId === provider.descriptor.id)?.lifetime
              ?? (item.target.sessionId ? "session" : "physical-runtime");
            if (lifetime === "physical-runtime") return !item.target.sessionId;
            if (context.sessionId) return item.target.sessionId === context.sessionId;
            return !item.target.sessionId;
          });
          return {
            harnessId: provider.descriptor.id,
            desiredRevision: row?.desiredRevision ?? "",
            records: (row?.records ?? []).map(honestRecord),
            ...(row?.target ? { target: row.target } : {}),
          };
        });
    },
    desired: (context) => desired(context),
    acknowledge,
    captureLaunch,
    releaseLaunch,
    release,
    instructionState,
    dispose() {
      disposeLaunchSink();
      disposeReceiptSink();
    },
  };
}
