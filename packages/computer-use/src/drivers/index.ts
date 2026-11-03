import type { ComputerDriver } from "../types.ts";
import { createLinuxDriver } from "./linux.ts";
import { createMacDriver } from "./macos.ts";
import { createWindowsDriver } from "./windows.ts";

export { createLinuxDriver, createMacDriver, createWindowsDriver };

/** The driver for the desktop the Polyth server itself runs on, or
 * undefined where there is no desktop at all (a headless Linux server). A
 * returned driver may still fail `probe` (missing helper, no permission). */
export function detectDriver(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ComputerDriver | undefined {
  if (platform === "darwin") return createMacDriver({ env });
  if (platform === "win32") return createWindowsDriver({ env });
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) return createLinuxDriver({ env });
  return undefined;
}
