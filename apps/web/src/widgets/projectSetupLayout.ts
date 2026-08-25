import type { WidgetDef } from "./catalog.ts";
import {
  applyWidgetLayoutMutations,
  type WidgetAudience,
  type WidgetLayout,
  type WidgetLayoutMutation,
} from "./widgetLayout.ts";
import { tr } from "../i18n/index.ts";

export type SetupWorkflow =
  | "build-debug"
  | "plan-coordinate"
  | "research"
  | "design-explore"
  | "write"
  | "general";

export interface ProjectSetupDraft {
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
  suggestedWidgetIds: readonly string[];
}

export const WORKFLOW_OPTIONS: readonly WorkflowOption[] = [
  {
    id: "build-debug",
    label: tr("widgets.projectsetuplayout.buildDebug"),
    description: tr("widgets.projectsetuplayout.codeChangesTerminalInternalBrowser"),
    suggestedWidgetIds: [
      "core.chat", "files.explorer", "git.recent", "terminal.shell",
      "browser.app", "session.work-status", "session.activity",
    ],
  },
  {
    id: "plan-coordinate",
    label: tr("widgets.projectsetuplayout.planCoordinate"),
    description: tr("widgets.projectsetuplayout.goalsNotesScheduleProgressAndReview"),
    suggestedWidgetIds: [
      "core.chat", "goals.current", "knowledge.notes", "schedule.tasks",
      "usage.session", "walkthrough.review",
    ],
  },
  {
    id: "research",
    label: tr("widgets.projectsetuplayout.research2"),
    description: tr("widgets.projectsetuplayout.conversationNotesBrowserGithubAndSources"),
    suggestedWidgetIds: [
      "core.chat", "knowledge.notes", "github.overview",
      "files.project-map", "core.quick-actions",
    ],
  },
  {
    id: "design-explore",
    label: tr("widgets.projectsetuplayout.designExplore"),
    description: tr("widgets.projectsetuplayout.ideasBrowserContextProjectContext"),
    suggestedWidgetIds: [
      "core.chat", "browser.app", "files.project-map", "knowledge.notes",
      "core.quick-actions", "goals.current",
    ],
  },
  {
    id: "write",
    label: tr("widgets.projectsetuplayout.write2"),
    description: tr("widgets.projectsetuplayout.aCalmComposerWithNotesGoalsAnd"),
    suggestedWidgetIds: [
      "core.chat", "knowledge.notes", "goals.current", "files.project-map",
      "core.quick-actions",
    ],
  },
  {
    id: "general",
    label: tr("widgets.projectsetuplayout.generalAssistant"),
    description: tr("widgets.projectsetuplayout.aBalancedPlaceToAskPlanBuild"),
    suggestedWidgetIds: [
      "core.chat", "core.quick-actions", "goals.current", "files.project-map",
      "git.recent", "knowledge.notes", "session.work-status",
    ],
  },
] as const;

export function workflowOption(id: SetupWorkflow): WorkflowOption {
  return WORKFLOW_OPTIONS.find((option) => option.id === id) ?? WORKFLOW_OPTIONS.at(-1)!;
}

export function createSetupDraft(workflow: SetupWorkflow = "general"): ProjectSetupDraft {
  const option = workflowOption(workflow);
  return { workflow, audience: "standard", widgetIds: [...option.suggestedWidgetIds] };
}

export function setupMutations(
  draft: ProjectSetupDraft,
  widgets: readonly Pick<WidgetDef, "id">[],
): WidgetLayoutMutation[] {
  const selected = new Set(draft.widgetIds);
  return [
    { type: "audience", audience: draft.audience },
    ...widgets.map(({ id }): WidgetLayoutMutation => ({
      type: "visibility",
      id,
      visible: selected.has(id),
    })),
  ];
}

export function applyProjectSetup(
  layout: WidgetLayout,
  draft: ProjectSetupDraft,
  widgets: readonly WidgetDef[],
): WidgetLayout {
  return applyWidgetLayoutMutations(layout, setupMutations(draft, widgets), widgets);
}
