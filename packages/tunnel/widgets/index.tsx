import { defineWebPackage } from "@polyth/web-sdk";
import { createApiTransport } from "@polyth/web-sdk";
import type { TunnelStatusDto } from "@polyth/contracts";
import { createElement } from "react";
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

const LINK_POLL_MS = 5_000;

/** Poll while the document is visible; read once when it shows again or the
 *  connection returns. A hidden tab issues no reads. Returns the disposer. */
export function pollLinkAvailability(refresh: () => void, intervalMs = LINK_POLL_MS): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const hidden = () => document.visibilityState === "hidden";
  const start = () => {
    if (timer === undefined) timer = setInterval(() => { if (!hidden()) refresh(); }, intervalMs);
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = () => {
    if (hidden()) { stop(); return; }
    refresh();
    start();
  };
  const onOnline = () => { if (!hidden()) refresh(); };
  if (!hidden()) { refresh(); start(); }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
  };
}

export default defineWebPackage((host) => () => {
  const stopPolling = pollLinkAvailability(() => { void refreshLinkAvailability(); });
  const translate = host.ui.locale.translate;
  const linkCapability = {
    id: "polyth-link",
    label: translate("tunnel.capability.label"),
    technicalLabel: "Polyth Link",
    plainDescription: translate("tunnel.capability.description"),
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
      icon: "qr",
      order: 42,
      component: () => createElement(LinkPage, { host }),
    }),
    () => {
      unsubAvailability();
      capOff();
    },
  ];
  return () => {
    stopPolling();
    off.toReversed().forEach((dispose) => dispose());
  };
});
