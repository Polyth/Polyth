import type { JsonObject, JsonValue } from "@polyth/contracts";
import type { ToolMsg } from "./reduce.ts";
import { diffStat } from "./utils.ts";

export type ExecutionKind =
  | "shell"
  | "read"
  | "edit"
  | "write"
  | "create"
  | "delete"
  | "move"
  | "search"
  | "web"
  | "mcp"
  | "subagent"
  | "test"
  | "git"
  | "tool";

export interface ExecutionPresentation {
  kind: ExecutionKind;
  label: string;
  preview: string;
  path?: string;
  command?: string;
  query?: string;
  diff?: string;
  stats?: { add: number; del: number };
}

const firstString = (input: JsonObject, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const lineCount = (text: string): number => text === "" ? 0 : text.split(/\r?\n/).length;

export function cleanShellCommand(command: string): string {
  return command
    .trim()
    .replace(/^(?:cd\s+(?:"[^"]+"|'[^']+'|[^;&]+?)\s*(?:&&|;)\s*)+/i, "")
    .replace(/\s+/g, " ");
}

export function middleTruncatePath(path: string, max = 58): string {
  if (path.length <= max) return path;
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const tail = parts.at(-1) ?? normalized;
  if (tail.length >= max - 4) return `…/${tail.slice(-(max - 2))}`;
  const head = normalized.startsWith("/") ? `/${parts[0] ?? ""}` : (parts[0] ?? "");
  const available = Math.max(4, max - head.length - tail.length - 3);
  return `${head.slice(0, available)}…/${tail}`;
}

export function compactUrl(raw: string, max = 62): string {
  try {
    const url = new URL(raw);
    const value = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    if (value.length <= max) return value;
    const parts = url.pathname.split("/").filter(Boolean);
    const tail = parts.slice(-2).join("/");
    const room = Math.max(8, max - url.host.length - tail.length - 2);
    return `${url.host}/${parts.slice(0, 1).join("").slice(0, room)}…/${tail}`;
  } catch {
    return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
  }
}

export function endTruncate(text: string, max = 96): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function editDiff(input: JsonObject): string | undefined {
  const patch = firstString(input, ["patch", "diff"]);
  if (patch) return patch;
  const before = firstString(input, ["oldString", "old_string", "before"]);
  const after = firstString(input, ["newString", "new_string", "after", "content"]);
  if (before === undefined && after === undefined) return undefined;
  return [
    ...(before ?? "").split(/\r?\n/).map((line) => `-${line}`),
    ...(after ?? "").split(/\r?\n/).map((line) => `+${line}`),
  ].join("\n");
}

function displayIntegration(tool: string): string {
  const normalized = tool
    .replace(/^mcp(?:__|[_:/-])*/i, "")
    .split(/__|[:/]/)[0]
    ?.replace(/[-_]+/g, " ")
    .trim();
  if (!normalized) return "MCP";
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function classifyTool(tool: string, input: JsonObject): ExecutionKind {
  const value = tool.toLowerCase();
  if (/^(bash|shell|shell_command|run_shell|exec|terminal)$/.test(value)) return "shell";
  if (/(^|[_:/-])(subagent|agent|task)([_:/-]|$)/.test(value) || value === "task") return "subagent";
  if (/mcp|github|linear|slack|notion|figma/.test(value)) return "mcp";
  if (/web|browser|fetch|url|http/.test(value)) return "web";
  if (/grep|glob|search|ripgrep|find/.test(value)) return "search";
  if (/delete|remove|unlink/.test(value)) return "delete";
  if (/move|rename/.test(value)) return "move";
  if (/create|mkdir|touch/.test(value)) return "create";
  if (/apply_patch|patch|edit|replace/.test(value)) return "edit";
  if (/write|save/.test(value)) return "write";
  if (/read|view|file/.test(value)) return "read";
  if (/test|check|lint|build/.test(value)) return "test";
  if (/^git(?:[_:/-]|$)/.test(value)) return "git";
  const command = firstString(input, ["command", "cmd"]);
  if (command && /^(?:npm|pnpm|yarn|node)\s+(?:run\s+)?(?:test|check|lint|build)\b/.test(cleanShellCommand(command))) return "test";
  return "tool";
}

function displayLabel(kind: ExecutionKind, tool: string): string {
  if (kind === "mcp") return displayIntegration(tool);
  return {
    shell: "Shell",
    read: "Read",
    edit: "Edit",
    write: "Write",
    create: "Create",
    delete: "Delete",
    move: "Move",
    search: "Search",
    web: "Web",
    subagent: "Subagent",
    test: "Test",
    git: "Git",
    tool: tool.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool",
  }[kind];
}

function resultCount(output: string | undefined): number | undefined {
  if (!output?.trim()) return undefined;
  const jsonMatch = output.match(/^\s*\{[\s\S]*?"(?:total|count|matches|results)"\s*:\s*(\d+)/i);
  if (jsonMatch) return Number(jsonMatch[1]);
  return output.split(/\r?\n/).filter((line) => line.trim()).length;
}

export function executionPresentation(message: Pick<ToolMsg, "tool" | "input" | "output" | "title">): ExecutionPresentation {
  const { tool, input, output, title } = message;
  const kind = classifyTool(tool, input);
  const label = displayLabel(kind, tool);
  const path = firstString(input, ["filePath", "file_path", "path", "file", "target", "destination"]);
  const command = firstString(input, ["command", "cmd"]);
  const query = firstString(input, ["pattern", "query", "search", "text"]);
  const url = firstString(input, ["url", "href"]);
  const description = firstString(input, ["description", "title", "operation", "action"]);
  const diff = kind === "edit" || kind === "write" || kind === "create" ? editDiff(input) : undefined;
  const stats = diff ? diffStat(diff) : undefined;
  const compactPath = path ? middleTruncatePath(path) : undefined;
  let preview = "";

  if (kind === "shell" || (kind === "test" && command)) {
    preview = endTruncate(cleanShellCommand(command ?? title ?? tool));
  } else if (kind === "read") {
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const range = offset !== undefined ? ` · L${offset}${limit ? `–${offset + limit - 1}` : ""}` : "";
    preview = `${compactPath ?? title ?? "File"}${range}`;
  } else if (kind === "edit" || kind === "write" || kind === "create") {
    const stat = stats && (stats.add > 0 || stats.del > 0) ? ` · +${stats.add} −${stats.del}` : "";
    preview = `${compactPath ?? title ?? "File"}${stat}`;
  } else if (kind === "delete") {
    preview = compactPath ?? description ?? title ?? "Item";
  } else if (kind === "move") {
    const from = firstString(input, ["from", "source", "oldPath", "old_path"]);
    const to = firstString(input, ["to", "destination", "newPath", "new_path", "path"]);
    preview = from && to ? `${middleTruncatePath(from, 28)} → ${middleTruncatePath(to, 28)}` : compactPath ?? description ?? "";
  } else if (kind === "search") {
    const count = resultCount(output);
    preview = `${query ? `"${endTruncate(query, 46)}"` : description ?? title ?? "Workspace"}${count !== undefined ? ` · ${count} ${count === 1 ? "match" : "matches"}` : ""}`;
  } else if (kind === "web") {
    const operation = description ?? (query ? `Search "${endTruncate(query, 38)}"` : "Open");
    preview = `${operation}${url ? ` · ${compactUrl(url, 48)}` : ""}`;
  } else if (kind === "mcp") {
    const action = description ?? tool.split(/__|[:/]/).at(-1)?.replace(/[-_]+/g, " ") ?? "Request";
    preview = endTruncate(action.replace(/\b(pr|pull request)\s*#?(\d+)/i, "pull request #$2"), 82);
  } else if (kind === "subagent") {
    preview = endTruncate(description ?? firstString(input, ["prompt"]) ?? "Delegated task", 86);
  } else {
    preview = endTruncate(description ?? compactPath ?? query ?? url ?? title ?? tool, 86);
  }

  return {
    kind,
    label,
    preview,
    ...(path ? { path } : {}),
    ...(command ? { command } : {}),
    ...(query ? { query } : {}),
    ...(diff ? { diff } : {}),
    ...(stats ? { stats } : {}),
  };
}

function compactValue(value: JsonValue): string {
  if (typeof value === "string") return endTruncate(value.replace(/\s+/g, " "), 180);
  if (value === null || typeof value !== "object") return String(value);
  return endTruncate(JSON.stringify(value), 180);
}

const LARGE_INPUT_KEYS = new Set([
  "command", "cmd", "content", "oldString", "old_string", "newString", "new_string",
  "patch", "diff", "prompt",
]);

export function normalizedInputEntries(input: JsonObject): Array<{ key: string; value: string }> {
  return Object.entries(input)
    .filter(([key, value]) => !LARGE_INPUT_KEYS.has(key) && value !== undefined)
    .slice(0, 8)
    .map(([key, value]) => ({ key: key.replace(/_/g, " "), value: compactValue(value) }));
}

export function outputLineCount(output: string): number {
  return lineCount(output);
}

export function executionGroupLabel(tools: readonly ToolMsg[]): string {
  const counts = new Map<ExecutionKind, number>();
  for (const tool of tools) {
    const kind = classifyTool(tool.tool, tool.input);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominant === "read" || dominant === "search") return "Repository inspection";
  if (dominant === "edit" || dominant === "write" || dominant === "create") return "Implementation";
  if (dominant === "test") return "Verification";
  if (dominant === "web" || dominant === "mcp") return "External research";
  if (dominant === "subagent") return "Delegated work";
  return "Agent work";
}

export function reasoningMilestones(reasoning: string): string[] {
  const paragraphs = reasoning
    .split(/\n{2,}|\n(?=(?:[-*]\s+|\d+[.)]\s+))/)
    .map((part) => part.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const useful = paragraphs.filter((part) =>
    !/^(?:we need|i need|let me|thinking|analysis|hmm|okay|ok)\b[.:,\s-]*/i.test(part) || part.length > 48);
  return (useful.length > 0 ? useful : paragraphs)
    .slice(-6)
    .map((part) => endTruncate(part, 240));
}
