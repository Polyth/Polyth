import { chooseMobileServer, isNativeMobile } from "@polyth/mobile/runtime";
import { registerCommand } from "./commands.ts";
import { tr } from "./i18n/index.ts";

/** Only the native app has a connection hub to go back to. */
export const canSwitchMobileServer = (): boolean => isNativeMobile();

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
  if (!canSwitchMobileServer()) return;
  registerCommand({
    id: "mobile.switch-polyth",
    label: tr("nativeconnections.switchServer"),
    group: tr("nativeconnections.group"),
    keywords: ["connections", "servers", "hosts", "polyth link", "switch server"],
    run: () => switchMobileServer(),
  });
}
