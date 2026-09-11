import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  normalizeDiscoveryUpdate,
  type DiscoveryUpdate,
} from "./discovery.ts";

interface DiscoveryEvent {
  state?: unknown;
  results?: unknown;
  error?: unknown;
}

interface PolythDiscoveryCapacitorPlugin {
  startDiscovery(): Promise<{ ok: boolean }>;
  stopDiscovery(): Promise<{ ok: boolean }>;
  addListener(
    eventName: "discoveryChanged",
    listener: (event: DiscoveryEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const NativePolythDiscovery = registerPlugin<PolythDiscoveryCapacitorPlugin>("PolythDiscovery");

export interface NativeDiscoverySession {
  stop(): Promise<void>;
}

export function nativeDiscoveryAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("PolythDiscovery");
}

export async function startNativeDiscovery(
  onUpdate: (update: DiscoveryUpdate) => void,
): Promise<NativeDiscoverySession> {
  if (!nativeDiscoveryAvailable()) throw new Error("discovery-unavailable");

  let stopped = false;
  const listener = await NativePolythDiscovery.addListener("discoveryChanged", (event) => {
    if (!stopped) onUpdate(normalizeDiscoveryUpdate(event));
  });

  try {
    await NativePolythDiscovery.startDiscovery();
  } catch (cause) {
    stopped = true;
    await listener.remove().catch(() => undefined);
    throw cause;
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await NativePolythDiscovery.stopDiscovery().catch(() => undefined);
      await listener.remove().catch(() => undefined);
    },
  };
}
