// One user-defined judge on one piece of evidence: bounded picked evidence,
// one question through JUDGMENT_SERVICE, and the fire condition. Recording and
// acting are the caller's decision (live runs record and act, backtests never do).
import { choice, choiceMargin, noul, score, type JudgmentQuestion, type JudgmentResult, type JudgmentState, type JudgmentTarget } from "@polyth/judgment";
import { pickEvidence, type PermissionEvidence, type TurnEvidence } from "./evidence.ts";
import type { JudgeContext } from "./builtins.ts";
import {
  approvesRequest, decidesRequests, isAction, parseRouteKey, type ActionEffect, type AssessmentAction, type AssessmentData, type JudgeDefinition,
  type JudgeEffect, type RequestVerdictData, type RequestVerdictKind,
} from "./types.ts";

export const customScope = (judgeId: string) => `judges.custom.${judgeId}.v1`;

/**
 * A judge is answered by an agent model: the one it names, else its owner's
 * Small Model. It never follows the Space's Judgment engine, so it needs no
 * API key and never touches Credential Vault.
 */
export function judgeTarget(judge: Pick<JudgeDefinition, "model">): Required<JudgmentTarget> {
  const route = judge.model ? parseRouteKey(judge.model) : undefined;
  return route ? { engineId: "agent", providerId: route.harnessId, modelId: `${route.providerID}/${route.modelID}` }
    : { engineId: "agent", providerId: "small-model", modelId: "default" };
}
export const customUseId = (judgeId: string) => `judges.custom.${judgeId}`;

export interface CustomOutcome {
  label?: string;
  probability?: number;
  probabilities?: Record<string, number>;
  margin?: number;
  /** The judge fired: its markers and suggestion apply. */
  fires: boolean;
  /** The judge fired or its answer runs actions. */
  wouldFire: boolean;
  /** Actions the answer runs, in the order they must run. */
  actions: ActionEffect[];
  /** Judgment failure reason; never treated as a decision. */
  failure?: string;
}

/** Answer the request before changing Auto-Approve (which would answer it itself), merge before nudging. */
const ACTION_ORDER: readonly ActionEffect["kind"][] = ["approve-request", "deny-request", "set-approval", "merge-isolated", "switch-route", "send-message"];
export const orderActions = (actions: ActionEffect[]): ActionEffect[] =>
  [...actions].sort((a, b) => ACTION_ORDER.indexOf(a.kind) - ACTION_ORDER.indexOf(b.kind));

function question(judge: JudgeDefinition): JudgmentQuestion {
  const q = judge.question;
  if (q.type === "noul") return noul(q.text);
  if (q.type === "choice") return choice(q.text, Object.fromEntries(q.labels.map((entry) => [entry.label, entry.description])));
  if (q.type === "score") return score(q.text, q.rubric);
  throw Object.assign(new Error("A route question is built from live routes"), { code: "invalid-input" });
}

const actionsOf = (judge: JudgeDefinition, when?: string): ActionEffect[] => orderActions(judge.effects
  .filter((effect): effect is ActionEffect => isAction(effect.kind) && (effect as { when?: string }).when === when));

/** Applies the judge's fire condition to a successful answer. */
export function evaluate(judge: JudgeDefinition, result: JudgmentResult<{ answer: JudgmentQuestion }>): CustomOutcome {
  if (!result.ok) return { fires: false, wouldFire: false, actions: [], failure: result.reason };
  const answer = result.answers.answer as unknown as { type: string; probability?: number; value?: string; probabilities?: Record<string, number> | number[]; score?: number; levelCount?: number };
  const { threshold, margin: minMargin } = judge.fire;
  if (answer.type === "noul") {
    const p = answer.probability!, margin = 2 * p - 1;
    const fires = p >= threshold && margin >= minMargin;
    const actions = fires ? actionsOf(judge) : [];
    return { label: p >= 0.5 ? "yes" : "no", probability: p, margin, fires, wouldFire: fires, actions };
  }
  if (answer.type === "choice") {
    const probabilities = answer.probabilities as Record<string, number>;
    const lead = (label: string) => (probabilities[label] ?? 0)
      - Math.max(0, ...Object.entries(probabilities).filter(([other]) => other !== label).map(([, value]) => value));
    const target = judge.fire.label;
    const fires = target !== undefined && (probabilities[target] ?? 0) >= threshold && lead(target) >= minMargin;
    // Only a confident top answer runs the actions tied to it; a close call runs nothing.
    const winner = answer.value!;
    const confident = (probabilities[winner] ?? 0) >= threshold && lead(winner) >= minMargin;
    const actions = confident ? actionsOf(judge, winner) : [];
    const shown = fires ? target! : winner;
    return { label: answer.value, probability: probabilities[shown] ?? 0, probabilities: { ...probabilities },
      margin: choiceMargin(answer as Parameters<typeof choiceMargin>[0]), fires, wouldFire: fires || actions.length > 0, actions };
  }
  const levels = Math.max(2, answer.levelCount ?? 2);
  const normalized = (answer.score ?? 0) / (levels - 1);
  const fires = normalized >= threshold;
  return { label: `level ${Math.round(answer.score ?? 0) + 1} of ${levels}`, probability: normalized, fires, wouldFire: fires,
    actions: fires ? actionsOf(judge) : [] };
}

