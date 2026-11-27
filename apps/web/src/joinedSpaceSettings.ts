// Settings while a joined Space is open (another Polyth server's Space,
// reached through Polyth Link). Three kinds of settings exist
// (docs/architecture/polyth-link.md "Joined Spaces"):
//
// - the person's own, the same everywhere (appearance, chat, notifications,
//   voice, keys…) — kept on this server, shown;
// - the Space's own, which come from the server it lives on (projects) —
//   shown, answered by that server with the person's rights there;
// - this computer's (harnesses, behavior, MCP, packages, users, Vault, SSH,
//   updates…) — hidden: they would change this server, not the open Space.
//
// Spaces and Polyth Link stay: switching Spaces, and joining and leaving
// other servers, live there (both answered by this server).
export const JOINED_SPACE_SETTINGS_PAGES: ReadonlySet<string> = new Set([
  "general", "appearance", "chat", "notifications", "sessions", "voice", "voice-mode",
  "shortcuts", "command-line", "projects", "spaces", "tunnel",
]);

export const joinedSpaceSettingsPageVisible = (joined: boolean, pageId: string): boolean =>
  !joined || JOINED_SPACE_SETTINGS_PAGES.has(pageId);
