// Append-only v9: instance-owner limits for an account (projects, harnesses,
// daily counts) and the per-day usage they are checked against. Like
// account_guardrails, a removed policy keeps its row (NULL limits) so the
// revision stays monotonic. Usage rows are counters only, never content.
export const accountLimitsMigration = String.raw`
CREATE TABLE account_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  limits_json TEXT CHECK(limits_json IS NULL OR json_valid(limits_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_by TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE account_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  day TEXT NOT NULL CHECK(length(day) = 10),
  messages INTEGER NOT NULL DEFAULT 0 CHECK(messages >= 0),
  chats INTEGER NOT NULL DEFAULT 0 CHECK(chats >= 0),
  PRIMARY KEY(user_id, day)
) STRICT;
`;
