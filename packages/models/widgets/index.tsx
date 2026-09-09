import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import ModelsPage from "./ModelsPage.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.slots.register({
      id: "opencode.providers-models",
      slot: "settings.harness.detail",
      order: 10,
      meta: { harnessId: "opencode", sectionId: "providers-models", label: "Providers & Models" },
      render: (context) => context.harnessId === "opencode" && context.sectionId === "providers-models" ? <ModelsPage /> : null,
    }),
    host.capabilities.register({
      id: "models-agents",
      label: "Models & providers",
      plainDescription: "Choose models and configure OpenCode providers.",
      keywords: ["model", "profile", "provider", "OpenCode"],
      standardTier: "technical",
      standardRank: 32,
      open: () => host.navigation.openSettingsPage("opencode"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
