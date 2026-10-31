import "./styles.css";
import { useSyncExternalStore } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import JudgmentSettings from "./JudgmentSettings.tsx";

const fieldLabels = {
  enabled: "judgment.settings.enabledLabel",
  uses: "judgment.settings.usesLabel",
  engine: "judgment.settings.engineLabel",
  provider: "judgment.settings.providerLabel",
  model: "judgment.settings.modelLabel",
  credential: "judgment.settings.credentialLabel",
} as const;

export default defineWebPackage((host) => () => {
  function SettingsPage() {
    const projectId = useSyncExternalStore(host.store.subscribe, () => host.store.getSnapshot().activeProjectId);
    return <JudgmentSettings key={projectId} projectId={projectId} openVault={() => host.navigation.openSettingsPage("secure-safe")} />;
  }
  const off = [
    host.settings.registerPage({ id: "judgment", packageId: "judgment", label: "Judgment", group: "Engineering", order: 55, icon: "circle-check", component: SettingsPage }),
    host.settings.registerItems((Object.keys(fieldLabels) as Array<keyof typeof fieldLabels>).map((field) => ({
      id: `judgment.${field}`, pageId: "judgment", label: tr(fieldLabels[field]), description: tr("judgment.settings.description"),
      keywords: ["judgment", field, "evaluation"], focusTarget: `judgment.${field}`,
    }))),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
