// F16 Settings → Access: shows whether the UI password gate is on, lists
// remembered device sessions, and offers per-device revoke + sign out
// everywhere. The password itself is configured server-side (POLYTH_UI_PASSWORD
// or a hash in data/auth.json) — it never transits this page.
import { useCallback, useEffect, useState } from "react";
import { api, type AuthDeviceDto, type AuthStatusDto } from "../../api.ts";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState, PageHead, Row } from "./parts.tsx";

const when = (ts: number): string => new Date(ts).toLocaleString();

/** "Chrome on macOS"-ish from a stored user-agent; raw prefix as fallback. */
const deviceLabel = (ua: string): string => {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os =
    /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
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
    if (!await confirmAlert("Sign out every device, including this one?", { title: "Sign out everywhere", confirmLabel: "Sign out" })) return;
    void api.authLogoutAll().then(() => location.reload()).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  if (err) return <><PageHead title="Access" /><EmptyState title="Server unreachable" body={err} /></>;
  if (!status) return <><PageHead title="Access" /><EmptyState title="Loading…" /></>;

  if (!status.required) {
    return (
      <>
        <PageHead title="Access" blurb="Optional UI password protecting every API and live connection." />
        <EmptyState
          title="No password set"
          body="This server accepts every connection. To require a password, set POLYTH_UI_PASSWORD in the server environment (POLYTH_UI_PASSWORD_LOCALHOST=optional keeps localhost open) and restart."
        />
      </>
    );
  }

  return (
    <>
      <PageHead title="Access" blurb="A UI password protects this server. Devices below hold a remembered session." />
      <Row label="Password protection" hint="Configured via POLYTH_UI_PASSWORD or data/auth.json on the server." itemId="access.protection">
        <span className="tag">on</span>
      </Row>
      <div className="set-page-head"><h3>Remembered devices</h3></div>
      {devices.length === 0
        ? <EmptyState title="No remembered devices" body="Sessions appear here after a successful login." />
        : devices.map((d) => (
          <Row
            key={d.id}
            label={`${deviceLabel(d.label)}${d.current ? " (this device)" : ""}`}
            hint={`Signed in ${when(d.createdAt)} · last seen ${when(d.lastSeenAt)}`}
          >
            <button className="small-btn" onClick={() => revoke(d.id)}>
              {d.current ? "Sign out" : "Revoke"}
            </button>
          </Row>
        ))}
      <Row label="Sign out everywhere" hint="Revokes every remembered device session, including this one." itemId="access.logout-all">
        <button className="small-btn danger" onClick={signOutAll}>Sign out all devices</button>
      </Row>
    </>
  );
}
