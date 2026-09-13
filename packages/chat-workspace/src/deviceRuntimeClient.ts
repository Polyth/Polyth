import { WebSocket } from "ws";
import type {
  ChatWorkspaceDeviceEvent,
  ChatWorkspaceDeviceHello,
} from "./deviceRuntimeProtocol.ts";
import type { ChatWorkspaceDeviceWorkerRuntime } from "./deviceWorkerRuntime.ts";

export interface ChatWorkspaceDeviceRuntimeClient {
  sendEvent(event: ChatWorkspaceDeviceEvent): void;
  close(): Promise<void>;
  readonly ready: Promise<void>;
}

export function connectChatWorkspaceDeviceRuntime(input: {
  wsUrl: string;
  hello: ChatWorkspaceDeviceHello;
  runtime: ChatWorkspaceDeviceWorkerRuntime;
  heartbeatMs?: number;
  headers?: Record<string, string>;
}): ChatWorkspaceDeviceRuntimeClient {
  const socket = new WebSocket(input.wsUrl, {
    ...(input.headers ? { headers: input.headers } : {}),
  });
  const heartbeatMs = Math.max(5_000, input.heartbeatMs ?? 10_000);
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let settled = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    readyReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });

  const send = (message: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  };

  socket.on("open", () => {
    send({ type: "hello", hello: input.hello });
  });

  socket.on("message", (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "ready") {
      readyResolve();
      if (!heartbeat) {
        heartbeat = setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
        heartbeat.unref?.();
      }
      return;
    }
    if (message.type === "command" && message.command && typeof message.command === "object") {
      void input.runtime.execute(message.command as import("./deviceRuntimeProtocol.ts").ChatWorkspaceDeviceCommand)
        .then((ack) => send({ type: "ack", ack }))
        .catch((error) => send({
          type: "ack",
          ack: {
            requestId: String((message.command as Record<string, unknown>).requestId ?? ""),
            ok: false,
            code: (error as Error & { code?: string }).code ?? "runtime-error",
            message: (error as Error).message,
          },
        }));
      return;
    }
    if (message.type === "error") {
      readyReject(Object.assign(new Error(String(message.message ?? message.code ?? "Chat Workspace device runtime error")), {
        code: String(message.code ?? "runtime-error"),
      }));
    }
  });

  socket.on("error", (error) => {
    if (!closed) readyReject(error instanceof Error ? error : new Error(String(error)));
  });

  socket.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (!closed) readyReject(new Error("Chat Workspace device runtime connection closed"));
  });

  return {
    ready,
    sendEvent(event) {
      send({ type: "event", event });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      socket.close();
      await input.runtime.close();
    },
  };
}
