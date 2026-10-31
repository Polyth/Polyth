import { createElement } from "react";
import { McpPage } from "../components/settings/pages.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { MCP_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister } from "./settingsPage.ts";
import { registerSlot } from "../slots.ts";

export function installMcpPackage(): () => void {
  return combineUnregister(
    registerSlot(
      "settings.harness.detail",
      "opencode.mcp",
      (context) => context.harnessId === "opencode" && context.sectionId === "mcp"
        ? createElement(McpPage, { embedded: true })
        : null,
      50,
      { harnessId: "opencode", sectionId: "mcp", label: "MCP" },
      "mcp",
    ),
    registerPackageOnboarding(MCP_TOUR),
  );
}
