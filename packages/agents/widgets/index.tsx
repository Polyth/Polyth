import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import AgentsPage from "./AgentsPage.tsx";
import AgentNavSection, { type AgentNavContext } from "./AgentNavSection.tsx";
import MakeAgentAction from "./MakeAgentAction.tsx";
import AgentSessionChip from "./AgentSessionChip.tsx";
import { bindAgentsHost } from "./agentsStore.ts";
import { AGENTS_PAGE_ID, openAgentsHome } from "./agentActions.ts";
import { AGENT_SESSION_PURPOSE } from "../src/agentSession.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export default defineWebPackage((host) => () => {
  const off = [
    // An agent opens in place of Chat, like a chat does: its own screen,
    // reached from its row in the navigator.
    ...(host.pages ? [host.pages.register({
      id: AGENTS_PAGE_ID,
      title: tr("agents.navSection"),
      component: ({ resource }) => createElement(AgentsPage, { host, resource }),
    })] : []),
    host.capabilities.register({
      id: "schedule",
      label: tr("agents.navSection"),
      plainDescription: tr("agents.capability.description"),
      keywords: ["agents", "agent", "schedule", "planner", "planned", "recurring", "automation", "heartbeat", "proactive"],
      standardTier: "more",
      standardRank: 14,
      defaultRails: { general: "right", operations: "top", home: "top", wellbeing: "top", finance: "top", personal: "right" },
      open: () => { openAgentsHome(host); },
      available: () => typeof host.navigation.openPage === "function",
    }),
    host.widgets.registerPlugin({
      id: "schedule",
      name: tr("agents.navSection"),
      widgets: [{
        id: "schedule.main",
        title: tr("agents.navSection"),
        description: tr("agents.capability.description"),
        defaultSlot: "workspace.main",
        supportedSlots: ["workspace.main", "workspace.bottom"],
        defaultSize: { w: 12, h: 6 },
        render: () => <AgentsPage host={host} resource={null} />,
      }],
    }),
    // Agents live among a project's sessions, above its pinned chats.
    host.slots.register({
      slot: "sidebar.project.leading",
      id: "schedule.agents",
      order: 10,
      render: (context) => createElement(AgentNavSection, { host, context: context as AgentNavContext }),
    }),
    // An agent's own session, opened in Chat, names its agent in the header.
    host.slots.register({
      slot: "session.header.status",
      id: "schedule.agent-session",
      order: 15,
      render: ({ sessionId }) => typeof sessionId === "string"
        ? createElement(AgentSessionChip, { key: sessionId, host, sessionId })
        : null,
    }),
    host.slots.register({
      slot: "sidebar.session.actions",
      id: "schedule.make-agent",
      order: 40,
      render: ({ sessionId, closeMenu }) => typeof sessionId === "string"
        ? createElement(MakeAgentAction, {
          key: sessionId,
          host,
          sessionId,
          closeMenu: typeof closeMenu === "function" ? closeMenu as () => void : undefined,
        })
        : null,
    }),
    // An agent's own sessions are read from its page, not the session list.
    ...(host.sessions.claimListing ? [host.sessions.claimListing(AGENT_SESSION_PURPOSE)] : []),
    bindAgentsHost(host),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
