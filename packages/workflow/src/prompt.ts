import type { WorkflowNodeDto, WorkflowRunContextDto } from "@polyth/contracts";

const MAX_PROMPT_CONTEXT = 12_000;

export interface WorkflowPromptSource {
  node: Pick<WorkflowNodeDto, "id" | "role">;
  output: string;
  sessionId?: string;
  /** Immediate dependencies take priority over older ancestor briefs. */
  direct?: boolean;
}

/** Every review unit ends its report with this line; the engine reads it. */
export const REVIEW_VERDICT_REQUIREMENT =
  "# Review verdict\n\nYou are a review gate. The units directly before you receive your findings and rework them in their own sessions, then you review again. Request changes only for concrete, actionable findings an executor can fix: for each, name the file or path, what is wrong, and what done looks like. Do not request changes for style preferences or for work outside the original request. List every finding on its own line as `- [blocker] path:line — what is wrong and what done looks like`, or `- [note] path:line — …` for an optional suggestion; notes never send work back, and the blockers decide the outcome. List a finding only once, and omit the path when it concerns no single file. End your report with exactly one final line, nothing after it: `Verdict: approved` or `Verdict: changes requested`.";

const HANDOFF_REQUIREMENT =
  "# Handoff requirements\n\nComplete this execution unit's instructions within the authorized scope before returning. End with the actual result, checks performed and their outcomes, and any unresolved requirements or concrete blockers. Progress notes, plans, and offers to continue are not a finished result. If your instructions permit edits, resolve actionable upstream findings and rerun affected checks; otherwise report them precisely for the next worker. Do not claim the task is complete while required work remains. When an upstream report is shortened, read its referenced child session for the full findings before acting.";

/** Units share what they located so the next one does not search again. */
export const FACTS_HEADING = "Located facts";
/** Most fact lines one unit's report contributes. */
export const MAX_UNIT_FACTS = 20;
/** Most fact lines a run carries, and the longest one. */
export const MAX_RUN_FACTS = 40;
export const MAX_FACT_CHARS = 240;
/** Share of a unit's prompt the facts may take. */
const MAX_FACTS_PROMPT = 3_000;

const FACTS_REQUIREMENT =
  `# ${FACTS_HEADING}\n\nBefore your closing lines add a \`# ${FACTS_HEADING}\` section (this exact English heading): at most ${MAX_UNIT_FACTS} lines \`- locator — what is there\` for what later units must find again, where the locator is \`path:line\` for code and files or the URL of a source. Only what you opened and checked, nothing already listed above. Omit the section if there is nothing new.`;

/** The heading as a markdown heading, a bold line or a plain labelled line. */
const FACTS_SECTION = new RegExp(`^(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?${FACTS_HEADING}(?:\\*\\*|__)?[ \\t]*:?(?:\\*\\*|__)?[ \\t]*$`, "i");
/** A locator, then a dash and the fact. The locator is a URL, a file with an
 * extension (`a/b.ts`, `a/b.ts:12`, `a/b.ts:12-40`, `a.md#part`) or a path
 * with at least one slash. A line without one is an opinion, not a location. */
const FACT_LINE = /^(?:https?:\/\/\S+|[\w@.()[\]~/-]*[\w)\]]\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?(?:#[\w.-]+)?|[\w@.()[\]~-]+(?:\/[\w@.()[\]~-]+)+\/?)\s+[—–-]\s+\S/;
const CONTROL = /[\u0000-\u001f\u007f]+/g;

const factText = (line: string): string =>
  line.replace(CONTROL, " ").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^`([^`]+)`/, "$1").trim().slice(0, MAX_FACT_CHARS);

/** The fact lines of a unit's report and the report without that section.
 * Only `locator — fact` lines under the heading count; anything else there
 * is dropped, and the section ends at the next heading. */
export function parseFacts(output: string): { facts: string[]; rest: string } {
  const lines = output.split("\n");
  const facts: string[] = [];
  const rest: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (FACTS_SECTION.test(trimmed)) { inside = true; continue; }
    if (inside && /^#{1,6}\s/.test(trimmed)) inside = false;
    // A review's closing verdict follows the section without a heading.
    if (inside && /^\**verdict\b/i.test(trimmed)) inside = false;
    if (!inside) { rest.push(line); continue; }
    const fact = factText(line);
    if (fact && FACT_LINE.test(fact) && facts.length < MAX_UNIT_FACTS && !facts.includes(fact)) facts.push(fact);
  }
  return { facts, rest: rest.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Facts a launcher supplies: any single line of text, bounded. */
export function launchFacts(value: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of value) {
    const fact = factText(entry);
    if (fact && !out.includes(fact)) out.push(fact);
    if (out.length >= MAX_RUN_FACTS) break;
  }
  return out;
}

/** `existing` plus the new lines, oldest first, within the run's limit. A full
 * map keeps what it has: the launcher's and the first units' facts are the
 * ones every later unit builds on. */
export function mergeFacts(existing: readonly string[], added: readonly string[]): string[] {
  const out = [...existing];
  for (const fact of added) {
    if (out.length >= MAX_RUN_FACTS) break;
    if (!out.includes(fact)) out.push(fact);
  }
  return out;
}

function factsSection(facts: readonly string[], available: number): string {
  const heading = `# ${FACTS_HEADING} so far\n\nThe launcher and earlier units already located these. Do not search for them again: open only the lines you need, and re-check a line before you rely on it.\n\n`;
  const budget = Math.min(MAX_FACTS_PROMPT, available) - heading.length;
  const lines: string[] = [];
  let used = 0;
  for (const fact of facts) {
    if (used + fact.length + 3 > budget) break;
    lines.push(`- ${fact}`);
    used += fact.length + 3;
  }
  return lines.length ? heading + lines.join("\n") : "";
}

