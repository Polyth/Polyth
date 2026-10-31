// Built-in Judgment uses. Each reads its resolved use state, asks one bounded
// question and, when the answer clears the user's threshold and margin,
// returns the assessment to record. Nothing here sends a prompt, approves,
// or changes the session: failure, timeout and low margin all mean "record
// nothing", which leaves today's behavior untouched.
import { choice, choiceMargin, noul, type JudgmentUseDescriptor } from "@polyth/judgment";
import type { JudgmentService } from "@polyth/judgment/server";
import type { SpaceContext } from "@polyth/contracts";
import { clipHead, clipTail, type TurnEvidence } from "./evidence.ts";
import { PACKAGE_ID, type AssessmentData } from "./types.ts";

export const COMPLETION_CHECK_USE = "judges.completion-check";
export const NEEDS_YOU_USE = "judges.needs-you";
export const VERIFY_FOLLOW_UP = "Please verify the change you just described: run the relevant tests or checks and show me the output.";

export const COMPLETION_CHECK: JudgmentUseDescriptor = {
  id: COMPLETION_CHECK_USE, packageId: PACKAGE_ID, order: 20,
  title: "Completion check",
  description: "After each turn, asks whether the work the assistant says is done was actually verified by commands, tests or file changes in that turn.",
  effect: "When the claim looks unverified, a quiet “Claimed, not verified” marker appears in the chat. Nothing is sent to the agent.",
  scope: "judges.completion-check.v1", evidence: "long", defaultEnabled: false,
  params: [
    { id: "threshold", label: "Mark when “claimed only” is at least", kind: "probability", default: 0.7 },
    { id: "margin", label: "Clear lead", kind: "probability", default: 0.2,
      hint: "How far the top answer must beat the runner-up before Polyth acts. Below it nothing is marked." },
    { id: "suggestFollowUp", label: "Offer “Ask the agent to verify”", kind: "boolean", default: false,
      hint: "Adds a button to the marker that puts a verification request in the composer. It is never sent for you." },
  ],
};

export const NEEDS_YOU: JudgmentUseDescriptor = {
  id: NEEDS_YOU_USE, packageId: PACKAGE_ID, order: 21,
  title: "Waiting for you",
  description: "After each turn, reads the end of the assistant's last message and asks whether it is waiting for you to answer or decide.",
  effect: "When it is, a “Waiting for you” marker appears in the chat. Notifications are unchanged.",
  scope: "judges.needs-you.v1", evidence: "short", defaultEnabled: false,
  params: [{ id: "threshold", label: "Mark when the chance is at least", kind: "probability", default: 0.7 }],
};

export const BUILTIN_USES = [COMPLETION_CHECK, NEEDS_YOU];
const COMPLETION_LABELS = {
  verified: "Commands, test runs or file changes in this turn directly support the completion the assistant describes.",
  claimed_only: "The assistant says the work is done or working, but nothing run or changed in this turn shows it.",
  cannot_tell: "The evidence is insufficient to decide, or the assistant does not claim completion.",
} as const;

export interface JudgeContext {
  judgment: JudgmentService;
  space: SpaceContext;
  projectId: string;
  sessionId: string;
  signal?: AbortSignal;
}
const metadata = (sessionId: string) => ({ sessionId });
const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** #2: returns the assessment to record, or undefined for "record nothing". */
export async function runCompletionCheck(ctx: JudgeContext, turn: TurnEvidence, now = Date.now()): Promise<AssessmentData | undefined> {
  const use = await ctx.judgment.resolveUse({ space: ctx.space, projectId: ctx.projectId }, COMPLETION_CHECK_USE);
  if (!use.enabled || !turn.answer.trim()) return undefined;
  const threshold = num(use.params.threshold, 0.7), minMargin = num(use.params.margin, 0.2);
  const state = {
    lastRequest: clipHead(turn.request, 1_500),
    lastAnswer: clipTail(turn.answer, 3_000),
    commandsRun: turn.commands.map((entry) => `[${entry.status}] ${entry.command}`),
    changedFiles: turn.changedFiles,
    openTodos: turn.openTodos,
  };
  const run = await ctx.judgment.createRun({ space: ctx.space, projectId: ctx.projectId });
  try {
    const result = await run.judge({ scope: COMPLETION_CHECK.scope, state, signal: ctx.signal, metadata: metadata(ctx.sessionId),
      questions: { outcome: choice("Did this turn actually verify the completion the assistant claims?", COMPLETION_LABELS) } });
    if (!result.ok) return undefined;
    const answer = result.answers.outcome;
    const p = answer.probabilities.claimed_only, margin = choiceMargin(answer);
    // Only a confident "claimed only" leads anything else; unsure stays silent.
    if (answer.value !== "claimed_only" || p < threshold || margin < minMargin) return undefined;
    return { useId: COMPLETION_CHECK_USE, scope: COMPLETION_CHECK.scope, kind: "completion-check", title: "Claimed, not verified",
      label: "claimed_only", probability: p, probabilities: { ...answer.probabilities }, margin,
      ...(use.params.suggestFollowUp === true ? { followUp: VERIFY_FOLLOW_UP } : {}), ts: now };
  } finally { run.dispose(); }
}

/** #3: returns the assessment to record, or undefined for "record nothing". */
export async function runNeedsYou(ctx: JudgeContext, turn: TurnEvidence, now = Date.now()): Promise<AssessmentData | undefined> {
  const use = await ctx.judgment.resolveUse({ space: ctx.space, projectId: ctx.projectId }, NEEDS_YOU_USE);
  if (!use.enabled || !turn.answer.trim()) return undefined;
  const threshold = num(use.params.threshold, 0.7);
  const run = await ctx.judgment.createRun({ space: ctx.space, projectId: ctx.projectId });
  try {
    const result = await run.judge({ scope: NEEDS_YOU.scope, state: clipTail(turn.answer, 400), signal: ctx.signal, metadata: metadata(ctx.sessionId),
      questions: { waiting: noul("Is the assistant waiting for the person to answer or decide?") } });
    if (!result.ok) return undefined;
    const p = result.answers.waiting.probability;
    if (p < threshold) return undefined;
    return { useId: NEEDS_YOU_USE, scope: NEEDS_YOU.scope, kind: "needs-you", title: "Waiting for you",
      label: "waiting", probability: p, attention: true, ts: now };
  } finally { run.dispose(); }
}
