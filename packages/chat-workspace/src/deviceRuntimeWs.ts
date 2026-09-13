import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import {
  allowWsCapability,
  claimWsUpgrade,
  closeWs,
  defaultWsIdentity,
  denyUpgrade,
  liveWsPrincipal,
  type WsAttachAuth,
} from "@polyth/plugins";
import type {
  ChatWorkspaceDeviceAck,
  ChatWorkspaceDeviceEvent,
  ChatWorkspaceDeviceHello,
} from "./deviceRuntimeProtocol.ts";
import { CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION } from "./deviceRuntimeProtocol.ts";
import type { ChatWorkspaceDeviceRuntimeRegistry } from "./deviceRuntimeRegistry.ts";

const WORKER_PATH = "/ws/chat-workspace/device-runtime";
const MAX_MESSAGE_BYTES = 512 * 1024;
const HELLO_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;

interface PendingAck {
  resolve(ack: ChatWorkspaceDeviceAck): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface BoundWorker {
  deviceId: string;
  principal: import("@polyth/contracts").AuthPrincipal;
  dispose(): Promise<void>;
  pending: Map<string, PendingAck>;
}

const runtimeError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export function attachChatWorkspaceDeviceRuntimeWs(
  server: Server,
  deps: WsAttachAuth & { registry: ChatWorkspaceDeviceRuntimeRegistry },
): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const workers = new Map<WebSocket, BoundWorker>();

  const send = (socket: WebSocket, message: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) throw runtimeError("runtime-disconnected", "Chat Workspace device runtime is not connected");
    socket.send(JSON.stringify(message));
  };

  const rejectPending = (bound: BoundWorker, code: string, message: string): void => {
    for (const pending of bound.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(runtimeError(code, message));
    }
    bound.pending.clear();
  };

  const cleanup = (socket: WebSocket): void => {
    deps.pairedSockets?.unbind(socket);
    const bound = workers.get(socket);
    workers.delete(socket);
    if (!bound) return;
    rejectPending(bound, "runtime-disconnected", "Chat Workspace device runtime disconnected");
    void bound.dispose().catch(() => {});
  };

  wss.on("connection", (socket, request: IncomingMessage) => {
    const resolution = defaultWsIdentity(deps, request);
    const principal = resolution.principal;
    if (principal.kind !== "paired-device") {
      closeWs(socket);
      return;
    }

    deps.pairedSockets?.bind(socket, principal, () => closeWs(socket));
    const helloTimer = setTimeout(() => closeWs(socket), HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    socket.on("message", (raw) => {
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      if (data.byteLength > MAX_MESSAGE_BYTES) {
        closeWs(socket);
        return;
      }
      const currentBound = workers.get(socket);
      const live = liveWsPrincipal(currentBound?.principal ?? principal, deps.refreshPrincipal);
      if (!live || live.kind !== "paired-device" || !allowWsCapability(live, REMOTE_CAPABILITY.browserUse)) {
        closeWs(socket);
        return;
      }
      if (currentBound) currentBound.principal = live;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      } catch {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", code: "invalid-json" }));
        return;
      }

      if (!currentBound) {
        if (parsed.type !== "hello" || !parsed.hello || typeof parsed.hello !== "object") {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", code: "runtime-hello-required" }));
          closeWs(socket);
          return;
        }
        const receivedHello = parsed.hello as ChatWorkspaceDeviceHello;
        if (receivedHello.protocolVersion !== CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", code: "runtime-protocol-mismatch" }));
          closeWs(socket);
          return;
        }
        // The Polyth Link principal is authoritative. A worker never gets to
        // self-assert the host-side device id used for grants/routing.
        const hello: ChatWorkspaceDeviceHello = {
          ...receivedHello,
          deviceId: live.deviceId,
        };
        try {
          const pending = new Map<string, PendingAck>();
          const registration = deps.registry.register(hello, {
            send(command) {
              return new Promise<ChatWorkspaceDeviceAck>((resolve, reject) => {
                if (socket.readyState !== WebSocket.OPEN) {
                  reject(runtimeError("runtime-disconnected", "Chat Workspace device runtime is not connected"));
                  return;
                }
                if (pending.has(command.requestId)) {
                  reject(runtimeError("conflict", `duplicate Chat Workspace device request ${command.requestId}`));
                  return;
                }
                const timer = setTimeout(() => {
                  pending.delete(command.requestId);
                  reject(runtimeError("runtime-timeout", `Chat Workspace device command timed out: ${command.kind}`));
                }, COMMAND_TIMEOUT_MS);
                timer.unref?.();
                pending.set(command.requestId, { resolve, reject, timer });
                try {
                  send(socket, { type: "command", command });
                } catch (error) {
                  clearTimeout(timer);
                  pending.delete(command.requestId);
                  reject(error instanceof Error ? error : runtimeError("runtime-send-failed", String(error)));
                }
              });
            },
            close() {
              closeWs(socket);
            },
          });
          clearTimeout(helloTimer);
          workers.set(socket, {
            deviceId: live.deviceId,
            principal: live,
            dispose: registration.dispose,
            pending,
          });
          send(socket, { type: "ready", protocolVersion: CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION });
        } catch (error) {
          const failure = error as Error & { code?: string };
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "error", code: failure.code ?? "runtime-invalid", message: failure.message }));
          }
          closeWs(socket);
        }
        return;
      }

      if (parsed.type === "heartbeat") {
        try {
          deps.registry.heartbeat(currentBound.deviceId);
          send(socket, { type: "heartbeat-ack" });
        } catch {
          closeWs(socket);
        }
        return;
      }

      if (parsed.type === "ack" && parsed.ack && typeof parsed.ack === "object") {
        const ack = parsed.ack as ChatWorkspaceDeviceAck;
        const pending = currentBound.pending.get(ack.requestId);
        if (!pending) return;
        currentBound.pending.delete(ack.requestId);
        clearTimeout(pending.timer);
        pending.resolve(ack);
        try { deps.registry.heartbeat(currentBound.deviceId); } catch { closeWs(socket); }
        return;
      }

      if (parsed.type === "event" && parsed.event && typeof parsed.event === "object") {
        try {
          deps.registry.event(currentBound.deviceId, parsed.event as ChatWorkspaceDeviceEvent);
        } catch {
          closeWs(socket);
        }
        return;
      }

      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", code: "runtime-message-invalid" }));
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      cleanup(socket);
    });
    socket.on("error", () => {
      clearTimeout(helloTimer);
      cleanup(socket);
    });
  });

  const stopClaim = claimWsUpgrade(server, (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname !== WORKER_PATH) return false;
    const resolution = defaultWsIdentity(deps, request);
    if (deps.authorize ? !deps.authorize(request) : !resolution.authenticated) {
      denyUpgrade(socket, 401);
      return true;
    }
    if (resolution.principal.kind !== "paired-device"
      || !allowWsCapability(resolution.principal, REMOTE_CAPABILITY.browserUse)) {
      denyUpgrade(socket, 403);
      return true;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
    return true;
  });

  return () => {
    stopClaim();
    for (const socket of [...workers.keys()]) {
      cleanup(socket);
      closeWs(socket);
    }
    wss.close();
  };
}
