import type { AuthPrincipal } from "@polyth/contracts";

type IdentifiedPrincipal = AuthPrincipal & { userId?: string };
interface BoundPairedSocket {
  deviceId: string;
  connectionId: string;
  close: () => void;
}
interface BoundAuthSocket {
  kind: "ui-session" | "paired-device";
  sessionId?: string;
  userId?: string;
  close: () => void;
  detachOwner: () => void;
}

/**
 * Process-local index of authenticated upgraded sockets. The durable identity
 * authority remains canonical; this index exists only so a committed revocation
 * can close otherwise-idle channels immediately instead of waiting for their
 * next message/frame to revalidate.
 */
const authSockets = new Map<object, BoundAuthSocket>();

function closeMatching(predicate: (socket: BoundAuthSocket) => boolean): number {
  let closed = 0;
  for (const [key, info] of [...authSockets]) {
    if (!predicate(info)) continue;
    authSockets.delete(key);
    info.detachOwner();
    try { info.close(); } catch { /* socket may already be closing */ }
    closed += 1;
  }
  return closed;
}

/** Close one canonical browser session across core and package WS channels. */
export function closeAuthSessionSockets(sessionId: string): number {
  if (!sessionId) return 0;
  return closeMatching((info) => info.kind === "ui-session" && info.sessionId === sessionId);
}

/** Close every canonical browser session owned by one user; pairings stay live. */
export function closeAuthUserSessionSockets(userId: string): number {
  if (!userId) return 0;
  return closeMatching((info) => info.kind === "ui-session" && info.userId === userId);
}

/** Close every canonical browser/paired channel owned by one user identity. */
export function closeAuthUserSockets(userId: string): number {
  if (!userId) return 0;
  return closeMatching((info) => info.userId === userId);
}

/**
 * Historical name retained for API compatibility. Besides its paired-device
 * index, bind() now records canonical ui-session sockets in the process-local
 * revocation index above. Device-specific methods and size remain paired-only.
 */
export class PairedSocketRegistry {
  private readonly sockets = new Map<object, BoundPairedSocket>();

  bind(socket: object, principal: AuthPrincipal, close: () => void): void {
    this.unbind(socket);
    const userId = (principal as IdentifiedPrincipal).userId;
    if (principal.kind === "ui-session") {
      authSockets.set(socket, {
        kind: "ui-session",
        sessionId: principal.sessionId,
        ...(typeof userId === "string" && userId ? { userId } : {}),
        close,
        detachOwner: () => {},
      });
      return;
    }
    if (principal.kind !== "paired-device") return;
    this.sockets.set(socket, {
      deviceId: principal.deviceId,
      connectionId: principal.connectionId,
      close,
    });
    authSockets.set(socket, {
      kind: "paired-device",
      ...(typeof userId === "string" && userId ? { userId } : {}),
      close,
      detachOwner: () => { this.sockets.delete(socket); },
    });
  }

  unbind(socket: object): void {
    this.sockets.delete(socket);
    authSockets.delete(socket);
  }

  closeDevice(deviceId: string): void {
    for (const [socket, info] of [...this.sockets]) {
      if (info.deviceId !== deviceId) continue;
      this.sockets.delete(socket);
      authSockets.delete(socket);
      info.close();
    }
  }

  closeConnection(connectionId: string): void {
    for (const [socket, info] of [...this.sockets]) {
      if (info.connectionId !== connectionId) continue;
      this.sockets.delete(socket);
      authSockets.delete(socket);
      info.close();
    }
  }

  activeCount(deviceId: string): number {
    let count = 0;
    for (const info of this.sockets.values()) {
      if (info.deviceId === deviceId) count += 1;
    }
    return count;
  }

  get size(): number {
    return this.sockets.size;
  }
}
