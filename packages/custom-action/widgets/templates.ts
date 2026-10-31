// Starters offered while a library is empty. A template only fills the
// editor; nothing is saved until the person presses Save.
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { CustomActionInput } from "../src/actionModel.ts";

export interface ActionTemplate {
  id: string;
  seed: () => Partial<CustomActionInput>;
}

export const ACTION_TEMPLATES: readonly ActionTemplate[] = [
  {
    id: "tests",
    seed: () => ({ name: tr("customaction.template.testsName"), command: "npm test", icon: "flask", color: "green", mode: "background" }),
  },
  {
    id: "fix-build",
    seed: () => ({
      name: tr("customaction.template.buildName"),
      command: "npm run build",
      icon: "wrench",
      color: "amber",
      mode: "chat",
      chat: { prompt: tr("customaction.template.buildPrompt"), when: "failure" },
    }),
  },
  {
    id: "summary",
    seed: () => ({
      name: tr("customaction.template.summaryName"),
      command: "git status --short --branch && git log --oneline -10",
      icon: "branch",
      color: "purple",
      mode: "chat",
      chat: { prompt: tr("customaction.template.summaryPrompt"), when: "always" },
    }),
  },
  {
    id: "dev",
    seed: () => ({ name: tr("customaction.template.devName"), command: "npm run dev", icon: "rocket", color: "blue", mode: "terminal" }),
  },
];
