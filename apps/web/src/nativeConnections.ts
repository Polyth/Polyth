import { isNativeMobile, returnToMobileConnectionHub } from "@polyth/mobile/runtime";
import { registerCommand } from "./commands.ts";

export function installNativeConnectionCommands(): void {
  if (!isNativeMobile()) return;
  registerCommand({
    id: "mobile.switch-polyth",
    label: "Switch Polyth server",
    group: "Mobile",
    keywords: ["connections", "servers", "hosts", "polyth link", "switch server"],
    run: () => { void returnToMobileConnectionHub(); },
  });
}
