// Append-only v5: bind account-link transactions to the exact reauthenticated
// user/session and give external identity links optimistic-concurrency revision.
export const providerLinkMigration = String.raw`
ALTER TABLE provider_transactions ADD COLUMN actor_user_id TEXT REFERENCES users(id);
ALTER TABLE provider_transactions ADD COLUMN actor_session_id TEXT REFERENCES auth_sessions(id);
ALTER TABLE login_identities ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
CREATE TRIGGER valid_provider_link_actor_insert BEFORE INSERT ON provider_transactions
WHEN (NEW.purpose='link' AND (NEW.actor_user_id IS NULL OR NEW.actor_session_id IS NULL))
 OR (NEW.purpose<>'link' AND (NEW.actor_user_id IS NOT NULL OR NEW.actor_session_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'invalid-provider-link-actor'); END;
CREATE TRIGGER immutable_provider_link_actor BEFORE UPDATE OF actor_user_id,actor_session_id ON provider_transactions
WHEN OLD.actor_user_id IS NOT NEW.actor_user_id OR OLD.actor_session_id IS NOT NEW.actor_session_id
BEGIN SELECT RAISE(ABORT,'immutable-provider-link-actor'); END;
`;
