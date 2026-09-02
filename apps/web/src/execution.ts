import type { JsonObject, JsonValue } from "@polyth/contracts";
import type { FileDiff } from "./diff.ts";
import { fileDiffsFromInput, looksLikeDiff, splitFileDiffs } from "./diff.ts";
import type { ToolMsg } from "./reduce.ts";

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
  files?: FileDiff[];
}

const firstString = (input: JsonObject, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const lineCount = (text: string): number => text === "" ? 0 : text.split(/\r?\n/).length;

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || (char === "&" && command[index + 1] === "&")) {
      segments.push(command.slice(start, index).trim());
      if (char === "&") index++;
      start = index + 1;
    }
  }
  segments.push(command.slice(start).trim());
  return segments.filter(Boolean);
}

function stripEnvironmentPrefix(segment: string): string {
  return segment
    .replace(/^env(?:\s+(?:-[A-Za-z]+|--[A-Za-z-]+(?:=\S+)?))*\s+/i, "")
    .replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/i, "")
    .trim();
}

function compactCommandPaths(command: string): string {
  return command.replace(/(?:"[^"\n]*[\\/][^"\n]*"|'[^'\n]*[\\/][^'\n]*'|[^\s"'`;|&]+[\\/][^\s"'`;|&]+)/g, (token) => {
    const quote = token[0] === '"' || token[0] === "'" ? token[0] : "";
    const value = quote ? token.slice(1, -1) : token;
    if (/^[a-z]+:\/\//i.test(value) || value.length <= 52) return token;
    const compact = middleTruncatePath(value, 52);
    return quote ? `${quote}${compact}${quote}` : compact;
  });
}

export function cleanShellCommand(command: string): string {
  const segments = shellSegments(command);
  let operative = "";
  for (const candidate of segments) {
    if (/^(?:cd|pushd|popd)\b/i.test(candidate)) continue;
    if (/^(?:export|unset)\s+[A-Za-z_][A-Za-z0-9_]*(?:=|$)/i.test(candidate)) continue;
    const stripped = stripEnvironmentPrefix(candidate);
    if (stripped) operative = stripped;
  }
  const cleaned = operative || stripEnvironmentPrefix(segments.at(-1) ?? command.trim()) || command.trim();
  return compactCommandPaths(cleaned.replace(/\s+/g, " "));
}

export function middleTruncatePath(path: string, max = 58): string {
  if (path.length <= max) return path;
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const tail = parts.at(-1) ?? normalized;
  if (tail.length >= max - 4) return `…/${tail.slice(-(max - 2))}`;
  const prefix = parts.slice(0, Math.min(normalized.startsWith("/") ? 4 : 3, Math.max(1, parts.length - 1)));
  const leadingSlash = normalized.startsWith("/") ? "/" : "";
  while (prefix.length > 1) {
    const candidate = `${leadingSlash}${prefix.join("/")}/…/${tail}`;
    if (candidate.length <= max) return candidate;
    prefix.pop();
  }
  const head = `${leadingSlash}${prefix[0] ?? ""}`;
  const candidate = `${head}/…/${tail}`;
  if (candidate.length <= max) return candidate;
  const tailRoom = Math.max(4, max - head.length - 3);
  return `${head}/…/${tail.slice(-tailRoom)}`;
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

function fileChangesFor(kind: ExecutionKind, input: JsonObject, output: string | undefined, path?: string): FileDiff[] {
  if (kind !== "edit" && kind !== "write" && kind !== "create" && kind !== "delete") return [];
  const fromInput = fileDiffsFromInput(input, path ?? "file");
  if (fromInput.length > 0) return fromInput;
  if (output && looksLikeDiff(output)) return splitFileDiffs(output, path ?? "file");
  return [];
}

function totalStats(files: readonly FileDiff[]): { add: number; del: number } | undefined {
  if (files.length === 0) return undefined;
  return files.reduce(
    (acc, file) => ({ add: acc.add + file.stats.add, del: acc.del + file.stats.del }),
    { add: 0, del: 0 },
  );
}

/** Known integration brand casing; title-case is only the fallback. */
const INTEGRATION_BRANDS: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  posthog: "PostHog",
  mongodb: "MongoDB",
  postgres: "Postgres",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  graphql: "GraphQL",
  openapi: "OpenAPI",
};

function displayIntegration(tool: string): string {
  const normalized = tool
    .replace(/^mcp(?:__|[_:/-])*/i, "")
    .split(/__|[:/]/)[0]
    ?.replace(/[-_]+/g, " ")
    .trim();
  if (!normalized) return "MCP";
  const brand = INTEGRATION_BRANDS[normalized.toLowerCase()];
  return brand ?? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
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
  const files = fileChangesFor(kind, input, output, path);
  const stats = totalStats(files);
  const diff = files.length === 0 ? undefined : files.map((file) => file.diff).join("\n");
  const displayPath = path ?? (files.length === 1 ? files[0]?.path : undefined);
  const compactPath = displayPath ? middleTruncatePath(displayPath) : undefined;
  let preview = "";

  if (kind === "shell" || (kind === "test" && command)) {
    preview = endTruncate(cleanShellCommand(command ?? title ?? tool));
  } else if (kind === "read") {
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const range = offset !== undefined ? ` · L${offset}${limit ? `–${offset + limit - 1}` : ""}` : "";
    preview = `${compactPath ?? title ?? "File"}${range}`;
  } else if (kind === "edit" || kind === "write" || kind === "create") {
    preview = files.length > 1
      ? `${files.length} files`
      : (compactPath ?? title ?? "File");
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
    const humanized = action.replace(/\b(pr|pull request)\s*#?(\d+)/i, "pull request #$2");
    preview = endTruncate(humanized.length > 0 ? humanized[0]!.toUpperCase() + humanized.slice(1) : humanized, 82);
  } else if (kind === "subagent") {
    preview = endTruncate(description ?? firstString(input, ["prompt"]) ?? "Delegated task", 86);
  } else {
    preview = endTruncate(description ?? compactPath ?? query ?? url ?? title ?? tool, 86);
  }

  return {
    kind,
    label,
    preview,
    ...(displayPath ? { path: displayPath } : {}),
    ...(command ? { command } : {}),
    ...(query ? { query } : {}),
    ...(diff ? { diff } : {}),
    ...(stats ? { stats } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

function compactValue(value: JsonValue): string {
  if (typeof value === "string") return endTruncate(value.replace(/\s+/g, " "), 180);
  if (value === null || typeof value !== "object") return String(value);
  return endTruncate(JSON.stringify(value), 180);
}

export interface NormalizedResultEntry {
  key: string;
  value: string;
  href?: string;
}

const RESULT_KEYS = [
  "title", "name", "status", "state", "number", "id", "url", "html_url",
  "owner", "repo", "repository", "summary", "message", "count", "total",
  "created_at", "updated_at",
] as const;

const humanKey = (key: string): string => key
  .replace(/([a-z])([A-Z])/g, "$1 $2")
  .replace(/[_-]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

function semanticResultValue(value: JsonValue): string {
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (value !== null && typeof value === "object") {
    for (const key of ["name", "login", "title", "label", "id"]) {
      const nested = value[key];
      if (nested !== undefined && (typeof nested === "string" || typeof nested === "number")) {
        return compactValue(nested);
      }
    }
    const count = Object.keys(value).length;
    return `${count} ${count === 1 ? "field" : "fields"}`;
  }
  return compactValue(value);
}

function unwrapMcpValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    if (value.length === 1) return unwrapMcpValue(value[0] ?? null);
    const contentBlocks = value.every((item) =>
      item !== null
      && typeof item === "object"
      && !Array.isArray(item)
      && item.type === "text"
      && typeof item.text === "string");
    const text = contentBlocks ? value[0] as JsonObject : undefined;
    if (text && typeof text.text === "string") {
      try {
        return unwrapMcpValue(JSON.parse(text.text) as JsonValue);
      } catch {
        return text.text;
      }
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  for (const key of ["data", "result"]) {
    const nested = value[key];
    if (nested !== undefined && Object.keys(value).length <= 3) return unwrapMcpValue(nested);
  }
  if (Array.isArray(value.content)) return unwrapMcpValue(value.content);
  return value;
}

function mcpArrayEntries(value: JsonValue[], label = "Item"): NormalizedResultEntry[] {
  const summary = {
    key: label === "Item" ? "Items" : label,
    value: `${value.length} ${value.length === 1 ? "item" : "items"}`,
  };
  const items = value.slice(0, 5).map((item, index): NormalizedResultEntry => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const href = ["html_url", "url", "href", "web_url"].map((key) => item[key])
        .find((candidate): candidate is string => typeof candidate === "string" && /^https?:\/\//i.test(candidate));
      const title = ["title", "name", "label", "summary", "filename", "path", "login"].map((key) => item[key])
        .find((candidate): candidate is string | number =>
          typeof candidate === "string" || typeof candidate === "number");
      const identity = title ?? ["number", "id"].map((key) => item[key])
        .find((candidate): candidate is string | number =>
          typeof candidate === "string" || typeof candidate === "number");
      return {
        key: `${label} ${index + 1}`,
        value: identity === undefined ? (href ?? "Structured item") : compactValue(identity),
        ...(href ? { href } : {}),
      };
    }
    const display = semanticResultValue(item);
    const href = typeof item === "string" && /^https?:\/\//i.test(item) ? item : undefined;
    return { key: `${label} ${index + 1}`, value: display, ...(href ? { href } : {}) };
  });
  return [summary, ...items];
}

export function normalizedMcpResult(output: string): NormalizedResultEntry[] | null {
  let parsed: JsonValue;
  try {
    parsed = unwrapMcpValue(JSON.parse(output) as JsonValue);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return [{ key: "Result", value: compactValue(parsed) }];
  }
  if (Array.isArray(parsed)) {
    return mcpArrayEntries(parsed);
  }
  const entries = Object.entries(parsed);
  const preferred = RESULT_KEYS.flatMap((key) => {
    const entry = entries.find(([candidate]) => candidate.toLowerCase() === key);
    return entry ? [entry] : [];
  });
  const remaining = entries.filter(([key]) => !preferred.some(([used]) => used === key));
  return [...preferred, ...remaining]
    .filter(([, value]) => value !== undefined && value !== null)
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) return mcpArrayEntries(value, humanKey(key));
      const display = semanticResultValue(value);
      const href = typeof value === "string" && /^https?:\/\//i.test(value) ? value : undefined;
      return [{ key: humanKey(key), value: display, ...(href ? { href } : {}) }];
    })
    .slice(0, 8);
}

const LARGE_INPUT_KEYS = new Set([
  "command", "cmd", "content", "oldString", "old_string", "newString", "new_string",
  "patch", "patchText", "patch_text", "diff", "prompt", "edits", "replacements",
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

/** Newest meaningful reasoning line for the collapsed live preview: markdown
 *  emphasis/heading/list markers are stripped so the tail reads as prose. */
export function reasoningTail(reasoning: string): string {
  const line = reasoning
    .split(/\r?\n/)
    .reverse()
    .map((candidate) => candidate.replace(/^[\s#>*+-]+/, "").replace(/[*_`]+/g, "").trim())
    .find((candidate) => candidate !== "");
  return line === undefined ? "" : endTruncate(line, 110);
}

/** First meaningful reasoning line for the collapsed preview once thinking
 *  finished (same stripping as reasoningTail, opposite end). */
export function reasoningHead(reasoning: string): string {
  const line = reasoning
    .split(/\r?\n/)
    .map((candidate) => candidate.replace(/^[\s#>*+-]+/, "").replace(/[*_`]+/g, "").trim())
    .find((candidate) => candidate !== "");
  return line === undefined ? "" : endTruncate(line, 110);
}
