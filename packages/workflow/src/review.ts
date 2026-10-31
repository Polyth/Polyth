import type {
  WorkflowDisputeDto,
  WorkflowDto,
  WorkflowReviewFindingDto,
  WorkflowNodeDto,
  WorkflowReviewVerdict,
} from "@polyth/contracts";
import { upstream } from "./graph.ts";

export const DEFAULT_REVIEW_ROUNDS = 2;
export const MAX_REVIEW_ROUNDS = 5;

type Graph = Pick<WorkflowDto, "nodes" | "edges">;

/** The single line a review unit ends with. Markdown emphasis, list markers
 * and a trailing period are tolerated; only the last such line counts. */
const VERDICT_LINE =
  /^\s*(?:[-*>#]+\s*)?(?:\*\*|__|`)?\s*verdict\s*(?:\*\*|__|`)?\s*[:：]\s*(?:\*\*|__|`)?\s*(.+?)\s*(?:\*\*|__|`)?\s*\.?\s*$/i;
const NEGATED = /\b(?:not|never|un)\s*(?:approv|accept|pass)/i;
const APPROVED = /\b(?:approv|accept|pass|lgtm|ok(?:ay)?\b|ship|no\s+(?:material\s+)?(?:findings|changes|issues))/i;
const CHANGES = /\b(?:changes?|reject|fail|block|rework|revis|request|needs?\s+work|incomplete)/i;

/** Reads the review decision from a completed report. A report without an
 * explicit verdict line never sends work back: silence is not a finding. */
export function parseReviewVerdict(output: string): WorkflowReviewVerdict | undefined {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = VERDICT_LINE.exec(lines[index]!);
    if (!match) continue;
    const value = match[1]!;
    // "approved, no changes needed" approves; "not approved" does not.
    if (NEGATED.test(value)) return "changes-requested";
    if (APPROVED.test(value)) return "approved";
    if (CHANGES.test(value)) return "changes-requested";
    return undefined;
  }
  return undefined;
}

export const isReviewNode = (node: Pick<WorkflowNodeDto, "kind">): boolean =>
  node.kind === "review";

/** An executor does the work a review can send back. Leads only plan, and a
 * review cannot rework another review. */
export const isExecutorNode = (node: Pick<WorkflowNodeDto, "kind">): boolean =>
  node.kind !== "lead" && node.kind !== "review";

/** Units a review sends its findings to: its direct dependencies that execute. */
export function reworkTargets(graph: Graph, reviewId: string): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return upstream(graph, reviewId).filter((id) => {
    const node = byId.get(id);
    return !!node && isExecutorNode(node);
  });
}

/** Every unit reachable from the given ones through the graph, excluding them. */
export function descendants(graph: Graph, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const source = stack.pop()!;
    for (const edge of graph.edges) {
      if (edge.source !== source || found.has(edge.target) || ids.includes(edge.target)) continue;
      found.add(edge.target);
      stack.push(edge.target);
    }
  }
  return found;
}

export const MAX_REVIEW_FINDINGS = 30;
export const MAX_FINDING_MESSAGE = 400;
export const MAX_DISPUTES = 30;
export const MAX_DISPUTE_TEXT = 400;

const BLOCKER_WORDS = "blocker|blocking|critical|major|must[- ]?fix";
const NOTE_WORDS = "warning|minor|nit|note|suggestion|optional";
const EMPHASIS = "(?:\\*\\*|__|\\*|_|`)*";
/** `- [blocker] path:line — message`. The severity word must be in square
 * brackets (emphasis around them and any case are fine): a plain bullet such
 * as `- Note: I could not run the tests` is prose, never a finding. The
 * location is optional. */
const FINDING_LINE = new RegExp(
  `^\\s*(?:[-*+•]|\\d+[.)])\\s*${EMPHASIS}\\[\\s*(${BLOCKER_WORDS}|${NOTE_WORDS})\\s*\\]${EMPHASIS}\\s*[:\\-–—]?\\s*(.*)$`,
  "i"
);
const BLOCKER = new RegExp(`^(?:${BLOCKER_WORDS})$`, "i");
/** The first token of a finding: `path`, `path:line` or `path:line-line`,
 * optionally in backticks or bold, optionally followed by a colon. */
const LOCATION_TOKEN = /^(?:\*\*|__|`)*([^\s`*]+?)(?::(\d+)(?:-\d+)?)?(?:\*\*|__|`)*:?(?=\s|$)/;
const SEPARATOR = /^\s*(?:—|–|--|-|:)\s*/;

const strip = (text: string): string =>
  text.replace(/(?:\*\*|__|`)/g, "").replace(/\s+/g, " ").trim();

