import { useMemo, useState } from "react";
import type { Project } from "@polyth/contracts";
import { api, type ScheduleLoopErrorDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  BotIcon, Button, CloseIcon, Icon, IconButton, Notice, PlusIcon, ShieldAlertIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { AGENT_ICONS, AgentMark } from "./AgentGlyph.tsx";
import type { AgentIconId } from "../src/agentPrompt.ts";
import { TemplateGrid } from "./AgentTemplates.tsx";
import { agentLive, isScheduledMessage, type AgentLive } from "./agentLive.ts";
import { statusLine } from "./agentText.ts";
import { useNow } from "./agentClock.ts";
import { refreshAgents } from "./agentsStore.ts";
import { agentName, openAgent, openNewAgent } from "./agentActions.ts";
import type { AgentTemplate } from "./agentModel.ts";

const glyphOf = (agent: ScheduleTaskDto) => AGENT_ICONS[agent.icon as AgentIconId] ?? BotIcon;

function Row({ host, agent, live }: { host?: WebPackageHost; agent: ScheduleTaskDto; live: AgentLive }) {
  const now = useNow(live.phase === "working");
  const report = live.lastReport;
  const line = report ? (report.headline ?? report.error ?? report.summary?.split("\n")[0]) : agent.description;
  return (
    <li className="agents-home-row" data-phase={live.phase} data-unread={live.unread > 0 || undefined}>
      <button type="button" className="agents-home-row-main" onClick={() => host && openAgent(host, agent)}>
        <span className="agents-home-glyph" data-color={agent.color ?? "neutral"} aria-hidden="true">
          {live.phase === "working"
            ? <AgentMark icon={agent.icon} color={agent.color} working size="sm" />
            : <Icon icon={glyphOf(agent)} size="md" />}
        </span>
        <span className="agents-home-copy">
          <span className="agents-home-name">{agentName(agent)}</span>
          {line && <span className="agents-home-line">{line}</span>}
        </span>
        <span className="agents-home-state" data-phase={live.phase}>{statusLine(agent, live, now || Date.now())}</span>
      </button>
    </li>
  );
}

/** Waiting requests across every agent, answered where they are. */
function Waiting({ host, agent, live }: { host?: WebPackageHost; agent: ScheduleTaskDto; live: AgentLive }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      {live.waiting.map(({ run, request }) => (
        <li key={request.requestId} className="agents-home-request">
          <span className="agents-home-request-icon" aria-hidden="true"><Icon icon={ShieldAlertIcon} size="sm" /></span>
          <span className="agents-home-copy">
            <span className="agents-home-name">{agentName(agent)}</span>
            {request.kind === "permission"
              ? <code className="agents-home-command">{request.title}</code>
              : <span className="agents-home-line">{request.title}</span>}
          </span>
          <span className="agents-home-request-actions">
            {request.kind === "permission" && run.sessionId ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                  setBusy(true);
                  void api.replyPermission(run.sessionId!, request.requestId, "reject").finally(() => { setBusy(false); void refreshAgents(); });
                }}>{tr("agents.deny")}</Button>
                <Button size="sm" disabled={busy} onClick={() => {
                  setBusy(true);
                  void api.replyPermission(run.sessionId!, request.requestId, "once").finally(() => { setBusy(false); void refreshAgents(); });
                }}>{tr("agents.allowOnce")}</Button>
              </>
            ) : (
              <Button size="sm" onClick={() => host && openAgent(host, agent)}>{tr("agents.openAgent")}</Button>
            )}
          </span>
        </li>
      ))}
    </>
  );
}

/** The agents' home: what waits for the person, then every agent by
 *  project. Agents themselves open from the navigator or from here. */
export default function AgentsHome({ host, agents, projects, loopErrors, loadError, onTemplate }: {
  host?: WebPackageHost;
  agents: readonly ScheduleTaskDto[];
  projects: readonly Project[];
  loopErrors: readonly ScheduleLoopErrorDto[];
  loadError: string;
  onTemplate: (template: AgentTemplate) => void;
}) {
  const standing = useMemo(() => agents
    .filter((agent) => !isScheduledMessage(agent))
    .map((agent) => ({ agent, live: agentLive(agent) })), [agents]);
  const waiting = standing.filter(({ live }) => live.waiting.length > 0);
  const byProject = projects
    .map((project) => ({ project, rows: standing.filter(({ agent }) => agent.projectId === project.id) }))
    .filter(({ rows }) => rows.length > 0);
  const dismissLoopError = async (path: string) => {
    for (const project of projects) {
      try {
        if ((await api.scheduleLoopErrorDismiss(project.id, path)).ok) break;
      } catch { /* try the next project */ }
    }
    void refreshAgents();
  };

  return (
    <div className="agents-scroll">
      <div className="agents-column agents-home">
        {loadError && <Notice tone="error">{tr("agents.couldNotLoadValue", { value: loadError })}</Notice>}
        {loopErrors.map((item) => (
          <Notice
            key={item.path}
            tone="warning"
            actions={<IconButton icon={CloseIcon} size="sm" label={tr("scheduleview.dismissLoopErrorForValue", { path: item.path })} onClick={() => void dismissLoopError(item.path)} />}
          >
            {item.error}
          </Notice>
        ))}
        {standing.length === 0 ? (
          <section className="agents-welcome">
            <h2 className="agents-welcome-title">{tr("agents.emptyTitle")}</h2>
            <p className="agents-welcome-body">{tr("agents.emptyBody")}</p>
            <div className="agents-welcome-actions">
              <Button variant="primary" iconStart={PlusIcon} onClick={() => host && openNewAgent(host)}>{tr("agents.newAgent")}</Button>
            </div>
            <h3 className="agents-section-title">{tr("agents.startFromTemplate")}</h3>
            <TemplateGrid onTemplate={onTemplate} />
          </section>
        ) : (
          <>
            {waiting.length > 0 && (
              <section className="agents-section" aria-labelledby="agents-home-waiting">
                <h2 className="agents-section-title" id="agents-home-waiting">
                  {tr("agents.needsYou")}
                  <span>{waiting.reduce((sum, { live }) => sum + live.waiting.length, 0).toLocaleString(getLocale())}</span>
                </h2>
                <ul className="agents-home-list">
                  {waiting.map(({ agent, live }) => <Waiting key={agent.id} host={host} agent={agent} live={live} />)}
                </ul>
              </section>
            )}
            {byProject.map(({ project, rows }) => (
              <section className="agents-section" key={project.id} aria-label={project.name || project.path}>
                <h2 className="agents-section-title">{project.name || project.path}</h2>
                <ul className="agents-home-list">
                  {rows.map(({ agent, live }) => <Row key={agent.id} host={host} agent={agent} live={live} />)}
                </ul>
              </section>
            ))}
            <div className="agents-home-foot">
              <Button iconStart={PlusIcon} onClick={() => host && openNewAgent(host)}>{tr("agents.newAgent")}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
