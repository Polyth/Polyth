/**
 * Canonical English messages owned by the hotkeys package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "settings.shortcutspage.clickToChange": "Click to change",
  "settings.shortcutspage.conflictsWith": "Conflicts with",
  "settings.shortcutspage.plugin": "plugin",
  "settings.shortcutspage.pluginsProvideTheseActionsClickABinding": "Plugins provide these actions. Click a binding and press a new key combo; conflicts stay visible until you resolve them. Esc cancels.",
  "settings.shortcutspage.pressKeys": "Press keys…",
  "settings.shortcutspage.providedBy": "Provided by",
  "settings.shortcutspage.resetAllToDefaults": "Reset all to defaults →",
  "settings.shortcutspage.shortcuts": "Shortcuts",
} as const;

export type HotkeysMessageKey = keyof typeof en;
export type HotkeysMessages = Record<HotkeysMessageKey, string>;