/**
 * What a permission judge's answer says about the request, for its card. A
 * confident answer the judge acts on is `approve` or `deny`, exactly when that
 * action runs (the fire rule of `evaluate`); a confident other answer is
 * advice, `against` approving for a judge that can approve and `clear` for one
 * that can only deny; anything else is `unsure`. The safety is the chance of
 * the answers that approve, or for a deny-only judge one minus the chance of
 * those that deny. Undefined without an answer, or for a judge that neither
 * approves nor denies: such a judge marks a request, it does not decide on it.
 */
export function requestVerdict(judge: JudgeDefinition, outcome: CustomOutcome): Pick<RequestVerdictData, "verdict" | "safety" | "label" | "probability"> | undefined {
  if (outcome.failure || outcome.probability === undefined || !decidesRequests(judge)) return undefined;
  const approving = judge.effects.filter(approvesRequest), denying = judge.effects.filter((effect) => effect.kind === "deny-request");
  const canApprove = approving.length > 0;
  const confidentIn = (approves: boolean, denies: boolean): RequestVerdictKind =>
    approves ? "approve" : denies ? "deny" : canApprove ? "against" : "clear";
  const { threshold, margin } = judge.fire;
  const question = judge.question;
  const share = (value: number) => Math.min(1, Math.max(0, value));
  if (question.type === "choice") {
    const probabilities = outcome.probabilities ?? {};
    const answers = (effects: JudgeEffect[]) => new Set(effects.map((effect) => (effect as { when?: string }).when).filter((when): when is string => !!when));
    const allow = answers(approving), deny = answers(denying);
    const sum = (set: Set<string>) => [...set].reduce((total, answer) => total + (probabilities[answer] ?? 0), 0);
    const label = outcome.label ?? "";
    const p = probabilities[label] ?? 0;
    const lead = p - Math.max(0, ...Object.entries(probabilities).filter(([other]) => other !== label).map(([, value]) => value));
    const confident = p >= threshold && lead >= margin;
    return { verdict: confident ? confidentIn(allow.has(label), deny.has(label)) : "unsure",
      safety: share(canApprove ? sum(allow) : 1 - sum(deny)), label, probability: p };
  }
  // A yes/no or score judge acts when it fires; a confident answer the other way only advises.
  const fired = (fires: boolean, confidentNot: boolean): RequestVerdictKind =>
    fires ? confidentIn(canApprove, !canApprove) : confidentNot ? confidentIn(false, false) : "unsure";
  if (question.type === "noul") {
    const p = outcome.probability;
    const verdict = fired(p >= threshold && 2 * p - 1 >= margin, 1 - p >= threshold && 1 - 2 * p >= margin);
    return { verdict, safety: share(canApprove ? p : 1 - p), label: p >= 0.5 ? "yes" : "no", probability: Math.max(p, 1 - p) };
  }
  if (question.type === "score") {
    const level = outcome.probability;
    return { verdict: fired(level >= threshold, level <= 1 - threshold), safety: share(canApprove ? level : 1 - level), label: outcome.label ?? "", probability: level };
  }
  return undefined;
}

/** The state a judge sends: its picks, plus anything its trigger always supplies. */
export function judgeState(judge: JudgeDefinition, turn: TurnEvidence, request?: PermissionEvidence): JudgmentState {
  return pickEvidence(turn, judge.evidence, request);
}

/** Asks the judge's question. The caller has already reserved the call against the daily cap. */
export async function askJudge(ctx: JudgeContext, judge: JudgeDefinition, turn: TurnEvidence, request?: PermissionEvidence): Promise<CustomOutcome> {
  const run = await ctx.judgment.createRun({ space: ctx.space, projectId: ctx.projectId });
  try {
    const result = await run.judge({ scope: customScope(judge.id), state: judgeState(judge, turn, request), signal: ctx.signal, target: judgeTarget(judge),
      questions: { answer: question(judge) }, metadata: { sessionId: ctx.sessionId } });
    return evaluate(judge, result as JudgmentResult<{ answer: JudgmentQuestion }>);
  } finally { run.dispose(); }
}

/** The assessment a fired judge records; its effects come only from the allowlist. */
export function assessmentFor(judge: JudgeDefinition, outcome: CustomOutcome, now = Date.now(), actions?: AssessmentAction[]): AssessmentData {
  const followUp = outcome.fires ? judge.effects.find((effect) => effect.kind === "suggest-follow-up") : undefined;
  return { useId: customUseId(judge.id), scope: customScope(judge.id), kind: "custom", title: judge.name, judgeId: judge.id,
    trigger: judge.trigger,
    label: outcome.label ?? "", probability: outcome.probability ?? 0,
    ...(outcome.probabilities ? { probabilities: outcome.probabilities } : {}),
    ...(outcome.margin !== undefined ? { margin: outcome.margin } : {}),
    ...(outcome.fires && judge.effects.some((effect) => effect.kind === "needs-attention") ? { attention: true } : {}),
    ...(followUp && followUp.kind === "suggest-follow-up" ? { followUp: followUp.text } : {}),
    ...(actions?.length ? { actions } : {}),
    ts: now };
}
