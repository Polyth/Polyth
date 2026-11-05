import { useEffect, useState } from "react";
import { desktopBridge, onRemoteDesktopSurface, type DesktopServerInfo } from "../desktopBridge.ts";
import { tr } from "../i18n/index.ts";
import { switchDesktopServer } from "../nativeConnections.ts";
import { Button, GlobeIcon, Icon, LinkIcon } from "./ui/index.ts";

/**
 * Says which Polyth the desktop window shows when it is another computer's: the
 * agents and files on screen are there, not here, and nothing else in the shell
 * tells them apart. Opens the app's native server menu. This computer's own page
 * shows nothing; the switch stays in the account menu.
 */
export default function DesktopServerSwitcher() {
  const remote = onRemoteDesktopSurface();
  const [server, setServer] = useState<DesktopServerInfo | null>(null);

  useEffect(() => {
    if (!remote) return undefined;
    let live = true;
    void desktopBridge()?.getInfo()
      .then((info) => { if (live) setServer(info.server ?? null); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [remote]);

  if (!remote || !server) return null;
  return (
    <button
      type="button"
      className="space-switcher header-control desktop-server-switcher"
      aria-haspopup="menu"
      aria-label={tr("desktop.servers.onServer", { name: server.label })}
      title={tr("desktop.servers.onServer", { name: server.label })}
      onClick={(event) => switchDesktopServer(event.currentTarget)}
    >
      <Icon icon={server.kind === "link" ? LinkIcon : GlobeIcon} size="sm" />
      <span className="space-switcher-name" dir="auto">{server.label}</span>
      <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The way out of another server's sign-in, setup and "can't reach" screens,
 *  which show no shell and so no switcher. */
export function DesktopServerExit() {
  if (!onRemoteDesktopSurface()) return null;
  return (
    <Button variant="ghost" size="sm" className="desktop-server-exit" type="button" onClick={() => void desktopBridge()?.servers?.list()}>
      {tr("desktop.servers.chooseAnother")}
    </Button>
  );
}
