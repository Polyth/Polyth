// Append-only v8: instance-owner guardrails for a household account. The row
// survives removal (NULL guardrails) so the revision stays monotonic and a
// stale editor cannot resurrect an older policy.
export const accountGuardrailsMigration = String.raw`
CREATE TABLE account_guardrails (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  guardrails_json TEXT CHECK(guardrails_json IS NULL OR json_valid(guardrails_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_by TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
`;
