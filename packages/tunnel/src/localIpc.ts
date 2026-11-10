import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** `\\.\pipe\…` or `\\?\pipe\…`: a Windows named pipe, not a file. */
export function isWindowsPipePath(path: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(path);
}

export interface LinkIpcPaths {
  /** The host listens here; this process connects for control RPC/events. */
  control: string;
  /** This process's server listens here; the host connects to proxy HTTP/WS. */
  ingress: string;
}

/** Local IPC addresses between this server and its Polyth Link host. Unix
 *  uses sockets inside the 0700 tunnel data directory. Windows has no such
 *  directory-scoped socket, so each start picks unguessable named pipes; the
 *  host creates its control pipe as the first instance with an owner-only
 *  DACL, so a squatter makes startup fail instead of intercepting it. */
export function linkIpcPaths(
  socketDir: string,
  platform: string = process.platform,
  nonce: string = randomBytes(16).toString("hex"),
): LinkIpcPaths {
  if (platform === "win32") {
    return {
      control: `\\\\.\\pipe\\polyth-link-${nonce}-host`,
      ingress: `\\\\.\\pipe\\polyth-link-${nonce}-ingress`,
    };
  }
  return { control: join(socketDir, "host.sock"), ingress: join(socketDir, "ingress.sock") };
}
