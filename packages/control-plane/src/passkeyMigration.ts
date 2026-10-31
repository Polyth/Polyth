// Append-only v3: passkey credentials and single-use WebAuthn challenges.
// Challenges persist only digests; usable challenge material never rests in SQLite.
export const passkeyMigration = String.raw`
CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key_spki_pem TEXT NOT NULL,
  algorithm INTEGER NOT NULL CHECK(algorithm IN (-257,-8,-7)),
  rp_id TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK(sign_count >= 0),
  name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
) STRICT;
CREATE INDEX passkey_credentials_by_user ON passkey_credentials(user_id,created_at_ms);
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK(purpose IN ('registration','authentication')),
  user_id TEXT REFERENCES users(id),
  session_id TEXT REFERENCES auth_sessions(id) ON DELETE CASCADE,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  CHECK(expires_at_ms > created_at_ms),
  CHECK((purpose='registration' AND user_id IS NOT NULL AND session_id IS NOT NULL)
     OR (purpose='authentication' AND session_id IS NULL))
) STRICT;
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges(expires_at_ms,consumed_at_ms);
CREATE TRIGGER immutable_passkey_identity BEFORE UPDATE OF user_id,credential_id,rp_id ON passkey_credentials
WHEN OLD.user_id<>NEW.user_id OR OLD.credential_id<>NEW.credential_id OR OLD.rp_id<>NEW.rp_id
BEGIN SELECT RAISE(ABORT,'immutable-identity'); END;
`;
