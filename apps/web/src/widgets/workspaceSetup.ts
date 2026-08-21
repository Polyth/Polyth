import type { WidgetDef } from "./catalog.ts";
import {
  applyWidgetLayoutMutations,
  type WidgetAudience,
  type WidgetLayout,
  type WidgetLayoutMutation,
  type WidgetLayoutPresetId,
} from "./widgetLayout.ts";

export type SetupWorkflow =
  | "build-debug"
  | "plan-coordinate"
  | "research"
  | "design-explore"
  | "write"
  | "general";

export interface WorkspaceSetupDraft {
  workflow: SetupWorkflow;
  audience: WidgetAudience;
  widgetIds: string[];
}

export const MIN_SETUP_WIDGETS = 5;
export const MAX_SETUP_WIDGETS = 8;

export function validSetupWidgetCount(widgetIds: readonly string[]): boolean {
  const unique = new Set(widgetIds);
  return unique.size === widgetIds.length
    && unique.size >= MIN_SETUP_WIDGETS
    && unique.size <= MAX_SETUP_WIDGETS;
}

export interface WorkflowOption {
  id: SetupWorkflow;
  label: string;
  description: string;
  preset: WidgetLayoutPresetId;
  suggestedWidgetIds: readonly string[];
}

export const WORKFLOW_OPTIONS: readonly WorkflowOption[] = [
  {
    id: "build-debug",
    label: "Build & debug",
    description: "Code, changes, terminal, preview, and live activity.",
    preset: "build-debug",
    suggestedWidgetIds: [
      "core.composer", "files.explorer", "git.recent", "terminal.shell",
      "preview.app", "session.work-status", "session.activity",
    ],
  },
  {
    id: "plan-coordinate",
    label: "Plan & coordinate",
    description: "Goals, notes, schedule, progress, and review.",
    preset: "manager",
    suggestedWidgetIds: [
      "core.composer", "goals.current", "knowledge.notes", "schedule.tasks",
      "usage.session", "walkthrough.review",
    ],
  },
  {
    id: "research",
    label: "Research",
    description: "Conversation, notes, browser, GitHub, and sources.",
    preset: "balanced",
    suggestedWidgetIds: [
      "core.composer", "core.chat", "knowledge.notes", "github.overview",
      "files.project-map", "core.quick-actions",
    ],
  },
  {
    id: "design-explore",
    label: "Design & explore",
    description: "Ideas, previews, project context, and quick actions.",
    preset: "balanced",
    suggestedWidgetIds: [
      "core.composer", "preview.app", "files.project-map", "knowledge.notes",
      "core.quick-actions", "goals.current",
    ],
  },
  {
    id: "write",
    label: "Write",
    description: "A calm composer with notes, goals, and references nearby.",
    preset: "focused",
    suggestedWidgetIds: [
      "core.composer", "knowledge.notes", "goals.current", "files.project-map",
      "core.quick-actions",
    ],
  },
  {
    id: "general",
    label: "General assistant",
    description: "A balanced place to ask, plan, build, and review.",
    preset: "balanced",
    suggestedWidgetIds: [
      "core.composer", "core.quick-actions", "goals.current", "files.project-map",
      "git.recent", "knowledge.notes", "session.work-status",
    ],
  },
] as const;

export function workflowOption(id: SetupWorkflow): WorkflowOption {
  return WORKFLOW_OPTIONS.find((option) => option.id === id) ?? WORKFLOW_OPTIONS.at(-1)!;
}

export function createSetupDraft(workflow: SetupWorkflow = "general"): WorkspaceSetupDraft {
  const option = workflowOption(workflow);
  return { workflow, audience: "standard", widgetIds: [...option.suggestedWidgetIds] };
}

export function setupMutations(draft: WorkspaceSetupDraft): WidgetLayoutMutation[] {
  return [
    { type: "preset", preset: workflowOption(draft.workflow).preset },
    { type: "audience", audience: draft.audience },
    ...draft.widgetIds.map((id): WidgetLayoutMutation => ({ type: "visibility", id, visible: true })),
  ];
}

export function applyWorkspaceSetup(
  layout: WidgetLayout,
  draft: WorkspaceSetupDraft,
  widgets: readonly WidgetDef[],
): WidgetLayout {
  return applyWidgetLayoutMutations(layout, setupMutations(draft), widgets);
}
