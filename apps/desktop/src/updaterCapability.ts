import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

interface UpdaterCapabilityOptions {
  packaged: boolean;
  platform?: NodeJS.Platform;
  appImagePath?: string;
  access?: (path: string, mode: number) => void;
  stat?: (path: string) => { isFile(): boolean };
}

export function assertUpdaterCapability({
  packaged,
  platform = process.platform,
  appImagePath = process.env.APPIMAGE,
  access = accessSync,
  stat = statSync,
}: UpdaterCapabilityOptions): void {
  if (!packaged || platform !== "linux") return;
  if (!appImagePath || !isAbsolute(appImagePath)) {
    throw new Error(
      "Updates require the packaged Linux AppImage. Start Polyth from its .AppImage file, not an extracted copy.",
    );
  }
  try {
    if (!stat(appImagePath).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`The running AppImage cannot be found at ${appImagePath}.`);
  }
  try {
    access(appImagePath, constants.W_OK);
  } catch {
    throw new Error(
      `The AppImage is not writable at ${appImagePath}. Move it to a writable location before updating.`,
    );
  }
}
