import { replyPermission } from "../init.ts";
import type { PendingPermission } from "../reduce.ts";

export default function PermissionBanner({ permissions }: { permissions: PendingPermission[] }) {
  if (permissions.length === 0) return null;
  return (
    <div className="perm-banner">
      <div className="perm-title">Permission requested</div>
      {permissions.map((p) => (
        <div className="perm-row" key={p.requestId}>
          <div className="perm-desc">
            <strong>{p.permission}</strong>
            {p.tool ? ` via ${p.tool}` : ""}
          </div>
          {p.patterns.length > 0 && (
            <div className="perm-patterns">
              {p.patterns.map((pat) => (
                <code key={pat}>{pat}</code>
              ))}
            </div>
          )}
          <div className="perm-actions">
            <button onClick={() => replyPermission(p.requestId, "once")}>Allow once</button>
            <button onClick={() => replyPermission(p.requestId, "always")}>Always</button>
            <button className="danger" onClick={() => replyPermission(p.requestId, "reject")}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}