import type { CadenceView } from "../src/cadenceView.ts";
import { localTimeZone, oncePresetAt } from "../src/cadenceView.ts";
import type { PlannerMessageKey } from "../src/i18n/index.ts";

/** Starting points offered on an empty Planner. They only prefill the form. */
export interface PlannerTemplate {
  id: string;
  title: PlannerMessageKey;
  prompt: PlannerMessageKey;
  view: () => CadenceView;
}

export const PLANNER_TEMPLATES: readonly PlannerTemplate[] = [
  {
    id: "briefing",
    title: "template.briefing",
    prompt: "template.briefingPrompt",
    view: () => ({ mode: "weekly", days: [1, 2, 3, 4, 5], hour: 9, minute: 0, timeZone: localTimeZone() }),
  },
  {
    id: "review",
    title: "template.review",
    prompt: "template.reviewPrompt",
    view: () => ({ mode: "weekly", days: [1], hour: 10, minute: 0, timeZone: localTimeZone() }),
  },
  {
    id: "tidy",
    title: "template.tidy",
    prompt: "template.tidyPrompt",
    view: () => ({ mode: "weekly", days: [5], hour: 16, minute: 0, timeZone: localTimeZone() }),
  },
  {
    id: "reminder",
    title: "template.reminder",
    prompt: "template.reminderPrompt",
    view: () => ({ mode: "once", at: oncePresetAt("tomorrow-morning") }),
  },
];
