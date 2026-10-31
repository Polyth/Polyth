import type { ReactNode } from "react";
import type {
  TaskTrackerAccountDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
} from "@polyth/contracts";
import type { TaskTrackersMessageKey } from "../src/i18n/en.ts";
import { tt, uiLocale } from "./i18n.ts";

export const PROVIDER_LABELS: Record<TaskTrackerProvider, string> = {
  jira: "Jira",
  trello: "Trello",
  linear: "Linear",
};

const BLURB_KEYS = {
  jira: "tasktrackers.brand.blurb.jira",
  trello: "tasktrackers.brand.blurb.trello",
  linear: "tasktrackers.brand.blurb.linear",
} as const;

export function providerBlurb(provider: TaskTrackerProvider): string {
  return tt(BLURB_KEYS[provider]);
}

const NOUN_KEYS = {
  issue: "tasktrackers.brand.noun.issue",
  card: "tasktrackers.brand.noun.card",
  project: "tasktrackers.brand.noun.project",
  workspace: "tasktrackers.brand.noun.workspace",
  team: "tasktrackers.brand.noun.team",
  board: "tasktrackers.brand.noun.board",
  columns: "tasktrackers.brand.noun.columns",
  lists: "tasktrackers.brand.noun.lists",
  statuses: "tasktrackers.brand.noun.statuses",
  projects: "tasktrackers.brand.noun.projects",
  workspaces: "tasktrackers.brand.noun.workspaces",
  teams: "tasktrackers.brand.noun.teams",
  allProjects: "tasktrackers.brand.noun.allProjects",
  allWorkspaces: "tasktrackers.brand.noun.allWorkspaces",
  allTeams: "tasktrackers.brand.noun.allTeams",
} as const;

type NounKey = keyof typeof NOUN_KEYS;

/** What each tracker calls the things the board shows. */
const PROVIDER_NOUN_NAMES: Record<TaskTrackerProvider, {
  task: NounKey;
  board: NounKey;
  columns: NounKey;
}> = {
  jira: { task: "issue", board: "board", columns: "columns" },
  trello: { task: "card", board: "board", columns: "lists" },
  linear: { task: "issue", board: "project", columns: "statuses" },
};

export function providerNouns(provider: TaskTrackerProvider): { task: string; board: string; columns: string } {
  const names = PROVIDER_NOUN_NAMES[provider];
  return {
    task: tt(NOUN_KEYS[names.task]),
    board: tt(NOUN_KEYS[names.board]),
    columns: tt(NOUN_KEYS[names.columns]),
  };
}

const CONNECT_KEYS: Record<TaskTrackerProvider, { cta: TaskTrackersMessageKey; how: TaskTrackersMessageKey; board: TaskTrackersMessageKey }> = {
  jira: { cta: "tasktrackers.brand.connect.jiraCta", how: "tasktrackers.brand.connect.jiraHow", board: "tasktrackers.brand.connect.jiraBoard" },
  trello: { cta: "tasktrackers.brand.connect.trelloCta", how: "tasktrackers.brand.connect.trelloHow", board: "tasktrackers.brand.connect.trelloBoard" },
  linear: { cta: "tasktrackers.brand.connect.linearCta", how: "tasktrackers.brand.connect.linearHow", board: "tasktrackers.brand.connect.linearBoard" },
};

/** How connecting works, in a few words, for tiles and empty states. */
export function connectCopy(provider: TaskTrackerProvider): { cta: string; how: string; board: string } {
  const keys = CONNECT_KEYS[provider];
  return { cta: tt(keys.cta), how: tt(keys.how), board: tt(keys.board) };
}

/** Simplified glyphs, not vendor logos: a diamond of chevrons, a two-list
 *  board, and a disc crossed by lanes. */
export function ProviderMark({ provider, size = "md" }: { provider: TaskTrackerProvider; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`tt-provider-mark ${provider} ${size}`} aria-hidden="true">
      {provider === "jira" ? (
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" fill="currentColor" opacity=".35" />
          <path d="M12 7.5 16.5 12 12 16.5 7.5 12Z" fill="currentColor" />
        </svg>
      ) : provider === "trello" ? (
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="currentColor" opacity=".35" />
          <rect x="6.5" y="6.5" width="4.5" height="10" rx="1.2" fill="currentColor" />
          <rect x="13" y="6.5" width="4.5" height="6.5" rx="1.2" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="8.5" fill="currentColor" opacity=".35" />
          <path d="M5.2 13.6 10.4 18.8M4.6 10.2l9.2 9.2M6.4 7.2l10.4 10.4M9.6 5.1l9.3 9.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

export function AccountAvatar({ account }: { account: TaskTrackerAccountDto }) {
  const initials = account.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";
  return (
    <span className="tt-avatar" aria-hidden="true">
      {account.avatarUrl
        ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
        : initials}
    </span>
  );
}

export type ProviderState = "off" | "connected" | "env" | "demo" | "disconnected";

export function providerState(info: TaskTrackerProviderDto | undefined): ProviderState {
  if (!info) return "disconnected";
  if (info.enabled === false) return "off";
  if (info.source === "personal" || info.source === "connection") return "connected";
  if (info.source === "env" || (info.source === undefined && info.configured)) return "env";
  if (info.mode === "demo") return "demo";
  return "disconnected";
}

const STATE_KEYS = {
  off: "tasktrackers.brand.state.off",
  connected: "tasktrackers.brand.state.connected",
  env: "tasktrackers.brand.state.env",
  demo: "tasktrackers.brand.state.demo",
  disconnected: "tasktrackers.brand.state.disconnected",
} as const;

export function stateLabel(state: ProviderState): string {
  return tt(STATE_KEYS[state]);
}

export const STATE_TONES: Record<ProviderState, "neutral" | "success" | "info" | "warning"> = {
  off: "neutral",
  connected: "success",
  env: "info",
  demo: "warning",
  disconnected: "neutral",
};

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const locale = uiLocale();
  if (seconds < 45) return tt("tasktrackers.brand.justNow");
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  return new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** Animated success check: stroke draws in, then the ring settles. */
export function SuccessCheck(): ReactNode {
  return (
    <svg className="tt-success-check" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="23" />
      <path d="M15 27.5 22.5 35 37.5 18.5" />
    </svg>
  );
}
