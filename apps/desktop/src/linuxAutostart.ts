import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const AUTOSTART_FILE_NAME = "polyth.desktop";
const BACKGROUND_ARG = "--background";

interface LinuxAutostartPaths {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

interface LinuxAutostartOptions extends LinuxAutostartPaths {
  enabled: boolean;
  executable?: string;
}

export const resolveLinuxAutostartFilePath = ({
  env = process.env,
  homeDir = homedir(),
}: LinuxAutostartPaths = {}): string => {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
  return join(configHome, "autostart", AUTOSTART_FILE_NAME);
};

export const resolveLinuxLaunchExecutable = ({
  env = process.env,
  execPath = process.execPath,
}: {
  env?: Record<string, string | undefined>;
  execPath?: string;
} = {}): string => {
  const appImage = env.APPIMAGE?.trim();
  return appImage && isAbsolute(appImage) ? appImage : execPath;
};

const quoteDesktopExecArg = (value: string): string => {
  if (!/[ \t\n"$\\`]/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
};

export const buildLinuxAutostartDesktopEntry = ({
  executable,
}: {
  executable: string;
}): string => [
  "[Desktop Entry]",
  "Type=Application",
  "Version=1.0",
  "Name=Polyth",
  "Comment=Start Polyth in the system tray",
  `Exec=${quoteDesktopExecArg(executable)} ${BACKGROUND_ARG}`,
  "Terminal=false",
  "X-GNOME-Autostart-enabled=true",
  "StartupWMClass=polyth.desktop",
  "",
].join("\n");

export async function setLinuxAutostartEnabled({
  enabled,
  executable,
  env = process.env,
  homeDir = homedir(),
}: LinuxAutostartOptions): Promise<string> {
  const filePath = resolveLinuxAutostartFilePath({ env, homeDir });
  if (!enabled) {
    await rm(filePath, { force: true });
    return filePath;
  }

  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const launchExecutable = executable ?? resolveLinuxLaunchExecutable({ env });
  await writeFile(temp, buildLinuxAutostartDesktopEntry({ executable: launchExecutable }), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return filePath;
}

export async function readLinuxAutostartEnabled(
  options: LinuxAutostartPaths = {},
): Promise<boolean> {
  try {
    const contents = await readFile(resolveLinuxAutostartFilePath(options), "utf8");
    return contents.includes("X-GNOME-Autostart-enabled=true");
  } catch {
    return false;
  }
}
