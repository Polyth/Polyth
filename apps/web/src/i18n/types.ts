import type { Locale } from "@polyth/contracts";
import type { BrowserMessageKey } from "@polyth/browser/i18n";
import type { CommandsMessageKey } from "@polyth/commands/i18n";
import type { DictationMessageKey } from "@polyth/dictation/i18n";
import type { EditorMessageKey } from "@polyth/editor/i18n";
import type { FilesMessageKey } from "@polyth/files/i18n";
import type { FusionMessageKey } from "@polyth/fusion/i18n";
import type { GitMessageKey } from "@polyth/git/i18n";
import type { GithubMessageKey } from "@polyth/github/i18n";
import type { GoalsMessageKey } from "@polyth/goals/i18n";
import type { HomeAssistantMessageKey } from "@polyth/home-assistant/i18n";
import type { HotkeysMessageKey } from "@polyth/hotkeys/i18n";
import type { KnowledgeMessageKey } from "@polyth/knowledge/i18n";
import type { ModelsMessageKey } from "@polyth/models/i18n";
import type { MultirunMessageKey } from "@polyth/multirun/i18n";
import type { PermissionsMessageKey } from "@polyth/permissions/i18n";
import type { PluginsMessageKey } from "@polyth/plugins/i18n";
import type { ScheduleMessageKey } from "@polyth/schedule/i18n";
import type { SecureSafeMessageKey } from "@polyth/secure-safe/i18n";
import type { SshMessageKey } from "@polyth/ssh/i18n";
import type { TerminalMessageKey } from "@polyth/terminal/i18n";
import type { UsageMessageKey } from "@polyth/usage/i18n";
import type { WalkthroughMessageKey } from "@polyth/walkthrough/i18n";
import type { WorkflowMessageKey } from "@polyth/workflow/i18n";
import type { AppMessageKey } from "./locales/en.ts";

export { LOCALES } from "@polyth/contracts";
export type { Locale } from "@polyth/contracts";

/** Every key `tr()` accepts: the app shell's own keys plus the keys of every
 *  package locale bundle merged into the runtime catalog. */
export type TranslationKey =
  | AppMessageKey
  | BrowserMessageKey
  | CommandsMessageKey
  | DictationMessageKey
  | EditorMessageKey
  | FilesMessageKey
  | FusionMessageKey
  | GitMessageKey
  | GithubMessageKey
  | GoalsMessageKey
  | HomeAssistantMessageKey
  | HotkeysMessageKey
  | KnowledgeMessageKey
  | ModelsMessageKey
  | MultirunMessageKey
  | PermissionsMessageKey
  | PluginsMessageKey
  | ScheduleMessageKey
  | SecureSafeMessageKey
  | SshMessageKey
  | TerminalMessageKey
  | UsageMessageKey
  | WalkthroughMessageKey
  | WorkflowMessageKey;

export type TranslationCatalog = Record<TranslationKey, string>;

export const LOCALE_NAMES: Record<Locale, string> = {
  uk: "Українська",
  en: "English",
  de: "Deutsch",
  fr: "Français",
  pl: "Polski",
  "pt-BR": "Português (Brasil)",
  it: "Italiano",
  es: "Español",
  "zh-CN": "简体中文",
  bg: "Български",
  ar: "العربية",
  pt: "Português (Portugal)",
};
