// Permission banner (WP15): redacted server-built preview, risk badge, mode
// icons, and an explicit "always" scope — session or project, never silently
// global from this UI.
import { useState } from "react";
import { replyPermission } from "../../../apps/web/src/init.ts";
import type { PendingPermission } from "../../../apps/web/src/reduce.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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
  const [open, setOpen] = useState(false);
  const scopes = p.allowedScopes ?? ["once", "session", "project"];
  const canAlways = scopes.includes("session") || scopes.includes("project");
  const risk = p.preview?.risk;
  return (
    <div className={`perm-row permission-execution${open ? " open" : ""}`}>
      <button type="button" className="permission-execution-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="permission-execution-alert" aria-hidden="true">!</span>
        <span className="permission-mode-icon" aria-hidden="true">{modeIcon(p.permission)}</span>
        <strong>{p.tool ?? p.permission}</strong>
        <span className="permission-execution-preview">{p.preview?.title ?? p.patterns[0] ?? p.permission}</span>
        <span className="permission-execution-status">Approval required</span>
        <span className="permission-execution-review">Review</span>
        <span className="permission-execution-mobile-status">Approval<br />Review</span>
        <span aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronRight />}</span>
      </button>
      {open && (
        <div className="permission-execution-body">
          <div className="perm-desc">
            <strong>{p.preview?.title ?? p.permission}</strong>
            {!p.preview && p.tool ? tr("permissionbanner.viaValue", { tool: p.tool }) : ""}
            {risk && <span className={`permission-risk risk-${risk}`}>{risk} {tr("permissionbanner.risk")}</span>}
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
            <button onClick={() => replyPermission(p.requestId, "once")}>{tr("permissionbanner.allowOnce")}</button>
            {canAlways && (
              <span className="perm-always">
                <button onClick={() => replyPermission(p.requestId, "always", scope)}>{tr("permissionbanner.always")}</button>
                <select
                  aria-label={tr("permissionbanner.alwaysScope")}
                  value={scope}
                  onChange={(e) => setScope(e.target.value === "project" ? "project" : "session")}
                >
                  {scopes.includes("session") && <option value="session">{tr("permissionbanner.thisSession")}</option>}
                  {scopes.includes("project") && <option value="project">{tr("permissionbanner.thisProject")}</option>}
                </select>
              </span>
            )}
            <button className="danger" onClick={() => replyPermission(p.requestId, "reject")}>{tr("permissionbanner.deny")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PermissionBanner({ permissions }: { permissions: PendingPermission[] }) {
  if (permissions.length === 0) return null;
  return (
    <div
      className="perm-banner permission-toast"
      role="alert"
      aria-live="assertive"
      aria-relevant="additions text"
    >
      <div className="perm-title sr-only">{tr("permissionbanner.permissionRequested")}</div>
      {permissions.map((p) => (
        <PermissionRow key={p.requestId} p={p} />
      ))}
    </div>
  );
}
