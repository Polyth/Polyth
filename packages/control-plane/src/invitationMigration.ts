// Append-only v15: one-time invitation links for new accounts. An instance
// owner issues a code for a local account; only its hash is stored. Accepting
// it lets the invited person choose their own password. Deleting an account
// deletes its invitations.
export const invitationMigration = String.raw`
CREATE TABLE account_invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  revoked_at_ms INTEGER
) STRICT;
CREATE INDEX account_invitations_user ON account_invitations(user_id);
`;
