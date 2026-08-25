/**
 * Canonical English messages owned by the commands package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "settings.commandspage.alias": "alias",
  "settings.commandspage.builtin": "built-in",
  "settings.commandspage.commandsSnippets": "Commands & Snippets",
  "settings.commandspage.descriptionOptional": "description (optional)",
  "settings.commandspage.generalSnippet": "General snippet",
  "settings.commandspage.name": "name",
  "settings.commandspage.noActiveProject": "No active project",
  "settings.commandspage.noSnippetsYet": "No snippets yet",
  "settings.commandspage.project": "project",
  "settings.commandspage.projectSnippet": "Project snippet",
  "settings.commandspage.promptUseArgumentsForTheTextAfter": "Prompt — use $ARGUMENTS for the text after /name",
  "settings.commandspage.saveCommand": "Save command",
  "settings.commandspage.saveSnippet": "Save snippet",
  "settings.commandspage.slashCommands": "Slash commands",
  "settings.commandspage.slashCommandsNameExpandIntoPromptsSnippets": "Slash commands (/name) expand into prompts; snippets (#alias) expand inline. Stored as markdown in the project or your home config.",
  "settings.commandspage.snippetText": "Snippet text",
  "settings.commandspage.snippets": "Snippets",
  "settings.commandspage.snippetsExpandAliasIntoSavedTextAnywhere": "Snippets expand #alias into saved text anywhere in a message.",
  "settings.commandspage.user": "user",
} as const;

export type CommandsMessageKey = keyof typeof en;
export type CommandsMessages = Record<CommandsMessageKey, string>;
