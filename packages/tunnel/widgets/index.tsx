import { defineWebPackage } from "@polyth/web-sdk";
import { createApiTransport } from "@polyth/web-sdk";
import type { TunnelStatusDto } from "@polyth/contracts";
import LinkPage from "./LinkPage.tsx";
import {
  applyTunnelStatusToCapability,
  polythLinkCapabilityAvailable,
  subscribePolythLinkCapability,
} from "./availability.ts";
import "./styles.css";

const api = createApiTransport({
  fetch: (url, init) => fetch(url, { credentials: "include", ...init }),
});

async function refreshLinkAvailability(): Promise<void> {
  try {
    const status = await api.get<TunnelStatusDto>("/api/tunnel/status");
    applyTunnelStatusToCapability(status);
  } catch {
    applyTunnelStatusToCapability({
      enabled: false,
      available: false,
      pairingAvailable: false,
      hostBinaryFound: false,
      hostProcessReady: false,
      endpointBound: false,
      ingressReady: false,
      activePolicy: null,
      mode: "direct-preferred",
      hostFingerprint: null,
      fingerprint: null,
      relayConfigured: false,
      identityAvailable: false,
      activeConnections: 0,
      activeDevices: 0,
      directConnections: 0,
      relayConnections: 0,
    });
  }
}

export default defineWebPackage((host) => () => {
  void refreshLinkAvailability();
  const timer = setInterval(() => { void refreshLinkAvailability(); }, 5_000);
  const linkCapability = {
    id: "polyth-link",
    label: "Pair a phone",
    technicalLabel: "Polyth Link",
    plainDescription: "Pair a phone with a QR code for secure remote access when the host is ready.",
    keywords: ["link", "pair", "qr", "mobile"],
    standardTier: "technical" as const,
    standardRank: 36,
    open: () => host.navigation.openSettingsPage("tunnel"),
    available: () => polythLinkCapabilityAvailable(),
  };
  const capOff = host.capabilities.register(linkCapability);
  const unsubAvailability = subscribePolythLinkCapability(() => {
    host.capabilities.notify();
  });
  const off = [
    host.settings.registerPage({
      id: "tunnel",
      packageId: "tunnel",
      label: "Polyth Link",
      group: "System",
      icon: "🔗",
      order: 42,
      component: LinkPage,
    }),
    () => {
      unsubAvailability();
      capOff();
    },
  ];
  return () => {
    clearInterval(timer);
    off.toReversed().forEach((dispose) => dispose());
  };
});
