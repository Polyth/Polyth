import { defineWebPackage } from "@polyth/web-sdk";
import base from "./runtime.tsx";
import McpPage from "./McpPage.tsx";

/** Canonical package entry: existing harness UI plus the package-owned MCP manager. */
export default defineWebPackage((host) => () => {
  const disposeBase = base(host)();
  const disposeMcp = host.settings.registerPage({
    id: "mcp",
    packageId: "harness-runtime",
    label: "MCP",
    group: "Engineering",
    icon: "server",
    order: 20,
    component: McpPage,
  });
  return () => {
    disposeMcp();
    disposeBase();
  };
});
