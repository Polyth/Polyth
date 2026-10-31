// "Conversations": the agent's own sessions, reached from its menus. They stay
// out of the project's session list (the package claims their purpose), so
// this is where a person opens one when they need the whole session.
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { SessionIcon, type MenuEntry } from "../../../apps/web/src/components/ui/index.ts";
import { agentConversations, type AgentConversationRef } from "./agentThreads.ts";

const startOfDay = (at: number): number => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** "14:17" today, else "25 Oct, 14:17"; a range names its day once. */
export function conversationWhen(conversation: Pick<AgentConversationRef, "startedAt" | "lastAt">, now = Date.now()): string {
  const locale = getLocale();
  const time = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const moment = (at: number) => at >= startOfDay(now)
    ? time(at)
    : `${new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${time(at)}`;
  const { startedAt, lastAt } = conversation;
  if (time(startedAt) === time(lastAt) && startOfDay(startedAt) === startOfDay(lastAt)) return moment(startedAt);
  const sameDay = startOfDay(startedAt) === startOfDay(lastAt);
  return `${moment(startedAt)} – ${sameDay ? time(lastAt) : moment(lastAt)}`;
}

/** Menu rows do not wrap: a long topic would widen the whole menu. */
const clipped = (text: string, limit = 56): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/** A drill-in menu row listing the agent's conversations, newest first;
 *  nothing when it has none yet. */
export function conversationMenuEntries(
  host: WebPackageHost,
  agent: Pick<ScheduleTaskDto, "history">,
  onNavigate?: () => void,
): MenuEntry[] {
  const conversations = agentConversations(agent);
  if (!conversations.length) return [];
  const now = Date.now();
  return [{
    id: "conversations",
    label: tr("agents.conversations"),
    icon: SessionIcon,
    value: conversations.length.toLocaleString(getLocale()),
    entries: conversations.map((conversation) => {
      const when = conversationWhen(conversation, now);
      return {
        id: `conversation-${conversation.sessionId}`,
        // What it was about reads first; when it happened, under it.
        label: conversation.topic ? clipped(conversation.topic) : when,
        detail: [
          conversation.topic ? when : "",
          tr("agents.runsCountValue", { count: conversation.runs }),
          conversation.live ? tr("agents.workingNow") : "",
        ].filter(Boolean).join(" · "),
        onSelect: () => {
          void host.conversation.openSession(conversation.sessionId);
          onNavigate?.();
        },
      };
    }),
    onSelect: () => {},
  }];
}
