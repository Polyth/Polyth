// Append-only v11: installation-wide permissions the instance owner gives an
// account (for example `harnesses.manage`). Like account_limits, removing every
// permission keeps the row (empty list) so the revision stays monotonic.
export const accountPermissionsMigration = String.raw`
CREATE TABLE account_permissions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json) AND json_type(permissions_json)='array'),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_by TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
`;
