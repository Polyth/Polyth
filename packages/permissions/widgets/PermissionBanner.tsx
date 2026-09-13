import { Fragment, useState } from "react";
import { api } from "@polyth/session/web-api";
import type { PendingPermission } from "../../../apps/web/src/reduce.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { Button, GlassDock, Separator } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

type PermissionAction = "once" | "always" | "reject" | "session";

function ResponsiveLabel({ full, short }: { full: string; short: string }) {
  return <><span className="permission-action-full">{full}</span><span className="permission-action-short">{short}</span></>;
}

function isBrowserRequest(p: PendingPermission): boolean {
  return p.permission === "package-tool"
    && (p.tool === "polyth_browser"
      || p.tool === "browser.polyth-browser"
      || p.tool?.startsWith("browser.") === true
      || p.patterns.some((pattern) => pattern === "browser.polyth-browser"));
}

/** Generic provider labels such as "Edit" repeat information already conveyed
 * by the target and do not deserve a second visual row. Keep only a genuinely
 * descriptive, server-built title. */
function requestTitle(p: PendingPermission, browser: boolean): string | null {
  if (browser) return tr("permissionbanner.agentWantsToUseBrowser");
  const title = p.preview?.title?.trim();
  if (!title) return null;
  const normalized = title.toLocaleLowerCase();
  if (normalized === p.permission.trim().toLocaleLowerCase()) return null;
  if (p.tool && normalized === p.tool.trim().toLocaleLowerCase()) return null;
  return title;
}

function PermissionRow({ p }: { p: PendingPermission }) {
  const [busy, setBusy] = useState<PermissionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopes = p.allowedScopes ?? ["once", "session", "project"];
  const alwaysScope = scopes.includes("session") ? "session" : scopes.includes("project") ? "project" : null;
  const browser = isBrowserRequest(p);
  const title = requestTitle(p, browser);
  const lines = p.preview !== undefined && p.preview.lines.length > 0 ? p.preview.lines : p.patterns;

  const reply = async (action: PermissionAction) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      if (action === "session") {
        // The canonical session policy also reconciles this open request. Set
        // it first so the resumed runtime cannot race ahead into another card.
        await api.autoAcceptSet(p.sessionId, "on");
      } else {
        await api.replyPermission(
          p.sessionId,
          p.requestId,
          action,
          action === "always" ? alwaysScope ?? undefined : undefined,
        );
      }
    } catch (reason) {
      setBusy(null);
      setError(reason instanceof Error ? reason.message : tr("common.error"));
    }
  };

  return (
    <div className="perm-row permission-request">
      {title && <strong className="permission-request-title">{title}</strong>}
      {browser && (
        <p className="permission-browser-capabilities">
          {tr("permissionbanner.browserActionCapabilities")}
        </p>
      )}
      {lines.length > 0 && (
        <div className="permission-preview">
          {lines.map((line, index) => <code key={index}>{line}</code>)}
        </div>
      )}
      <div className={`perm-actions${alwaysScope ? " has-always" : ""}`} aria-label={tr("permissionbanner.permissionRequested")}>
        <Button size="sm" variant="ghost" className="permission-deny" aria-label={tr("permissionbanner.deny")} busy={busy === "reject"} disabled={busy !== null} onClick={() => void reply("reject")}>
          <ResponsiveLabel full={tr("permissionbanner.deny")} short={tr("permissionbanner.denyShort")} />
        </Button>
        <Button size="sm" variant="primary" className="permission-allow" aria-label={tr("permissionbanner.allowOnce")} busy={busy === "once"} disabled={busy !== null} onClick={() => void reply("once")}>
          <ResponsiveLabel full={tr("permissionbanner.allowOnce")} short={tr("permissionbanner.once")} />
        </Button>
        {alwaysScope && (
          <Button
            size="sm"
            variant="quiet"
            className="permission-always"
            aria-label={`${tr("permissionbanner.always")} — ${alwaysScope === "session" ? tr("permissionbanner.thisSession") : tr("permissionbanner.thisProject")}`}
            title={`${tr("permissionbanner.always")} — ${alwaysScope === "session" ? tr("permissionbanner.thisSession") : tr("permissionbanner.thisProject")}`}
            busy={busy === "always"}
            disabled={busy !== null}
            onClick={() => void reply("always")}
          >
            {tr("permissionbanner.always")}
          </Button>
        )}
        <Button
          size="sm"
          variant="quiet"
          className="permission-session"
          aria-label={tr("permissionbanner.allowAllSession")}
          title={tr("permissionbanner.allowAllSession")}
          busy={busy === "session"}
          disabled={busy !== null}
          onClick={() => void reply("session")}
        >
          <ResponsiveLabel full={tr("permissionbanner.allSession")} short={tr("permissionbanner.session")} />
        </Button>
      </div>
      {error && <p className="permission-error" role="alert">{error}</p>}
    </div>
  );
}

export default function PermissionBanner({ permissions }: { permissions: PendingPermission[] }) {
  if (permissions.length === 0) return null;
  return (
    <GlassDock className="perm-banner permission-toast" role="alert" aria-live="assertive" aria-relevant="additions text">
      <div className="perm-title">
        <span className="permission-mode-icon" aria-hidden="true"><Icon.shield /></span>
        {tr("permissionbanner.permissionRequested")}
      </div>
      {permissions.map((p, index) => (
        <Fragment key={p.requestId}>
          {index > 0 && <Separator decorative />}
          <PermissionRow p={p} />
        </Fragment>
      ))}
    </GlassDock>
  );
}
