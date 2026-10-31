import type {
  NativePluginComponentKind,
  NativePluginDto,
  NativePluginEffect,
  NativePluginListDto,
  NativePluginMutationResponseDto,
  NativePluginScope,
  NativePluginSourceKind,
} from "@polyth/contracts/capability-installations";

import { englishTranslate, pluralKey, type Translate } from "./englishTranslate.ts";

const camel = (id: string): string => id.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase());

export const effectTone = (effect: NativePluginEffect): "success" | "warning" | "info" | "neutral" =>
  effect === "active" ? "success" : effect === "hidden-by-polyth" || effect === "unsupported" ? "warning" : effect === "emulated" ? "info" : "neutral";
const MAX_OPTIONS_BYTES = 16 * 1024;

const OPTIONS_EXAMPLE = '{"key": "value"}';

export type PluginComponentChip = { id: string; label: string; effect: string; tone: ReturnType<typeof effectTone>; description: string };

export type PluginProject = NonNullable<NativePluginListDto["project"]>;

/** Scopes written inside a project's folder; unavailable without a project. */
export const projectScope = (scope: NativePluginScope): boolean => scope === "project" || scope === "local";

/** "project Alpha (/work/alpha)". */
export const projectName = (project: PluginProject, t: Translate = englishTranslate): string =>
  t("plugins.projectName", { name: project.name, path: project.path });

export const scopeLabel = (scope: NativePluginScope, t: Translate = englishTranslate): string => t(`plugins.scope.${scope}`);
/** Where a scope applies; a project scope names the project when known. */
export const scopeHint = (scope: NativePluginScope, project?: PluginProject, t: Translate = englishTranslate): string => {
  if (!projectScope(scope) || !project) return t(`plugins.scopeHint.${scope}`);
  return t(scope === "project" ? "plugins.scopeHint.projectShared" : "plugins.scopeHint.projectLocal", { project: projectName(project, t) });
};

/** Install scopes the form may offer: project scopes need a named project. */
export const installableScopes = (scopes: readonly NativePluginScope[], project?: PluginProject): NativePluginScope[] =>
  scopes.filter((scope) => project || !projectScope(scope));

/** The install confirmation sentence, before the risk text. Options are only
 * mentioned, never shown: they may hold credentials. */
export function installQuestion(plugin: string, scope: NativePluginScope | undefined, project: PluginProject | undefined, withOptions: boolean, t: Translate = englishTranslate): string {
  const suffix = withOptions ? "Options" : "";
  if (scope && projectScope(scope) && project) {
    return t(`plugins.installQ.${scope === "local" ? "projectLocal" : "project"}${suffix}`, { plugin, project: projectName(project, t) });
  }
  if (scope) return t(`plugins.installQ.scope${suffix}`, { plugin, scope: t(`plugins.scopeNoun.${scope}`) });
  return t(`plugins.installQ.plain${withOptions ? "Options" : ""}`, { plugin });
}

/** The import confirmation sentence for `count` entries. */
export function importQuestion(count: number, scope: NativePluginScope | undefined, project: PluginProject | undefined, t: Translate = englishTranslate): string {
  if (scope && projectScope(scope) && project) return t(pluralKey("plugins.importQ.project", count), { count, project: projectName(project, t) });
  if (scope) return t(pluralKey("plugins.importQ.scope", count), { count, scope: t(`plugins.scopeNoun.${scope}`) });
  return t(pluralKey("plugins.importQ.plain", count), { count });
}

/** Parses the optional options field: empty means none, otherwise a JSON object. */
export function parsePluginOptions(text: string, t: Translate = englishTranslate): { options?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: t("plugins.optionsInvalidJson") };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: t("plugins.optionsNotObject", { example: OPTIONS_EXAMPLE }) };
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > MAX_OPTIONS_BYTES) return { error: t("plugins.optionsTooBig") };
  return { options: parsed as Record<string, unknown> };
}

/** "Marketplace · official" / "npm · @scope/pkg". */
export const sourceLabel = (plugin: Pick<NativePluginDto, "source">, t: Translate = englishTranslate): string => {
  const kind: NativePluginSourceKind = plugin.source.kind;
  // npm, Git and URL are protocol names and stay as they are.
  const label = kind === "marketplace" || kind === "local" || kind === "unknown" ? t(`plugins.source.${kind}`)
    : kind === "npm" ? "npm" : kind === "git" ? "Git" : "URL";
  return [label, plugin.source.ref].filter(Boolean).join(" · ");
};