/** Build one node's instructions, run input, and serialized upstream context. */
export function buildNodePrompt(
  node: WorkflowNodeDto,
  input: string,
  sources: readonly WorkflowPromptSource[] = [],
  context?: WorkflowRunContextDto,
  team: readonly WorkflowNodeDto[] = [],
  /** The run's located facts so far. */
  facts: readonly string[] = []
): string {
  const sections: string[] = [];
  if (node.role.trim()) sections.push(`# Role\n\n${node.role.trim()}`);
  sections.push(
    `# Execution unit\n\n${node.id}${node.group ? ` (group: ${node.group})` : ""}`
  );
  if (node.prompt.trim())
    sections.push(`# Instructions\n\n${node.prompt.trim()}`);
  sections.push(HANDOFF_REQUIREMENT);
  sections.push(FACTS_REQUIREMENT);
  if (node.kind === "review") sections.push(REVIEW_VERDICT_REQUIREMENT);
  if (node.kind === "lead" && team.length) {
    sections.push(`# Workflow team\n\nAssign work to these exact execution-unit IDs:\n${team
      .filter((member) => member.id !== node.id)
      .map((member) => `- ${member.id}: ${member.role}${member.group ? ` (group: ${member.group})` : ""}`)
      .join("\n")}`);
  }
  if (input.trim()) sections.push(`# Workflow input\n\n${input.trim()}`);

  // Parent conversation context is assembled once by the server from the
  // validated canonical event stream. Keep it bounded and pass it only to
  // entry nodes; downstream nodes receive the explicit upstream outputs.
  // A launch that shares only the request repeats the input above: skip it.
  const conversation = context?.conversation?.trim() ?? "";
  if (conversation && conversation !== `User: ${input.trim()}` && sources.length === 0) {
    const heading = "# Parent conversation context\n\n";
    const remaining = MAX_PROMPT_CONTEXT - sections.join("\n\n").length - heading.length - 2;
    // Preserve the newest canonical messages after reserving the instructions
    // and current request. A final prefix slice would discard the latest turn.
    if (remaining > 0) sections.push(heading + conversation.slice(-remaining));
  }
  if (context?.attachments?.length && sources.length === 0) {
    const attachments = context.attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mime}, ${attachment.size} bytes${
          attachment.path ? `, ${attachment.path}` : ""
        })`
    );
    sections.push(`# Supplied attachments\n\n${attachments.join("\n")}`);
  }

  // Facts are the densest context a unit gets, so they are placed before the
  // upstream reports, which give up that room and no longer repeat them.
  const located = factsSection(facts, MAX_PROMPT_CONTEXT - sections.join("\n\n").length - 2);
  if (located) sections.push(located);
  const upstreamText = serializeSources(sources, MAX_PROMPT_CONTEXT - sections.join("\n\n").length - 24);
  if (upstreamText) sections.push(`# Upstream output\n\n${upstreamText}`);
  return sections.join("\n\n").slice(0, MAX_PROMPT_CONTEXT);
}

