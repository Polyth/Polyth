import { useEffect, useMemo, type ReactNode } from "react";
import { harnessSignInExpiry, type HarnessSnapshot } from "@polyth/contracts";
import { peekHarnessSnapshots, readHarnessSnapshots, useCatalogRevision } from "@polyth/models/runtime-catalog";
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Notice } from "../../../apps/web/src/components/ui/index.ts";

/** The harness an agent's main route is pinned to, if any. */
export const pinnedHarnessOf = (agent: Pick<ScheduleTaskDto, "harness" | "model">): string | undefined =>
  agent.harness?.mode === "pinned" ? agent.harness.harnessId : agent.model?.harnessId;

export type AgentSignInState =
  | { kind: "needed" }
  | { kind: "before-next-run" | "soon"; expiresAt: number };

/** What the agent's pinned login means for its runs: signed out or ended
 *  (runs on it are refused), ending before the next scheduled run, or ending
 *  within 10 days. Nothing when the CLI reports no end. */
export function agentSignInState(
  agent: Pick<ScheduleTaskDto, "enabled" | "nextRunAt">,
  row: Pick<HarnessSnapshot, "availability">,
  now: number,
): AgentSignInState | undefined {
  const { availability } = row;
  const { level } = harnessSignInExpiry(availability.authExpiresAt, now);
  if (availability.state === "auth-required" || availability.authenticated === false || level === "ended") return { kind: "needed" };
  const expiresAt = availability.authExpiresAt;
  if (expiresAt === undefined) return undefined;
  if (agent.enabled && agent.nextRunAt !== null && agent.nextRunAt >= expiresAt) return { kind: "before-next-run", expiresAt };
  return level === "soon" || level === "imminent" ? { kind: "soon", expiresAt } : undefined;
}

/** The picker's naming: a Space title can hide the account. */
const profileName = (identity: HarnessSnapshot["identity"]): string => {
  const label = identity.accountLabel?.trim();
  return label && !identity.name.toLowerCase().includes(label.toLowerCase()) ? `${identity.name} · ${label}` : identity.name;
};

/** A notice on the agent's screen when its pinned login stops or will stop
 *  its runs, with a way to the harness's settings. */
export function useAgentSignInNotice(host: WebPackageHost | undefined, agent: ScheduleTaskDto): ReactNode {
  const harnessId = pinnedHarnessOf(agent);
  const revision = useCatalogRevision();
  // Rendered whenever the agent or the catalog changes; no clock of its own.
  const now = Date.now();
  const rows = useMemo(() => harnessId ? peekHarnessSnapshots({ projectId: agent.projectId }) : undefined, [harnessId, agent.projectId, revision]);
  const missing = Boolean(harnessId) && rows === undefined;
  useEffect(() => {
    if (missing) void readHarnessSnapshots({ projectId: agent.projectId }).catch(() => {});
  }, [missing, agent.projectId]);
  const row = harnessId ? rows?.find((candidate) => candidate.identity.id === harnessId) : undefined;
  const state = row && row.policy.enabled ? agentSignInState(agent, row, now) : undefined;
  if (!row || !state) return null;
  const name = profileName(row.identity);
  const date = state.kind === "needed" ? "" : new Intl.DateTimeFormat(host?.ui.locale.get(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(state.expiresAt));
  const text = state.kind === "needed" ? tr("agents.signIn.needed", { name })
    : state.kind === "before-next-run" ? tr("agents.signIn.beforeNextRun", { name, date })
      : tr("agents.signIn.soon", { name, date });
  return <Notice
    tone={state.kind === "needed" ? "error" : "warning"}
    className="agent-sign-in-notice"
    data-kind={state.kind}
    actions={host && <Button size="sm" variant="ghost" onClick={() => host.navigation.openSettingsPage("harnesses", { itemId: row.identity.id })}>{tr("agents.signIn.settings")}</Button>}
  >{text}</Notice>;
}
