export interface ConflictPresentation {
  changeRequest?: string;
  numberPrefix?: string;
}

export function buildConflictResolutionPrompt(
  detail: { number: number; title: string; url: string; baseRefName: string; headRefName: string },
  userPrompt: string,
  presentation: ConflictPresentation = {},
): string {
  const instructions = userPrompt.trim();
  const kind = presentation.changeRequest ?? "pull request";
  const prefix = presentation.numberPrefix ?? "#";
  return [
    `Resolve the merge conflicts for ${kind} ${prefix}${detail.number}.`, "",
    "Pull request context:", `- Title: ${detail.title}`, `- URL: ${detail.url}`,
    `- Base branch: ${detail.baseRefName}`, `- Head branch: ${detail.headRefName}`, "",
    "User instructions:", instructions || "Inspect and resolve every merge conflict in the current worktree.", "",
    "Required safety and completion steps:", "- Resolve the conflicts carefully and explain each non-obvious decision.",
    "- Run the relevant tests or checks after resolving the conflicts.",
    "- Commit the completed conflict resolution locally with a descriptive commit message.",
    "- Do not merge the pull request or push any commits without explicit user approval.",
  ].join("\n");
}
