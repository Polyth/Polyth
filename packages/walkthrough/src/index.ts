// Walkthrough workflow plugin: turns a session's file-editing tool calls into
// an ordered list of reviewable steps with a unified diff per step. Entirely
// derived from the durable session event log (invariant #4) — there is no
// in-memory state; approve/reject just appends an overlay event and the next
// GET re-derives the list, so a server restart cannot lose or duplicate a
// decision.
import type { JsonObject, SessionEvent, WalkthroughStepDto, WalkthroughStepStatus } from "@polyth/contracts";
import { unifiedDiff } from "../../../apps/web/src/diff.ts";

export type { WalkthroughStepDto, WalkthroughStepStatus } from "@polyth/contracts";
export {
  WALKTHROUGH_PROMPT_VERSION, buildWalkthroughPrompt, heuristicStages,
  parseGeneratedStages, parseUnifiedDiffText, sourceDigestOf,
} from "./generate.ts";
export type { DiffFileSummary, DiffHunk, StageParse } from "./generate.ts";
export { REVIEW_PROMPT_VERSION, buildReviewPrompt, parseReviewAssessment } from "./review.ts";
export type { ReviewParse } from "./review.ts";
export { unifiedDiff };

const FILE_TOOLS = new Set(["write", "edit", "patch"]);

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const fileOf = (input: Record<string, unknown>): string | undefined => {
  const v = input.filePath ?? input.path ?? input.file;
  return typeof v === "string" && v ? v : undefined;
};

// ---------------------------------------------------------------- step derivation

const diffFor = (tool: string, input: Record<string, unknown>): string => {
  const file = fileOf(input) ?? "file";
  if (typeof input.diff === "string" && input.diff.trim()) return input.diff;
  if (tool === "edit") {
    const oldString = typeof input.oldString === "string" ? input.oldString : "";
    const newString = typeof input.newString === "string" ? input.newString : "";
    return unifiedDiff(oldString, newString, file);
  }
  if (tool === "write") {
    const content = typeof input.content === "string" ? input.content : "";
    return unifiedDiff("", content, file);
  }
  return "";
};

const verbFor = (tool: string): string => (tool === "write" ? "Write" : tool === "edit" ? "Edit" : "Patch");

/** Pure derivation: ordered file-change steps + their current approve/reject
 *  status, entirely reconstructed from the event log. */
export function deriveWalkthrough(events: readonly SessionEvent[]): WalkthroughStepDto[] {
  const steps: WalkthroughStepDto[] = [];
  for (const ev of events) {
    if (ev.type !== "tool/result") continue;
    const d = ev.data as { tool?: unknown; title?: unknown; input?: unknown };
    const tool = typeof d.tool === "string" ? d.tool : "";
    if (!FILE_TOOLS.has(tool)) continue;
    const input = asRecord(d.input) ?? {};
    const file = fileOf(input);
    if (!file) continue;
    const diff = diffFor(tool, input);
    if (!diff.trim()) continue;
    const explanation = typeof d.title === "string" && d.title.trim() ? d.title.trim() : `${verbFor(tool)} ${file}`;
    steps.push({ file, explanation, diff, status: "pending" });
  }

  for (const ev of events) {
    if (ev.type !== "walkthrough/step-approved" && ev.type !== "walkthrough/step-rejected") continue;
    const idx = Number((ev.data as { stepIndex?: unknown }).stepIndex);
    const step = steps[idx];
    if (!step) continue;
    step.status = ev.type === "walkthrough/step-approved" ? "approved" : "rejected";
  }

  return steps;
}

export function stepEventData(stepIndex: number, step: WalkthroughStepDto): JsonObject {
  return { stepIndex, file: step.file };
}

export const decisionEventType = (status: Extract<WalkthroughStepStatus, "approved" | "rejected">): string =>
  status === "approved" ? "walkthrough/step-approved" : "walkthrough/step-rejected";
