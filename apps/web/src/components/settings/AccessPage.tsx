// F16 Settings → Access: shows whether the UI password gate is on, lists
// remembered device sessions, and offers per-device revoke + sign out
// everywhere. The password itself is configured server-side (POLYTH_UI_PASSWORD
// or a hash in data/auth.json) — it never transits this page.
import { useCallback, useEffect, useState } from "react";
import { api, type AuthDeviceDto, type AuthStatusDto } from "@polyth/session/web-api";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState, PageHead, Row } from "./parts.tsx";
import { getLocale, tr } from "../../i18n/index.ts";

const when = (ts: number): string => new Date(ts).toLocaleString(getLocale());

/** "Chrome on macOS"-ish from a stored user-agent; raw prefix as fallback. */
const deviceLabel = (ua: string): string => {
  if (!ua) return tr("settings.accesspage.unknownDevice");
  const browser =
    /Edg\//.test(ua) ? tr("settings.accesspage.edge") : /Firefox\//.test(ua) ? tr("settings.accesspage.firefox")
    : /Chrome\//.test(ua) ? tr("settings.accesspage.chrome") : /Safari\//.test(ua) ? tr("settings.accesspage.safari") : null;
  const os =
    /Windows/.test(ua) ? tr("settings.accesspage.windows") : /Mac OS X|Macintosh/.test(ua) ? tr("settings.accesspage.macos")
    : /Android/.test(ua) ? tr("settings.accesspage.android") : /iPhone|iPad/.test(ua) ? tr("settings.accesspage.ios")
    : /Linux/.test(ua) ? tr("settings.accesspage.linux") : null;
  if (browser && os) return tr("settings.accesspage.valueOnValue", { browser: browser, os: os });
  return browser ?? os ?? ua.slice(0, 40);
};

export default function AccessPage() {
  const [status, setStatus] = useState<AuthStatusDto | null>(null);
  const [devices, setDevices] = useState<AuthDeviceDto[]>([]);
  const [err, setErr] = useState("");

  const refresh = useCallback(() => {
    void api.authStatus().then((s) => {
      setStatus(s);
      if (s.required) {
        void api.authSessions().then(setDevices).catch(() => setDevices([]));
      }
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const revoke = (id: string) => {
    void api.authRevoke(id).then(refresh).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const signOutAll = async () => {
    if (!await confirmAlert(tr("settings.accesspage.signOutEveryDeviceIncludingThisOne"), { title: tr("settings.accesspage.signOutEverywhere"), confirmLabel: tr("settings.accesspage.signOut") })) return;
    void api.authLogoutAll().then(() => location.reload()).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  if (err) return <><PageHead title={tr("settings.accesspage.access")} /><EmptyState title={tr("settings.accesspage.serverUnreachable")} body={err} /></>;
  if (!status) return <><PageHead title={tr("settings.accesspage.access")} /><EmptyState title={tr("common.loading")} busy /></>;

  if (!status.required) {
    return (
      <>
        <PageHead title={tr("settings.accesspage.access")} blurb={tr("settings.accesspage.optionalUiPasswordProtectingEveryApiAnd")} />
        <EmptyState
          title={tr("settings.accesspage.noPasswordSet")}
          body={tr("settings.accesspage.thisServerAcceptsEveryConnectionToRequire")}
        />
      </>
    );
  }

  return (
    <>
      <PageHead title={tr("settings.accesspage.access")} blurb={tr("settings.accesspage.aUiPasswordProtectsThisServerDevices")} />
      <Row label={tr("settings.accesspage.passwordProtection")} hint={tr("settings.accesspage.configuredViaPolythUiPasswordOrData")} itemId="access.protection">
        <span className="tag">{tr("settings.accesspage.on")}</span>
      </Row>
      <div className="set-page-head"><h3>{tr("settings.accesspage.rememberedDevices")}</h3></div>
      {devices.length === 0
        ? <EmptyState title={tr("settings.accesspage.noRememberedDevices")} body={tr("settings.accesspage.sessionsAppearHereAfterASuccessfulLogin")} />
        : devices.map((d) => (
          <Row
            key={d.id}
            label={d.current
              ? tr("settings.accesspage.valueThisDevice", { value: deviceLabel(d.label) })
              : deviceLabel(d.label)}
            hint={tr("settings.accesspage.signedInValueLastSeenValue", { value: when(d.createdAt), value2: when(d.lastSeenAt) })}
          >
            <button className="small-btn" onClick={() => revoke(d.id)}>
              {d.current ? tr("settings.accesspage.signOut") : tr("settings.accesspage.revoke")}
            </button>
          </Row>
        ))}
      <Row label={tr("settings.accesspage.signOutEverywhere")} hint={tr("settings.accesspage.revokesEveryRememberedDeviceSessionIncludingThis")} itemId="access.logout-all">
        <button className="small-btn danger" onClick={signOutAll}>{tr("settings.accesspage.signOutAllDevices")}</button>
      </Row>
    </>
  );
}
