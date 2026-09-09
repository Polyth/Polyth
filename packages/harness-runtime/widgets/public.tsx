import { defineWebPackage } from "@polyth/web-sdk";
import base from "./index.tsx";
import McpPage from "./McpPage.tsx";

/** Keep the existing harness UI intact and add the package-owned MCP manager. */
export default defineWebPackage((host) => () => {
  const disposeBase = base(host)();
  const disposeMcp = host.settings.registerPage({
    id: "mcp",
    packageId: "harness-runtime",
    label: "MCP",
    group: "Engineering",
    order: 20,
    component: McpPage,
  });
  return () => {
    disposeMcp();
    disposeBase();
  };
});