/** Findings listed one per line as `- [blocker] path:line — what is wrong`.
 * Lines that are not findings are ignored, so a report's prose never turns
 * into findings; a finding without a path keeps its whole message. */
export function parseReviewFindings(output: string): WorkflowReviewFindingDto[] {
  const found: WorkflowReviewFindingDto[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = FINDING_LINE.exec(raw);
    if (!match) continue;
    const severity = BLOCKER.test(match[1]!) ? "blocker" : "note";
    let rest = match[2]!.trim();
    let path: string | undefined;
    let line: number | undefined;
    const located = LOCATION_TOKEN.exec(rest);
    // Only a token that looks like a path counts as one: it has a separator
    // or an extension, or a line number follows it.
    if (located && (located[2] || /[/\\]|\.[A-Za-z][A-Za-z0-9]*$/.test(located[1]!))) {
      path = located[1];
      if (located[2]) line = Number(located[2]);
      rest = rest.slice(located[0].length);
    }
    rest = rest.replace(SEPARATOR, "");
    const message = strip(rest).slice(0, MAX_FINDING_MESSAGE);
    if (!message) continue;
    found.push({
      severity,
      ...(path ? { path: path.slice(0, 300) } : {}),
      ...(line !== undefined && Number.isSafeInteger(line) ? { line } : {}),
      message,
    });
    if (found.length >= MAX_REVIEW_FINDINGS) break;
  }
  return found;
}

/** The decision rule. When a report lists at least one structured finding the
 * blockers decide: none approves (an early exit; notes stay visible), one or
 * more request changes, whatever the verdict line says. Without structured
 * findings there is nothing to decide on and the caller falls back to the
 * verdict line (and Judgment). */
export function verdictFromFindings(
  findings: readonly WorkflowReviewFindingDto[]
): WorkflowReviewVerdict | undefined {
  if (!findings.length) return undefined;
  return findings.some((finding) => finding.severity === "blocker")
    ? "changes-requested"
    : "approved";
}

const DISPUTE_LINE = /^\s*(?:[-*>#]+\s*)?(?:\*\*|__|`)?\s*disputed\s*(?:\*\*|__|`)?\s*[:：]\s*(?:\*\*|__|`)?\s*(.+?)\s*$/i;

/** `Disputed: <finding in a few words> — <why>` lines from an executor's
 * report. A line without a reason is not a dispute. */
export function parseDisputes(output: string): WorkflowDisputeDto[] {
  const found: WorkflowDisputeDto[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = DISPUTE_LINE.exec(raw);
    if (!match) continue;
    const body = strip(match[1]!);
    const split = /\s(?:—|–|--)\s|\s-\s|:\s/.exec(body);
    if (!split) continue;
    const finding = body.slice(0, split.index).trim().slice(0, MAX_DISPUTE_TEXT);
    const reason = body.slice(split.index + split[0].length).trim().slice(0, MAX_DISPUTE_TEXT);
    if (!finding || !reason) continue;
    found.push({ finding, reason });
    if (found.length >= MAX_DISPUTES) break;
  }
  return found;
}

const COMMON_WORDS = new Set(("the and for this that with from into not are was were has have had but its it's can will "
  + "should would could must may does did doesn't isn't when where which what than then them they their there here also only "
  + "too any all each per via use used using over under more most some such own same").split(" "));
const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []).filter((word) => !COMMON_WORDS.has(word)));

/** The builder's reply to a blocker: a dispute naming the same path, or the
 * one sharing most words with the finding. No overlap, no reply. */
export function matchDispute(
  finding: Pick<WorkflowReviewFindingDto, "path" | "message">,
  disputes: readonly WorkflowDisputeDto[]
): WorkflowDisputeDto | undefined {
  const target = words(`${finding.path ?? ""} ${finding.message}`);
  let best: { dispute: WorkflowDisputeDto; score: number } | undefined;
  for (const dispute of disputes) {
    const mine = words(dispute.finding);
    let score = 0;
    for (const word of mine) if (target.has(word)) score++;
    if (finding.path && dispute.finding.toLowerCase().includes(finding.path.toLowerCase())) score += 2;
    if (score > 0 && (!best || score > best.score)) best = { dispute, score };
  }
  return best?.dispute;
}
