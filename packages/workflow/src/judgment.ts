import type {
  SpaceContext,
  WorkflowReviewJudgmentDto,
  WorkflowNodeDto,
  WorkflowReviewVerdict,
} from "@polyth/contracts";
import {
  choice,
  choiceMargin,
  topChoiceProbability,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type JudgmentUseDescriptor,
} from "@polyth/judgment";
import type { JudgmentService } from "@polyth/judgment/server";
import { parseReviewVerdict } from "./review.ts";

export const WORKFLOW_REVIEW_VERDICT_USE_ID = "workflow.review-verdict";
export const WORKFLOW_REVIEW_VERDICT_SCOPE = "workflow.review-verdict.v1";

export const DEFAULT_VERDICT_THRESHOLD = 0.7;
export const DEFAULT_VERDICT_MARGIN = 0.2;
export const DEFAULT_VERDICT_UNCERTAIN = "ask";

export type WorkflowVerdictUncertainPolicy = "ask" | "approve";

export type WorkflowReviewChoice = "approved" | "changes_requested" | "cannot_tell";

export type { WorkflowReviewJudgmentDto };

export const workflowReviewVerdictDescriptor: JudgmentUseDescriptor = {
  id: WORKFLOW_REVIEW_VERDICT_USE_ID,
  packageId: "workflow",
  title: "Workflow review verdict",
  description: "Infer whether a review report approved changes or requested fixes when it omitted an explicit verdict line.",
  effect: "Treats confident changes-requested as rework; if uncertain, asks for human review or approves based on configuration.",
  scope: WORKFLOW_REVIEW_VERDICT_SCOPE,
  evidence: "long",
  defaultEnabled: false,
  params: [
    {
      id: "threshold",
      kind: "probability",
      label: "Required confidence",
      hint: "How sure Judgment must be of a verdict before Polyth applies it without asking you.",
      default: DEFAULT_VERDICT_THRESHOLD,
    },
    {
      id: "margin",
      kind: "probability",
      label: "Clear lead",
      hint: "How far the top answer must beat the runner-up before Polyth acts.",
      default: DEFAULT_VERDICT_MARGIN,
    },
    {
      id: "uncertain",
      kind: "choice",
      label: "When uncertain",
      hint: "What happens when the report has no Verdict line and Judgment is not sure.",
      options: [
        { value: "ask", label: "Ask for human review" },
        { value: "approve", label: "Approve without rework" },
      ],
      default: DEFAULT_VERDICT_UNCERTAIN,
    },
  ],
};

