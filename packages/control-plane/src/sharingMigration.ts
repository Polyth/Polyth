// Append-only v12: session sharing (Spaces §14.3). A resource may name the
// resource whose access it follows (a delegated subagent follows its parent
// chat; the registry parent stays the project). People are given access by
// name through grants, and each Space keeps one sharing policy row once an
// admin saves it.
export const sharingMigration = String.raw`
ALTER TABLE resources ADD COLUMN access_parent_id TEXT
  CHECK(access_parent_id IS NULL OR access_parent_id <> id);

CREATE TRIGGER resource_access_parent_set_once
BEFORE UPDATE OF access_parent_id ON resources
WHEN OLD.access_parent_id IS NOT NULL AND OLD.access_parent_id IS NOT NEW.access_parent_id
BEGIN SELECT RAISE(ABORT,'immutable-resource-access-parent'); END;

CREATE INDEX idx_resources_access_parent ON resources(access_parent_id)
  WHERE access_parent_id IS NOT NULL;

CREATE TABLE resource_grants (
  resource_id TEXT NOT NULL REFERENCES resources(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  access TEXT NOT NULL CHECK(access IN ('view','collaborate','manage')),
  granted_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  PRIMARY KEY(resource_id,principal_id)
) STRICT;
CREATE INDEX idx_resource_grants_principal ON resource_grants(principal_id,resource_id);

CREATE TABLE space_sharing_policies (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  default_visibility TEXT NOT NULL CHECK(default_visibility IN ('private','space')),
  allow_space_visibility INTEGER NOT NULL CHECK(allow_space_visibility IN (0,1)),
  members_may_share INTEGER NOT NULL CHECK(members_may_share IN (0,1)),
  max_member_access TEXT NOT NULL CHECK(max_member_access IN ('view','collaborate','manage')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_by TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(allow_space_visibility = 1 OR default_visibility = 'private')
) STRICT;
`;
