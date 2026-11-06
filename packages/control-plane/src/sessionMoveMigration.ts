// Append-only v14: a chat may move to another project of its Space. A session's
// registry parent is its project, and until now it was part of the row's
// immutable identity. Only a session row, only between two projects, and only
// to an active project of the same Space may change it; every other identity
// column stays immutable and every other kind keeps its parent for good.
export const sessionMoveMigration = String.raw`
DROP TRIGGER immutable_resource_identity;
CREATE TRIGGER immutable_resource_identity
BEFORE UPDATE OF id,kind,org_id,space_id,parent_id,created_by ON resources
WHEN OLD.id<>NEW.id OR OLD.kind<>NEW.kind OR OLD.org_id<>NEW.org_id OR OLD.space_id<>NEW.space_id
 OR OLD.created_by<>NEW.created_by
 OR (OLD.parent_id IS NOT NEW.parent_id
     AND (OLD.kind<>'session' OR OLD.parent_id IS NULL OR NEW.parent_id IS NULL))
BEGIN SELECT RAISE(ABORT,'immutable-resource-identity'); END;

CREATE TRIGGER session_parent_is_active_project
BEFORE UPDATE OF parent_id ON resources
WHEN OLD.parent_id IS NOT NEW.parent_id
 AND NOT EXISTS(
   SELECT 1 FROM resources target
    WHERE target.id=NEW.parent_id AND target.org_id=NEW.org_id AND target.space_id=NEW.space_id
      AND target.kind='project' AND target.lifecycle='active')
BEGIN SELECT RAISE(ABORT,'invalid-resource-parent'); END;
`;
