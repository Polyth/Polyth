import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { AuthPrincipal, AuthResolution } from "@polyth/contracts";
import { principalAllowsRemoteCapability } from "@polyth/contracts";
import type { PairedSocketRegistry } from "./pairedSockets.ts";

export type WsAuthorize = (req: IncomingMessage) => boolean;

export interface WsAttachAuth {
  authorize?: WsAuthorize;
  identity?: (req: IncomingMessage) => AuthResolution;
  refreshPrincipal?: (principal: AuthPrincipal) => AuthPrincipal | null;
  pairedSockets?: PairedSocketRegistry;
}

const anonymous: AuthResolution = { principal: { kind: "anonymous" }, authenticated: false };
const localLoopback: AuthResolution = {
  principal: { kind: "local-user", trustedLoopback: true },
  authenticated: true,
};

export function normalizeWsAttachAuth(auth?: WsAuthorize | WsAttachAuth): WsAttachAuth {
  if (typeof auth === "function") return { authorize: auth };
  return auth ?? {};
}

export function defaultWsIdentity(auth: WsAttachAuth, req: IncomingMessage): AuthResolution {
  if (auth.identity) return auth.identity(req);
  if (auth.authorize) return auth.authorize(req) ? localLoopback : anonymous;
  return localLoopback;
}

export function liveWsPrincipal(
  bound: AuthPrincipal,
  refresh?: (principal: AuthPrincipal) => AuthPrincipal | null,
): AuthPrincipal | null {
  if (!refresh) return bound;
  return refresh(bound);
}

export function allowWsCapability(principal: AuthPrincipal | null, capability: string): boolean {
  if (!principal) return false;
  return principalAllowsRemoteCapability(principal, capability);
}

export function denyUpgrade(socket: Socket, status = 401): void {
  if (socket.destroyed || socket.writableEnded) return;
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Error";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

export type WsUpgradeClaim = (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
) => boolean;

interface UpgradeRouter {
  claims: Set<WsUpgradeClaim>;
  dispatch: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
}

const upgradeRouters = new WeakMap<import("node:http").Server, UpgradeRouter>();

/** One `upgrade` listener per HTTP server. Claims run in registration order;
 *  the first that returns true owns the socket. Unclaimed upgrades close with 404. */
export function claimWsUpgrade(
  server: import("node:http").Server,
  claim: WsUpgradeClaim,
): () => void {
  let router = upgradeRouters.get(server);
  if (!router) {
    const claims = new Set<WsUpgradeClaim>();
    const dispatch = (req: IncomingMessage, socket: Socket, head: Buffer) => {
      socket.on("error", () => {});
      for (const next of claims) {
        if (next(req, socket, head)) return;
      }
      denyUpgrade(socket, 404);
    };
    router = { claims, dispatch };
    upgradeRouters.set(server, router);
    server.on("upgrade", dispatch);
    server.on("close", () => {
      server.off("upgrade", dispatch);
      upgradeRouters.delete(server);
    });
  }
  router.claims.add(claim);
  return () => {
    upgradeRouters.get(server)?.claims.delete(claim);
  };
}

export function closeWs(
  socket: { readyState?: number; close(code?: number, reason?: string): void; terminate?(): void },
  code = 4001,
  reason = "revoked",
): void {
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate?.();
  }
}
