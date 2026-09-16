import type { HarnessSelection, HarnessTransition } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import base from "./runtime.tsx";
import HarnessAuthRecovery from "./HarnessAuthRecovery.tsx";
import HarnessSystemPrompt from "./HarnessSystemPrompt.tsx";
import McpPage from "./McpPage.tsx";

/** Canonical package entry: existing harness UI plus package-owned recovery and MCP surfaces. */
export default defineWebPackage((host) => () => {
  const disposeBase = base(host)();
  const disposeRecovery = host.slots.register({
    id: "harnesses.transition",
    // Recovery is a conversation-level notice, not a composer control: it
    // renders above the composer next to RuntimeEpochBanner, never inside the
    // execution rail.
    slot: "session.composer.before",
    order: 10,
    render: (props) => <HarnessAuthRecovery
      host={host}
      projectId={props.projectId as string | undefined}
      spaceId={props.spaceId as string | undefined}
      sessionId={props.sessionId as string | undefined}
      resolvedHarnessId={props.resolvedHarnessId as string | undefined}
      pendingHarnessSelection={props.pendingHarnessSelection as HarnessSelection | undefined}
      transition={props.harnessTransition as HarnessTransition | undefined}
    />,
  });
  const disposeSystemPrompt = host.slots.register({
    id: "harnesses.system-prompt",
    slot: "settings.harness.detail",
    order: 5,
    meta: { harnessId: "*", sectionId: "system-prompt", label: "System prompt" },
    render: (context) => context.sectionId === "system-prompt" && typeof context.harnessId === "string"
      ? <HarnessSystemPrompt harnessId={context.harnessId} />
      : null,
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
    disposeSystemPrompt();
    disposeRecovery();
    disposeBase();
  };
});
