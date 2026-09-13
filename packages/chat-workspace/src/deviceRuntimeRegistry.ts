import { randomUUID } from "node:crypto";
import type {
  ChatWorkspaceDeviceAck,
  ChatWorkspaceDeviceCommand,
  ChatWorkspaceDeviceCommandInput,
  ChatWorkspaceDeviceEvent,
  ChatWorkspaceDeviceHello,
} from "./deviceRuntimeProtocol.ts";
import {
  CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION,
  assertSafeDeviceProtocolPayload,
} from "./deviceRuntimeProtocol.ts";
import type { ChatWorkspaceRuntimeCapability } from "./runtime.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export interface ChatWorkspaceDeviceTransport {
  send(command: ChatWorkspaceDeviceCommand): Promise<ChatWorkspaceDeviceAck>;
  close?(): void | Promise<void>;
}

interface RegisteredDevice {
  hello: ChatWorkspaceDeviceHello;
  transport: ChatWorkspaceDeviceTransport;
  generation: number;
  connectedAt: number;
  lastSeenAt: number;
}

export interface ChatWorkspaceDeviceRuntimeRegistry {
  register(hello: ChatWorkspaceDeviceHello, transport: ChatWorkspaceDeviceTransport): { generation: number; dispose(): Promise<void> };
  heartbeat(deviceId: string): void;
  event(deviceId: string, event: ChatWorkspaceDeviceEvent): void;
  capabilities(now?: number): ChatWorkspaceRuntimeCapability[];
  dispatch(deviceId: string, command: ChatWorkspaceDeviceCommandInput, timeoutMs?: number): Promise<ChatWorkspaceDeviceAck>;
  disconnect(deviceId: string): Promise<void>;
  closeAll(): Promise<void>;
  onEvent(cb: (deviceId: string, event: ChatWorkspaceDeviceEvent) => void): { dispose(): void };
}

export function createChatWorkspaceDeviceRuntimeRegistry(opts?: {
  staleAfterMs?: number;
  now?: () => number;
}): ChatWorkspaceDeviceRuntimeRegistry {
  const devices = new Map<string, RegisteredDevice>();
  const listeners = new Set<(deviceId: string, event: ChatWorkspaceDeviceEvent) => void>();
  const staleAfterMs = Math.max(5_000, opts?.staleAfterMs ?? 30_000);
  const now = opts?.now ?? Date.now;
  let nextGeneration = 0;

  const capabilityFor = (device: RegisteredDevice, current: number): ChatWorkspaceRuntimeCapability => {
    const fresh = current - device.lastSeenAt <= staleAfterMs;
    const capable = device.hello.capabilities.localChromium
      && device.hello.capabilities.localRendering
      && device.hello.capabilities.persistentProfiles;
    return {
      kind: "desktop-local",
      available: fresh && capable,
      deviceId: device.hello.deviceId,
      deviceName: device.hello.deviceName,
      localRendering: device.hello.capabilities.localRendering,
      localProfileState: device.hello.capabilities.persistentProfiles,
      ...(!fresh ? { reason: "desktop runtime heartbeat expired" } : {}),
      ...(fresh && !capable ? { reason: "desktop runtime lacks required browser capabilities" } : {}),
    };
  };

  const closeRecord = async (deviceId: string, expected?: RegisteredDevice): Promise<void> => {
    const device = devices.get(deviceId);
    if (!device || (expected && device !== expected)) return;
    devices.delete(deviceId);
    await device.transport.close?.();
  };

  return {
    register(hello, transport) {
      if (!hello.deviceId || !hello.deviceName) throw err("invalid-input", "desktop runtime identity required");
      if (hello.protocolVersion !== CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION) {
        throw err("runtime-version-unsupported", `unsupported Chat Workspace device protocol ${hello.protocolVersion}`);
      }
      assertSafeDeviceProtocolPayload(hello);

      const existing = devices.get(hello.deviceId);
      if (existing && existing.transport !== transport) void existing.transport.close?.();

      nextGeneration = (nextGeneration + 1) >>> 0;
      if (nextGeneration === 0) nextGeneration = 1;
      const registered: RegisteredDevice = {
        hello,
        transport,
        generation: nextGeneration,
        connectedAt: now(),
        lastSeenAt: now(),
      };
      devices.set(hello.deviceId, registered);
      return {
        generation: registered.generation,
        dispose: () => closeRecord(hello.deviceId, registered),
      };
    },

    heartbeat(deviceId) {
      const device = devices.get(deviceId);
      if (!device) throw err("not-found", `desktop runtime ${deviceId} is not registered`);
      device.lastSeenAt = now();
    },

    event(deviceId, event) {
      const device = devices.get(deviceId);
      if (!device) throw err("not-found", `desktop runtime ${deviceId} is not registered`);
      assertSafeDeviceProtocolPayload(event);
      device.lastSeenAt = now();
      for (const cb of [...listeners]) cb(deviceId, event);
    },

    capabilities(current = now()) {
      return [...devices.values()]
        .map((device) => capabilityFor(device, current))
        .sort((a, b) => (a.deviceName ?? a.deviceId ?? "").localeCompare(b.deviceName ?? b.deviceId ?? ""));
    },

    async dispatch(deviceId, command, timeoutMs = 15_000) {
      const device = devices.get(deviceId);
      if (!device) throw err("not-found", `desktop runtime ${deviceId} is not registered`);
      const capability = capabilityFor(device, now());
      if (!capability.available) throw err("unavailable", capability.reason ?? "desktop runtime unavailable");
      const request = {
        ...command,
        requestId: randomUUID(),
      } as ChatWorkspaceDeviceCommand;
      assertSafeDeviceProtocolPayload(request);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ack = await Promise.race([
          device.transport.send(request),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(err("timeout", `desktop runtime ${deviceId} did not respond`)),
              Math.max(1_000, Math.min(timeoutMs, 60_000)),
            );
            timer.unref?.();
          }),
        ]);
        const current = devices.get(deviceId);
        if (current !== device || current.generation !== device.generation) {
          throw err("runtime-replaced", `desktop runtime ${deviceId} was replaced while command was in flight`);
        }
        if (ack.requestId !== request.requestId) throw err("protocol-error", "desktop runtime response requestId mismatch");
        device.lastSeenAt = now();
        return ack;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    disconnect(deviceId) {
      return closeRecord(deviceId);
    },

    async closeAll() {
      await Promise.all([...devices.entries()].map(([deviceId, device]) => closeRecord(deviceId, device)));
    },

    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => { listeners.delete(cb); } };
    },
  };
}
