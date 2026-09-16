import type { HarnessTransition } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import base from "./runtime.tsx";
import HarnessAuthRecovery from "./HarnessAuthRecovery.tsx";
import McpPage from "./McpPage.tsx";

/** Canonical package entry: existing harness UI plus package-owned recovery and MCP surfaces. */
export default defineWebPackage((host) => () => {
  const disposeBase = base(host)();
  const disposeRecovery = host.slots.register({
    id: "harnesses.transition",
    slot: "composer.execution",
    order: 10,
    render: (props) => <HarnessAuthRecovery
      host={host}
      projectId={props.projectId as string | undefined}
      spaceId={props.spaceId as string | undefined}
      sessionId={props.sessionId as string | undefined}
      resolvedHarnessId={props.resolvedHarnessId as string | undefined}
      transition={props.harnessTransition as HarnessTransition | undefined}
    />,
  });
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
    disposeRecovery();
    disposeBase();
  };
});