/** Upstream reports under role headings, newest-relevant first, within budget. */
function serializeSources(sources: readonly WorkflowPromptSource[], available: number): string {
  const nonemptySources = sources
    .map((source) => ({ ...source, output: parseFacts(source.output).rest }))
    .filter((source) => source.output.trim())
    .sort((a, b) => Number(b.direct === true) - Number(a.direct === true));
  if (!nonemptySources.length) return "";
  const headers = nonemptySources.map((source) =>
    `## ${source.node.role} (${source.node.id})\n\n${source.sessionId ? `Child session: ${source.sessionId}\n\n` : ""}`);
  let budget = Math.max(0, available - headers.reduce((total, header) => total + header.length + 2, 0));
  const directCount = nonemptySources.filter((source) => source.direct).length;
  const ancestorCount = nonemptySources.length - directCount;
  const ancestorReserve = Math.min(ancestorCount * 250, Math.floor(budget / 4));
  const perDirect = Math.min(4_000, Math.floor((budget - ancestorReserve) / Math.max(1, directCount)));
  const omitted = "[Earlier output omitted; read the child session for the full report.]\n\n";
  return nonemptySources.map((source, index) => {
    const limit = source.direct ? perDirect
      : Math.min(4_000, Math.floor(budget / Math.max(1, nonemptySources.length - index)));
    const output = source.output.trim();
    const shortened = output.length <= limit ? output
      : limit > omitted.length ? omitted + output.slice(-(limit - omitted.length))
        : output.slice(Math.max(0, output.length - limit));
    budget -= shortened.length;
    return headers[index]! + shortened;
  }).join("\n\n");
}

export interface WorkflowReworkPrompt {
  /** The round this unit is now on (2 for the first rework). */
  round: number;
  /** Review reports that requested changes (executors) or the reworked
   * reports of the units before this one (reviews and other dependents). */
  sources: readonly WorkflowPromptSource[];
  /** The unit continues in its own child session, so its original brief,
   * the request and its earlier work are already in that session's history.
   * A fresh session receives the full brief again. */
  resumed: boolean;
  /** This unit's own last report, repeated only for a fresh session. */
  previousOutput?: string;
  /** The person's guidance after the rounds ran out and they asked for another. */
  guidance?: string;
}

/** The follow-up turn a unit receives when a review sends work back. */
export function buildReworkPrompt(
  node: WorkflowNodeDto,
  input: string,
  rework: WorkflowReworkPrompt,
  base?: { sources?: readonly WorkflowPromptSource[]; context?: WorkflowRunContextDto; team?: readonly WorkflowNodeDto[]; facts?: readonly string[] }
): string {
  const sections: string[] = [];
  if (!rework.resumed) {
    sections.push(buildNodePrompt(node, input, base?.sources ?? [], base?.context, base?.team ?? [], base?.facts ?? []));
    if (rework.previousOutput?.trim())
      sections.push(`# Your previous report (round ${rework.round - 1})\n\n${rework.previousOutput.trim().slice(-3_000)}`);
  }
  const review = node.kind === "review";
  const heading = review
    ? `# Re-review (round ${rework.round})\n\nThe units before you addressed your findings and report below. Re-inspect the actual work, not the reports: confirm each earlier finding as resolved or still open, note any new material issue, and keep your standard unchanged.`
    : rework.sources.some((source) => source.node.role)
      ? `# Rework (round ${rework.round})\n\nA review sent this work back. Address every finding within your scope in the actual working tree, building on your previous work rather than starting over. Fix every blocker. For a blocker you deliberately do not change, end your report with one line per blocker, \`Disputed: <finding in a few words> — <why>\`, instead of silently skipping it. Rerun the affected checks after your last edit.`
      : `# Update (round ${rework.round})\n\nThe work you depend on changed after review. Redo your unit against the current state.`;
  sections.push(heading);
  if (rework.guidance?.trim())
    sections.push(`# Guidance from the person\n\nThe review rounds ran out with blockers still open, and the person who started this run asked for another round with this guidance. It takes priority over the findings it contradicts.\n\n${rework.guidance.trim().slice(0, 2_000)}`);
  const reports = serializeSources(rework.sources, MAX_PROMPT_CONTEXT - sections.join("\n\n").length - 400);
  if (reports) sections.push(`# ${review ? "Rework reports" : "Review findings"}\n\n${reports}`);
  sections.push(review
    ? "End with the same handoff as before and exactly one final line: `Verdict: approved` or `Verdict: changes requested`."
    : "End with the same handoff as before: what changed, the checks you ran and their outcomes, and anything still unresolved.");
  return sections.join("\n\n").slice(0, MAX_PROMPT_CONTEXT);
}
