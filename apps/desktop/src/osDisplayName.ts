// The owner's name for a first run without a password, taken from the OS
// account instead of asked for: the full name where the OS keeps one (macOS
// `id -F`, the Linux GECOS field), otherwise the login name. Renaming lives in
// Settings → Users → your account. Never throws; a slow or missing tool only
// falls back to the login name.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";

const MAX_NAME_LENGTH = 80;
const LOOKUP_TIMEOUT_MS = 2_000;

type RunCommand = (file: string, args: readonly string[]) => Promise<string>;

const runCommand: RunCommand = (file, args) => new Promise((resolveRun, rejectRun) => {
  execFile(file, [...args], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
    error ? rejectRun(error) : resolveRun(String(stdout)));
});

/** Printable, single-line, at most 80 UTF-16 units (the account name rule),
 *  never splitting a character. */
export function cleanDisplayName(value: string | null | undefined): string {
  const text = (value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > MAX_NAME_LENGTH) break;
    kept += char;
  }
  return kept.trim();
}

/** The full-name part of a `getent passwd` line (GECOS, before the first comma). */
export function gecosFullName(passwdLine: string): string {
  const gecos = passwdLine.split("\n")[0]?.split(":")[4] ?? "";
  return cleanDisplayName(gecos.split(",")[0]);
}

/** "max" → "Max"; a login name is the fallback when the OS has no full name. */
export function loginDisplayName(username: string): string {
  const login = cleanDisplayName(username);
  return login ? `${login.charAt(0).toLocaleUpperCase()}${login.slice(1)}` : "";
}

export async function osDisplayName(options: {
  platform?: NodeJS.Platform;
  username?: string;
  run?: RunCommand;
} = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  let username = options.username;
  if (username === undefined) {
    try { username = userInfo().username; } catch { username = ""; }
  }
  const run = options.run ?? runCommand;
  let fullName = "";
  try {
    if (platform === "darwin") fullName = cleanDisplayName(await run("id", ["-F"]));
    // Never an option-looking argument: a plain account name only.
    else if (platform === "linux" && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(username)) fullName = gecosFullName(await run("getent", ["passwd", username]));
  } catch {
    fullName = "";
  }
  return fullName || loginDisplayName(username) || "Owner";
}
