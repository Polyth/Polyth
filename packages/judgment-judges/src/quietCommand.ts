// Quiet commands: a call that printed nothing for 9 minutes is about to be
// stopped by Polyth. A judge decides whether it is still working. The only
// thing it can do is press Keep running; every other outcome (stuck, unsure,
// low chance, timeout, error) leaves the stop to run, so Polyth's behavior is
// today's unless the judge is confident.
import { choice, type JudgmentUseDescriptor } from "@polyth/judgment";
import type { JudgmentService } from "@polyth/judgment/server";
import type { SessionEvent, SessionService, SpaceContext } from "@polyth/contracts";
import { clipHead, clipTail, redact } from "./evidence.ts";
import { PACKAGE_ID, type AssessmentData } from "./types.ts";

export const QUIET_COMMAND_USE = "judges.quiet-command";

export const QUIET_COMMAND: JudgmentUseDescriptor = {
  id: QUIET_COMMAND_USE, packageId: PACKAGE_ID, order: 23,
  title: "Quiet commands",
  description: "When a command has printed nothing for 9 minutes and nobody pressed Keep running, a judge decides: still working (it keeps running, up to the 60-minute limit) or stuck (Polyth stops it at 10 minutes).",
  effect: "When it is confident the command is still working, Polyth presses Keep running for it. Otherwise nothing changes and the silence stop runs on time.",
  scope: "judges.quiet-command.v1", evidence: "short", defaultEnabled: false,
  params: [
    { id: "threshold", label: "Keep running when “still working” is at least", kind: "probability", default: 0.75 },
  ],
};

const LABELS = {
  working: "The command is most likely still doing real work: a build, test suite, install, download, sleep or long query that prints nothing for a while.",
  stuck: "The command is most likely stuck: waiting for input, an interactive prompt, a password or passphrase, a pager, an editor, or a server that never exits.",
  cannot_tell: "The evidence is insufficient to decide.",
} as const;

const QUESTION = "This command has printed nothing for a long time. Is it still working or is it stuck? "
  + "Builds, test suites, installs, downloads, sleeps and long queries are usually working. "
  + "Waiting for input, an interactive prompt, a password or passphrase, a pager, an editor, or a server that never exits means stuck.";

/** Least time that must remain before the stop for a judge call to be worth making. */
export const MIN_REMAINING_MS = 10_000;
const CALL_TIMEOUT_MS = 45_000;
const STOP_MARGIN_MS = 5_000;
const INPUT_MAX = 600, ANSWER_MAX = 600;

export interface QuietEvent {
  sessionId: string; callId: string; tool: string; startedAt: number; quietSince: number; stopsAt: number;
  spaceId?: string; projectId?: string;
}

const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

/** The command line or description of a call's input; shells say `command`, Antigravity `CommandLine`. */
export function callInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const raw = record.command ?? record.CommandLine ?? record.commandLine ?? record.cmd ?? record.script;
  const command = Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : str(raw);
  const description = str(record.description) ?? str(record.Description);
  return [command, description && description !== command ? `(${description})` : undefined].filter(Boolean).join(" ");
}

/** The call's input and the assistant's last text before it, from the call's own session. */
export function quietEvidence(events: readonly SessionEvent[], callId: string) {
  const index = events.findIndex((event) => (event.type === "tool/call" || event.type === "tool/started")
    && (event.data as { callId?: unknown }).callId === callId);
  const call = index >= 0 ? events[index] : undefined;
  const before = index >= 0 ? events.slice(0, index) : events;
  const said = before.findLast((event) => event.type === "assistant/message" && !event.ignorable && str((event.data as { text?: unknown }).text));
  return {
    input: callInputText((call?.data as { input?: unknown } | undefined)?.input),
    agentSaid: str((said?.data as { text?: unknown } | undefined)?.text) ?? "",
  };
}

export interface QuietDeps {
  judgment: JudgmentService;
  /** The Space's own facade: reads this Space's session and keeps its call. */
  sessions: SessionService;
  space: SpaceContext;
  signal?: AbortSignal;
  now?: () => number;
}
export type QuietOutcome =
  | { kept: true; assessment: AssessmentData }
  | { kept: false; reason: "disabled" | "no-space" | "no-time" | "not-working" | "no-answer" | "ended" };

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** Judges one quiet call and keeps it running only on a confident "working". Never throws for a call that ended. */
export async function runQuietCommand(deps: QuietDeps, event: QuietEvent): Promise<QuietOutcome> {
  const now = deps.now ?? Date.now;
  if (!event.spaceId || event.spaceId !== deps.space.spaceId) return { kept: false, reason: "no-space" };
  if (event.stopsAt - now() < MIN_REMAINING_MS) return { kept: false, reason: "no-time" };
  // A facade that cannot keep a call is not worth a judge call, and must never record "kept".
  const keep = deps.sessions.keepToolRunning?.bind(deps.sessions);
  if (!keep) return { kept: false, reason: "ended" };
  const use = await deps.judgment.resolveUse({ space: deps.space, projectId: event.projectId ?? "" }, QUIET_COMMAND_USE);
  if (!use.enabled) return { kept: false, reason: "disabled" };
  const threshold = num(use.params.threshold, 0.75);
  const evidence = quietEvidence(await deps.sessions.events(event.sessionId), event.callId);
  const t = now();
  const state = {
    tool: redact(event.tool),
    input: clipHead(redact(evidence.input), INPUT_MAX),
    minutesRunning: minutes(t - event.startedAt),
    minutesQuiet: minutes(t - event.quietSince),
    everShowedActivity: event.quietSince > event.startedAt,
    agentSaidBefore: clipTail(redact(evidence.agentSaid), ANSWER_MAX),
  };
  // A call that ends while the judge thinks is not worth waiting for: the stop is at most this far away.
  const timeoutMs = Math.min(CALL_TIMEOUT_MS, event.stopsAt - now() - STOP_MARGIN_MS);
  if (timeoutMs <= 0) return { kept: false, reason: "no-time" };
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timer]) : timer;
  const run = await deps.judgment.createRun({ space: deps.space, projectId: event.projectId ?? "" });
  let probability: number;
  try {
    const result = await run.judge({ scope: QUIET_COMMAND.scope, state, signal, metadata: { sessionId: event.sessionId },
      questions: { status: choice(QUESTION, LABELS) } });
    if (!result.ok) return { kept: false, reason: "no-answer" };
    const answer = result.answers.status;
    probability = answer.probabilities.working ?? 0;
    if (answer.value !== "working" || probability < threshold) return { kept: false, reason: "not-working" };
  } finally { run.dispose(); }
  // The judge took time: a stop that already ran or an ended call leaves nothing to keep.
  if (now() >= event.stopsAt) return { kept: false, reason: "no-time" };
  try {
    await keep(event.sessionId, event.callId, { via: "judge", useId: QUIET_COMMAND_USE });
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === "conflict") return { kept: false, reason: "ended" };
    throw error;
  }
  return { kept: true, assessment: { useId: QUIET_COMMAND_USE, scope: QUIET_COMMAND.scope, kind: "quiet-command", title: "Kept a quiet command running",
    label: "working", probability, ts: now() } };
}
