// Pure helpers for the SSH remotes UI — DOM-free and node:test friendly.
import type { SshConnectionDto, SshConnectionInput, SshConnectionState } from "@polyth/contracts";

export interface SshFormValues {
  name: string;
  host: string;
  user: string;
  port: string;
  authMode: "agent" | "identity-file";
  identityFile: string;
}

export const emptySshForm: SshFormValues = {
  name: "", host: "", user: "", port: "", authMode: "agent", identityFile: "",
};

export function formFromConnection(conn: SshConnectionDto): SshFormValues {
  return {
    name: conn.name,
    host: conn.host,
    user: conn.user ?? "",
    port: conn.port !== undefined ? String(conn.port) : "",
    authMode: conn.authMode,
    identityFile: conn.identityFile ?? "",
  };
}

/** Mirrors the server-side checks so obvious mistakes fail before a request.
 *  Returns the first human-readable problem, or null when submittable. */
export function validateSshForm(values: SshFormValues): string | null {
  const host = values.host.trim();
  if (!host) return "Host is required.";
  if (host.startsWith("-")) return "Host must not start with a dash.";
  if (/\s/.test(host)) return "Host must not contain spaces.";
  const user = values.user.trim();
  if (user && (/\s/.test(user) || user.includes("@"))) return "User must be a plain login name.";
  if (values.port.trim()) {
    const port = Number(values.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port must be between 1 and 65535.";
  }
  if (values.authMode === "identity-file" && !values.identityFile.trim()) {
    return "Choose a private-key file path or switch to agent auth.";
  }
  return null;
}

export function formToInput(values: SshFormValues): SshConnectionInput {
  const port = values.port.trim() ? Number(values.port.trim()) : undefined;
  return {
    host: values.host.trim(),
    name: values.name.trim(),
    user: values.user.trim(),
    authMode: values.authMode,
    identityFile: values.authMode === "identity-file" ? values.identityFile.trim() : "",
    ...(port !== undefined ? { port } : {}),
  };
}

/** "dev@build.example:2222" — the canonical target shorthand. */
export function connectionTarget(conn: Pick<SshConnectionDto, "host" | "user" | "port">): string {
  const dest = conn.user ? `${conn.user}@${conn.host}` : conn.host;
  return conn.port !== undefined && conn.port !== 22 ? `${dest}:${conn.port}` : dest;
}

export interface StateBadge { text: string; tone: "ok" | "muted" | "err" }

export function stateBadge(state: SshConnectionState | undefined): StateBadge {
  if (state === "connected") return { text: "Connected", tone: "ok" };
  if (state === "auth-failed") return { text: "Auth failed", tone: "err" };
  if (state === "unreachable") return { text: "Unreachable", tone: "err" };
  if (state === "disconnected") return { text: "Disconnected", tone: "muted" };
  return { text: "Unknown", tone: "muted" };
}

/** POSIX basename used to suggest a project name from the remote path. */
export function remoteBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || trimmed || "";
}
