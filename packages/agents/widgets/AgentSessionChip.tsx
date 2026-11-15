// An agent's own session opened in Chat leads its header with the way back to
// the agent's page: the host's Back control, with the agent's mark and name.
import { useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { SessionBackButton, type SessionBackPresentation } from "../../../apps/web/src/components/ui/index.ts";
import { AGENT_SESSION_PURPOSE } from "../src/agentSession.ts";
import { AgentMark } from "./AgentGlyph.tsx";
import { agentSessionIds } from "./agentLive.ts";
import { agentName, openAgent } from "./agentActions.ts";
import { useAgents } from "./agentsStore.ts";

function BackToAgent({ host, sessionId, presentation }: {
  host: WebPackageHost;
  sessionId: string;
  presentation: SessionBackPresentation;
}) {
  const { agents } = useAgents();
  const agent = agents?.find((candidate) => agentSessionIds(candidate).has(sessionId));
  if (!agent) return null;
  const working = agent.history?.some((run) => run.status === "running" && run.sessionId === sessionId) ?? false;
  return (
    <SessionBackButton
      presentation={presentation}
      className="agent-chip"
      label={agentName(agent)}
      mark={<AgentMark icon={agent.icon} color={agent.color} working={working} size="sm" />}
      onBack={() => { openAgent(host, agent); }}
    />
  );
}

/** Mounted for every open chat; only an agent's own session reads the agents
 *  list (and so starts its polling). */
export default function AgentSessionChip({ host, sessionId, presentation = "bar" }: {
  host: WebPackageHost;
  sessionId: string;
  presentation?: SessionBackPresentation;
}) {
  const purpose = useSyncExternalStore(
    host.sessions.subscribe,
    () => host.sessions.get(sessionId)?.purpose,
    () => undefined,
  );
  if (purpose !== AGENT_SESSION_PURPOSE) return null;
  return <BackToAgent host={host} sessionId={sessionId} presentation={presentation} />;
}
