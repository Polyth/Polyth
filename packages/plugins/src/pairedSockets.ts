import type { AuthPrincipal } from "@polyth/contracts";

interface BoundSocket {
  deviceId: string;
  connectionId: string;
  close: () => void;
}

/** Live paired-device sockets. Revoke/disconnect close only matching sockets. */
export class PairedSocketRegistry {
  private readonly sockets = new Map<object, BoundSocket>();

  bind(socket: object, principal: AuthPrincipal, close: () => void): void {
    if (principal.kind !== "paired-device") return;
    this.sockets.set(socket, {
      deviceId: principal.deviceId,
      connectionId: principal.connectionId,
      close,
    });
  }

  unbind(socket: object): void {
    this.sockets.delete(socket);
  }

  closeDevice(deviceId: string): void {
    for (const [socket, info] of [...this.sockets]) {
      if (info.deviceId !== deviceId) continue;
      this.sockets.delete(socket);
      info.close();
    }
  }

  closeConnection(connectionId: string): void {
    for (const [socket, info] of [...this.sockets]) {
      if (info.connectionId !== connectionId) continue;
      this.sockets.delete(socket);
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
