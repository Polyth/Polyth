import { chooseMobileServer, isNativeMobile, returnToMobileConnectionHub } from "@polyth/mobile/runtime";
import { registerCommand } from "./commands.ts";
import { desktopBridge, onRemoteDesktopSurface } from "./desktopBridge.ts";
import { tr } from "./i18n/index.ts";

/** Only the native app has a connection hub to go back to. */
export const canSwitchMobileServer = (): boolean => isNativeMobile();

/** The desktop app can move its window to another server. */
export const canSwitchDesktopServer = (): boolean => desktopBridge()?.servers !== undefined;

/** The app's native server menu at `trigger`, drawn by the main process. */
export function switchDesktopServer(trigger?: Element | null): void {
  const rect = trigger?.getBoundingClientRect();
  void desktopBridge()?.servers?.menu(rect && rect.width > 0
    ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    : undefined);
}

/** This page is a client of a server elsewhere, through a local Link proxy. */
export const isLinkClientPage = (): boolean => isNativeMobile() || desktopBridge()?.linkProxy === true;

/** The open server's page lost its local proxy: go back and reconnect it. */
export async function returnToConnectionHub(path: string): Promise<void> {
  const servers = onRemoteDesktopSurface() ? desktopBridge()?.servers : undefined;
  if (servers) await servers.resume(path);
  else await returnToMobileConnectionHub(path, { resume: true });
}

/**
 * The app's native server menu at `trigger` (paired servers + Add server);
 * without a trigger, or where the menu cannot show, the connection hub's
 * server list.
 */
export function switchMobileServer(trigger?: Element | null): void {
  const rect = trigger?.getBoundingClientRect();
  void chooseMobileServer(rect && rect.width > 0
    ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    : undefined);
}

export function installNativeConnectionCommands(): void {
  if (canSwitchDesktopServer()) {
    registerCommand({
      id: "desktop.switch-polyth",
      label: tr("nativeconnections.switchServer"),
      group: tr("desktop.settings.pageLabel"),
      keywords: ["connections", "servers", "hosts", "polyth link", "switch server", "client"],
      run: () => { void desktopBridge()?.servers?.list(); },
    });
    return;
  }
  if (!canSwitchMobileServer()) return;
  registerCommand({
    id: "mobile.switch-polyth",
    label: tr("nativeconnections.switchServer"),
    group: tr("nativeconnections.group"),
    keywords: ["connections", "servers", "hosts", "polyth link", "switch server"],
    run: () => switchMobileServer(),
  });
}
