import type { AccountGuardrails, GuardrailApprovals, HarnessModelRef } from "@polyth/contracts";
import { tr, type TranslationKey } from "../../i18n/index.ts";

/** Pure editor state for the Protected mode dialog; kept free of React so it can be tested directly. */
export interface GuardrailDraft {
  enabled: boolean;
  models: HarnessModelRef[];
  approvals: GuardrailApprovals;
  /** Capabilities beyond the baseline. */
  extra: string[];
}

/** Capabilities that can change files, run commands, drive the browser or
 *  register server folders as projects. */
export const RISKY_GRANTS: readonly string[] = [
  "core.projects.write",
  "terminal.open",
  "terminal.input",
  "terminal.resize",
  "files.write",
  "git.write",
  "browser.use",
];

const modelKey = (model: HarnessModelRef): string => `${model.harnessId}\u0000${model.providerID}\u0000${model.modelID}`;
export const sameModel = (a: HarnessModelRef, b: HarnessModelRef): boolean => modelKey(a) === modelKey(b);

export const isRiskyGrant = (capability: string): boolean => RISKY_GRANTS.includes(capability);

/** Capabilities the owner may add on top of the baseline, in contract order. */
export function extraGrantChoices(grantable: readonly string[], baseline: readonly string[]): string[] {
  return grantable.filter((capability) => !baseline.includes(capability));
}

export function draftFrom(
  current: AccountGuardrails | null,
  grantable: readonly string[],
  baseline: readonly string[],
): GuardrailDraft {
  if (!current) return { enabled: false, models: [], approvals: "none", extra: [] };
  return {
    enabled: true,
    models: current.models.map((model) => ({ ...model })),
    approvals: current.approvals,
    extra: current.grants.filter((capability) => grantable.includes(capability) && !baseline.includes(capability)),
  };
}

/** `null` removes the guardrails; otherwise baseline + chosen extras. */
export function buildGuardrails(draft: GuardrailDraft, baseline: readonly string[]): AccountGuardrails | null {
  if (!draft.enabled) return null;
  return {
    grants: [...new Set([...baseline, ...draft.extra])],
    models: draft.models.map((model) => ({
      harnessId: model.harnessId,
      providerID: model.providerID,
      modelID: model.modelID,
    })),
    approvals: draft.approvals,
  };
}

export function addModel(models: readonly HarnessModelRef[], model: HarnessModelRef): HarnessModelRef[] {
  return models.some((entry) => sameModel(entry, model)) ? [...models] : [...models, model];
}

export function removeModel(models: readonly HarnessModelRef[], model: HarnessModelRef): HarnessModelRef[] {
  return models.filter((entry) => !sameModel(entry, model));
}

/** The first entry is the default for new chats. */
export function makeDefaultModel(models: readonly HarnessModelRef[], model: HarnessModelRef): HarnessModelRef[] {
  const found = models.find((entry) => sameModel(entry, model));
  return found ? [found, ...models.filter((entry) => !sameModel(entry, model))] : [...models];
}

export function toggleExtra(extra: readonly string[], capability: string, on: boolean): string[] {
  const rest = extra.filter((entry) => entry !== capability);
  return on ? [...rest, capability] : rest;
}

export function draftChanged(a: GuardrailDraft, b: GuardrailDraft): boolean {
  return a.enabled !== b.enabled
    || a.approvals !== b.approvals
    || a.models.length !== b.models.length
    || a.models.some((model, index) => !sameModel(model, b.models[index]!))
    || [...a.extra].sort().join() !== [...b.extra].sort().join();
}

/** Plain-language labels; unknown capabilities fall back to the raw id. */
const GRANT_KEYS: Record<string, readonly [TranslationKey, TranslationKey]> = {
  "core.projects.write": ["settings.guardrails.manageProjects", "settings.guardrails.manageProjectsDetail"],
  "core.sessions.delete": ["settings.guardrails.deleteChats", "settings.guardrails.deleteChatsDetail"],
  "files.read": ["settings.guardrails.readFiles", "settings.guardrails.readFilesDetail"],
  "files.write": ["settings.guardrails.editFiles", "settings.guardrails.editFilesDetail"],
  "terminal.open": ["settings.guardrails.openTerminal", "settings.guardrails.openTerminalDetail"],
  "terminal.input": ["settings.guardrails.typeInTerminal", "settings.guardrails.typeInTerminalDetail"],
  "terminal.resize": ["settings.guardrails.resizeTerminal", "settings.guardrails.resizeTerminalDetail"],
  "git.read": ["settings.guardrails.readGit", "settings.guardrails.readGitDetail"],
  "git.write": ["settings.guardrails.changeGit", "settings.guardrails.changeGitDetail"],
  "browser.use": ["settings.guardrails.useBrowser", "settings.guardrails.useBrowserDetail"],
};

export const grantLabel = (capability: string): { label: string; detail: string } => {
  const keys = GRANT_KEYS[capability];
  return keys ? { label: tr(keys[0]), detail: tr(keys[1]) } : { label: capability, detail: "" };
};
