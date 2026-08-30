// Permission banner (WP15, redesigned P2-W2): an approval is ALWAYS
// action-required UI. The card never hides its decision buttons behind a
// disclosure — intent (server-built redacted preview title), target lines,
// risk, and Allow/Always/Deny are all visible the moment the request lands.
// Only the machine identity ("via <tool>") is secondary text.
import { useState } from "react";
import { replyPermission } from "../../../apps/web/src/init.ts";
import type { PendingPermission } from "../../../apps/web/src/reduce.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { Button, Select } from "../../../apps/web/src/components/ui/index.ts";
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
  const scopes = p.allowedScopes ?? ["once", "session", "project"];
  const canAlways = scopes.includes("session") || scopes.includes("project");
  const risk = p.preview?.risk;
  const title = p.preview?.title ?? p.permission;
  // The preview is server-built and secret-redacted; raw patterns are the
  // fallback for old events. Either way the target is visible pre-decision.
  const lines = p.preview !== undefined && p.preview.lines.length > 0 ? p.preview.lines : p.patterns;
  return (
    <div className="perm-row permission-request">
      <div className="permission-request-head">
        <span className="permission-mode-icon" aria-hidden="true">{modeIcon(p.permission)}</span>
        <strong className="permission-request-title">{title}</strong>
        {p.tool !== undefined && p.tool !== title && (
          <span className="permission-request-tool">{tr("permissionbanner.viaValue", { tool: p.tool })}</span>
        )}
        {risk !== undefined && <span className={`permission-risk risk-${risk}`}>{risk} {tr("permissionbanner.risk")}</span>}
      </div>
      {lines.length > 0 && (
        <div className="permission-preview">
          {lines.map((line, index) => (
            <code key={index}>{line}</code>
          ))}
        </div>
      )}
      <div className="perm-actions">
        <Button variant="primary" className="permission-allow" onClick={() => replyPermission(p.requestId, "once")}>
          {tr("permissionbanner.allowOnce")}
        </Button>
        {canAlways && (
          <span className="perm-always">
            <Button variant="quiet" onClick={() => replyPermission(p.requestId, "always", scope)}>
              {tr("permissionbanner.always")}
            </Button>
            <Select
              label={tr("permissionbanner.alwaysScope")}
              ariaLabel={tr("permissionbanner.alwaysScope")}
              value={scope}
              options={[
                ...(scopes.includes("session") ? [{ value: "session", label: tr("permissionbanner.thisSession") }] : []),
                ...(scopes.includes("project") ? [{ value: "project", label: tr("permissionbanner.thisProject") }] : []),
              ]}
              onChange={(value) => setScope(value === "project" ? "project" : "session")}
              className="perm-always-scope"
            />
          </span>
        )}
        <Button variant="danger" className="permission-deny" onClick={() => replyPermission(p.requestId, "reject")}>
          {tr("permissionbanner.deny")}
        </Button>
      </div>
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
      <div className="perm-title">
        <span className="permission-alert-mark" aria-hidden="true">!</span>
        {tr("permissionbanner.permissionRequested")}
      </div>
      {permissions.map((p) => (
        <PermissionRow key={p.requestId} p={p} />
      ))}
    </div>
  );
}
