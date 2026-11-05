// A checkbox on the permission card of an agent's own session: the policy
// decision made there also becomes the agent's level, the one its settings show
// and every next session starts with (`applyPermissions`). The agent's level is
// only ever raised here; its settings are where it comes back down.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import { api } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { setUiError } from "../../../apps/web/src/store.ts";
import { Checkbox } from "../../../apps/web/src/components/ui/index.ts";
import { AGENT_SESSION_PURPOSE } from "../src/agentSession.ts";
import { agentName } from "./agentActions.ts";
import { agentLevelAtLeast } from "./agentModel.ts";
import { agentSessionIds, isScheduledMessage } from "./agentLive.ts";
import { agentsSnapshot, optimistic, useAgents } from "./agentsStore.ts";

export type PolicyLevel = "routine" | "all";

/** The card's `PermissionPolicyEffect`, as the slot context hands it over. */
export interface PolicyEffect {
  confirmNote?: string;
  apply(level: PolicyLevel): void;
}

/** A repository file never decides how much its agent may do unasked, and an
 *  agent acting for nobody fails its run when its level asks to approve. */
const mayKeepLevel = (agent: ScheduleTaskDto): boolean =>
  agent.source !== "loop-file" && Boolean(agent.ownerUserId) && !isScheduledMessage(agent);

function save(agent: ScheduleTaskDto, level: PolicyLevel): void {
  const name = agentName(agent);
  void optimistic(agent.id, { permissions: level }, () => api.scheduleUpdate(agent.id, { permissions: level })).then(() => {
    setUiError(tr("agents.futureApprovalSavedValue", { name, level: tr(`agents.permission.${level}`) }), null, undefined, "info");
  }).catch((reason: unknown) => {
    setUiError(friendlyError(tr("agents.futureApprovalFailedValue", { name }), reason));
  });
}

function Option({ sessionId, level, addPolicyEffect }: {
  sessionId: string;
  level: PolicyLevel;
  addPolicyEffect: (effect: PolicyEffect) => () => void;
}) {
  const { agents } = useAgents();
  const agent = agents?.find((candidate) => agentSessionIds(candidate).has(sessionId));
  const [checked, setChecked] = useState(false);
  const offered = agent !== undefined && mayKeepLevel(agent) && !agentLevelAtLeast(agent.permissions, level);
  const agentId = agent?.id;
  useEffect(() => {
    if (!checked || !offered || !agentId) return;
    return addPolicyEffect({
      confirmNote: tr("agents.futureApprovalConfirm"),
      apply: (decided) => {
        const current = agentsSnapshot().agents?.find((candidate) => candidate.id === agentId);
        if (current) save(current, decided);
      },
    });
  }, [checked, offered, agentId, addPolicyEffect]);
  if (!offered) return null;
  return (
    <div className="agent-future-approval" title={tr("agents.futureApprovalTitle")}>
      <Checkbox checked={checked} onChange={setChecked} label={tr("agents.futureApproval")} />
    </div>
  );
}

/** Mounted on every permission card; only an agent's own session reads the
 *  agents list (and so starts its polling). */
export default function AgentFutureApproval({ host, sessionId, level, addPolicyEffect }: {
  host: WebPackageHost;
  sessionId: string;
  level: PolicyLevel;
  addPolicyEffect: (effect: PolicyEffect) => () => void;
}) {
  const purpose = useSyncExternalStore(
    host.sessions.subscribe,
    () => host.sessions.get(sessionId)?.purpose,
    () => undefined,
  );
  // On the agent's page the list is already read, whatever the session list holds.
  const known = agentsSnapshot().agents?.some((candidate) => agentSessionIds(candidate).has(sessionId)) ?? false;
  if (purpose !== AGENT_SESSION_PURPOSE && !known) return null;
  return <Option sessionId={sessionId} level={level} addPolicyEffect={addPolicyEffect} />;
}
