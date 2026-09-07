import { PackageHostError, type PackageErrorCode } from "./errors.ts";
import {
  MAX_IN_FLIGHT,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_CHANNEL,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  parseEnvelope,
  payloadSize,
  requestEnvelope,
  type HandshakeReady,
  type ProtocolEnvelope,
} from "./protocol.ts";
import { type RemoteUiAction, type RemoteUiNode } from "./remoteUi.ts";

export interface PolythPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close?: () => void;
  start?: () => void;
}

export interface ConnectPolythOptions {
  target?: {
    parent: { postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void };
    addEventListener: Window["addEventListener"];
    removeEventListener: Window["removeEventListener"];
  };
  port?: PolythPort;
  mountNonce?: string;
  requestTimeoutMs?: number;
}

export interface PolythSessionSnapshot {
  id: string;
  title: string;
  busy: boolean;
}

export interface PolythProjectSnapshot {
  id: string;
  name: string;
}

export interface PolythConnectionStatus {
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  account?: string;
  error?: string;
}

export interface PolythHost {
  readonly ready: HandshakeReady;
  hasCapability(name: string): boolean;
  ui: {
    render(tree: RemoteUiNode): Promise<void>;
    onAction(id: string, handler: (action: RemoteUiAction) => void): () => void;
    onComposerAction(handler: (actionId: string) => void): () => void;
    toast(request: { kind?: "info" | "success" | "error"; message: string }): Promise<void>;
    openSurface(surfaceId: string): Promise<void>;
    openExternalUrl(url: string): Promise<void>;
  };
  composer: {
    write(text: string, mode?: "replace" | "append"): Promise<void>;
    send(input: { text: string }): Promise<void>;
  };
  session: {
    read(): Promise<PolythSessionSnapshot | null>;
    appendContext(text: string): Promise<void>;
  };
  project: {
    readMetadata(): Promise<PolythProjectSnapshot | null>;
  };
  attachments: {
    create(input: {
      resourceId: string;
      title: string;
      subtitle?: string;
      url?: string;
      kind?: string;
      text?: string;
    }): Promise<void>;
  };
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  network: {
    fetch(input: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      connectionId?: string;
    }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
  };
  auth: {
    connection(id: string): Promise<PolythConnectionStatus>;
    connect(id: string): Promise<PolythConnectionStatus>;
    disconnect(id: string): Promise<PolythConnectionStatus>;
  };
  clipboard: {
    write(text: string): Promise<void>;
  };
  dispose(): void;
}

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: PackageHostError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const helloMessage = (mountNonce: string) => ({
  channel: PROTOCOL_CHANNEL,
  v: PROTOCOL_VERSION,
  kind: "hello",
  mountNonce,
});

function readMountNonce(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof window !== "undefined") {
    const injected = (window as unknown as { __POLYTH_MOUNT__?: unknown }).__POLYTH_MOUNT__;
    if (typeof injected === "string" && injected) return injected;
  }
  if (typeof location === "undefined") return "";
  return new URLSearchParams(location.search).get("mount") ?? "";
}

export function connectPolyth(options: ConnectPolythOptions = {}): Promise<PolythHost> {
  if (options.port) return connectOnPort(options.port, options.requestTimeoutMs);
  const target = options.target ?? (typeof window === "undefined" ? null : window);
  if (!target) {
    return Promise.reject(new PackageHostError("HOST_UNAVAILABLE", "connectPolyth runs in a sandbox frame"));
  }
  const nonce = readMountNonce(options.mountNonce);
  if (!nonce) {
    return Promise.reject(new PackageHostError("PROTOCOL_MISMATCH", "missing mount nonce"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener("message", onMessage);
      reject(new PackageHostError("HOST_TIMEOUT", "host did not complete handshake"));
    }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    const onMessage = (event: Event) => {
      if (!(event instanceof MessageEvent)) return;
      if (event.source !== target.parent) return;
      const data = event.data as { channel?: unknown; kind?: unknown } | null;
      if (!data || data.channel !== PROTOCOL_CHANNEL || data.kind !== "port") return;
      const port = event.ports[0] as PolythPort | undefined;
      if (!port) return;
      clearTimeout(timer);
      target.removeEventListener("message", onMessage);
      void connectOnPort(port, options.requestTimeoutMs).then(resolve, reject);
    };
    target.addEventListener("message", onMessage);
    target.parent.postMessage(helloMessage(nonce), "*");
  });
}

