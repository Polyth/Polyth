import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  setPolythLinkNative,
  type ConnectionMetadata,
  type PairingAttempt,
  type PairingPreview,
  type PolythLinkNative,
  type ProxyLaunch,
} from "./polythLink.ts";

interface PolythLinkCapacitorPlugin {
  parsePairingTicket(options: { raw: string }): Promise<PairingPreview>;
  beginPairing(options: { raw: string; label: string }): Promise<PairingAttempt>;
  confirmPairing(options: { attemptId: string }): Promise<ProxyLaunch>;
  cancelPairing(options: { attemptId: string }): Promise<{ ok: boolean }>;
  listConnections(): Promise<{ connections: ConnectionMetadata[] }>;
  connect(options: { connectionId: string }): Promise<ProxyLaunch>;
  disconnect(options: { connectionId: string }): Promise<{ ok: boolean }>;
  forgetConnection(options: { connectionId: string }): Promise<{ ok: boolean }>;
  getStatus(options: { connectionId: string }): Promise<{
    state: string;
    transport?: "direct" | "relay";
    error?: string;
  }>;
  scanPairingQr(): Promise<{ raw?: string }>;
}

const NativePolythLink = registerPlugin<PolythLinkCapacitorPlugin>("PolythLink");

let installed = false;

export function nativePairingScannerAvailable(): boolean {
  return Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === "ios"
    && Capacitor.isPluginAvailable("PolythLink");
}

export async function scanNativePairingQr(): Promise<string | undefined> {
  if (!nativePairingScannerAvailable()) return undefined;
  const { raw } = await NativePolythLink.scanPairingQr();
  return typeof raw === "string" && raw ? raw : undefined;
}

export function installNativePolythLink(): void {
  if (installed || !Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("PolythLink")) return;
  installed = true;

  const adapter: PolythLinkNative = {
    parsePairingTicket: (raw) => NativePolythLink.parsePairingTicket({ raw }),
    beginPairing: (raw, label) => NativePolythLink.beginPairing({ raw, label }),
    confirmPairing: (attemptId) => NativePolythLink.confirmPairing({ attemptId }),
    cancelPairing: async (attemptId) => {
      await NativePolythLink.cancelPairing({ attemptId });
    },
    listConnections: async () => (await NativePolythLink.listConnections()).connections,
    connect: (connectionId) => NativePolythLink.connect({ connectionId }),
    disconnect: async (connectionId) => {
      await NativePolythLink.disconnect({ connectionId });
    },
    forgetConnection: async (connectionId) => {
      await NativePolythLink.forgetConnection({ connectionId });
    },
    getStatus: (connectionId) => NativePolythLink.getStatus({ connectionId }),
  };

  setPolythLinkNative(adapter);
}
