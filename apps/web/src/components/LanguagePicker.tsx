// The interface language as a choice anyone can spot: the language glyph and
// the current language's own name, opening every supported language with the
// system language first. First-run surfaces (setup, the interface tour) carry
// it because the system language is only a guess about what the person reads;
// Settings keeps its own row. The switch happens in place: callers re-render
// through the locale subscription and keep whatever the person has entered.
import { useSyncExternalStore } from "react";
import {
  getLocalePreference,
  getLocaleSnapshot,
  LOCALES,
  LOCALE_NAMES,
  setLocale,
  subscribeLocale,
  systemLocale,
  tr,
  type LocalePreference,
} from "../i18n/index.ts";
import { Button, ChevronDownIcon, LanguageIcon, Menu, type MenuEntry } from "./ui/index.ts";

export default function LanguagePicker({ className }: { className?: string }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  const preference = getLocalePreference();
  const choose = (next: LocalePreference) => { void setLocale(next); };
  const entries: MenuEntry[] = [
    {
      id: "system",
      label: tr("settings.pages.languageSystem", { language: LOCALE_NAMES[systemLocale()] }),
      kind: "radio",
      checked: preference === "system",
      onSelect: () => choose("system"),
    },
    ...LOCALES.map((option): MenuEntry => ({
      id: option,
      label: LOCALE_NAMES[option],
      kind: "radio",
      checked: preference === option,
      onSelect: () => choose(option),
    })),
  ];
  const label = tr("common.language");
  return (
    <Menu label={label} entries={entries} align="end">
      {(trigger) => (
        <Button
          {...trigger}
          size="sm"
          iconStart={LanguageIcon}
          iconEnd={ChevronDownIcon}
          className={["language-picker", className].filter(Boolean).join(" ")}
          aria-label={`${label}: ${LOCALE_NAMES[locale]}`}
          title={label}
        >
          {LOCALE_NAMES[locale]}
        </Button>
      )}
    </Menu>
  );
}