async function connectOnPort(port: PolythPort, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PolythHost> {
  port.start?.();
  const pending = new Map<string, Pending>();
  const actionHandlers = new Map<string, Set<(action: RemoteUiAction) => void>>();
  const composerActionHandlers = new Set<(actionId: string) => void>();
  let seq = 0;
  let disposed = false;
  let ready: HandshakeReady | null = null;

  const onMessage = (event: MessageEvent) => {
    const envelope = parseEnvelope(event.data);
    if (!envelope) return;
    if (envelope.kind === "event" && envelope.method === "ui.action") {
      const payload = envelope.payload as RemoteUiAction | undefined;
      if (!payload || typeof payload.id !== "string") return;
      for (const handler of actionHandlers.get(payload.id) ?? []) handler(payload);
      return;
    }
    if (envelope.kind === "event" && envelope.method === "composer.action") {
      const payload = envelope.payload as { actionId?: unknown } | undefined;
      if (!payload || typeof payload.actionId !== "string" || !payload.actionId) return;
      for (const handler of composerActionHandlers) handler(payload.actionId);
      return;
    }
    if (envelope.kind !== "response" || !envelope.id) return;
    const waiter = pending.get(envelope.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(envelope.id);
    if (envelope.ok) waiter.resolve(envelope.payload);
    else {
      waiter.reject(new PackageHostError(
        (envelope.error?.code ?? "HOST_REJECTED") as PackageErrorCode,
        envelope.error?.message ?? "request failed",
      ));
    }
  };
  port.addEventListener("message", onMessage);

  const send = (envelope: ProtocolEnvelope): void => {
    if (disposed) throw new PackageHostError("PACKAGE_DISABLED", "runtime is disposed");
    if (payloadSize(envelope) > MAX_PAYLOAD_BYTES) {
      throw new PackageHostError("INVALID_REQUEST", "payload exceeds size limit");
    }
    port.postMessage(envelope);
  };

  const request = (method: string, payload?: unknown): Promise<unknown> => {
    if (disposed) return Promise.reject(new PackageHostError("PACKAGE_DISABLED", "runtime is disposed"));
    if (pending.size >= MAX_IN_FLIGHT) {
      return Promise.reject(new PackageHostError("HOST_REJECTED", "too many in-flight requests"));
    }
    seq += 1;
    const id = `p-${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PackageHostError("HOST_TIMEOUT", "host did not answer in time"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send(requestEnvelope(id, method, payload));
      } catch (cause) {
        clearTimeout(timer);
        pending.delete(id);
        reject(cause);
      }
    });
  };

  const handshake = await request("runtime.hello") as HandshakeReady;
  if (!handshake || handshake.protocolVersion !== PROTOCOL_VERSION) {
    port.removeEventListener("message", onMessage);
    port.close?.();
    throw new PackageHostError("PROTOCOL_MISMATCH", "host protocol is incompatible");
  }
  ready = handshake;
  const capabilities = new Set(handshake.capabilities);

  const host: PolythHost = {
    get ready() {
      return ready!;
    },
    hasCapability: (name) => capabilities.has(name),
    ui: {
      render: async (tree) => {
        await request("ui.render", tree);
      },
      onAction: (id, handler) => {
        let set = actionHandlers.get(id);
        if (!set) {
          set = new Set();
          actionHandlers.set(id, set);
        }
        set.add(handler);
        return () => {
          set!.delete(handler);
          if (set!.size === 0) actionHandlers.delete(id);
        };
      },
      onComposerAction: (handler) => {
        composerActionHandlers.add(handler);
        return () => { composerActionHandlers.delete(handler); };
      },
      toast: (payload) => request("ui.toast", payload).then(() => undefined),
      openSurface: (surfaceId) => request("ui.openSurface", { surfaceId }).then(() => undefined),
      openExternalUrl: (url) => request("ui.openExternalUrl", { url }).then(() => undefined),
    },
    composer: {
      write: (text, mode = "replace") => request("composer.write", { text, mode }).then(() => undefined),
      send: (input) => request("composer.send", { text: input.text }).then(() => undefined),
    },
    session: {
      read: () => request("session.read") as Promise<PolythSessionSnapshot | null>,
      appendContext: (text) => request("session.appendContext", { text }).then(() => undefined),
    },
    project: {
      readMetadata: () => request("project.readMetadata") as Promise<PolythProjectSnapshot | null>,
    },
    attachments: {
      create: (input) => request("attachments.create", input).then(() => undefined),
    },
    storage: {
      get: (key) => request("storage.get", { key }) as Promise<string | null>,
      set: (key, value) => request("storage.set", { key, value }).then(() => undefined),
      delete: (key) => request("storage.delete", { key }).then(() => undefined),
    },
    network: {
      fetch: (input) => request("network.fetch", input) as Promise<{
        status: number;
        body: string;
        headers: Record<string, string>;
      }>,
    },
    auth: {
      connection: (id) => request("auth.connection", { id }) as Promise<PolythConnectionStatus>,
      connect: (id) => request("auth.connect", { id }) as Promise<PolythConnectionStatus>,
      disconnect: (id) => request("auth.disconnect", { id }) as Promise<PolythConnectionStatus>,
    },
    clipboard: {
      write: (text) => request("clipboard.write", { text }).then(() => undefined),
    },
    dispose: () => {
      if (disposed) return;
      port.removeEventListener("message", onMessage);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new PackageHostError("PACKAGE_DISABLED", "runtime is disposed"));
      }
      pending.clear();
      actionHandlers.clear();
      composerActionHandlers.clear();
      disposed = true;
      queueMicrotask(() => port.close?.());
    },
  };
  return host;
}
