// Append-only v13: how people reach this installation. `accounts` is every
// installation so far: the owner signs in with a credential. `local` is a
// Polyth Desktop owner who chose "only me" at first run: no credential exists
// and only the Desktop main process can open an owner session. `local` is
// chosen during setup only; once ready, an installation may leave it (the
// owner sets a password) but never return to it.
export const localAccessMigration = String.raw`
ALTER TABLE installation ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'accounts'
  CHECK(access_mode IN ('accounts','local'));

CREATE TRIGGER local_access_only_during_setup BEFORE UPDATE OF access_mode ON installation
WHEN NEW.access_mode='local' AND OLD.access_mode<>'local' AND OLD.state IN ('ready','recovery')
BEGIN SELECT RAISE(ABORT,'invalid-transition'); END;
-- The singleton row exists since v1; re-creating it (INSERT OR REPLACE, or
-- DELETE then INSERT) must not be a way back into 'local'. A missing row
-- already fails closed (recovery-required).
CREATE TRIGGER local_access_never_inserted BEFORE INSERT ON installation
WHEN NEW.access_mode='local'
BEGIN SELECT RAISE(ABORT,'invalid-transition'); END;

CREATE TABLE owner_credential_recovery (
  user_id TEXT NOT NULL REFERENCES users(id),
  set_id TEXT NOT NULL,
  code_hash TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL
) STRICT;
`;
