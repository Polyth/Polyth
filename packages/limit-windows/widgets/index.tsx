import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { createCopy } from "./copy.ts";
import LimitWindowsSettings from "./LimitWindowsSettings.tsx";

/**
 * Limit windows: when each account's limit window starts. The server does the
 * work (`src/controller.ts`); this package only adds its settings page.
 */
export default defineWebPackage((host) => () => {
  const copy = createCopy(host.ui.locale.get());
  const off = [
    host.settings.registerPage({
      id: "limit-windows",
      packageId: "limit-windows",
      label: copy.page,
      group: "Workspace",
      icon: "schedule",
      order: 42,
      component: LimitWindowsSettings,
      settingsItems: [
        {
          id: "limit-windows.plan",
          pageId: "limit-windows",
          label: copy.page,
          description: copy.searchPlan,
          keywords: ["limit", "window", "reset", "quota", "5h", "weekly", "ping", "cheapest", "ліміт", "вікно", "скидання", "квота"],
          focusTarget: "limit-windows.plan",
        },
      ],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
