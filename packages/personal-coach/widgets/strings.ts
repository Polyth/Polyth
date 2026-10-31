/**
 * Locale-aware lookup for the Personal Coach package.
 *
 * Messages live in `src/i18n/`, which the shell's i18n loader merges through
 * the package manifest's `./i18n` exports. `main.tsx` points the helper at
 * `host.ui.locale.translate`; direct component mounts (tests) fall back to the
 * bundled English catalog. Call sites keep the flat `t(key, values)` helper.
 */
import { en, type CoachMessageKey } from "../src/i18n/en.ts";

export type CoachStringKey = CoachMessageKey;

type Translator = (key: CoachMessageKey, values?: Record<string, string | number>) => string;

const interpolate = (message: string, values?: Record<string, string | number>): string => {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    values[name] === undefined ? whole : String(values[name]));
};

const english: Translator = (key, values) => interpolate(en[key] ?? key, values);

let translate: Translator = english;

/** Point the package helper at the host's locale translator. */
export function setCoachTranslator(next: Translator): void {
  translate = next;
}

/** Resolve one Coach string, substituting `{name}` placeholders. Missing values
 *  leave the placeholder visible rather than printing "undefined", so a broken
 *  call site is obvious in review instead of shipping silently. */
export function t(key: CoachStringKey, values?: Record<string, string | number>): string {
  return translate(key, values);
}
