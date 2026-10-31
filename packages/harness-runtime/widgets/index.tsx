import type { HarnessSelection, HarnessSnapshot, HarnessTransition } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import base from "./runtime.tsx";
import HarnessAccounts from "./HarnessAccounts.tsx";
import HarnessAuthRecovery from "./HarnessAuthRecovery.tsx";
import HarnessMaintenance from "./HarnessMaintenance.tsx";
import HarnessPlugins from "./HarnessPlugins.tsx";
import HarnessSkills from "./HarnessSkills.tsx";
import HarnessSystemPrompt from "./HarnessSystemPrompt.tsx";
import McpPage from "./McpPage.tsx";

/** Canonical package entry: existing harness UI plus package-owned recovery and MCP surfaces. */
export default defineWebPackage((host) => () => {
  const t = (key: string) => host.ui.locale.translate(`harnessruntime.shell.${key}`);
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
    meta: { harnessId: "*", sectionId: "system-prompt", label: host.ui.locale.translate("harnessruntime.systemPrompt.title") },
    render: (context) => context.sectionId === "system-prompt" && typeof context.harnessId === "string"
      ? <HarnessSystemPrompt host={host} harnessId={context.harnessId} />
      : null,
  });
  // One Accounts section for every multi-account harness family; it appears
  // only on harnesses whose identity names an account list.
  const disposeAccounts = host.slots.register({
    id: "harnesses.accounts",
    slot: "settings.harness.detail",
    order: 3,
    meta: { harnessId: "*", sectionId: "accounts", label: t("accounts"), requires: "accounts" },
    render: (context) => {
      const accounts = (context.snapshot as HarnessSnapshot | undefined)?.identity.accounts;
      return context.sectionId === "accounts" && accounts
        ? <HarnessAccounts key={accounts.endpoint} host={host} accounts={accounts} projectId={context.projectId as string | null | undefined} />
        : null;
    },
  });
  const disposeMaintenance = host.slots.register({
    id: "harnesses.maintenance",
    slot: "settings.harness.detail",
    order: 4,
    meta: { harnessId: "*", sectionId: "runtime", label: t("runtime") },
    render: (context) => context.sectionId === "runtime" && typeof context.harnessId === "string"
      ? <HarnessMaintenance host={host} harnessId={context.harnessId} snapshot={context.snapshot as HarnessSnapshot | undefined} projectId={context.projectId as string | null | undefined} canManage={context.canManage !== false} />
      : null,
  });
  // The harness's own plugin system, on harnesses whose provider can list it.
  const disposePlugins = host.slots.register({
    id: "harnesses.plugins",
    slot: "settings.harness.detail",
    order: 45,
    meta: { harnessId: "*", sectionId: "plugins", label: t("plugins"), requires: "native-plugins" },
    render: (context) => {
      const snapshot = context.snapshot as HarnessSnapshot | undefined;
      return context.sectionId === "plugins" && typeof context.harnessId === "string" && snapshot?.identity.nativePlugins
        ? <HarnessPlugins key={`${context.harnessId}:${String(context.projectId ?? "")}`} host={host} harnessId={context.harnessId} snapshot={snapshot} projectId={context.projectId as string | null | undefined} />
        : null;
    },
  });
  // The harness's own skills, inherited or muted per Space.
  const disposeSkills = host.slots.register({
    id: "harnesses.skills",
    slot: "settings.harness.detail",
    order: 40,
    meta: { harnessId: "*", sectionId: "skills", label: t("skills"), requires: "native-skills" },
    render: (context) => {
      const snapshot = context.snapshot as HarnessSnapshot | undefined;
      return context.sectionId === "skills" && typeof context.harnessId === "string" && snapshot?.identity.nativeSkills
        ? <HarnessSkills key={`${context.harnessId}:${String(context.projectId ?? "")}`} host={host} harnessId={context.harnessId} snapshot={snapshot} projectId={context.projectId as string | null | undefined} />
        : null;
    },
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
  const disposeMcpItems = host.settings.registerItems([
    {
      id: "mcp.servers",
      pageId: "mcp",
      label: t("mcp.servers"),
      description: t("mcp.serversDescription"),
      keywords: ["mcp", "servers", "install", "stdio", "http"],
      focusTarget: "mcp.servers",
    },
    {
      id: "mcp.install",
      pageId: "mcp",
      label: t("mcp.install"),
      description: t("mcp.installDescription"),
      keywords: ["mcp", "install", "url", "command", "npx"],
      focusTarget: "mcp.install",
    },
    {
      id: "mcp.import",
      pageId: "mcp",
      label: t("mcp.import"),
      description: t("mcp.importDescription"),
      keywords: ["mcp", "import", "json", "mcpServers", "mcp_servers"],
      focusTarget: "mcp.import",
    },
    {
      id: "mcp.tools",
      pageId: "mcp",
      label: t("mcp.tools"),
      description: t("mcp.toolsDescription"),
      keywords: ["mcp", "tools", "schema", "inventory", "probe"],
      focusTarget: "mcp.tools",
    },
    {
      id: "mcp.check",
      pageId: "mcp",
      label: t("mcp.check"),
      description: t("mcp.checkDescription"),
      keywords: ["mcp", "check", "probe", "tools", "list"],
      focusTarget: "mcp.check",
    },
  ]);
  const disposeHarnessItems = host.settings.registerItems([
    {
      id: "harnesses.person-default",
      pageId: "harnesses",
      label: host.ui.locale.translate("harnessruntime.personDefault.label"),
      description: t("personDefaultDescription"),
      keywords: ["default", "harness", "assistant", "my", "personal", "new chat"],
      focusTarget: "harnesses.person-default",
    },
  ]);
  return () => {
    disposeHarnessItems();
    disposeMcpItems();
    disposeMcp();
    disposeSystemPrompt();
    disposeAccounts();
    disposeMaintenance();
    disposePlugins();
    disposeSkills();
    disposeRecovery();
    disposeBase();
  };
});
