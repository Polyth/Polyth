// What a person can do to an agent, from its row in the navigator or from its
// own page. Every action shows at once in the shared agents snapshot and puts
// back the previous state if the server refuses.
import type { AttachmentRef } from "@polyth/contracts";
import { api, type AgentContinuationDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { setUiError } from "../../../apps/web/src/store.ts";
import { deletePlannerTask } from "./plannerTaskActions.ts";
import { draftFromTask, draftToInput } from "./agentModel.ts";
import { newestReportAt } from "./agentLive.ts";
import { dropAgent, optimistic, putAgent, refreshAgents, requestAgentPage, type AgentTab } from "./agentsStore.ts";

/** The page that shows agents in place of Chat. */
export const AGENTS_PAGE_ID = "agents";
/** Resource of the page that creates an agent. */
export const NEW_AGENT_RESOURCE = "new";

export const agentName = (agent: Pick<ScheduleTaskDto, "title" | "prompt">): string =>
  agent.title?.trim() || agent.prompt.split("\n")[0]!.slice(0, 60);

const fail = (cause: unknown): false => {
  setUiError(cause instanceof Error ? cause.message : String(cause));
  return false;
};

/** Show the agent's page in place of Chat, on a tab when one is asked for. */
export function openAgent(host: WebPackageHost, agent: Pick<ScheduleTaskDto, "id" | "projectId">, tab?: AgentTab): boolean {
  if (tab) requestAgentPage(agent.id, tab);
  return host.navigation.openPage?.(AGENTS_PAGE_ID, agent.id, { projectId: agent.projectId }) ?? false;
}

/** The agents' home: what waits for the person, across projects. */
export function openAgentsHome(host: WebPackageHost): boolean {
  return host.navigation.openPage?.(AGENTS_PAGE_ID, null) ?? false;
}

export function openNewAgent(host: WebPackageHost, projectId?: string): boolean {
  return host.navigation.openPage?.(AGENTS_PAGE_ID, NEW_AGENT_RESOURCE, projectId ? { projectId } : {}) ?? false;
}

/** Why the agent refused a message it could not take as it stands, in the
 *  person's language; other failures keep the server's words. */
const RUN_REFUSALS: Partial<Record<string, Parameters<typeof tr>[0]>> = {
  /** The waiting messages would pass what one run carries. */
  "payload-too-large": "agents.refusedQueueFull",
  /** A one-off run of a file version waits for the run in progress. */
  conflict: "agents.refusedVersionWaiting",
  /** The agents are stopping or starting again (a wake without words cannot
   *  wait; the person's words are kept and sent after the restart). */
  unavailable: "agents.refusedRestarting",
};

export function runRefusal(cause: unknown): unknown {
  const code = (cause as { code?: unknown } | null)?.code;
  const key = typeof code === "string" ? RUN_REFUSALS[code] : undefined;
  return key ? new Error(tr(key)) : cause;
}

/** Start a run now, with the person's words (and files) when there are any.
 *  `continuation` says whether they go on in the current conversation. */
export async function runAgent(
  agent: ScheduleTaskDto,
  input?: string,
  options?: { continuation?: AgentContinuationDto; attachments?: AttachmentRef[] },
): Promise<boolean> {
  try {
    putAgent(await api.scheduleRun(agent.id, input, options));
    void refreshAgents();
    return true;
  } catch (cause) {
    return fail(runRefusal(cause));
  }
}

export async function stopAgent(agent: ScheduleTaskDto): Promise<boolean> {
  try {
    await api.scheduleStop(agent.id);
    void refreshAgents();
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

export async function pauseAgent(agent: ScheduleTaskDto, pause: boolean): Promise<boolean> {
  try {
    await optimistic(agent.id, { enabled: !pause }, () => api.schedulePause(agent.id, pause));
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

/** Everything the agent filed so far counts as read. */
export async function markAgentRead(agent: ScheduleTaskDto): Promise<boolean> {
  const at = newestReportAt(agent);
  if (at === undefined || (agent.seenAt ?? 0) >= at) return true;
  try {
    await optimistic(agent.id, { seenAt: at }, () => api.scheduleSeen(agent.id, at));
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

export async function renameAgent(agent: ScheduleTaskDto, title: string): Promise<boolean> {
  const next = title.trim();
  if (!next || next === agentName(agent)) return true;
  try {
    await optimistic(agent.id, { title: next }, () => api.scheduleUpdate(agent.id, { title: next }));
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

/** A paused copy, so two agents never wake for the same job by accident. */
export async function duplicateAgent(agent: ScheduleTaskDto): Promise<ScheduleTaskDto | null> {
  const draft = draftFromTask(agent, getLocale());
  try {
    const created = await api.scheduleCreate(draftToInput({ ...draft, name: tr("agents.copyOfValue", { name: draft.name }) }, false));
    putAgent(created);
    void refreshAgents();
    return created;
  } catch (cause) {
    fail(cause);
    return null;
  }
}

/** Asks first; repository agents are removed by deleting their file. */
export async function deleteAgent(agent: ScheduleTaskDto): Promise<boolean> {
  if (!await deletePlannerTask(agent)) return false;
  dropAgent(agent.id);
  void refreshAgents();
  return true;
}
