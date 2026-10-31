import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import CustomTitlesSettingsPage from "./CustomTitlesSettingsPage.tsx";
import RegenerateTitleAction from "./RegenerateTitleAction.tsx";
import RegenerateTitlesBulkAction, { type BulkReport } from "./RegenerateTitlesBulkAction.tsx";
import { customTitlesStrings } from "./strings.ts";

export default defineWebPackage((host) => () => {
  const copy = customTitlesStrings(host.ui.locale.get());
  const off = host.settings.registerPage({
    id: "custom-titles",
    packageId: "custom-titles",
    label: copy.pageLabel,
    group: "Customize",
    icon: "edit",
    order: 34,
    component: () => createElement(CustomTitlesSettingsPage, { host }),
    settingsItems: [
      {
        id: "custom-titles.mode",
        pageId: "custom-titles",
        label: copy.itemModeLabel,
        description: copy.itemModeDescription,
        keywords: ["title", "session", "fallback", "always"],
        focusTarget: "custom-titles.mode",
      },
      {
        id: "custom-titles.model",
        pageId: "custom-titles",
        label: copy.itemModelLabel,
        description: copy.itemModelDescription,
        keywords: ["title", "model", "harness", "opencode", "free"],
        focusTarget: "custom-titles.model",
      },
      {
        id: "custom-titles.rules",
        pageId: "custom-titles",
        label: copy.itemRulesLabel,
        description: copy.itemRulesDescription,
        keywords: ["title", "language", "style", "rules"],
        focusTarget: "custom-titles.rules",
      },
    ],
  });
  const offAction = host.slots.register({
    slot: "sidebar.session.actions",
    id: "custom-titles.regenerate",
    order: 34,
    render: ({ sessionId, closeMenu }) => typeof sessionId === "string"
      ? createElement(RegenerateTitleAction, {
        key: sessionId,
        host,
        sessionId,
        closeMenu: typeof closeMenu === "function" ? closeMenu as () => void : undefined,
      })
      : null,
  });
  const offBulkAction = host.slots.register({
    slot: "sidebar.sessions.bulk.actions",
    id: "custom-titles.regenerate-selected",
    order: 34,
    render: ({ sessionIds, closeMenu, done, report }) => Array.isArray(sessionIds) && sessionIds.length > 0
      ? createElement(RegenerateTitlesBulkAction, {
        host,
        sessionIds: sessionIds.filter((id): id is string => typeof id === "string"),
        closeMenu: typeof closeMenu === "function" ? closeMenu as () => void : undefined,
        done: typeof done === "function" ? done as () => void : undefined,
        report: typeof report === "function" ? report as BulkReport : undefined,
      })
      : null,
  });
  return () => { offBulkAction(); offAction(); off(); };
});
