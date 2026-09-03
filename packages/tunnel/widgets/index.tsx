import { defineWebPackage } from "@polyth/web-sdk";
import LinkPage from "./LinkPage.tsx";
import "./styles.css";

export default defineWebPackage((host) => () => {
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
    host.capabilities.register({
      id: "polyth-link",
      label: "Pair a phone",
      technicalLabel: "Polyth Link",
      plainDescription: "Pair a phone with a QR code for secure remote access.",
      keywords: ["link", "pair", "qr", "mobile", "relay"],
      standardTier: "technical",
      standardRank: 36,
      open: () => host.navigation.openSettingsPage("tunnel"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
