import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  setPolythLinkNative,
  type ConnectionMetadata,
  type ConnectionRecovery,
  type NumericPairingInput,
  type PairingAttempt,
  type PairingPreview,
  type PolythLinkNative,
  type ProxyLaunch,
} from "./polythLink.ts";

interface PolythLinkCapacitorPlugin {
  parsePairingTicket(options: { raw: string }): Promise<PairingPreview>;
  beginPairing(options: { raw: string; label: string }): Promise<PairingAttempt>;
  beginNumericPairing(options: NumericPairingInput): Promise<PairingAttempt>;
  confirmPairing(options: { attemptId: string }): Promise<ProxyLaunch>;
  cancelPairing(options: { attemptId: string }): Promise<{ ok: boolean }>;
  listConnections(): Promise<{ connections: ConnectionMetadata[] }>;
  connect(options: { connectionId: string }): Promise<ProxyLaunch>;
  recoverConnection(options: { connectionId: string }): Promise<ConnectionRecovery>;
  disconnect(options: { connectionId: string }): Promise<{ ok: boolean }>;
  forgetConnection(options: { connectionId: string }): Promise<{ ok: boolean }>;
  getStatus(options: { connectionId: string }): Promise<{
    state: string;
    transport?: "direct" | "relay";
    /** Connected session whose lost link is being re-established. */
    reconnecting?: boolean;
    error?: string;
  }>;
  scanPairingQr(): Promise<{ raw?: string }>;
  /** The open server's page asks for the server menu at its button. The app
   *  draws the list itself; the page learns only what kind of choice it was. */
  presentServerMenu(options: ServerMenuAnchor): Promise<{ action?: string }>;
  /** Bundled hub only: the server picked from that menu, once. */
  consumeServerChoice(): Promise<{ connectionId?: string }>;
}

/** The menu's trigger in CSS pixels, relative to the viewport. */
export interface ServerMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `switch` and `add` leave this page for the hub; `current` and `cancel` stay. */
export type ServerMenuAction = "switch" | "add" | "current" | "cancel";

const NativePolythLink = registerPlugin<PolythLinkCapacitorPlugin>("PolythLink");

let installed = false;

export function nativePairingScannerAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("PolythLink");
}

export async function scanNativePairingQr(): Promise<string | undefined> {
  if (!nativePairingScannerAvailable()) return undefined;
  const { raw } = await NativePolythLink.scanPairingQr();
  return typeof raw === "string" && raw ? raw : undefined;
}

/**
 * Show the native server menu (paired servers + Add server) at `anchor`.
 * `null` means this page cannot show it (an older app build, a development
 * host, or any page the app does not own): the caller falls back to the hub.
 */
export async function presentNativeServerMenu(anchor: ServerMenuAnchor): Promise<ServerMenuAction | null> {
  if (!nativePairingScannerAvailable()) return null;
  try {
    const { action } = await NativePolythLink.presentServerMenu(anchor);
    return action === "switch" || action === "add" || action === "current" || action === "cancel"
      ? action
      : "cancel";
  } catch (cause) {
    // A second tap while the menu is still up is not a reason to leave.
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    return code === "busy" ? "cancel" : null;
  }
}

export async function consumeNativeServerChoice(): Promise<string | undefined> {
  if (!nativePairingScannerAvailable()) return undefined;
  const { connectionId } = await NativePolythLink.consumeServerChoice();
  return typeof connectionId === "string" && connectionId ? connectionId : undefined;
}

export function installNativePolythLink(): void {
  if (installed || !Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("PolythLink")) return;
  installed = true;

  const adapter: PolythLinkNative = {
    parsePairingTicket: (raw) => NativePolythLink.parsePairingTicket({ raw }),
    beginPairing: (raw, label) => NativePolythLink.beginPairing({ raw, label }),
    beginNumericPairing: (input) => NativePolythLink.beginNumericPairing(input),
    confirmPairing: (attemptId) => NativePolythLink.confirmPairing({ attemptId }),
    cancelPairing: async (attemptId) => {
      await NativePolythLink.cancelPairing({ attemptId });
    },
    listConnections: async () => (await NativePolythLink.listConnections()).connections,
    connect: (connectionId) => NativePolythLink.connect({ connectionId }),
    recoverConnection: (connectionId) => NativePolythLink.recoverConnection({ connectionId }),
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
