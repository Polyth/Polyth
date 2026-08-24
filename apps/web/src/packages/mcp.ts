import { McpPage } from "../components/settings/pages.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { MCP_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installMcpPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "mcp",
      packageId: "mcp",
      label: "MCP",
      group: "Engineering",
      icon: "🔌",
      order: 40,
      component: McpPage,
      settingsItems: [
        {
          id: "mcp.servers",
          pageId: "mcp",
          label: "MCP servers",
          description: "Model Context Protocol server configuration",
          keywords: ["mcp", "tools", "transport", "stdio"],
          focusTarget: "mcp.servers",
        },
      ],
    }),
    registerPackageOnboarding(MCP_TOUR),
  );
}
