// Append-only v2: v1's bytes and recorded checksum must remain unchanged.
export const securityMigration = String.raw`
ALTER TABLE principals ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK(auth_epoch > 0);
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0);
ALTER TABLE outbox ADD COLUMN next_attempt_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN lease_token TEXT;
ALTER TABLE outbox ADD COLUMN lease_expires_at_ms INTEGER;
ALTER TABLE outbox ADD COLUMN last_error_code TEXT;
CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY, issuer TEXT NOT NULL, kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), UNIQUE(id,issuer)
) STRICT;
CREATE TABLE login_identities (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  provider_config_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(provider_config_id,issuer) REFERENCES identity_providers(id,issuer),
  UNIQUE(provider_config_id,issuer,subject)
) STRICT;
CREATE INDEX login_identities_by_user ON login_identities(user_id);
CREATE TRIGGER immutable_principal BEFORE UPDATE OF id,kind ON principals
WHEN OLD.id<>NEW.id OR OLD.kind<>NEW.kind
BEGIN SELECT RAISE(ABORT,'immutable-identity'); END;
CREATE TRIGGER immutable_user BEFORE UPDATE OF id ON users WHEN OLD.id<>NEW.id
BEGIN SELECT RAISE(ABORT,'immutable-identity'); END;
CREATE TRIGGER user_kind_insert BEFORE INSERT ON users
WHEN NOT EXISTS(SELECT 1 FROM principals WHERE id=NEW.id AND kind='user')
BEGIN SELECT RAISE(ABORT,'invalid-user-principal'); END;
CREATE TRIGGER immutable_login_identity BEFORE UPDATE OF user_id,provider_config_id,issuer,subject ON login_identities
WHEN OLD.user_id<>NEW.user_id OR OLD.provider_config_id<>NEW.provider_config_id
 OR OLD.issuer<>NEW.issuer OR OLD.subject<>NEW.subject
BEGIN SELECT RAISE(ABORT,'immutable-login-identity'); END;
CREATE TRIGGER immutable_instance_role_user BEFORE UPDATE OF user_id ON instance_roles
WHEN OLD.user_id<>NEW.user_id
BEGIN SELECT RAISE(ABORT,'immutable-identity'); END;
CREATE TRIGGER immutable_installation BEFORE UPDATE OF id,singleton ON installation
WHEN OLD.id<>NEW.id OR OLD.singleton<>NEW.singleton
BEGIN SELECT RAISE(ABORT,'immutable-installation'); END;
CREATE TRIGGER prevent_authority_reset BEFORE UPDATE OF state ON installation
WHEN OLD.state IN ('ready','recovery') AND NEW.state<>OLD.state AND NEW.state<>'recovery'
BEGIN SELECT RAISE(ABORT,'recovery-required'); END;
CREATE TRIGGER prevent_epoch_rollback BEFORE UPDATE OF authority_epoch ON installation
WHEN NEW.authority_epoch<OLD.authority_epoch
BEGIN SELECT RAISE(ABORT,'stale-authority'); END;
CREATE TRIGGER prevent_auth_epoch_rollback BEFORE UPDATE OF auth_epoch ON principals
WHEN NEW.auth_epoch<OLD.auth_epoch
BEGIN SELECT RAISE(ABORT,'stale-authority'); END;
DROP TRIGGER keep_instance_owner_delete;
DROP TRIGGER keep_instance_owner_update;
CREATE TRIGGER keep_instance_owner_delete BEFORE DELETE ON instance_roles
WHEN OLD.role='owner' AND (SELECT state FROM installation WHERE singleton=1)='ready'
 AND EXISTS(SELECT 1 FROM principals WHERE id=OLD.user_id AND status='active')
 AND NOT EXISTS(SELECT 1 FROM instance_roles r JOIN principals p ON p.id=r.user_id
                WHERE r.role='owner' AND p.status='active' AND r.user_id<>OLD.user_id)
BEGIN SELECT RAISE(ABORT,'last-owner'); END;
CREATE TRIGGER keep_instance_owner_update BEFORE UPDATE OF role ON instance_roles
WHEN OLD.role='owner' AND NEW.role<>'owner'
 AND (SELECT state FROM installation WHERE singleton=1)='ready'
 AND EXISTS(SELECT 1 FROM principals WHERE id=OLD.user_id AND status='active')
 AND NOT EXISTS(SELECT 1 FROM instance_roles r JOIN principals p ON p.id=r.user_id
                WHERE r.role='owner' AND p.status='active' AND r.user_id<>OLD.user_id)
BEGIN SELECT RAISE(ABORT,'last-owner'); END;
CREATE TRIGGER require_ready_owner BEFORE UPDATE OF state ON installation
WHEN NEW.state='ready' AND NOT EXISTS(
  SELECT 1 FROM instance_roles r JOIN users u ON u.id=r.user_id JOIN principals p ON p.id=u.id
  WHERE r.role='owner' AND p.status='active')
BEGIN SELECT RAISE(ABORT,'missing-owner'); END;
CREATE TRIGGER valid_auth_session_insert BEFORE INSERT ON auth_sessions
WHEN NEW.expires_at_ms<=NEW.created_at_ms OR NEW.last_seen_at_ms<NEW.created_at_ms
BEGIN SELECT RAISE(ABORT,'invalid-session-lifetime'); END;
CREATE TRIGGER valid_auth_session_update BEFORE UPDATE ON auth_sessions
WHEN NEW.expires_at_ms<=NEW.created_at_ms OR NEW.last_seen_at_ms<NEW.created_at_ms
BEGIN SELECT RAISE(ABORT,'invalid-session-lifetime'); END;
`;
