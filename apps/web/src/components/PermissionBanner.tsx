// Permission banner (WP15): redacted server-built preview, risk badge, mode
// icons, and an explicit "always" scope — session or project, never silently
// global from this UI.
import { useState } from "react";
import { replyPermission } from "../init.ts";
import type { PendingPermission } from "../reduce.ts";
import { Icon } from "../icons.tsx";

type AlwaysScope = "session" | "project";

function modeIcon(permission: string) {
  const p = permission.toLowerCase();
  if (/bash|shell|terminal|exec/.test(p)) return <Icon.term />;
  if (/edit|write|patch/.test(p)) return <Icon.pencil />;
  if (/fetch|web|http|net/.test(p)) return <Icon.globe />;
  if (/read|list|glob|grep/.test(p)) return <Icon.files />;
  return <Icon.shield />;
}

function PermissionRow({ p }: { p: PendingPermission }) {
  const [scope, setScope] = useState<AlwaysScope>("session");
  const scopes = p.allowedScopes ?? ["once", "session", "project"];
  const canAlways = scopes.includes("session") || scopes.includes("project");
  const risk = p.preview?.risk;
  return (
    <div className="perm-row">
      <div className="perm-desc">
        <span className="permission-mode-icon" aria-hidden="true">{modeIcon(p.permission)}</span>
        <strong>{p.preview?.title ?? p.permission}</strong>
        {!p.preview && p.tool ? ` via ${p.tool}` : ""}
        {risk && <span className={`permission-risk risk-${risk}`}>{risk} risk</span>}
      </div>
      {p.preview && p.preview.lines.length > 0 ? (
        <div className="permission-preview">
          {p.preview.lines.map((line, i) => (
            <code key={i}>{line}</code>
          ))}
        </div>
      ) : (
        p.patterns.length > 0 && (
          <div className="perm-patterns">
            {p.patterns.map((pat) => (
              <code key={pat}>{pat}</code>
            ))}
          </div>
        )
      )}
      <div className="perm-actions">
        <button onClick={() => replyPermission(p.requestId, "once")}>Allow once</button>
        {canAlways && (
          <span className="perm-always">
            <button onClick={() => replyPermission(p.requestId, "always", scope)}>Always</button>
            <select
              aria-label="Always scope"
              value={scope}
              onChange={(e) => setScope(e.target.value === "project" ? "project" : "session")}
            >
              {scopes.includes("session") && <option value="session">this session</option>}
              {scopes.includes("project") && <option value="project">this project</option>}
            </select>
          </span>
        )}
        <button className="danger" onClick={() => replyPermission(p.requestId, "reject")}>Reject</button>
      </div>
    </div>
  );
}

export default function PermissionBanner({ permissions }: { permissions: PendingPermission[] }) {
  if (permissions.length === 0) return null;
  return (
    <div className="perm-banner permission-toast">
      <div className="perm-title">Permission requested</div>
      {permissions.map((p) => (
        <PermissionRow key={p.requestId} p={p} />
      ))}
    </div>
  );
}
