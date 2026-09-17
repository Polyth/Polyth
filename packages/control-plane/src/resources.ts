import { controlError, digest, type ControlPlane } from './index.ts';

export type ResourceVisibility = 'private' | 'restricted' | 'space' | 'inherit';
export type ResourceLifecycle = 'provisioning' | 'active' | 'archiving' | 'archived' | 'deleting' | 'deleted' | 'quarantined';
export type ProvisioningState = 'pending' | 'domain-ready' | 'finalized' | 'aborted' | 'quarantined';

export interface CanonicalResource {
  id: string;
  kind: string;
  orgId: string;
  spaceId: string;
  parentId?: string;
  ownerPrincipalId: string;
  createdBy: string;
  visibility: ResourceVisibility;
  lifecycle: ResourceLifecycle;
  accessRevision: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ResourceProvisioning {
  operationId: string;
  resourceId: string;
  requestDigest: string;
  state: ProvisioningState;
  domainReceiptDigest?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface BeginResourceProvisioning {
  operationId: string;
  resourceId: string;
  kind: string;
  orgId: string;
  spaceId: string;
  parentId?: string;
  ownerPrincipalId: string;
  createdBy: string;
  visibility: ResourceVisibility;
}

export interface ResourceRegistry {
  begin(input: BeginResourceProvisioning): { resource: CanonicalResource; provisioning: ResourceProvisioning; replayed: boolean };
  resource(resourceId: string): CanonicalResource | undefined;
  active(resourceId: string, scope: { orgId: string; spaceId: string }): CanonicalResource | undefined;
  provisioning(operationId: string): ResourceProvisioning | undefined;
  pending(): ResourceProvisioning[];
  recordDomainReady(operationId: string, domainReceipt: string | Buffer): ResourceProvisioning;
  activate(operationId: string, expectedResourceRevision: number): CanonicalResource;
  abortMissingDomain(operationId: string, expectedResourceRevision: number): CanonicalResource;
  quarantineUnknown(operationId: string, expectedResourceRevision: number): CanonicalResource;
}

type ResourceRow = {
  id: string; kind: string; org_id: string; space_id: string; parent_id: string | null;
  owner_principal_id: string; created_by: string; visibility: ResourceVisibility; lifecycle: ResourceLifecycle;
  access_revision: number; revision: number; created_at_ms: number; updated_at_ms: number;
};
type ProvisioningRow = {
  operation_id: string; resource_id: string; request_digest: string; state: ProvisioningState;
  domain_receipt_digest: string | null; created_at_ms: number; updated_at_ms: number; revision: number;
};

// Leading `_` is admitted for derived first-party ids such as package workspace
// projects (`__polyth_pkg_<hash>`); `.` still cannot lead, so no `.`/`..` id.
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;
const KIND = /^[a-z][a-z0-9.-]{0,63}$/;
const VISIBILITY = new Set<ResourceVisibility>(['private', 'restricted', 'space', 'inherit']);
const SYSTEM_ACTOR = 'system:resource-provisioner';

function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw controlError('invalid-input', `Invalid ${field}`);
  return value;
}
function kind(value: unknown): string {
  if (typeof value !== 'string' || !KIND.test(value)) throw controlError('invalid-input', 'Invalid resource kind');
  return value;
}
function visibility(value: unknown): ResourceVisibility {
  if (typeof value !== 'string' || !VISIBILITY.has(value as ResourceVisibility)) throw controlError('invalid-input', 'Invalid resource visibility');
  return value as ResourceVisibility;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw controlError('invalid-input', 'Invalid resource revision');
  return value as number;
}
function resource(row: ResourceRow | undefined): CanonicalResource | undefined {
  if (!row) return undefined;
  return {
    id: row.id, kind: row.kind, orgId: row.org_id, spaceId: row.space_id,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    ownerPrincipalId: row.owner_principal_id, createdBy: row.created_by,
    visibility: row.visibility, lifecycle: row.lifecycle,
    accessRevision: row.access_revision, revision: row.revision,
    createdAt: row.created_at_ms, updatedAt: row.updated_at_ms,
  };
}
function provisioning(row: ProvisioningRow | undefined): ResourceProvisioning | undefined {
  if (!row) return undefined;
  return {
    operationId: row.operation_id, resourceId: row.resource_id, requestDigest: row.request_digest,
    state: row.state, ...(row.domain_receipt_digest === null ? {} : { domainReceiptDigest: row.domain_receipt_digest }),
    createdAt: row.created_at_ms, updatedAt: row.updated_at_ms, revision: row.revision,
  };
}
function requestDigest(input: BeginResourceProvisioning): string {
  return digest(JSON.stringify({
    resourceId: input.resourceId, kind: input.kind, orgId: input.orgId, spaceId: input.spaceId,
    parentId: input.parentId ?? null, ownerPrincipalId: input.ownerPrincipalId,
    createdBy: input.createdBy, visibility: input.visibility,
  }));
}

export function createResourceRegistry(control: ControlPlane, opts: { now?: () => number } = {}): ResourceRegistry {
  const now = opts.now ?? Date.now;
  const resourceRow = (resourceId: string): ResourceRow | undefined => control.get<ResourceRow>(
    `SELECT id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,visibility,lifecycle,
            access_revision,revision,created_at_ms,updated_at_ms FROM resources WHERE id=?`, resourceId,
  );
  const provisioningRow = (operationId: string): ProvisioningRow | undefined => control.get<ProvisioningRow>(
    `SELECT operation_id,resource_id,request_digest,state,domain_receipt_digest,created_at_ms,updated_at_ms,revision
       FROM resource_provisioning WHERE operation_id=?`, operationId,
  );
  const assertedResource = (operationId: string): { saga: ProvisioningRow; row: ResourceRow } => {
    const saga = provisioningRow(operationId);
    if (!saga) throw controlError('not-found', 'Provisioning operation not found');
    const row = resourceRow(saga.resource_id);
    if (!row) throw controlError('recovery-required', 'Provisioning metadata is inconsistent');
    return { saga, row };
  };
  const changed = (count: number | bigint): void => {
    if (Number(count) !== 1) throw controlError('conflict', 'Resource state changed; retry from current state');
  };

  return {
    begin(raw) {
      const input: BeginResourceProvisioning = {
        operationId: identity(raw.operationId, 'operation ID'),
        resourceId: identity(raw.resourceId, 'resource ID'),
        kind: kind(raw.kind),
        orgId: identity(raw.orgId, 'organization ID'),
        spaceId: identity(raw.spaceId, 'Space ID'),
        ...(raw.parentId === undefined ? {} : { parentId: identity(raw.parentId, 'parent resource ID') }),
        ownerPrincipalId: identity(raw.ownerPrincipalId, 'owner principal ID'),
        createdBy: identity(raw.createdBy, 'creator principal ID'),
        visibility: visibility(raw.visibility),
      };
      const request = requestDigest(input);
      const prior = provisioningRow(input.operationId);
      if (prior) {
        if (prior.request_digest !== request || prior.resource_id !== input.resourceId) {
          throw controlError('conflict', 'Operation ID was already used for another resource request');
        }
        const row = resourceRow(prior.resource_id);
        if (!row) throw controlError('recovery-required', 'Provisioning metadata is inconsistent');
        return { resource: resource(row)!, provisioning: provisioning(prior)!, replayed: true };
      }
      const time = now();
      return control.transaction(() => {
        const raced = provisioningRow(input.operationId);
        if (raced) {
          if (raced.request_digest !== request || raced.resource_id !== input.resourceId) {
            throw controlError('conflict', 'Operation ID was already used for another resource request');
          }
          const row = resourceRow(raced.resource_id);
          if (!row) throw controlError('recovery-required', 'Provisioning metadata is inconsistent');
          return { resource: resource(row)!, provisioning: provisioning(raced)!, replayed: true };
        }
        if (resourceRow(input.resourceId)) throw controlError('conflict', 'Resource ID already exists');
        if (!control.get('SELECT 1 FROM spaces WHERE id=? AND org_id=?', input.spaceId, input.orgId)) {
          throw controlError('not-found', 'Resource Space does not exist in the requested organization');
        }
        for (const principal of [input.ownerPrincipalId, input.createdBy]) {
          if (!control.get("SELECT 1 FROM principals WHERE id=? AND status='active'", principal)) {
            throw controlError('not-found', 'Resource principal is not active');
          }
        }
        if (input.parentId && !control.get(
          "SELECT 1 FROM resources WHERE id=? AND org_id=? AND space_id=? AND lifecycle='active'",
          input.parentId, input.orgId, input.spaceId,
        )) throw controlError('not-found', 'Parent resource is not active in the requested scope');
        control.run(
          `INSERT INTO resources(id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
           VALUES(?,?,?,?,?,?,?,?, 'provisioning',?,?)`,
          input.resourceId, input.kind, input.orgId, input.spaceId, input.parentId ?? null,
          input.ownerPrincipalId, input.createdBy, input.visibility, time, time,
        );
        control.run(
          `INSERT INTO resource_provisioning(operation_id,resource_id,request_digest,state,created_at_ms,updated_at_ms)
           VALUES(?,?,?,'pending',?,?)`, input.operationId, input.resourceId, request, time, time,
        );
        control.audit(input.createdBy, 'resource.provisioning-begun', input.resourceId);
        return {
          resource: resource(resourceRow(input.resourceId))!,
          provisioning: provisioning(provisioningRow(input.operationId))!,
          replayed: false,
        };
      });
    },
    resource(resourceId) {
      return resource(resourceRow(identity(resourceId, 'resource ID')));
    },
    active(resourceId, scope) {
      const id = identity(resourceId, 'resource ID');
      const orgId = identity(scope.orgId, 'organization ID');
      const spaceId = identity(scope.spaceId, 'Space ID');
      return resource(control.get<ResourceRow>(
        `SELECT id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,visibility,lifecycle,
                access_revision,revision,created_at_ms,updated_at_ms
           FROM resources WHERE id=? AND org_id=? AND space_id=? AND lifecycle='active'`,
        id, orgId, spaceId,
      ));
    },
    provisioning(operationId) {
      return provisioning(provisioningRow(identity(operationId, 'operation ID')));
    },
    pending() {
      return control.all<ProvisioningRow>(
        `SELECT operation_id,resource_id,request_digest,state,domain_receipt_digest,created_at_ms,updated_at_ms,revision
           FROM resource_provisioning WHERE state IN ('pending','domain-ready','quarantined')
          ORDER BY updated_at_ms,operation_id`,
      ).map(row => provisioning(row)!);
    },
    recordDomainReady(operationId, domainReceipt) {
      const op = identity(operationId, 'operation ID');
      if ((typeof domainReceipt !== 'string' && !Buffer.isBuffer(domainReceipt)) || domainReceipt.length === 0
        || (typeof domainReceipt === 'string' ? Buffer.byteLength(domainReceipt) : domainReceipt.length) > 65_536) {
        throw controlError('invalid-input', 'Invalid domain receipt');
      }
      const receiptDigest = digest(domainReceipt);
      return control.transaction(() => {
        const { saga, row } = assertedResource(op);
        if (saga.state === 'finalized') {
          if (saga.domain_receipt_digest !== receiptDigest || row.lifecycle !== 'active') {
            throw controlError('conflict', 'Finalized provisioning receipt does not match');
          }
          return provisioning(saga)!;
        }
        if (saga.state === 'aborted') throw controlError('conflict', 'Provisioning operation was aborted');
        if (row.lifecycle !== 'provisioning' && row.lifecycle !== 'quarantined') {
          throw controlError('recovery-required', 'Provisioning resource lifecycle is inconsistent');
        }
        if (saga.state === 'domain-ready') {
          if (saga.domain_receipt_digest !== receiptDigest) throw controlError('conflict', 'Domain receipt does not match');
          return provisioning(saga)!;
        }
        if (saga.domain_receipt_digest !== null && saga.domain_receipt_digest !== receiptDigest) {
          throw controlError('conflict', 'Domain receipt does not match');
        }
        changed(control.run(
          `UPDATE resource_provisioning SET state='domain-ready',domain_receipt_digest=?,updated_at_ms=?,revision=revision+1
            WHERE operation_id=? AND revision=? AND state IN ('pending','quarantined')`,
          receiptDigest, now(), op, saga.revision,
        ).changes);
        control.audit(SYSTEM_ACTOR, 'resource.domain-ready', saga.resource_id);
        return provisioning(provisioningRow(op))!;
      });
    },
    activate(operationId, expectedResourceRevision) {
      const op = identity(operationId, 'operation ID');
      const expected = revision(expectedResourceRevision);
      return control.transaction(() => {
        const { saga, row } = assertedResource(op);
        if (saga.state === 'finalized') {
          if (row.lifecycle !== 'active') throw controlError('recovery-required', 'Finalized resource is not active');
          return resource(row)!;
        }
        if (saga.state !== 'domain-ready' || !saga.domain_receipt_digest) {
          throw controlError('conflict', 'Domain durability must be proven before activation');
        }
        if (row.revision !== expected) throw controlError('conflict', 'Resource revision is stale');
        if (row.lifecycle !== 'provisioning' && row.lifecycle !== 'quarantined') {
          throw controlError('conflict', 'Resource is not activatable');
        }
        const time = now();
        changed(control.run(
          `UPDATE resources SET lifecycle='active',access_revision=access_revision+1,revision=revision+1,updated_at_ms=?
            WHERE id=? AND revision=? AND lifecycle IN ('provisioning','quarantined')`,
          time, row.id, expected,
        ).changes);
        changed(control.run(
          `UPDATE resource_provisioning SET state='finalized',updated_at_ms=?,revision=revision+1
            WHERE operation_id=? AND revision=? AND state='domain-ready'`,
          time, op, saga.revision,
        ).changes);
        control.audit(row.created_by, 'resource.activated', row.id);
        return resource(resourceRow(row.id))!;
      });
    },
    abortMissingDomain(operationId, expectedResourceRevision) {
      const op = identity(operationId, 'operation ID');
      const expected = revision(expectedResourceRevision);
      return control.transaction(() => {
        const { saga, row } = assertedResource(op);
        if (saga.state === 'aborted') {
          if (row.lifecycle !== 'deleted') throw controlError('recovery-required', 'Aborted resource is not deleted');
          return resource(row)!;
        }
        if (saga.state === 'domain-ready' || saga.state === 'finalized' || saga.domain_receipt_digest !== null) {
          throw controlError('conflict', 'Durable domain state cannot be aborted as missing');
        }
        if (row.revision !== expected) throw controlError('conflict', 'Resource revision is stale');
        if (row.lifecycle !== 'provisioning' && row.lifecycle !== 'quarantined') throw controlError('conflict', 'Resource is not abortable');
        const time = now();
        changed(control.run(
          `UPDATE resources SET lifecycle='deleted',revision=revision+1,updated_at_ms=?
            WHERE id=? AND revision=? AND lifecycle IN ('provisioning','quarantined')`,
          time, row.id, expected,
        ).changes);
        changed(control.run(
          `UPDATE resource_provisioning SET state='aborted',updated_at_ms=?,revision=revision+1
            WHERE operation_id=? AND revision=? AND state IN ('pending','quarantined')`,
          time, op, saga.revision,
        ).changes);
        control.audit(SYSTEM_ACTOR, 'resource.provisioning-aborted', row.id);
        return resource(resourceRow(row.id))!;
      });
    },
    quarantineUnknown(operationId, expectedResourceRevision) {
      const op = identity(operationId, 'operation ID');
      const expected = revision(expectedResourceRevision);
      return control.transaction(() => {
        const { saga, row } = assertedResource(op);
        if (saga.state === 'quarantined') {
          if (row.lifecycle !== 'quarantined') throw controlError('recovery-required', 'Quarantined resource state is inconsistent');
          return resource(row)!;
        }
        if (saga.state === 'finalized' || saga.state === 'aborted') throw controlError('conflict', 'Provisioning operation is already terminal');
        if (row.revision !== expected) throw controlError('conflict', 'Resource revision is stale');
        if (row.lifecycle !== 'provisioning') throw controlError('conflict', 'Resource is not quarantineable');
        const time = now();
        changed(control.run(
          `UPDATE resources SET lifecycle='quarantined',revision=revision+1,updated_at_ms=?
            WHERE id=? AND revision=? AND lifecycle='provisioning'`,
          time, row.id, expected,
        ).changes);
        changed(control.run(
          `UPDATE resource_provisioning SET state='quarantined',updated_at_ms=?,revision=revision+1
            WHERE operation_id=? AND revision=? AND state IN ('pending','domain-ready')`,
          time, op, saga.revision,
        ).changes);
        control.audit(SYSTEM_ACTOR, 'resource.provisioning-quarantined', row.id);
        return resource(resourceRow(row.id))!;
      });
    },
  };
}
