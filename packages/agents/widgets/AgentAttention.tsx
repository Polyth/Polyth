import { useState, type ReactNode } from "react";
import { api, type ScheduleRunDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { Button } from "../../../apps/web/src/components/ui/index.ts";
import { sameNeed } from "../src/agentReport.ts";
import { pauseAgent } from "./agentActions.ts";
import { agentAttention, failureTitle, type AttentionItem } from "./agentFailure.ts";
import { pinnedHarnessOf } from "./agentSignIn.tsx";
import { optimistic } from "./agentsStore.ts";

/** "today", "yesterday", "Tue", or "12 Oct": when something began to wait. */
function sinceLabel(at: number, now = Date.now()): string {
  const locale = getLocale();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / (24 * 60 * 60_000));
  if (days <= 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-Math.max(0, days), "day");
  if (days < 7) return new Date(at).toLocaleDateString(locale, { weekday: "long" });
  return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** A headline as it reads inside a sentence. */
const inSentence = (text: string): string => text.charAt(0).toLocaleLowerCase(getLocale()) + text.slice(1);

const webLink = (url: string | undefined): string | undefined =>
  url && /^https?:\/\/[^\s]+$/i.test(url) ? url : undefined;

/** The harness whose route served (or refused) `run`: a backup's, else the main one's. */
const harnessOfRun = (agent: ScheduleTaskDto, run: ScheduleRunDto): string | undefined =>
  (run.backup ? agent.fallbackModels?.[run.backup - 1]?.harnessId : undefined) ?? pinnedHarnessOf(agent);

/** Settle (or reopen) a request wherever the agent's reports asked it. */
export async function settleNeed(agent: ScheduleTaskDto, runId: string, index: number, done: boolean): Promise<void> {
  const asked = agent.history?.find((run) => run.runId === runId)?.needs?.[index];
  if (!asked) return;
  const at = Date.now();
  const history = (agent.history ?? []).map((run) => !run.needs?.some((need) => sameNeed(need.text, asked.text)) ? run : {
    ...run,
    needs: run.needs.map((need) => {
      if (!sameNeed(need.text, asked.text)) return need;
      const { done: _was, ...open } = need;
      return done ? { ...open, done: { at, by: "user" as const } } : open;
    }),
  });
  await optimistic(agent.id, { history }, () => api.scheduleNeedDone(agent.id, runId, index, done)).catch(() => {});
}

/** What waits for the person, above the agent's conversation: why it no
 *  longer wakes, what stopped its newest run that only they can clear, and
 *  what its reports asked of them. One place, whatever the report it came
 *  from scrolled to; each line names the thing and carries the way to do it.
 *  Nothing waits: nothing is drawn. */
export default function AgentAttention({ host, agent, onOpenSession }: {
  host?: WebPackageHost;
  agent: ScheduleTaskDto;
  onOpenSession?: (sessionId: string) => void;
}) {
  const phone = useShellMode() === "phone";
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState("");
  const items = agentAttention(agent);
  if (!items.length) return null;
  const room = phone ? 2 : 3;
  const shown = all ? items : items.slice(0, room);
  const hidden = items.length - shown.length;

  const row = (item: AttentionItem): { tone?: "stopped"; title: string; detail?: string; meta?: string; actions: ReactNode } => {
    if (item.kind === "stopped") {
      const session = item.last?.sessionId;
      return {
        tone: "stopped",
        title: item.reason === "budget" ? tr("agents.trippedBudget") : tr("agents.attention.stoppedTitleValue", { count: item.count }),
        detail: item.reason === "budget"
          ? `${item.detail ?? ""} ${tr("agents.attention.budgetDetail")}`.trim()
          : `${item.last ? `${tr("agents.attention.lastRunValue", { what: inSentence(failureTitle(item.last)) })} ` : ""}${tr("agents.attention.stoppedDetail")}`,
        actions: item.reason === "budget" ? null : (
          <>
            {session && onOpenSession && (
              <Button size="sm" variant="ghost" onClick={() => onOpenSession(session)}>{tr("agents.openSession")}</Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={busy === item.key}
              onClick={() => {
                setBusy(item.key);
                void pauseAgent(agent, false).finally(() => setBusy(""));
              }}
            >
              {tr("agents.resume")}
            </Button>
          </>
        ),
      };
    }
    if (item.kind === "route") {
      const harnessId = harnessOfRun(agent, item.run);
      return {
        title: tr("agents.attention.routeTitle"),
        detail: item.detail,
        meta: sinceLabel(item.run.finishedAt ?? item.run.startedAt),
        actions: host && harnessId ? (
          <Button size="sm" onClick={() => host.navigation.openSettingsPage("harnesses", { itemId: harnessId })}>
            {tr("agents.signIn.settings")}
          </Button>
        ) : null,
      };
    }
    if (item.kind === "approval") {
      const session = item.run.sessionId;
      return {
        title: tr("agents.attention.approvalTitle"),
        detail: tr("agents.fail.approvalDetail"),
        meta: sinceLabel(item.run.finishedAt ?? item.run.startedAt),
        actions: session && onOpenSession
          ? <Button size="sm" onClick={() => onOpenSession(session)}>{tr("agents.openSession")}</Button>
          : null,
      };
    }
    const { need } = item;
    const url = webLink(need.url);
    return {
      title: need.text,
      ...(need.detail ? { detail: need.detail } : {}),
      meta: sinceLabel(need.since),
      actions: (
        <>
          {url && (
            <a className="ui-btn ui-btn--quiet ui-btn--sm agent-need-open" href={url} target="_blank" rel="noopener noreferrer">
              {/\/pull\/\d+/.test(url) ? tr("agents.openPr") : tr("agents.openLink")}
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="agent-attention-done"
            disabled={busy === item.key}
            onClick={() => {
              setBusy(item.key);
              void settleNeed(agent, need.runId, need.index, true).finally(() => setBusy(""));
            }}
          >
            {tr("agents.need.done")}
          </Button>
        </>
      ),
    };
  };

  return (
    <section className="agent-attention" aria-label={tr("agents.needsYou")}>
      <div className="agent-attention-column">
        <h2 className="agent-attention-label">
          {tr("agents.needsYou")}
          {items.length > 1 && <span className="agent-attention-count">{items.length}</span>}
        </h2>
        <ul className="agent-attention-list">
          {shown.map((item) => {
            const view = row(item);
            return (
              <li key={item.key} className="agent-attention-item" data-kind={item.kind} data-tone={view.tone}>
                <span className="agent-attention-words">
                  <span className="agent-attention-title">{view.title}</span>
                  {view.detail && <span className="agent-attention-detail">{view.detail}</span>}
                </span>
                {view.meta && <span className="agent-attention-since">{view.meta}</span>}
                {view.actions && <span className="agent-attention-actions">{view.actions}</span>}
              </li>
            );
          })}
        </ul>
        {(hidden > 0 || all) && items.length > room && (
          <button type="button" className="agent-attention-more" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? tr("agents.showLess") : tr("agents.attention.moreValue", { count: hidden })}
          </button>
        )}
      </div>
    </section>
  );
}
