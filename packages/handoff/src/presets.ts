import type { HandoffPresetDto, JsonObject } from "@polyth/contracts";

export const HANDOFF_PRESETS: HandoffPresetDto[] = [
  {
    id: "review",
    label: "Review changes",
    instruction: "Review these changes critically. Focus on correctness, regressions, security, and anything that should block a merge. Be specific and cite files.",
    sources: [
      { id: "task" },
      { id: "session-summary" },
      { id: "git-diff" },
      { id: "changed-files" },
    ],
  },
  {
    id: "debug",
    label: "Debug failure",
    instruction: "Help me debug this failure. Identify the most likely root cause from the errors and diff, then propose the smallest fix.",
    sources: [
      { id: "task" },
      { id: "session-summary" },
      { id: "session-errors" },
      { id: "git-diff" },
      { id: "changed-files" },
    ],
  },
  {
    id: "plan",
    label: "Plan implementation",
    instruction: "Plan the implementation of this task against the current codebase. List the files to change, the order of work, and the risks.",
    sources: [
      { id: "task" },
      { id: "session-summary" },
      { id: "changed-files" },
      { id: "file", params: { paths: [] } },
    ],
  },
  {
    id: "custom",
    label: "Custom",
    instruction: "",
    sources: [],
  },
];

export function presetById(id: string): HandoffPresetDto | undefined {
  return HANDOFF_PRESETS.find((p) => p.id === id);
}

export function mergePresetSources(
  presetId: string,
  sources: Array<{ id: string; params?: JsonObject }>,
): Array<{ id: string; params?: JsonObject }> {
  const preset = presetById(presetId);
  if (presetId === "custom" || sources.length > 0) return sources;
  return preset?.sources ?? [];
}
