// `polyth` command-line tool for Polyth Desktop.
//
// The packaged app carries a bundled JavaScript CLI (resources/cli/polyth.cjs)
// and runs it with its own Electron binary in Node mode, so people do not
// need a separate Node.js. "Install Command-Line Tool" writes a small user-
// owned launcher on PATH; it never needs administrator rights. The CLI finds
// the running desktop through the control socket in the desktop data folder,
// and `polyth open` hands a path back to this instance through the
// single-instance handoff (`--polyth-open=/p/…/s/…`).
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CliLauncherInput {
  platform: NodeJS.Platform;
  /** The app's own executable (Electron binary). */
  executable: string;
  /** Set when running from an AppImage: the stable outer file, not the mount. */
  appImage?: string;
  /** Absolute path of the bundled CLI script. */
  cliScript: string;
  home: string;
  localAppData?: string;
}

export interface CliLauncherPlan {
  path: string;
  content: string;
  mode: number;
  /** Whether the launcher's folder is usually on PATH already. */
  pathHint: string;
}

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function cliLauncherPlan(input: CliLauncherInput): CliLauncherPlan {
  const executable = input.appImage || input.executable;
  if (input.platform === "win32") {
    const dir = join(input.localAppData ?? join(input.home, "AppData", "Local"), "Polyth", "bin");
    const path = join(dir, "polyth.cmd");
    // cmd quoting: paths are wrapped in double quotes; Windows paths cannot contain them.
    const content = [
      "@echo off",
      "setlocal",
      "set ELECTRON_RUN_AS_NODE=1",
      `set "POLYTH_DESKTOP_EXECUTABLE=${executable}"`,
      `"${executable}" "${input.cliScript}" %*`,
      "",
    ].join("\r\n");
    return { path, content, mode: 0o644, pathHint: `Add ${dir} to your PATH (Settings → Environment variables) to run \`polyth\` from any terminal.` };
  }
  const dir = join(input.home, ".local", "bin");
  const path = join(dir, "polyth");
  const content = [
    "#!/bin/sh",
    "# Polyth command-line tool (installed by Polyth Desktop).",
    `POLYTH_DESKTOP_EXECUTABLE=${shQuote(executable)}`,
    "export POLYTH_DESKTOP_EXECUTABLE",
    `ELECTRON_RUN_AS_NODE=1 exec "$POLYTH_DESKTOP_EXECUTABLE" ${shQuote(input.cliScript)} "$@"`,
    "",
  ].join("\n");
  return {
    path,
    content,
    mode: 0o755,
    pathHint: input.platform === "darwin"
      ? `If \`polyth\` is not found, add this to ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"`
      : "Most Linux shells include ~/.local/bin on PATH; if `polyth` is not found, log out and back in or add it to PATH.",
  };
}

export async function installCliLauncher(plan: CliLauncherPlan): Promise<void> {
  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(plan.path, plan.content, { mode: plan.mode });
  await chmod(plan.path, plan.mode);
}

/** In-app path from `--polyth-open=<path>`; only Polyth's own routes. */
export function openPathFromArgv(argv: readonly string[]): string | null {
  const arg = [...argv].reverse().find((value) => value.startsWith("--polyth-open="));
  if (!arg) return null;
  const path = arg.slice("--polyth-open=".length);
  return /^\/(?:p\/[A-Za-z0-9._~%-]{1,200}(?:\/s\/[A-Za-z0-9._~%-]{1,200})?)?$/.test(path) ? path : null;
}
