// Append-only v10: command-line access. `access_tokens` holds hashed bearer
// tokens a person issued for a CLI device (device authorization) or for an
// automation; `device_authorizations` is the short-lived pending half of the
// device flow (no plaintext token is ever stored — the token is minted when
// the CLI redeems an approved code); `cli_trust` is the single owner-chosen
// no-token mode. Revoked tokens keep their row (revoked_at_ms) for audit.
export const cliAccessMigration = String.raw`
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('device','automation')),
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
CREATE INDEX access_tokens_by_user ON access_tokens(user_id,created_at_ms);
CREATE TABLE device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  profile TEXT NOT NULL,
  client_address TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','redeemed')),
  user_id TEXT REFERENCES users(id),
  token_id TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_poll_at_ms INTEGER
) STRICT;
CREATE TABLE cli_trust (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  mode TEXT NOT NULL CHECK(mode IN ('off','loopback','private-network')),
  user_id TEXT REFERENCES users(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at_ms INTEGER NOT NULL
) STRICT;
`;
