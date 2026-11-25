/**
 * Canonical English messages owned by the page-apps package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "pageapps.surface.title": "Apps",
  "pageapps.surface.description": "Pages you kept as apps.",
  "pageapps.capability.description": "Your apps: pages an agent drew, kept to open again with their data.",
  "pageapps.action.save": "Save as app",
  "pageapps.saved.created": "Saved as an app: {title}",
  "pageapps.saved.updated": "App updated: {title} (version {version})",
  "pageapps.saved.unchanged": "Already saved: {title}",
  "pageapps.saved.open": "Open",
  "pageapps.save.failed": "Couldn't save the app",
  "pageapps.empty.title": "No apps yet",
  "pageapps.empty.description": "Ask an agent for a page (a tracker, a calculator, a checklist) and choose Save as app on it. It opens here and remembers its data.",
  "pageapps.loading": "Loading apps…",
  "pageapps.load.failed": "Couldn't load your apps",
  "pageapps.retry": "Try again",
  "pageapps.open": "Open {title}",
  "pageapps.openWindow": "Open in a window",
  "pageapps.rename": "Rename",
  "pageapps.rename.title": "Rename app",
  "pageapps.rename.message": "Name",
  "pageapps.remove": "Remove",
  "pageapps.remove.title": "Remove {title}?",
  "pageapps.remove.message": "The app and the data it stored are deleted. The chat it came from keeps the page.",
  "pageapps.removed": "App removed",
  "pageapps.more": "More for {title}",
  "pageapps.back": "All apps",
  "pageapps.version": "Version {version}",
  "pageapps.updated": "Updated {date}",
  "pageapps.missing.title": "This app is gone",
  "pageapps.missing.description": "It was removed, perhaps on another device.",
  "pageapps.stopped": "This app kept leaving its page, so it was stopped.",
  "pageapps.reload": "Reload",
  "pageapps.storage.failed": "This app could not save its data: its storage is full or the server is out of reach. Recent changes may be lost.",
  "pageapps.window.blocked": "The browser blocked the window. Allow pop-ups for Polyth and try again.",
  "pageapps.failed": "Couldn't change the app",
} as const;

export type PageAppsMessageKey = keyof typeof en;
export type PageAppsMessages = Record<PageAppsMessageKey, string>;
