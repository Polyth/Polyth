// Pure helpers for the SSH remotes UI — DOM-free and node:test friendly.
import type { SshConnectionDto, SshConnectionInput, SshConnectionState } from "@polyth/contracts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";

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
  if (!host) return tr("ssh.sshui.hostRequired");
  if (host.startsWith("-")) return tr("ssh.sshui.hostDash");
  if (/\s/.test(host)) return tr("ssh.sshui.hostSpaces");
  const user = values.user.trim();
  if (user && (/\s/.test(user) || user.includes("@"))) return tr("ssh.sshui.userLogin");
  if (values.port.trim()) {
    const port = Number(values.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) return tr("ssh.sshui.portRange");
  }
  if (values.authMode === "identity-file" && !values.identityFile.trim()) {
    return tr("ssh.sshui.choosePrivateKey");
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
  if (state === "connected") return { text: tr("ssh.sshui.connected"), tone: "ok" };
  if (state === "auth-failed") return { text: tr("ssh.sshui.authFailed"), tone: "err" };
  if (state === "unreachable") return { text: tr("ssh.sshui.unreachable"), tone: "err" };
  if (state === "disconnected") return { text: tr("ssh.sshui.disconnected"), tone: "muted" };
  return { text: tr("ssh.sshui.unknown"), tone: "muted" };
}

/** POSIX basename used to suggest a project name from the remote path. */
export function remoteBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || trimmed || "";
}
