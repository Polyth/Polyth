import { defineWebPackage } from "@polyth/web-sdk";
import { MonitoringView } from "./MonitoringView.tsx";
import { monitoringWords } from "./strings.ts";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const t = monitoringWords(host.ui.locale.get());
  const title = t("Monitoring", "Моніторинг");
  const off = [
    host.surfaces.register({
      id: "monitoring", title, description: t("Hosts, service health and log tails", "Хости, стан служб і останні рядки логів"),
      capabilityId: "monitoring", order: 56,
      component: (props) => <MonitoringView {...props} host={host} />,
      presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 320, preferredMaxWidth: 1100, keepAlive: false, escape: "close" },
    }),
    host.settings.registerPage({
      id: "monitoring", label: title, group: "Engineering", icon: "activity", order: 56,
      component: () => <MonitoringView host={host} initialTab="access" presentation="settings" />,
      settingsItems: [{ id: "monitoring.access", pageId: "monitoring", label: t("What agents can read", "Що можуть читати агенти"),
        focusTarget: "monitoring.access", keywords: ["monitoring", "sysadmin", "hosts", "logs", "permissions", "моніторинг", "дозволи"] }],
    }),
    host.workbench.profiles.register({
      id: "sysadmin", label: t("System administration", "Адміністрування"), order: 35,
      description: t("Diagnose hosts with an agent and explicit access policy", "Діагностика хостів з агентом і явними дозволами"),
      sessionPurpose: "sysadmin",
      defaultLayout: { surfaces: [{ surface: "session", region: "primary", active: true }, { surface: "monitoring", region: "end", active: true }] },
      presentation: { text: "code" },
    }),
    host.capabilities.register({
      id: "monitoring", label: title, plainDescription: t("Inspect host resources, services and logs", "Перевіряйте ресурси хостів, служби й журнали"),
      keywords: ["monitoring", "sysadmin", "hosts", "ssh", "logs", "tail", "моніторинг"], standardTier: "technical", standardRank: 35,
      defaultRails: { operations: "right" },
      open: () => host.navigation.openWorkspacePane("monitoring"), available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
