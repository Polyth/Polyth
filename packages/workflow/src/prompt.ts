import type { WorkflowNodeDto } from "@polyth/contracts";

export interface WorkflowPromptSource {
  node: Pick<WorkflowNodeDto, "id" | "role">;
  output: string;
}

/** Build one node's instructions, run input, and serialized upstream context. */
export function buildNodePrompt(
  node: WorkflowNodeDto,
  input: string,
  sources: readonly WorkflowPromptSource[] = [],
): string {
  const sections: string[] = [];
  if (node.role.trim()) sections.push(`# Role\n\n${node.role.trim()}`);
  if (node.prompt.trim()) sections.push(`# Instructions\n\n${node.prompt.trim()}`);
  if (input.trim()) sections.push(`# Workflow input\n\n${input.trim()}`);

  const upstreamText = sources
    .filter((source) => source.output.trim())
    .map((source) => `## ${source.node.role} (${source.node.id})\n\n${source.output.trim()}`);
  if (upstreamText.length > 0) {
    sections.push(`# Upstream output\n\n${upstreamText.join("\n\n")}`);
  }
  return sections.join("\n\n");
}
