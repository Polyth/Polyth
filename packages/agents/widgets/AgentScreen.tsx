import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import {
  Button, CloseIcon, CopyIcon, DeleteIcon, DownloadIcon, Icon, IconButton, Menu, MoreIcon, Notice, PauseIcon,
  PlayIcon, promptAlert, StopIcon, SuccessIcon, Tabs, type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { AgentMark } from "./AgentGlyph.tsx";
import AgentConversation from "./AgentConversation.tsx";
import AgentNotebook from "./AgentNotebook.tsx";
import AgentContextPanel from "./AgentContextPanel.tsx";
import { NavigatorButton } from "./PageBar.tsx";
import { conversationMenuEntries } from "./agentConversationsMenu.ts";
import { agentLive, type AgentLive } from "./agentLive.ts";
import { statusLine } from "./agentText.ts";
import { useNow } from "./agentClock.ts";
import { onAgentPageRequest, putAgent, takeAgentPageRequest, type AgentTab } from "./agentsStore.ts";
import {
  agentName, deleteAgent, duplicateAgent, markAgentRead, openAgent, pauseAgent, runAgent, stopAgent,
} from "./agentActions.ts";

/** The status line's colour: only states that ask something of the person
 *  or are happening now are coloured. */
function statusTone(phase: ReturnType<typeof agentLive>["phase"]): string | undefined {
  if (phase === "needs-you" || phase === "review") return "attention";
  if (phase === "stopped") return "danger";
  if (phase === "working") return "working";
  return undefined;
}

/** The status line's words. A working agent's clock moves each second with
 *  its row's; the live region hears that it works, not every second. */
function StatusText({ agent, live }: { agent: ScheduleTaskDto; live: AgentLive }) {
  const now = useNow(live.phase === "working");
  const text = statusLine(agent, live, now || Date.now(), live.phase === "stopped" && !!agent.tripped);
  if (live.phase !== "working") return <span>{text}</span>;
  return (
    <>
      <span className="sr-only">{tr("agents.workingNow")}</span>
      <span aria-hidden="true">{text}</span>
    </>
  );
}

/** An agent's own screen, in place of Chat: who it is and what it is doing,
 *  then its conversation — its reports and your messages — or what it
 *  remembers, or its settings. */
export default function AgentScreen({
  host,
  agent,
  error,
  onDismissError,
  onReview,
  onExport,
  onConvert,
  settings,
  settingsDirty,
}: {
  host?: WebPackageHost;
  agent: ScheduleTaskDto;
  error: string;
  onDismissError: () => void;
  onReview: (action: "trust-current" | "run-once" | "reject") => void;
  onExport?: () => void;
  onConvert?: () => void;
  settings: ReactNode;
  settingsDirty: boolean;
}) {
  const phone = useShellMode() === "phone";
  const [tab, setTab] = useState<AgentTab>(() => takeAgentPageRequest(agent.id)?.tab ?? "conversation");
  const [busy, setBusy] = useState(false);
  const live = agentLive(agent);
  const name = agentName(agent);
  const repository = agent.source === "loop-file";
  const running = live.running !== undefined;
  const paused = !agent.enabled;

  // Another agent opens on its conversation (or the tab asked for); a request
  // for this agent's tab (Settings from its row's menu) switches to it.
  const shown = useRef(agent.id);
  useEffect(() => {
    if (shown.current !== agent.id) {
      shown.current = agent.id;
      setTab(takeAgentPageRequest(agent.id)?.tab ?? "conversation");
    }
    return onAgentPageRequest(() => {
      const request = takeAgentPageRequest(agent.id);
      if (request?.tab) setTab(request.tab);
    });
  }, [agent.id]);

  const guard = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };
  const runWithNote = async () => {
    const note = await promptAlert(tr("agents.runWithNoteMessage"), {
      title: tr("agents.runWithNote"),
      confirmLabel: tr("scheduleview.runNow"),
      placeholder: tr("agents.runWithNotePlaceholder"),
    });
    if (note !== null) await guard(() => runAgent(agent, note.trim() || undefined));
  };

  const menu: MenuEntry[] = [
    ...(live.phase !== "review" && !running ? [{ id: "run-note", label: tr("agents.runWithNote"), icon: PlayIcon, onSelect: () => void runWithNote() } satisfies MenuEntry] : []),
    ...(paused && live.phase !== "review" && !running ? [{ id: "run", label: tr("scheduleview.runNow"), icon: PlayIcon, onSelect: () => void guard(() => runAgent(agent)) } satisfies MenuEntry] : []),
    ...(live.phase !== "review" && live.phase !== "draft" && !paused
      ? [{ id: "pause", label: tr("agents.pauseWakes"), icon: PauseIcon, onSelect: () => void pauseAgent(agent, true) } satisfies MenuEntry]
      : []),
    ...(live.unread > 0 ? [{ id: "read", label: tr("agents.markRead"), icon: SuccessIcon, onSelect: () => void markAgentRead(agent) } satisfies MenuEntry] : []),
    ...(host ? conversationMenuEntries(host, agent) : []),
    ...(onExport ? [{ id: "export", label: tr("agents.exportToRepo"), icon: DownloadIcon, onSelect: onExport } satisfies MenuEntry] : []),
    ...(onConvert ? [{ id: "convert", label: tr("agents.convertLoop"), onSelect: onConvert } satisfies MenuEntry] : []),
    ...(!repository ? [
      {
        id: "duplicate",
        label: tr("scheduleview.duplicate"),
        icon: CopyIcon,
        onSelect: () => void duplicateAgent(agent).then((copy) => { if (copy && host) openAgent(host, copy, "settings"); }),
      } satisfies MenuEntry,
      "separator" as const,
      { id: "delete", label: tr("agents.deleteAgent"), icon: DeleteIcon, danger: true, onSelect: () => void deleteAgent(agent) } satisfies MenuEntry,
    ] : []),
  ];
  // One action leads, whatever the state; everything else waits in the menu.
  const primary = live.phase === "review" ? null
    : live.phase === "draft" ? (
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void guard(() => pauseAgent(agent, false))}>
        {tr("scheduleview.activate")}
      </Button>
    ) : running ? (
      phone
        ? <IconButton icon={StopIcon} size="lg" className="agent-stop" label={tr("agents.stop")} disabled={busy} onClick={() => void guard(() => stopAgent(agent))} />
        : <Button size="sm" iconStart={StopIcon} className="agent-stop" disabled={busy} onClick={() => void guard(() => stopAgent(agent))}>{tr("agents.stop")}</Button>
    ) : paused ? (
      phone
        ? <IconButton icon={PlayIcon} size="lg" label={tr("agents.resume")} disabled={busy} onClick={() => void pauseAgent(agent, false)} />
        : <Button size="sm" iconStart={PlayIcon} disabled={busy} onClick={() => void pauseAgent(agent, false)}>{tr("agents.resume")}</Button>
    ) : (
      phone
        ? <IconButton icon={PlayIcon} size="lg" label={tr("scheduleview.runNow")} disabled={busy} onClick={() => void guard(() => runAgent(agent))} />
        : <Button size="sm" iconStart={PlayIcon} disabled={busy} onClick={() => void guard(() => runAgent(agent))}>{tr("scheduleview.runNow")}</Button>
    );
  const tone = statusTone(live.phase);

  return (
    <div className="agent-screen" data-phase={live.phase} aria-busy={busy || undefined}>
      <header className="agent-head">
        <div className="agent-head-inner">
          <NavigatorButton />
          <span className="agent-head-glyph" aria-hidden="true">
            <AgentMark icon={agent.icon} color={agent.color} working={running} />
          </span>
          <div className="agent-head-titles">
            <h1 className="agent-head-name" title={agent.description || name}>{name}</h1>
            <p className="agent-head-status" data-tone={tone} role="status">
              {tone && <i aria-hidden="true" />}
              <StatusText agent={agent} live={live} />
              {repository && <span className="agent-head-tag">{tr("agents.repository")}</span>}
            </p>
          </div>
          <div className="agent-head-actions">
            {primary}
            {menu.length > 0 && (
              <Menu label={tr("agents.agentActions")} align="end" entries={menu}>
                {(trigger) => <IconButton icon={MoreIcon} size={phone ? "lg" : "sm"} label={tr("agents.agentActions")} {...trigger} />}
              </Menu>
            )}
          </div>
        </div>
        <div className="agent-head-tabs">
          <Tabs
            size="sm"
            idBase={`agent-${agent.id}`}
            label={tr("agents.agentSections")}
            value={tab}
            onChange={(id) => setTab(id as AgentTab)}
            tabs={[
              { id: "conversation", label: tr("agents.conversation") },
              { id: "memory", label: tr("agents.memory") },
              {
                id: "settings",
                label: settingsDirty
                  ? <span className="agent-tab-dirty">{tr("agents.settings")}<i aria-label={tr("agents.unsavedChanges")} /></span>
                  : tr("agents.settings"),
              },
            ]}
          />
        </div>
      </header>

      {error && (
        <div className="agent-notices">
          <Notice
            tone="error"
            actions={<IconButton icon={CloseIcon} size="sm" label={tr("common.close")} onClick={onDismissError} />}
          >
            {error}
          </Notice>
        </div>
      )}

      {tab === "conversation" && (
        <AgentConversation
          host={host}
          agent={agent}
          live={live}
          onReview={onReview}
          onRun={(message) => runAgent(agent, message.text || undefined, {
            ...(message.continuation !== "auto" ? { continuation: message.continuation } : {}),
            ...(message.attachments.length ? { attachments: message.attachments } : {}),
          })}
          onStop={async () => { await stopAgent(agent); }}
        />
      )}
      {tab === "memory" && (
        <div className="agents-scroll" role="tabpanel">
          <div className="agents-column">
            <AgentNotebook
              task={agent}
              onSave={async (text) => { putAgent(await api.scheduleUpdate(agent.id, { notebook: text })); }}
            />
            <section className="agents-section agent-memory-context" aria-labelledby={`context-${agent.id}`}>
              <h2 className="agents-section-title" id={`context-${agent.id}`}>{tr("agents.sectionUsage")}</h2>
              <AgentContextPanel task={agent} {...(host ? { host } : {})} />
            </section>
          </div>
        </div>
      )}
      {tab === "settings" && (
        <div className="agents-scroll" role="tabpanel">
          <div className="agents-column agent-settings">{settings}</div>
        </div>
      )}
    </div>
  );
}