export interface JudgeReviewOptions {
  judgment: JudgmentService;
  space: SpaceContext;
  projectId: string;
  output: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface JudgedVerdictOutcome {
  /** Absent when no decision is applied (judgment off, failed, or uncertain). */
  verdict?: WorkflowReviewVerdict;
  judgment?: WorkflowReviewJudgmentDto;
}

/**
 * Bounds the report text passed to Judgment to the tail (~4000 characters).
 * Review reports normally state their conclusions and findings at the end.
 */
export const boundReviewReportTail = (report: string, maxChars = 4_000): string =>
  report.length <= maxChars ? report : report.slice(-maxChars);

/**
 * Constructs the choice question for review report verdict classification.
 */
export function createReviewVerdictQuestion(): ChoiceQuestion<WorkflowReviewChoice> {
  return choice(
    "What is the review decision of this report?",
    {
      approved: "The reviewer found no blocking issues, approved the changes, or judged the work acceptable to proceed.",
      changes_requested: "The reviewer requested changes, found actionable flaws, bugs, or unaddressed requirements that require rework.",
      cannot_tell: "The report is ambiguous, incomplete, cut off, discusses unrelated topics, or does not take a stance on whether changes are needed or approved.",
    }
  );
}

/**
 * Asks Judgment to classify the review report's decision.
 * Called ONLY when the explicit verdict line parser returns undefined.
 */
export async function judgeReviewVerdict(options: JudgeReviewOptions): Promise<JudgedVerdictOutcome | undefined> {
  const { judgment, space, projectId, output, sessionId, signal } = options;

  let useState;
  try {
    useState = await judgment.resolveUse({ space, projectId }, WORKFLOW_REVIEW_VERDICT_USE_ID);
  } catch {
    return undefined;
  }
  if (!useState?.enabled) return undefined;

  const threshold = typeof useState.params.threshold === "number" ? useState.params.threshold : DEFAULT_VERDICT_THRESHOLD;
  const margin = typeof useState.params.margin === "number" ? useState.params.margin : DEFAULT_VERDICT_MARGIN;
  const uncertain = (typeof useState.params.uncertain === "string" && (useState.params.uncertain === "approve" || useState.params.uncertain === "ask"))
    ? (useState.params.uncertain as WorkflowVerdictUncertainPolicy)
    : DEFAULT_VERDICT_UNCERTAIN;

  const reportTail = boundReviewReportTail(output);
  const verdictQuestion = createReviewVerdictQuestion();

  let run;
  try {
    run = await judgment.createRun({ space, projectId });
  } catch {
    return undefined;
  }

  try {
    const result = await run.judge({
      scope: WORKFLOW_REVIEW_VERDICT_SCOPE,
      state: { reportTail },
      questions: { verdict: verdictQuestion },
      metadata: {
        projectId,
        ...(sessionId ? { sessionId } : {}),
      },
      signal,
    });

    if (!result.ok) {
      return undefined;
    }

    const answer = result.answers.verdict as ChoiceAnswer<WorkflowReviewChoice>;
    const topProb = topChoiceProbability(answer);
    const calculatedMargin = choiceMargin(answer);
    const topChoice = answer.value;

    const probabilities: Record<WorkflowReviewChoice, number> = {
      approved: answer.probabilities.approved ?? 0,
      changes_requested: answer.probabilities.changes_requested ?? 0,
      cannot_tell: answer.probabilities.cannot_tell ?? 0,
    };

    const baseJudgment: Omit<WorkflowReviewJudgmentDto, "verdict"> = {
      probabilities,
      topProbability: topProb,
      margin: calculatedMargin,
      topChoice,
    };

    if (topChoice === "changes_requested" && topProb >= threshold && calculatedMargin >= margin) {
      return {
        verdict: "changes-requested",
        judgment: {
          ...baseJudgment,
          verdict: "changes-requested",
        },
      };
    }

    if (topChoice === "approved" && topProb >= threshold && calculatedMargin >= margin) {
      return {
        verdict: "approved",
        judgment: {
          ...baseJudgment,
          verdict: "approved",
        },
      };
    }

    // Uncertain path
    if (uncertain === "approve") {
      return {
        verdict: "approved",
        judgment: {
          ...baseJudgment,
          verdict: "approved",
        },
      };
    }

    return {
      judgment: {
        ...baseJudgment,
        verdict: "uncertain",
      },
    };
  } catch {
    return undefined;
  } finally {
    run.dispose();
  }
}

/**
 * Resolves review verdict with the strict policy:
 * 1. An explicit Verdict line ALWAYS wins and Judgment is not called.
 * 2. Only when the parser returns undefined, asks Judgment if configured.
 * 3. On Judgment off/failure, falls back to undefined (today's behavior).
 */
export async function resolveReviewVerdict(options: {
  output: string;
  judgment?: JudgmentService;
  space?: SpaceContext;
  projectId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<JudgedVerdictOutcome> {
  const explicit = parseReviewVerdict(options.output);
  if (explicit !== undefined) {
    return { verdict: explicit };
  }
  if (!options.judgment || !options.space || !options.projectId) {
    return {};
  }
  const judged = await judgeReviewVerdict({
    judgment: options.judgment,
    space: options.space,
    projectId: options.projectId,
    output: options.output,
    sessionId: options.sessionId,
    signal: options.signal,
  });
  return judged ?? {};
}
