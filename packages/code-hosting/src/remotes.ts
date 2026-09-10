export interface GitRemoteLocation {
  remoteName: string;
  url: string;
  hostname: string;
  fullPath: string;
  protocol: "http" | "https" | "ssh" | "git";
}

export type GitRemoteExec = (
  bin: "git",
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

function cleanPath(path: string): string | null {
  const clean = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/$/, "");
  const parts = clean.split("/");
  if (
    !clean || clean.length > 4096 || parts.length < 2
    || /[\0-\x20\\?#]/.test(clean)
    || parts.some((part) => !part || part === "." || part === "..")
  ) return null;
  return clean;
}

/** Parse HTTP(S), ssh://, git://, and SCP-style remotes without contacting them. */
export function parseGitRemoteUrl(raw: string): Omit<GitRemoteLocation, "remoteName"> | null {
  const value = raw.trim();
  if (!value || value !== raw || value.length > 8192 || /[\0-\x20\\?#]/.test(value)) return null;
  if (value.includes("://")) try {
    const url = new URL(value);
    const protocol = url.protocol.replace(":", "");
    if (protocol !== "http" && protocol !== "https" && protocol !== "ssh" && protocol !== "git") return null;
    if (url.username && url.protocol !== "ssh:") return null;
    if (url.password || url.search || url.hash) return null;
    const fullPath = cleanPath(decodeURIComponent(url.pathname));
    if (!fullPath) return null;
    return {
      url: value,
      hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      fullPath,
      protocol,
    };
  } catch {
    return null;
  }
  const separator = value.indexOf(":");
  const at = value.indexOf("@");
  // In SCP syntax an optional user must precede the host separator. Reject
  // password-shaped input instead of returning it in repository context.
  if (at >= 0 && at > separator) return null;
  const match = value.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/);
  const fullPath = match?.[2] ? cleanPath(match[2]) : null;
  if (!match?.[1] || !fullPath) return null;
  return { url: value, hostname: match[1].toLowerCase(), fullPath, protocol: "ssh" };
}

/** Enumerate every configured fetch URL using argv-only local Git commands. */
export async function detectGitRemotes(
  cwd: string,
  exec: GitRemoteExec,
): Promise<GitRemoteLocation[]> {
  const names = (await exec("git", ["remote"], { cwd })).stdout
    .split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const found: GitRemoteLocation[] = [];
  for (const remoteName of names) {
    const output = await exec("git", ["remote", "get-url", "--all", "--", remoteName], { cwd });
    for (const raw of output.stdout.split(/\r?\n/)) {
      const parsed = parseGitRemoteUrl(raw);
      if (parsed) found.push({ remoteName, ...parsed });
    }
  }
  return found;
}
