// User-editable "use todos" rule. When enabled, the server appends it to the
// global behavior instructions every harness receives, so the rule reaches
// Claude, Codex, OpenCode, ACP agents, … through the same projection path.
// Browser-safe: shared by the server entry and the settings page.

export const TODOS_PACKAGE_ID = "todos";
export const TODO_RULE_MAX_CHARS = 4_000;

// Wording verified live with a cheap model (Claude Haiku 4.5): a softer
// "keep a todo list" version was ignored; naming the FIRST tool call works.
export const DEFAULT_TODO_RULE = [
  "For any request that needs three or more steps, your FIRST tool call must create the todo list with your todo/plan tool (TaskCreate once per item, TodoWrite, update_plan or todowrite).",
  "Then keep exactly one item in progress and mark each item completed immediately after finishing it; add newly discovered work as new items. Only single-step or purely conversational requests skip the list.",
].join("\n");

export interface TodoRuleSettings {
  /** Append the rule to every harness's global behavior instructions. */
  enabled: boolean;
  /** Rule body. Empty text falls back to the default rule. */
  text: string;
}

export const DEFAULT_TODO_RULE_SETTINGS: TodoRuleSettings = Object.freeze({
  enabled: false,
  text: DEFAULT_TODO_RULE,
});

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

/** Strict parser for persisted or submitted settings. Missing fields take
 *  defaults; wrong types and oversize text are rejected, not coerced. */
export function parseTodoRuleSettings(value: unknown): TodoRuleSettings {
  if (value === undefined || value === null) return { ...DEFAULT_TODO_RULE_SETTINGS };
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("todo rule settings must be an object");
  const row = value as Record<string, unknown>;
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw invalid("enabled must be a boolean");
  if (row.text !== undefined && typeof row.text !== "string") throw invalid("text must be a string");
  const text = typeof row.text === "string" ? row.text.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length > TODO_RULE_MAX_CHARS) throw invalid(`rule text exceeds ${TODO_RULE_MAX_CHARS} characters`);
  return {
    enabled: row.enabled === true,
    text: text || DEFAULT_TODO_RULE,
  };
}

/** The model-visible section, or "" when the rule is off. */
export function todoRuleSection(settings: TodoRuleSettings): string {
  if (!settings.enabled) return "";
  const body = settings.text.trim() || DEFAULT_TODO_RULE;
  return `## Todo discipline (mandatory)\n\n${body}`;
}
