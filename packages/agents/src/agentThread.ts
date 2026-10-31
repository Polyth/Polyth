// Which conversation a run joins: a session the agent already talks in, or a
// new one. Browser-safe and pure: the server decides with it when a run starts
// and tells the agent's page the same answer before the person sends.
import type { ContextWindowState } from "@polyth/contracts";
import { DEFAULT_ROTATE_AT } from "./agentPrompt.ts";
import { AGENT_SESSION_PURPOSE } from "./agentSession.ts";

/** Characters one message to an agent keeps (longer text is cut). The
 *  composer sends no more than this. */
export const AGENT_INPUT_LIMIT = 8_000;

/** What the person asked for with their message. `auto` lets the agent judge. */
export type AgentContinuation = "auto" | "continue" | "new";

/** Why a run started a new session when it could have continued one. */
export type AgentFreshReason =
  /** The person chose a new conversation. */
  | "asked"
  /** The last exchange ended longer ago than the follow-up window. */
  | "idle"
  /** The charter, model or route changed since that session started. */
  | "instructions-changed"
  /** That session reached the agent's rotation threshold. */
  | "context-full"
  /** That session was compacted and the charter may be gone from it. */
  | "compacted"
  /** That session is gone, archived, outside the agent's project, or (for a
   *  fresh agent) not an agent session. */
  | "unavailable"
  /** There was nothing to continue. */
  | "none";

/** A fresh agent continues the session of its newest exchange this long
 *  after that exchange ended; later, the person's words start a new one. */
export const FOLLOW_UP_WINDOW_MS = 8 * 60 * 60_000;

/** The parts of a run record the decision reads. */
export interface ThreadRun {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "ok" | "failed" | "skipped" | "unknown";
  sessionId?: string;
  input?: string;
  signal?: "quiet" | "update" | "alert";
  summary?: string;
  headline?: string;
  stopped?: boolean;
  /** `rollingKeyOf` of the task when the run's session started. */
  key?: string;
}

/** A run the person can see in the conversation (and so reply to): their own
 *  words, or a report that says something. Quiet checks and skips are not. */
function visible(run: ThreadRun): boolean {
  if (run.input) return true;
  if (run.status === "running") return true;
  if (run.status !== "ok" && !run.stopped) return run.status === "failed";
  if (run.signal) return run.signal !== "quiet";
  return !!(run.summary?.trim() || run.headline);
}

/** The run whose session a fresh agent's next message from the person would
 *  continue: the newest visible exchange that has a session. `history` is
 *  newest first, as tasks keep it. */
export function followUpRun<T extends ThreadRun>(history: readonly T[] | undefined): T | undefined {
  return (history ?? []).find((run) => run.sessionId && visible(run));
}

/** When the conversation with `run` last moved. */
export const exchangeAt = (run: Pick<ThreadRun, "startedAt" | "finishedAt">): number => run.finishedAt ?? run.startedAt;

/** What the decision knows about the candidate session (its projection). */
export interface ThreadSession {
  status?: string;
  /** `AGENT_SESSION_PURPOSE` on the agent's own sessions. */
  purpose?: string;
  contextWindow?: Pick<ContextWindowState, "fraction" | "compaction">;
}

/** Where the person's message waiting for a run in progress goes, fixed when
 *  it queued (what the page promised then): continue `sessionId`, or start a
 *  new conversation for `reason`. A fresh agent's run goes there; when it
 *  starts, only that session's health is checked again. A rolling agent
 *  follows its ongoing conversation (which may have moved on meanwhile) and
 *  uses this target for display only. */
export interface ThreadTarget {
  sessionId?: string;
  /** The key that session's exchange was started with (see `ThreadRun.key`). */
  key?: string;
  /** When that exchange last moved. */
  at?: number;
  reason?: AgentFreshReason;
}

export type ThreadDecision =
  /** Continue `sessionId`. `resendCharter`: repeat the standing instructions. */
  | { continue: true; sessionId: string; resendCharter: boolean; compactFirst?: boolean }
  | { continue: false; reason: AgentFreshReason };

export interface ThreadInput {
  /** `rolling`: one ongoing conversation; `fresh`: a session per run, with
   *  the person's follow-ups continuing the session they answer. */
  mode: "rolling" | "fresh";
  continuation: AgentContinuation;
  /** The run carries the person's words (only those may follow up a fresh agent's run). */
  personal: boolean;
  now: number;
  /** Rolling: the agent's last session. Fresh: `followUpRun(history)`'s
   *  session, or the one a waiting message was promised (`ThreadTarget`). */
  candidate?: { sessionId: string; at: number; key?: string };
  /** `rollingKeyOf(task)` now. */
  currentKey: string;
  /** The candidate's projection; absent when it no longer exists. */
  session?: ThreadSession;
  /** Rolling only (a fresh agent uses the default and never compacts). */
  rotateAt?: number;
  whenFull?: "new-session" | "compact";
}

/** Continue a session or start a new one, and why. The same rules serve the
 *  run and the owner's `followUp` preview (both on the server). */
export function threadDecision(input: ThreadInput): ThreadDecision {
  const rolling = input.mode === "rolling";
  if (!rolling && !input.personal) return { continue: false, reason: "none" };
  if (input.continuation === "new") return { continue: false, reason: "asked" };
  const candidate = input.candidate;
  if (!candidate) return { continue: false, reason: "none" };
  const session = input.session;
  if (!session || session.status === "archived") return { continue: false, reason: "unavailable" };
  // A fresh agent follows up only its own sessions, never a chat it once
  // posted into (an agent that used to work in a chosen session).
  if (!rolling && session.purpose !== AGENT_SESSION_PURPOSE) return { continue: false, reason: "unavailable" };
  // A rolling agent always knows the key its session started with. A fresh
  // run recorded before runs kept one is taken as compatible: the person is
  // answering what that run said, so the reply belongs with it.
  const keyChanged = rolling
    ? candidate.key !== input.currentKey
    : candidate.key !== undefined && candidate.key !== input.currentKey;
  if (keyChanged) return { continue: false, reason: "instructions-changed" };
  const window = session.contextWindow;
  // Only a rolling agent set to compact compacts; a fresh one never does on
  // its own, and a full session means a new conversation.
  const compacting = rolling && input.whenFull === "compact";
  const compacted = Boolean(window?.compaction?.lastAt);
  if (compacted && rolling && !compacting) return { continue: false, reason: "compacted" };
  const fraction = window?.fraction;
  const rotateAt = rolling ? input.rotateAt ?? DEFAULT_ROTATE_AT : DEFAULT_ROTATE_AT;
  const full = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= rotateAt;
  if (full && !compacting) return { continue: false, reason: "context-full" };
  if (!rolling && input.continuation === "auto" && input.now - candidate.at > FOLLOW_UP_WINDOW_MS) {
    return { continue: false, reason: "idle" };
  }
  // A compaction may have summarised the charter away: repeat it. A rolling
  // agent also repeats it when the occupancy is unknown.
  const unknown = typeof fraction !== "number" || !Number.isFinite(fraction);
  return {
    continue: true,
    sessionId: candidate.sessionId,
    resendCharter: compacted || (rolling && (unknown || full)),
    ...(full && compacting ? { compactFirst: true } : {}),
  };
}
