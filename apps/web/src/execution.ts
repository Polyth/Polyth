import type { JsonObject, JsonValue } from "@polyth/contracts";
import type { ToolActivityDescription } from "@polyth/web-sdk";
import type { FileDiff } from "./diff.ts";
import { fileDiffsFromInput, looksLikeDiff, splitFileDiffs } from "./diff.ts";
import {
  describeMcpCall,
  effectiveToolCall,
  endTruncate,
  isNativeTodoTool,
  isPolythMcpCall,
  nativeTodoItems,
  type McpCall,
  type McpCallView,
  type McpDescribeContext,
} from "./toolCallView.ts";
import type { ToolMsg } from "./reduce.ts";

export { endTruncate };

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
  | "browser"
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
  /** Human projection of an MCP call (Polyth agent tools or another server). */
  mcp?: McpCallView;
}

export interface ExecutionPathParts {
  filename: string;
  directory: string;
  relativePath: string;
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

function unwrapShellLauncher(command: string): string {
  const match = command.match(/^(?:\/(?:usr\/)?bin\/)?(?:(?:ba|da|z|k)?sh|fish)\s+(?:-[A-Za-z]*c[A-Za-z]*|--command)\s+([\s\S]+)$/i);
  if (!match) return command;
  const body = match[1]!.trim();
  const quote = body[0];
  return (quote === "'" || quote === '"') && body.at(-1) === quote
    ? body.slice(1, -1).trim()
    : body.replace(/^["']/, "").trim();
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
  // Native runtimes commonly wrap the complete compound command in `sh -c`.
  // Unwrap before splitting so a leading formatter (`printf`) does not hide
  // the repository operation that follows it.
  const launched = unwrapShellLauncher(command.trim());
  const segments = shellSegments(launched);
  let operative = "";
  for (const candidate of segments) {
    if (/^(?:cd|pushd|popd)\b/i.test(candidate)) continue;
    if (/^(?:export|unset)\s+[A-Za-z_][A-Za-z0-9_]*(?:=|$)/i.test(candidate)) continue;
    const stripped = stripEnvironmentPrefix(candidate);
    if (stripped) operative = stripped;
  }
  const cleaned = operative || stripEnvironmentPrefix(segments.at(-1) ?? launched) || launched;
  return compactCommandPaths(unwrapShellLauncher(cleaned).replace(/\s+/g, " "));
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

/** Filename-first mobile projection. The full path remains available to the
 * disclosure while the collapsed row drops a known project-root prefix. */
export function executionPathParts(path: string, projectRoot?: string | null): ExecutionPathParts {
  const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  const root = projectRoot?.replaceAll("\\", "/").replace(/\/+$/, "");
  const relativePath = root && (normalized === root || normalized.startsWith(`${root}/`))
    ? normalized.slice(root.length).replace(/^\/+/, "")
    : normalized.replace(/^\.\//, "");
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.at(-1) ?? relativePath;
  return {
    filename,
    directory: parts.slice(0, -1).join("/"),
    relativePath,
  };
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

/** Antigravity wraps an applied edit's unified hunks in diff_block markers
 *  inside the native result text. Extract just the hunks so the rendered diff
 *  is not mixed with the prose status line. */
function diffBlockBody(output: string): string {
  const start = output.indexOf("[diff_block_start]");
  const end = output.indexOf("[diff_block_end]");
  return start >= 0 && end > start
    ? output.slice(start + "[diff_block_start]".length, end).trim()
    : output;
}

function fileChangesFor(kind: ExecutionKind, input: JsonObject, output: string | undefined, path?: string): FileDiff[] {
  if (kind !== "edit" && kind !== "write" && kind !== "create" && kind !== "delete") return [];
  const fromInput = fileDiffsFromInput(input, path ?? "file");
  if (fromInput.length > 0) return fromInput;
  const candidate = output ? diffBlockBody(output) : "";
  if (candidate && looksLikeDiff(candidate)) return splitFileDiffs(candidate, path ?? "file");
  return [];
}

function totalStats(files: readonly FileDiff[]): { add: number; del: number } | undefined {
  if (files.length === 0) return undefined;
  return files.reduce(
    (acc, file) => ({ add: acc.add + file.stats.add, del: acc.del + file.stats.del }),
    { add: 0, del: 0 },
  );
}

/** An MCP-looking tool no harness wrapped (`github.fetch_file`, `linear_x`):
 *  its first segment names the integration. */
function looseMcpCall(tool: string, input: JsonObject): McpCall {
  const name = tool.replace(/^mcp(?:__|[_:/-])*/i, "");
  const [server, ...rest] = name.split(/__|[.:/]/);
  return rest.length && server ? { server, tool: rest.join("."), args: input } : { server: name || "mcp", tool: name, args: input };
}

function classifyMcpCall(call: McpCall): ExecutionKind {
  const tool = call.tool.toLowerCase();
  if (isPolythMcpCall(call)) {
    if ((tool === "polyth" || tool === "polyth_control" || tool === "control") && call.args.action === "agent.spawn") return "subagent";
    if (/^polyth_browser/.test(tool)) return "browser";
  }
  if (call.server?.toLowerCase() === "browser") return "browser";
  return "mcp";
}

export function classifyTool(tool: string, input: JsonObject): ExecutionKind {
  // Every harness's MCP naming (wrappers included) is classified by the call it carries.
  const mcpCall = effectiveToolCall(tool, input).mcp;
  if (mcpCall) return classifyMcpCall(mcpCall);
  // OpenCode prefixes project-provisioned package tools with the MCP server
  // name. "polyth-agent-tools" describes the bridge, not a delegated agent;
  // classify the contributed tool itself so ordinary package actions do not
  // render as Subagent cards.
  const value = tool.toLowerCase().replace(
    /^(?:mcp(?:__|[_:/-])*)?polyth-agent-tools(?:__|[_:/-])+/, "",
  );
  const action = firstString(input, ["action"]);
  if (value === "polyth" && action === "agent.spawn") return "subagent";
  const shell = /^(bash|shell|shell_command|run_shell|exec|terminal)$/.test(value);
  const command = firstString(input, ["command", "cmd"]);
  // Some native runtimes expose repository work through one command transport.
  // Keep that transport in history, but present the operation's semantic intent.
  if (shell && command) {
    if (browserCommandPreview(command)) return "browser";
    const operation = cleanShellCommand(command);
    const executable = operation.match(/^\s*(?:command\s+)?([^\s]+)/)?.[1]
      ?.replace(/^["']|["']$/g, "")
      .split(/[\\/]/).at(-1)?.toLowerCase();
    if (executable && /^(rg|ripgrep|grep|egrep|fgrep|fd)$/.test(executable)) return "search";
    if (executable === "find"
      && !/(?:^|\s)-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint(?:0)?|fls|fprintf)(?:\s|$)/.test(operation)) return "search";
    if (executable === "sed" && /(?:^|\s)-(?:[A-Za-z]*n[A-Za-z]*)(?:\s|$)/.test(operation)
      && !/(?:^|\s)(?:-[A-Za-z]*i[A-Za-z]*|--in-place)(?:[=\s]|$)/.test(operation)) return "read";
    if (executable && /^(cat|head|tail|less|more|bat|nl)$/.test(executable)) return "read";
    if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|build)\b/.test(operation)
      || /^node(?:\s+--[\w-]+(?:=\S+)?)*\s+--test(?:\s|$)/.test(operation)) return "test";
    if (/^git\s+(?:diff|status|log|show|blame)\b/.test(operation)) return "git";
  }
  if (shell) return "shell";
  // A full-list todo tool (TodoWrite, todo_write, update_plan, …) updates the
  // agent's plan; its name must not read as a file write.
  if (isNativeTodoTool(value)) return "tool";
  if (/(^|[_:/-])(subagent|agent|task)([_:/-]|$)/.test(value) || value === "task") return "subagent";
  if (/polyth_browser|^(?:mcp__)?browser(?:[_.:/-]|$)/.test(value)) return "browser";
  if (/mcp|github|linear|slack|notion|figma/.test(value)) return "mcp";
  if (/web|fetch|url|http/.test(value)) return "web";
  if (/grep|glob|search|ripgrep|find/.test(value)) return "search";
  if (/delete|remove|unlink/.test(value)) return "delete";
  if (/move|rename/.test(value)) return "move";
  if (/create|mkdir|touch/.test(value)) return "create";
  if (/apply_patch|patch|edit|replace|sed[._-]?file/.test(value)) return "edit";
  if (/write|save/.test(value)) return "write";
  if (/read|view|file/.test(value)) return "read";
  if (/test|check|lint|build/.test(value)) return "test";
  if (/^git(?:[_:/-]|$)/.test(value)) return "git";
  if (command && (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|build)\b/.test(cleanShellCommand(command))
    || /^node(?:\s+--[\w-]+(?:=\S+)?)*\s+--test(?:\s|$)/.test(cleanShellCommand(command)))) return "test";
  return "tool";
}

function displayLabel(kind: ExecutionKind, tool: string): string {
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
    browser: "Browser",
    mcp: "MCP",
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

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (escaped) word += "\\";
  if (word) words.push(word);
  return words;
}

const commandBasename = (value: string): string => value.replaceAll("\\", "/").split("/").at(-1) ?? value;

function testCommandPreview(command: string): string {
  const words = shellWords(command);
  const executable = commandBasename(words[0] ?? "").toLowerCase();
  const npmAction = command.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?(build(?::[^\s]+)?|test|check|lint)\b/i)?.[1];
  if (npmAction) {
    const [action, target] = npmAction.split(":", 2);
    const verb = action === "build" ? "Build" : action === "lint" ? "Lint" : action === "check" ? "Check" : "Run tests";
    return target ? `${verb} ${target}` : verb;
  }
  if (executable === "node" && words.includes("--test")) {
    const pattern = words.find((word) => word.startsWith("--test-name-pattern="))?.slice("--test-name-pattern=".length);
    const testIndex = words.indexOf("--test");
    const path = words.slice(testIndex + 1).find((word) => !word.startsWith("-") && /(?:^|[\\/])[^\\/]+(?:\.test)?\.[cm]?[jt]sx?$/.test(word));
    const subject = path ? middleTruncatePath(path, 58) : "Node tests";
    return pattern ? `${subject} · “${endTruncate(pattern, 42)}”` : subject;
  }
  return "Run checks";
}

function readCommandPreview(command: string): string {
  const words = shellWords(command);
  const executable = commandBasename(words[0] ?? "").toLowerCase();
  if (executable === "sed") {
    const scriptIndex = words.findIndex((word) => /^(\d+)(?:,(\d+))?p$/.test(word));
    const script = scriptIndex >= 0 ? words[scriptIndex]! : "";
    const range = script.match(/^(\d+)(?:,(\d+))?p$/);
    const path = words.slice(scriptIndex + 1).find((word) => word !== "|" && !word.startsWith("-"));
    if (path) {
      const line = range ? ` · L${range[1]}${range[2] ? `–${range[2]}` : ""}` : "";
      return `${middleTruncatePath(path, 62)}${line}`;
    }
  }
  const path = [...words].reverse().find((word) => word !== "-" && !word.startsWith("-") && !/[|;&]/.test(word));
  return path ? middleTruncatePath(path, 72) : "Workspace content";
}

const RG_OPTIONS_WITH_VALUE = new Set([
  "-A", "-B", "-C", "-e", "-f", "-g", "-j", "-M", "-m", "-r", "-t", "-T",
  "--after-context", "--before-context", "--context", "--encoding", "--engine", "--file", "--glob",
  "--iglob", "--max-columns", "--max-count", "--max-depth", "--path-separator", "--regexp", "--replace", "--type", "--type-not",
]);

function searchCommandPreview(command: string): string {
  const words = shellWords(command);
  const executable = commandBasename(words[0] ?? "").toLowerCase();
  if (executable === "find") {
    const root = words.slice(1).find((word) => !word.startsWith("-") && !word.startsWith("!"));
    return root && root !== "." ? `Workspace items · ${middleTruncatePath(root, 48)}` : "Workspace items";
  }
  if (executable === "fd") {
    const query = words.slice(1).find((word) => !word.startsWith("-"));
    return query ? `“${endTruncate(query, 54)}”` : "Workspace files";
  }
  if (/^(?:rg|ripgrep|grep|egrep|fgrep)$/.test(executable)) {
    if (words.includes("--files")) return "Workspace files";
    const positionals: string[] = [];
    for (let index = 1; index < words.length; index++) {
      const word = words[index]!;
      if (RG_OPTIONS_WITH_VALUE.has(word)) {
        index++;
        continue;
      }
      if (word.startsWith("-")) continue;
      if (/^[|;&]/.test(word)) break;
      positionals.push(word);
    }
    const query = positionals[0];
    const scopes = positionals.slice(1, 4);
    if (query) return `“${endTruncate(query, 48)}”${scopes.length ? ` · ${scopes.map((scope) => middleTruncatePath(scope, 24)).join(", ")}` : ""}`;
  }
  return "Workspace";
}

function gitCommandPreview(command: string): string {
  if (/^git\s+diff\s+--check\b/.test(command)) return "Check diff whitespace";
  if (/^git\s+diff\b/.test(command)) return "Review changes";
  if (/^git\s+status\b/.test(command)) return "Check working tree";
  if (/^git\s+log\b/.test(command)) return "Review history";
  if (/^git\s+(?:show|blame)\b/.test(command)) return "Inspect history";
  return "Repository operation";
}

/** Browser-transport previews: helper commands carrying
 *  `polyth-browser.mjs <verb>` read as browser actions, not "Run node". */
const BROWSER_VERBS: Readonly<Record<string, string>> = {
  capability: "Check browser capability",
  projects: "List projects",
  sessions: "List browser sessions",
  open: "Open page",
  navigate: "Go to",
  snapshot: "Read page",
  click: "Click",
  type: "Type",
  scroll: "Scroll",
  action: "Browser action",
  capture: "Screenshot",
  close: "Close page",
};

function browserActionPreview(action: string, input: JsonObject): string {
  const verb = action.replace(/^browser[._:/-]/, "");
  const label = BROWSER_VERBS[verb] ?? ({
    back: "Go back", forward: "Go forward", inspect: "Inspect page",
    resize: "Resize browser", colorScheme: "Change browser appearance",
  } as Record<string, string>)[verb] ?? "Browser action";
  const target = verb === "open" || verb === "navigate"
    ? firstString(input, ["url"])
    : verb === "click" ? firstString(input, ["text", "selector"])
    : verb === "type" || verb === "snapshot" ? firstString(input, ["selector"])
    : verb === "scroll" ? firstString(input, ["direction"])
    : verb === "resize" ? firstString(input, ["viewport"])
    : undefined;
  // Typed values and opaque session/project IDs are never summary text.
  return target ? `${label} · ${endTruncate(verb === "open" || verb === "navigate" ? compactUrl(target) : target, 48)}` : label;
}

function browserCommandPreview(command: string): string | undefined {
  const previews: string[] = [];
  for (const segment of shellSegments(unwrapShellLauncher(command.trim()))) {
    if (/^(?:cd|pushd|popd)\s/.test(segment)) continue;
    const words = shellWords(stripEnvironmentPrefix(segment));
    // Recognize a direct helper invocation, not its name inside echo, tests or JS.
    const scriptIndex = commandBasename(words[0] ?? "") === "node" ? 1 : 0;
    if (commandBasename(words[scriptIndex] ?? "") !== "polyth-browser.mjs") return undefined;
    const verb = words[scriptIndex + 1];
    if (!verb || !Object.hasOwn(BROWSER_VERBS, verb)) return undefined;
    const args = words.slice(scriptIndex + 2);
    if (args.some((arg) => /^(?:\|\|?|&|>|>>|<)$/.test(arg))) return undefined;
    const target = args[1]; // Every target follows an opaque project/session ID.
    previews.push(browserActionPreview(verb, {
      ...(/^(?:open|navigate)$/.test(verb) && target ? { url: target } : {}),
      ...(/^(?:click|type|snapshot)$/.test(verb) && target ? { selector: target } : {}),
      ...(verb === "scroll" && target ? { direction: target } : {}),
    }));
  }
  return previews.length ? previews.join("; ") : undefined;
}

/** Collapsed rows describe intent; the complete command remains available in
 * the expanded Command section for inspection and copying. */
function shellCommandPreview(kind: ExecutionKind, command: string): string {
  const cleaned = cleanShellCommand(command);
  if (kind === "read") return readCommandPreview(cleaned);
  if (kind === "search") return searchCommandPreview(cleaned);
  if (kind === "test") return testCommandPreview(cleaned);
  if (kind === "git") return gitCommandPreview(cleaned);
  if (/^command\s+-v\b/.test(cleaned)) return "Check command availability";
  const words = shellWords(cleaned);
  const executable = commandBasename(words[0] ?? "");
  return executable ? `Run ${executable}` : "Run command";
}

export function executionPresentation(
  message: Pick<ToolMsg, "tool" | "input" | "output" | "title">,
  context: McpDescribeContext = {},
): ExecutionPresentation {
  const { output, title } = message;
  const effective = effectiveToolCall(message.tool, message.input);
  const { tool, input } = effective;
  const kind = classifyTool(tool, input);
  let label = displayLabel(kind, tool);
  let mcp: McpCallView | undefined;
  const path = firstString(input, [
    "filePath", "file_path", "path", "file", "target", "destination",
    "TargetFile", "AbsolutePath", "NotebookPath",
  ]);
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

  if (command && (kind === "shell" || kind === "read" || kind === "search" || kind === "test" || kind === "git")) {
    preview = endTruncate(shellCommandPreview(kind, command));
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
  } else if (kind === "browser") {
    const parameters = input.parameters;
    const browserInput = parameters && typeof parameters === "object" && !Array.isArray(parameters) ? parameters : input;
    const action = firstString(input, ["action", "kind", "operation"]) ?? tool.split(/[._:/-]/).at(-1) ?? "browse";
    preview = endTruncate((command ? browserCommandPreview(command) : undefined) ?? browserActionPreview(action, browserInput));
  } else if (kind === "mcp") {
    mcp = describeMcpCall(effective.mcp ?? looseMcpCall(tool, input), output, context);
    label = mcp.title;
    preview = endTruncate(mcp.preview, 96);
  } else if (kind === "subagent") {
    const parameters = input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)
      ? input.parameters as JsonObject
      : {};
    preview = endTruncate(
      firstString(parameters, ["title", "description"])
        ?? description
        ?? firstString(parameters, ["prompt"])
        ?? firstString(input, ["prompt"])
        ?? "Delegated task",
      86,
    );
  } else if (isNativeTodoTool(tool)) {
    label = "Plan";
    const items = nativeTodoItems(tool, input);
    const done = items?.filter((item) => item.status === "done").length ?? 0;
    const current = items?.find((item) => item.status === "active") ?? items?.find((item) => item.status === "pending");
    preview = items
      ? endTruncate(`${done}/${items.length} done${current ? ` · ${current.text}` : ""}`, 86)
      : endTruncate(description ?? title ?? tool, 86);
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
    ...(mcp ? { mcp } : {}),
  };
}

function compactValue(value: JsonValue): string {
  if (typeof value === "string") return endTruncate(value.replace(/\s+/g, " "), 180);
  if (value === null || typeof value !== "object") return String(value);
  return endTruncate(JSON.stringify(value), 180);
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

/** Extensions the files raw endpoint actually serves as an image. `.svg` is
 *  deliberately out: the server hands it back as a download, and reading one
 *  means reading its markup. */
const IMAGE_PATH = /\.(?:avif|bmp|gif|ico|jpe?g|png|webp)$/i;

export function isImagePath(path: string | undefined): boolean {
  return path !== undefined && IMAGE_PATH.test(path);
}

// "00012| text" pads the separator with one space; "  12→text" does not.
const NUMBERED_LINE = /^\s*(\d+)(?:\| ?|→)(.*)$/;

/** Read tools ship a transport, not a document: the body is wrapped in
 *  `<file>` tags and every line carries its own number ("00012| x", "  12→x").
 *  Strip that back to real source plus the line the fragment starts at, so it
 *  can be rendered with a real gutter and syntax colour. */
export function readFragment(output: string): { code: string; startLine: number } {
  const body = output
    .replace(/^\s*<file>\r?\n?/, "")
    .replace(/\r?\n?<\/file>\s*$/, "")
    .replace(/\s+$/, "");
  const lines = body.split(/\r?\n/);
  const numbered = lines
    .map((line) => NUMBERED_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  // Trailing notes ("(File has more lines…)") are normal; a body that is only
  // incidentally numeric is not a numbered read.
  if (numbered.length < Math.max(2, lines.length - 2)) return { code: body, startLine: 1 };
  return { code: numbered.map((match) => match[2]).join("\n"), startLine: Number(numbered[0]![1]) };
}

export function outputLineCount(output: string): number {
  return lineCount(output);
}

export function executionGroupLabel(tools: readonly ToolMsg[]): string {
  const counts = new Map<ExecutionKind, number>();
  for (const tool of tools) {
    const mcpCall = effectiveToolCall(tool.tool, tool.input).mcp;
    // Polyth's own tools are agent bookkeeping, not external research; a plan
    // update says nothing about what the work was.
    if (mcpCall && isPolythMcpCall(mcpCall) && mcpCall.tool === "polyth_todo") continue;
    const kind = classifyTool(tool.tool, tool.input);
    const counted = kind === "mcp" && mcpCall && isPolythMcpCall(mcpCall) ? "tool" : kind;
    counts.set(counted, (counts.get(counted) ?? 0) + 1);
  }
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominant === "read" || dominant === "search") return "Repository inspection";
  if (dominant === "edit" || dominant === "write" || dominant === "create") return "Implementation";
  if (dominant === "test") return "Verification";
  if (dominant === "web" || dominant === "mcp") return "External research";
  if (dominant === "subagent") return "Delegated work";
  return "Agent work";
}

function cleanReasoningLine(line: string): string {
  return line.replace(/^[\s#>*+-]+/, "").replace(/[*_`]+/g, "").trim();
}

/** Two-line reasoning preview: the beginning once settled, the live tail while
 * streaming. The CSS owns the final clamp; this only keeps the mounted text
 * bounded and free of markdown markers. A zero max length keeps short static
 * thoughts complete so they never gain an ellipsis. */
export function reasoningPreview(reasoning: string, preferTail = false, maxLineLength = 180): string {
  const lines = reasoning
    .split(/\r?\n/)
    .map(cleanReasoningLine)
    .filter((line) => line !== "");
  return (preferTail ? lines.slice(-2) : lines.slice(0, 2))
    .map((line) => maxLineLength > 0 ? endTruncate(line, maxLineLength) : line)
    .join("\n");
}

/** Raw reasoning after the two meaningful lines shown in the header. Keeping
 * the split here makes the expanded body continue the preview instead of
 * repeating it. */
export function reasoningContinuation(reasoning: string): string {
  const lines = reasoning.split(/\r?\n/);
  let meaningful = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || cleanReasoningLine(line) === "") continue;
    meaningful += 1;
    if (meaningful > 2) return lines.slice(index).join("\n").trim();
  }
  return "";
}

/** Newest meaningful reasoning line for the collapsed live preview: markdown
 * emphasis/heading/list markers are stripped so the tail reads as prose. */
export function reasoningTail(reasoning: string): string {
  const line = reasoning
    .split(/\r?\n/)
    .reverse()
    .map(cleanReasoningLine)
    .find((candidate) => candidate !== "");
  return line === undefined ? "" : endTruncate(line, 110);
}

/** First meaningful reasoning line for the collapsed preview once thinking
 * finished (same stripping as reasoningTail, opposite end). */
export function reasoningHead(reasoning: string): string {
  const line = reasoning
    .split(/\r?\n/)
    .map(cleanReasoningLine)
    .find((candidate) => candidate !== "");
  return line === undefined ? "" : endTruncate(line, 110);
}

/** A speakable subject is a few plain words; a regex or code fragment is not. */
const speakableTerm = (value: string | undefined, max = 40): string | undefined => {
  if (!value || /[\\^$|*+?()[\]{}<>=;]/.test(value)) return undefined;
  const words = value.replace(/[^\p{L}\p{N}\s._-]+/gu, " ").replace(/\s+/g, " ").trim();
  return words && words.length <= max && /\p{L}/u.test(words) ? words : undefined;
};

/** The package-facing reading of a tool call (`host.execution.describe`):
 *  the same classification as the timeline cards, reduced to a kind and a
 *  short subject that is safe to say aloud — a file name, never its path. */
export function describeToolActivity(tool: string, input: JsonObject): ToolActivityDescription {
  const presentation = executionPresentation({ tool, input, output: undefined, title: undefined });
  const { kind } = presentation;
  const fileName = presentation.path && !(presentation.files && presentation.files.length > 1)
    ? executionPathParts(presentation.path).filename || undefined
    : undefined;
  const withTarget = (target: string | undefined): ToolActivityDescription =>
    target ? { kind, target } : { kind };
  switch (kind) {
    case "read":
    case "edit":
    case "write":
    case "create":
    case "delete":
      return withTarget(fileName);
    case "search":
      return withTarget(speakableTerm(presentation.query));
    case "shell": {
      const executable = presentation.command
        ? commandBasename(shellWords(cleanShellCommand(presentation.command))[0] ?? "")
        : "";
      return withTarget(speakableTerm(executable, 24));
    }
    case "web": {
      const url = firstString(effectiveToolCall(tool, input).input, ["url", "href"]);
      try {
        return withTarget(url ? new URL(url).host.replace(/^www\./, "") : undefined);
      } catch {
        return { kind };
      }
    }
    case "mcp":
      return withTarget(presentation.mcp && !presentation.mcp.polyth ? speakableTerm(presentation.mcp.service, 30) : undefined);
    case "tool":
      if (presentation.label === "Plan") return { kind: "plan" };
      return withTarget(speakableTerm(presentation.label, 30));
    default:
      return { kind };
  }
}
