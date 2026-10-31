// An agent's own session opened in Chat names its agent in the session
// header: whose conversation this is, and the way back to the agent's page.
import { useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { ChevronRightIcon, Icon } from "../../../apps/web/src/components/ui/index.ts";
import { AGENT_SESSION_PURPOSE } from "../src/agentSession.ts";
import { AgentMark } from "./AgentGlyph.tsx";
import { agentSessionIds } from "./agentLive.ts";
import { agentName, openAgent } from "./agentActions.ts";
import { useAgents } from "./agentsStore.ts";

function OwnerChip({ host, sessionId }: { host: WebPackageHost; sessionId: string }) {
  const { agents } = useAgents();
  const agent = agents?.find((candidate) => agentSessionIds(candidate).has(sessionId));
  if (!agent) return null;
  const name = agentName(agent);
  const working = agent.history?.some((run) => run.status === "running" && run.sessionId === sessionId) ?? false;
  const label = tr("agents.sessionOfValue", { name });
  return (
    <button
      type="button"
      className="agent-chip"
      data-color={agent.color ?? "neutral"}
      aria-label={`${label}. ${tr("agents.backToAgent")}`}
      title={`${label} · ${tr("agents.backToAgent")}`}
      onClick={() => { openAgent(host, agent); }}
    >
      <AgentMark icon={agent.icon} color={agent.color} working={working} size="sm" />
      <span className="agent-chip-name" dir="auto">{name}</span>
      <Icon icon={ChevronRightIcon} size="sm" className="agent-chip-chevron" />
    </button>
  );
}

/** Mounted for every open chat; only an agent's own session reads the agents
 *  list (and so starts its polling). */
export default function AgentSessionChip({ host, sessionId }: { host: WebPackageHost; sessionId: string }) {
  const purpose = useSyncExternalStore(
    host.sessions.subscribe,
    () => host.sessions.get(sessionId)?.purpose,
    () => undefined,
  );
  if (purpose !== AGENT_SESSION_PURPOSE) return null;
  return <OwnerChip host={host} sessionId={sessionId} />;
}
