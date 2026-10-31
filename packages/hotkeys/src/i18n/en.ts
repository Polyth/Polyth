/**
 * Canonical English messages owned by the hotkeys package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "settings.shortcutspage.action.dictate": "Start or stop dictation",
  "settings.shortcutspage.action.findInConversation": "Find in conversation",
  "settings.shortcutspage.action.focusComposer": "Focus composer",
  "settings.shortcutspage.action.newSession": "New session",
  "settings.shortcutspage.action.notificationCentre": "Notification centre",
  "settings.shortcutspage.action.palette": "Command palette",
  "settings.shortcutspage.action.searchFiles": "Search files",
  "settings.shortcutspage.action.searchSessions": "Search sessions",
  "settings.shortcutspage.action.searchWorkspace": "Search workspace contents",
  "settings.shortcutspage.action.settings": "Settings",
  "settings.shortcutspage.action.splitView": "Split view with the previous chat",
  "settings.shortcutspage.action.viewFiles": "Files view",
  "settings.shortcutspage.action.viewGit": "Git view",
  "settings.shortcutspage.action.viewTerminal": "Open Terminal",
  "settings.shortcutspage.action.voiceMode": "Voice mode",
  "settings.shortcutspage.changeShortcut": "Change shortcut: {action}",
  "settings.shortcutspage.conflictsWith": "Conflicts with",
  "settings.shortcutspage.pressKeys": "Press keys…",
  "settings.shortcutspage.cancel": "Cancel",
  "settings.shortcutspage.changeShortcutFor": "Change shortcut for {action}, currently {combo}",
  "settings.shortcutspage.groupGeneral": "General",
  "settings.shortcutspage.groupSearch": "Search",
  "settings.shortcutspage.groupViews": "Views",
  "settings.shortcutspage.intro": "Click a shortcut, then press the new keys. Esc cancels.",
  "settings.shortcutspage.pressKeysFor": "Press the new keys for {action}",
  "settings.shortcutspage.reset": "Reset",
  "settings.shortcutspage.resetAll": "Reset all",
  "settings.shortcutspage.resetAllConfirm": "Reset every shortcut to its default?",
  "settings.shortcutspage.touchNote": "Shortcuts need a hardware keyboard.",
  "settings.shortcutspage.shortcuts": "Shortcuts",
} as const;

export type HotkeysMessageKey = keyof typeof en;
export type HotkeysMessages = Record<HotkeysMessageKey, string>;
