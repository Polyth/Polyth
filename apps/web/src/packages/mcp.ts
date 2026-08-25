import { McpPage } from "../components/settings/pages.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { MCP_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";

export function installMcpPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "mcp",
      packageId: "mcp",
      label: tr("packages.mcp.mcp"),
      group: "Engineering",
      icon: "🔌",
      order: 40,
      component: McpPage,
      settingsItems: [
        {
          id: "mcp.servers",
          pageId: "mcp",
          label: tr("packages.mcp.mcpServers"),
          description: tr("packages.mcp.modelContextProtocolServerConfiguration"),
          keywords: ["mcp", "tools", "transport", "stdio"],
          focusTarget: "mcp.servers",
        },
      ],
    }),
    registerPackageOnboarding(MCP_TOUR),
  );
}
