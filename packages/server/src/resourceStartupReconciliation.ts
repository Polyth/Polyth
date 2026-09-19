import type { SessionProjection } from "@polyth/contracts";
import type { CanonicalResource, ResourceProvisioning } from "@polyth/control-plane/resources";
import type { CanonicalSecurity } from "./canonicalSecurity.ts";
import type { ProjectRegistry } from "./projects.ts";
import { projectResourceReceipt, sessionResourceReceipt } from "./resourceReceipts.ts";

const ACTOR = "system:resource-reconciler";

const recovery = (): Error => Object.assign(
  new Error("Canonical resource authority does not match durable domain state"),
  { code: "recovery-required" },
);

export interface StartupSessionSource {
  projection?(sessionId: string): Promise<SessionProjection | undefined>;
  /** A deletion tombstone proves the domain rows were removed even if a
   * previous process failed before the canonical resource transition. */
  deletionTombstone?(sessionId: string): Promise<unknown | undefined>;
}

export interface ResourceStartupReconciliationResult {
  provisioningFinalized: number;
  provisioningAborted: number;
  deletionsFinalized: number;
  lifecycleRolledBack: number;
  archivesFinalized: number;
  restoresFinalized: number;
}

export async function reconcileCanonicalResourcesAtBoot(input: {
  security: CanonicalSecurity;
  projects: ProjectRegistry;
  sessions: StartupSessionSource;
}): Promise<ResourceStartupReconciliationResult> {
  const { security, projects, sessions } = input;
  const result: ResourceStartupReconciliationResult = {
    provisioningFinalized: 0,
    provisioningAborted: 0,
    deletionsFinalized: 0,
    lifecycleRolledBack: 0,
    archivesFinalized: 0,
    restoresFinalized: 0,
  };
  const pending = new Map<string, ResourceProvisioning>(
    security.resources.pending().map((operation) => [operation.resourceId, operation]),
  );
  const resources = security.control.all<{ id: string; kind: string }>(
    "SELECT id,kind FROM resources WHERE kind IN ('project','session') ORDER BY kind,id",
  );

  const current = (id: string): CanonicalResource => {
    const row = security.resources.resource(id);
    if (!row) throw recovery();
    return row;
  };
  const transition = (
    row: CanonicalResource,
    from: readonly CanonicalResource["lifecycle"][],
    to: CanonicalResource["lifecycle"],
    action: string,
    bumpAccess = true,
  ): CanonicalResource => security.resourceLifecycle.transition({
    resourceId: row.id,
    kind: row.kind,
    orgId: row.orgId,
    spaceId: row.spaceId,
    from,
    to,
    expectedRevision: row.revision,
    actor: ACTOR,
    action,
    bumpAccess,
  });
  const finishProvisioning = (row: CanonicalResource, receipt: string): CanonicalResource => {
    const operation = pending.get(row.id);
    if (!operation) throw recovery();
    security.resources.recordDomainReady(operation.operationId, receipt);
    const refreshed = current(row.id);
    const active = security.resources.activate(operation.operationId, refreshed.revision);
    result.provisioningFinalized += 1;
    return active;
  };
  const abortMissing = (row: CanonicalResource): void => {
    const operation = pending.get(row.id);
    if (!operation || operation.state === "domain-ready" || operation.domainReceiptDigest) throw recovery();
    security.resources.abortMissingDomain(operation.operationId, row.revision);
    result.provisioningAborted += 1;
  };

  for (const identity of resources) {
    let row = current(identity.id);
    if (identity.kind === "project") {
      const project = await projects.get(row.id);
      if (!project) {
        if (row.lifecycle === "provisioning" || row.lifecycle === "quarantined") {
          abortMissing(row);
          continue;
        }
        if (row.lifecycle === "deleting") {
          transition(row, ["deleting"], "deleted", "resource.delete-reconciled", false);
          result.deletionsFinalized += 1;
          continue;
        }
        if (row.lifecycle === "deleted") continue;
        throw recovery();
      }
      if (row.kind !== "project" || project.spaceId !== row.spaceId || row.parentId !== undefined) throw recovery();
      if (row.lifecycle === "provisioning" || row.lifecycle === "quarantined") {
        row = finishProvisioning(row, projectResourceReceipt(project));
      }
      if (row.lifecycle === "deleting") {
        transition(row, ["deleting"], "active", "resource.delete-rolled-back");
        result.lifecycleRolledBack += 1;
        continue;
      }
      if (row.lifecycle !== "active") throw recovery();
      continue;
    }

    if (identity.kind !== "session") throw recovery();
    if (!sessions.projection) throw recovery();
    const projection = await sessions.projection(row.id);
    if (!projection) {
      const deletionProof = await sessions.deletionTombstone?.(row.id);
      if (row.lifecycle === "active" && deletionProof !== undefined) {
        // A prior delete committed the session tombstone/domain purge but a
        // concurrent read rolled the resource back to active. Re-enter the
        // lifecycle graph explicitly, then finish the canonical tombstone.
        const deleting = transition(row, ["active"], "deleting", "resource.delete-recovered");
        transition(deleting, ["deleting"], "deleted", "resource.delete-reconciled", false);
        result.deletionsFinalized += 1;
        continue;
      }
      if (row.lifecycle === "provisioning" || row.lifecycle === "quarantined") {
        abortMissing(row);
        continue;
      }
      if (row.lifecycle === "deleting") {
        transition(row, ["deleting"], "deleted", "resource.delete-reconciled", false);
        result.deletionsFinalized += 1;
        continue;
      }
      if (row.lifecycle === "deleted") continue;
      throw recovery();
    }
    if (row.kind !== "session" || projection.spaceId !== row.spaceId || row.parentId !== projection.projectId) {
      throw recovery();
    }
    const project = row.parentId
      ? security.resources.active(row.parentId, { orgId: row.orgId, spaceId: row.spaceId })
      : undefined;
    if (!project || project.kind !== "project") throw recovery();

    if (row.lifecycle === "provisioning" || row.lifecycle === "quarantined") {
      row = finishProvisioning(row, sessionResourceReceipt(projection));
    }
    if (row.lifecycle === "archiving") {
      if (projection.status === "archived") {
        transition(row, ["archiving"], "archived", "resource.archived");
        result.archivesFinalized += 1;
      } else {
        transition(row, ["archiving"], "active", "resource.archive-rolled-back");
        result.lifecycleRolledBack += 1;
      }
      continue;
    }
    if (row.lifecycle === "archived") {
      if (projection.status === "archived") continue;
      transition(row, ["archived"], "active", "resource.restored");
      result.restoresFinalized += 1;
      continue;
    }
    if (row.lifecycle === "deleting") {
      transition(
        row,
        ["deleting"],
        projection.status === "archived" ? "archived" : "active",
        "resource.delete-rolled-back",
      );
      result.lifecycleRolledBack += 1;
      continue;
    }
    if (row.lifecycle !== "active" || projection.status === "archived") throw recovery();
  }

  return result;
}