export function componentChips(plugin: Pick<NativePluginDto, "components">, t: Translate = englishTranslate): PluginComponentChip[] {
  return (plugin.components ?? []).filter((component) => component.count > 0).map((component) => {
    const kind: NativePluginComponentKind = component.kind;
    const names = component.names?.length ? ` ${component.names.join(", ")}.` : "";
    const effect = camel(component.effect);
    return {
      id: kind,
      label: t(pluralKey(`plugins.component.${camel(kind)}`, component.count), { count: component.count }),
      effect: t(`plugins.effect.${effect}`),
      tone: effectTone(component.effect),
      description: `${component.reason ?? t(`plugins.effectDesc.${effect}`)}${names}`.trim(),
    };
  });
}

export const appliesText = (list: Pick<NativePluginListDto, "support">, t: Translate = englishTranslate): string =>
  t(list.support.applies === "runtime-restart" ? "plugins.appliesRuntimeRestart" : "plugins.appliesNextSession");

export type PluginOutcomeNotice = { tone: "success" | "error" | "warning"; text: string; details?: string[] };

const actionKeys: Record<string, string> = {
  install: "installed",
  uninstall: "removed",
  enable: "turnedOn",
  disable: "turnedOff",
  update: "updated",
};

/** User-facing text for a mutation response. A refusal is a known result; only
 * `unknown` says the outcome is unconfirmed. */
export function outcomeNotice(action: string, plugin: string, response: NativePluginMutationResponseDto, applies: "next-session" | "runtime-restart", t: Translate = englishTranslate): PluginOutcomeNotice {
  if (response.outcome === "confirmed") {
    const message = response.message?.trim() ? sentence(response.message.trim()) : "";
    // The harness's own words win: "already in the config; nothing changed"
    // is neither an install nor a reason to restart.
    if (/\bnothing (?:was )?changed\b/i.test(message)) {
      return { tone: "success", text: t("plugins.unchanged", { plugin, message }) };
    }
    // Only the backend knows whether its runtime still has to restart.
    const when = response.pendingRestart
      ? t("plugins.restartToApply")
      : applies === "next-session" ? t("plugins.newConversationsUse") : "";
    return { tone: "success", text: [t(`plugins.action.${actionKeys[action] ?? "changed"}`, { plugin }), message, when].filter(Boolean).join(" ") };
  }
  if (response.outcome === "rejected") {
    if (response.code === "confirmation-required") {
      return { tone: "error", text: `${t("plugins.confirmationRequired", { plugin })}${response.message ? ` ${response.message}` : ""}` };
    }
    if (response.code === "not-installed") {
      return { tone: "error", text: response.message || t("plugins.notInstalled") };
    }
    return { tone: "error", text: response.message ? t("plugins.nothingChanged", { message: response.message }) : t("plugins.refused") };
  }
  return {
    tone: "warning",
    text: t(response.list ? "plugins.unconfirmedWithList" : "plugins.unconfirmedNoList"),
  };
}

const sentence = (text: string): string => /[.!?…]$/.test(text) ? text : `${text}.`;

export type PluginImportResult =
  | { spec: string; response: NativePluginMutationResponseDto }
  | { spec: string; failure: PluginOutcomeNotice };

/** One notice for an import: every attempted entry with its own outcome, and
 * why it stopped early when an outcome was not confirmed. */
export function importSummary(results: readonly PluginImportResult[], total: number, applies: "next-session" | "runtime-restart", t: Translate = englishTranslate): PluginOutcomeNotice {
  const entryText = (result: PluginImportResult): PluginOutcomeNotice => {
    if (!("response" in result)) return result.failure;
    const { response } = result;
    if (response.outcome !== "confirmed") return outcomeNotice("install", result.spec, response, applies, t);
    return { tone: "success", text: response.message?.trim() ? sentence(response.message.trim()) : t("plugins.installedShort") };
  };
  const notices = results.map(entryText);
  const done = results.filter((result) => "response" in result && result.response.outcome === "confirmed");
  const restart = done.some((result) => "response" in result && result.response.pendingRestart);
  // The import only stops early on an outcome it cannot confirm.
  const last = results.at(-1);
  const stopped = Boolean(last) && results.length < total;
  const tone = notices.some((notice) => notice.tone === "warning") ? "warning"
    : notices.some((notice) => notice.tone === "error") ? "error" : "success";
  const parts = [
    t(pluralKey("plugins.importDone", total), { done: done.length, total }),
    restart ? t("plugins.restartToApplyThem") : done.length && applies === "next-session" ? t("plugins.newConversationsUseThem") : "",
    stopped ? t("plugins.stoppedAt", { spec: last!.spec, remaining: total - results.length }) : "",
  ];
  return {
    tone,
    text: parts.filter(Boolean).join(" "),
    details: results.map((result, index) => `${result.spec} — ${notices[index]!.text}`),
  };
}

/** Error text for a failed request, by HTTP status. */
export function requestFailureText(status: number | undefined, message: string, t: Translate = englishTranslate): string {
  if (status === 403) return t("plugins.ownerOnly");
  if (status === undefined) return t("plugins.connectionDropped");
  return message;
}
