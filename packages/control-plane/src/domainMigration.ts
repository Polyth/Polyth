// Append-only v6: canonical resource metadata and the durable control side of
// cross-store provisioning. Policy/key rows are metadata only: policy documents,
// grants and secret material belong to their later domain owners.
export const domainMigration = String.raw`
ALTER TABLE organization_memberships ADD COLUMN expires_at_ms INTEGER
  CHECK(expires_at_ms IS NULL OR expires_at_ms > 0);
ALTER TABLE space_memberships ADD COLUMN expires_at_ms INTEGER
  CHECK(expires_at_ms IS NULL OR expires_at_ms > 0);

CREATE TRIGGER organization_owner_membership_no_expiry
BEFORE INSERT ON organization_memberships
WHEN NEW.role='owner' AND NEW.expires_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'owner-membership-expiry'); END;
CREATE TRIGGER organization_owner_membership_no_expiry_update
BEFORE UPDATE OF role,expires_at_ms ON organization_memberships
WHEN NEW.role='owner' AND NEW.expires_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'owner-membership-expiry'); END;
CREATE TRIGGER space_owner_membership_no_expiry
BEFORE INSERT ON space_memberships
WHEN NEW.role='owner' AND NEW.expires_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'owner-membership-expiry'); END;
CREATE TRIGGER space_owner_membership_no_expiry_update
BEFORE UPDATE OF role,expires_at_ms ON space_memberships
WHEN NEW.role='owner' AND NEW.expires_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'owner-membership-expiry'); END;

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  parent_id TEXT,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_by TEXT NOT NULL REFERENCES principals(id),
  visibility TEXT NOT NULL CHECK(visibility IN ('private','restricted','space','inherit')),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('provisioning','active','archiving','archived','deleting','deleted','quarantined')),
  access_revision INTEGER NOT NULL DEFAULT 1 CHECK(access_revision > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(space_id,id),
  FOREIGN KEY(org_id,space_id) REFERENCES spaces(org_id,id),
  FOREIGN KEY(space_id,parent_id) REFERENCES resources(space_id,id),
  CHECK(parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE TABLE resource_provisioning (
  operation_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id),
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','domain-ready','finalized','aborted','quarantined')),
  domain_receipt_digest TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  CHECK(
    (state IN ('domain-ready','finalized') AND domain_receipt_digest IS NOT NULL)
    OR (state IN ('pending','aborted') AND domain_receipt_digest IS NULL)
    OR state='quarantined'
  )
) STRICT;

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  space_id TEXT,
  resource_id TEXT,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('organization','space','resource')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(org_id,space_id) REFERENCES spaces(org_id,id),
  FOREIGN KEY(space_id,resource_id) REFERENCES resources(space_id,id),
  CHECK(
    (scope_kind='organization' AND scope_id=org_id AND space_id IS NULL AND resource_id IS NULL)
    OR (scope_kind='space' AND scope_id=space_id AND space_id IS NOT NULL AND resource_id IS NULL)
    OR (scope_kind='resource' AND scope_id=resource_id AND space_id IS NOT NULL AND resource_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE key_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','disabled','retired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE key_versions (
  provider_id TEXT NOT NULL REFERENCES key_providers(id),
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')),
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  PRIMARY KEY(provider_id,version),
  CHECK(retired_at_ms IS NULL OR retired_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_resources_scope ON resources(space_id,kind,lifecycle,id);
CREATE INDEX idx_resources_org_lifecycle ON resources(org_id,lifecycle,id);
CREATE INDEX idx_resource_provisioning_state ON resource_provisioning(state,updated_at_ms,operation_id);
CREATE INDEX idx_policies_scope ON policies(scope_kind,scope_id,id);
CREATE INDEX idx_org_memberships_expiry ON organization_memberships(user_id,state,expires_at_ms,org_id);
CREATE INDEX idx_space_memberships_expiry ON space_memberships(principal_id,state,expires_at_ms,space_id);
CREATE UNIQUE INDEX one_active_key_version ON key_versions(provider_id) WHERE state='active';

CREATE TRIGGER immutable_resource_identity
BEFORE UPDATE OF id,kind,org_id,space_id,parent_id,created_by ON resources
WHEN OLD.id<>NEW.id OR OLD.kind<>NEW.kind OR OLD.org_id<>NEW.org_id OR OLD.space_id<>NEW.space_id
 OR OLD.parent_id IS NOT NEW.parent_id OR OLD.created_by<>NEW.created_by
BEGIN SELECT RAISE(ABORT,'immutable-resource-identity'); END;
CREATE TRIGGER prevent_resource_revision_rollback
BEFORE UPDATE OF revision,access_revision ON resources
WHEN NEW.revision<OLD.revision OR NEW.access_revision<OLD.access_revision
BEGIN SELECT RAISE(ABORT,'stale-resource-revision'); END;
CREATE TRIGGER immutable_provisioning_identity
BEFORE UPDATE OF operation_id,resource_id,request_digest,created_at_ms ON resource_provisioning
WHEN OLD.operation_id<>NEW.operation_id OR OLD.resource_id<>NEW.resource_id
 OR OLD.request_digest<>NEW.request_digest OR OLD.created_at_ms<>NEW.created_at_ms
BEGIN SELECT RAISE(ABORT,'immutable-provisioning-identity'); END;
CREATE TRIGGER prevent_provisioning_revision_rollback
BEFORE UPDATE OF revision ON resource_provisioning
WHEN NEW.revision<OLD.revision
BEGIN SELECT RAISE(ABORT,'stale-resource-revision'); END;
`;
