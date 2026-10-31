// Append-only v4: provider framework state. OAuth/OIDC secrets never live here;
// only opaque broker references and hashed browser capabilities are persisted.
export const providerMigration = String.raw`
ALTER TABLE identity_providers ADD COLUMN public_config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(public_config_json));
ALTER TABLE identity_providers ADD COLUMN client_secret_ref TEXT;
ALTER TABLE identity_providers ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;
CREATE TABLE provider_transactions (
  id TEXT PRIMARY KEY,
  provider_config_id TEXT NOT NULL REFERENCES identity_providers(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('setup','login','link')),
  state_hash TEXT NOT NULL UNIQUE,
  browser_binding_hash TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  exchange_started_at_ms INTEGER,
  consumed_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  CHECK(expires_at_ms > created_at_ms),
  CHECK(NOT (consumed_at_ms IS NOT NULL AND cancelled_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX provider_transactions_expiry ON provider_transactions(expires_at_ms);
CREATE TRIGGER immutable_provider_transaction BEFORE UPDATE OF provider_config_id,purpose,state_hash,browser_binding_hash,secret_ref,return_to,created_at_ms,expires_at_ms ON provider_transactions
WHEN OLD.provider_config_id<>NEW.provider_config_id OR OLD.purpose<>NEW.purpose OR OLD.state_hash<>NEW.state_hash
 OR OLD.browser_binding_hash<>NEW.browser_binding_hash OR OLD.secret_ref<>NEW.secret_ref OR OLD.return_to<>NEW.return_to
 OR OLD.created_at_ms<>NEW.created_at_ms OR OLD.expires_at_ms<>NEW.expires_at_ms
BEGIN SELECT RAISE(ABORT,'immutable-provider-transaction'); END;
`;
