/**
 * Canonical English messages owned by the editor package.
 */
export const en = {
  "editor.command.findReferences": "Editor: Find references",
  "editor.command.goToDefinition": "Editor: Go to definition",
  "editor.command.peekDefinition": "Editor: Peek definition",
  "editor.command.renameSymbol": "Editor: Rename symbol",
  "editor.search.find": "Find",
  "editor.search.replace": "Replace",
  "editor.search.next": "Next",
  "editor.search.previous": "Previous",
  "editor.search.all": "All",
  "editor.search.matchCase": "Match case",
  "editor.search.regexp": "Regexp",
  "editor.search.byWord": "By word",
  "editor.search.replaceAll": "Replace all",
  "editor.search.close": "Close",
  "editor.plainText": "Plain text",
  "editor.languageUnavailable": "Grammar unavailable — plain text",
  "editor.profile.authoring": "Authoring",
  "editor.profile.authoringDescription": "Writing-focused layout with Chat and files.",
  "editor.profile.development": "Development",
  "editor.profile.developmentDescription": "Editor, Git, and Terminal around Chat.",
} as const;

export type EditorMessageKey = keyof typeof en;
export type EditorMessages = Record<EditorMessageKey, string>;
