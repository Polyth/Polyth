// Versioned production migrations, not the blueprint's illustrative SQL.
// Every applied checksum is verified before any identity can be resolved.
export const migrations = [String.raw`
CREATE TABLE installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('uninitialized','claimed','configuring','ready','recovery')),
  authority_epoch INTEGER NOT NULL DEFAULT 1 CHECK(authority_epoch > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
CREATE TABLE legacy_imports (name TEXT PRIMARY KEY, digest TEXT NOT NULL, imported_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE principals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('user','group','service','system')),
  status TEXT NOT NULL CHECK(status IN ('active','suspended','offboarding','disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
CREATE TABLE users (
  id TEXT PRIMARY KEY REFERENCES principals(id), display_name TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0 CHECK(managed IN (0,1)),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
CREATE TABLE organization_memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','guest')),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('invited','active','suspended','offboarding','disabled')),
  source TEXT NOT NULL DEFAULT 'local', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  PRIMARY KEY(org_id,user_id)
) STRICT;
CREATE TABLE instance_roles (
  user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin')),
  revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(user_id,role)
) STRICT;
CREATE TABLE spaces (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL, storage_identity TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('personal','shared')),
  discovery_mode TEXT NOT NULL DEFAULT 'all-visible' CHECK(discovery_mode IN ('assigned-only','all-visible')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  color TEXT, icon TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), UNIQUE(org_id,id)
) STRICT;
CREATE TABLE space_memberships (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer','reference')),
  state TEXT NOT NULL DEFAULT 'active', created_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), PRIMARY KEY(space_id,principal_id)
) STRICT;
CREATE INDEX memberships_by_principal ON space_memberships(principal_id,space_id,state);
CREATE TABLE device_selections (
  device_key TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  PRIMARY KEY(device_key,user_id)
) STRICT;
CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id), login_name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, changed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  label TEXT NOT NULL, auth_epoch INTEGER NOT NULL, elevated_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
CREATE INDEX auth_sessions_by_user ON auth_sessions(user_id,expires_at_ms);
CREATE TABLE setup_claims (
  id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installation(id),
  owner_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, browser_binding_hash TEXT,
  expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER, revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE setup_recovery (claim_id TEXT NOT NULL, set_id TEXT NOT NULL, code_hash TEXT PRIMARY KEY) STRICT;
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), set_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE, used_at_ms INTEGER, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  resource_id TEXT, occurred_at_ms INTEGER NOT NULL, authority_epoch INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
) STRICT;
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, audit_seq INTEGER NOT NULL REFERENCES audit_events(seq),
  delivered_at_ms INTEGER
) STRICT;
CREATE INDEX pending_outbox ON outbox(id) WHERE delivered_at_ms IS NULL;
CREATE TABLE operation_receipts (
  actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
) STRICT;
CREATE TRIGGER keep_instance_owner_delete BEFORE DELETE ON instance_roles
WHEN OLD.role='owner' AND (SELECT state FROM installation WHERE singleton=1)='ready'
 AND (SELECT count(*) FROM instance_roles WHERE role='owner')=1
BEGIN SELECT RAISE(ABORT,'last-owner'); END;
CREATE TRIGGER keep_instance_owner_update BEFORE UPDATE OF role ON instance_roles
WHEN OLD.role='owner' AND NEW.role<>'owner'
 AND (SELECT state FROM installation WHERE singleton=1)='ready'
 AND (SELECT count(*) FROM instance_roles WHERE role='owner')=1
BEGIN SELECT RAISE(ABORT,'last-owner'); END;
CREATE TRIGGER keep_active_owner BEFORE UPDATE OF status ON principals
WHEN NEW.status<>'active' AND EXISTS(SELECT 1 FROM instance_roles WHERE user_id=OLD.id AND role='owner')
 AND (SELECT count(*) FROM instance_roles r JOIN principals p ON p.id=r.user_id
      WHERE r.role='owner' AND p.status='active')=1
 AND (SELECT state FROM installation WHERE singleton=1)='ready'
BEGIN SELECT RAISE(ABORT,'last-owner'); END;
`];
