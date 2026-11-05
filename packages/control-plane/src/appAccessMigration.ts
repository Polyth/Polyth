// Append-only v14: third-party apps. An `app` token is a person's bearer token
// for the Client API, created in the web UI or through the device flow. SQLite
// cannot widen a CHECK in place, so `access_tokens` is rebuilt row for row
// (nothing references it by foreign key); hashes, grants, epochs and revocation
// history carry over unchanged. `device_authorizations.kind` says what a pending
// sign-in will mint; every existing row is a terminal sign-in.
export const appAccessMigration = String.raw`
CREATE TABLE access_tokens_v14 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('device','automation','app')),
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  grants_json TEXT NOT NULL CHECK(json_valid(grants_json)),
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  auth_epoch INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
INSERT INTO access_tokens_v14(id,user_id,kind,label,token_hash,grants_json,space_id,auth_epoch,created_at_ms,last_used_at_ms,expires_at_ms,revoked_at_ms,revision)
  SELECT id,user_id,kind,label,token_hash,grants_json,space_id,auth_epoch,created_at_ms,last_used_at_ms,expires_at_ms,revoked_at_ms,revision FROM access_tokens;
DROP TABLE access_tokens;
ALTER TABLE access_tokens_v14 RENAME TO access_tokens;
CREATE INDEX access_tokens_by_user ON access_tokens(user_id,created_at_ms);
ALTER TABLE device_authorizations ADD COLUMN kind TEXT NOT NULL DEFAULT 'device' CHECK(kind IN ('device','app'));
`;
