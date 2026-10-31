// One readable projection of an MCP tool call, whatever harness made it.
//
// Harnesses name the same call differently: Claude `mcp__server__tool`,
// OpenCode `server_tool`, Antigravity `call_mcp_tool` (server, tool and JSON
// arguments as fields) or `mcp_server_tool`, Codex the bare tool plus a
// `server` input field. `mcpCallOf` folds them into one call; `describeMcpCall`
// turns a call and its result into the words and structure the timeline shows,
// so a row reads as what the agent did, not as transport.
import type { JsonObject, JsonValue } from "@polyth/contracts";
import { isTodoToolName, normalizeTodoItems, todoItemsFromToolInput, type TodoItem } from "@polyth/todos";
import { getLocale, tr, type TranslationKey } from "./i18n/index.ts";

/** Server name the Polyth agent-tools bridge is published under. */
export const POLYTH_MCP_SERVER = "polyth-agent-tools";

export interface McpCall {
  /** Raw server id when the harness reported one. */
  server?: string;
  /** Tool name on that server. */
  tool: string;
  args: JsonObject;
}

export type McpIcon =
  | "plan" | "session" | "brain" | "globe" | "file" | "shield" | "home"
  | "usage" | "chat" | "plug" | "search" | "check" | "github" | "events";

export interface McpField {
  label: string;
  value: string;
  href?: string;
}

export interface McpListItem {
  title: string;
  href?: string;
  detail?: string;
  meta?: string;
}

export type McpBody =
  | { kind: "todo"; items: TodoItem[]; changed: string[] }
  | { kind: "list"; label: string; items: McpListItem[]; total: number }
  | { kind: "session"; title: string; status?: string; detail?: string; sessionId?: string }
  | { kind: "fields"; fields: McpField[] }
  | { kind: "text"; text: string }
  | { kind: "empty"; text: string };

export interface McpCallView {
  /** Human service name: "Polyth", "GitHub", "Home Assistant". */
  service: string;
  /** True for Polyth's own tools, whose service name is not news. */
  polyth: boolean;
  /** Collapsed-row title. */
  title: string;
  /** Collapsed-row detail. */
  preview: string;
  icon: McpIcon;
  /** Text the call carried (a message sent, a memory saved). */
  message?: { label: string; text: string };
  /** Readable request arguments not already said by title/preview/message. */
  request: McpField[];
  /** Result blocks in reading order. */
  result: McpBody[];
}

export interface McpDescribeContext {
  /** Canonical session title for an id the call names. */
  sessionTitle?(id: string): string | undefined;
}

const record = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const scalar = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : str(value);

function jsonArgs(value: unknown): JsonObject {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== "string") return {};
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

/** Polyth agent tools some harnesses publish without their server prefix. */
const BARE_POLYTH_TOOL = /^(?:polyth(?:_[a-z0-9_]+)?|memory_(?:search|get|remember|feedback)|monitoring_read|google_(?:gmail|calendar|drive)_[a-z_]+)$/;

export function mcpCallOf(tool: string, input: JsonObject): McpCall | undefined {
  const name = tool.trim();
  if (/^call_mcp_tool$/i.test(name)) {
    const inner = str(input.ToolName ?? input.toolName ?? input.tool_name ?? input.tool);
    if (!inner) return undefined;
    const server = str(input.ServerName ?? input.serverName ?? input.server_name ?? input.server);
    return { ...(server ? { server } : {}), tool: inner, args: jsonArgs(input.Arguments ?? input.arguments ?? input.args) };
  }
  const qualified = name.match(/^mcp__(.+?)__(.+)$/);
  if (qualified) return { server: qualified[1]!, tool: qualified[2]!, args: input };
  const polyth = name.match(/^(?:mcp__?)?polyth-agent-tools(?:__|_)(.+)$/);
  if (polyth) return { server: POLYTH_MCP_SERVER, tool: polyth[1]!, args: input };
  // Antigravity's `mcp_<server>_<tool>`: only a hyphenated server splits unambiguously.
  const single = name.match(/^mcp_([a-z0-9]+(?:-[a-z0-9]+)+)_(.+)$/i);
  if (single) return { server: single[1]!, tool: single[2]!, args: input };
  // Codex reports the bare tool and adds the server as an input field.
  const server = str(input.server);
  if (server && /^[\w.-]+$/.test(server) && /^[\w.-]+$/.test(name)) {
    const { server: _server, ...args } = input;
    return { server, tool: name, args };
  }
  if (BARE_POLYTH_TOOL.test(name)) return { server: POLYTH_MCP_SERVER, tool: name, args: input };
  return undefined;
}

/** `mcp__server__tool` for a call with a known server, else its bare tool. */
export function canonicalMcpToolName(call: McpCall): string {
  return call.server ? `mcp__${call.server}__${call.tool}` : call.tool;
}

/** The tool a row is really about: an MCP wrapper is replaced by the call it carries. */
export function effectiveToolCall(tool: string, input: JsonObject): { tool: string; input: JsonObject; mcp?: McpCall } {
  const mcp = mcpCallOf(tool, input);
  return mcp ? { tool: canonicalMcpToolName(mcp), input: mcp.args, mcp } : { tool, input };
}

export const isPolythMcpCall = (call: McpCall): boolean =>
  call.server === POLYTH_MCP_SERVER || call.server === "polyth" || (!call.server && BARE_POLYTH_TOOL.test(call.tool));

// ---- text helpers -------------------------------------------------------------

export function endTruncate(text: string, max = 96): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const oneLine = (text: string, max = 96): string => endTruncate(text.replace(/\s+/g, " ").trim(), max);

const firstLine = (text: string, max = 96): string =>
  oneLine(text.split(/\r?\n/).map((line) => line.replace(/^[\s#>*+-]+/, "").trim()).find(Boolean) ?? "", max);

const sentence = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** "session.switchHarness", "get_pull_request" → "Session switch harness". */
export function humanizeName(value: string): string {
  return sentence(value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/-]+|_+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase());
}

const BRANDS: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  posthog: "PostHog",
  mongodb: "MongoDB",
  postgres: "Postgres",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  graphql: "GraphQL",
  openapi: "OpenAPI",
  mempalace: "MemPalace",
  opencode: "OpenCode",
  "polyth-agent-tools": "Polyth",
  polyth: "Polyth",
};

export function serviceName(server: string | undefined): string {
  if (!server) return "MCP";
  const brand = BRANDS[server.toLowerCase()];
  if (brand) return brand;
  return server.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) || "MCP";
}

const quoted = (text: string, max = 56): string => `“${oneLine(text, max)}”`;

const COUNT_KEYS = {
  item: ["toolcall.countItemOne", "toolcall.countItemOther"],
  field: ["toolcall.countFieldOne", "toolcall.countFieldOther"],
  project: ["toolcall.countProjectOne", "toolcall.countProjectOther"],
  subagent: ["toolcall.countSubagentOne", "toolcall.countSubagentOther"],
  session: ["toolcall.countSessionOne", "toolcall.countSessionOther"],
  update: ["toolcall.countUpdateOne", "toolcall.countUpdateOther"],
  result: ["toolcall.countResultOne", "toolcall.countResultOther"],
  savedCredential: ["toolcall.countSavedCredentialOne", "toolcall.countSavedCredentialOther"],
} as const satisfies Record<string, readonly [TranslationKey, TranslationKey]>;

/** "1 result" / "5 results" in the active language. */
const count = (n: number, noun: keyof typeof COUNT_KEYS): string =>
  tr(COUNT_KEYS[noun][new Intl.PluralRules(getLocale()).select(n) === "one" ? 0 : 1], { count: n });

// ---- result parsing -------------------------------------------------------------

/** Unwrap MCP content blocks and thin `{data|result}` envelopes. */
export function unwrapMcpValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    if (value.length === 1) return unwrapMcpValue(value[0] ?? null);
    const blocks = value.length > 0 && value.every((item) => {
      const block = record(item);
      return block?.type === "text" && typeof block.text === "string";
    });
    if (blocks) {
      const text = value.map((item) => (record(item)!.text as string)).join("\n");
      try {
        return unwrapMcpValue(JSON.parse(text) as JsonValue);
      } catch {
        return text;
      }
    }
    return value;
  }
  const row = record(value);
  if (!row) return value;
  if (row.type === "text" && typeof row.text === "string" && Object.keys(row).length <= 3) {
    try {
      return unwrapMcpValue(JSON.parse(row.text) as JsonValue);
    } catch {
      return row.text;
    }
  }
  for (const key of ["data", "result"]) {
    const nested = row[key];
    if (nested !== undefined && Object.keys(row).length <= 3) return unwrapMcpValue(nested);
  }
  if (Array.isArray(row.content)) return unwrapMcpValue(row.content);
  return value;
}

/** Parsed result value, or the plain text when the result is not JSON. */
export function mcpResultValue(output: string | undefined): JsonValue | undefined {
  if (output === undefined || !output.trim()) return undefined;
  try {
    return unwrapMcpValue(JSON.parse(output) as JsonValue);
  } catch {
    return output.trim();
  }
}

const TITLE_KEYS = ["title", "name", "friendlyName", "label", "subject", "summary", "filename", "path", "login", "handle", "query"] as const;
const DETAIL_KEYS = ["snippet", "description", "purpose", "excerpt", "body", "text", "content", "message", "preview"] as const;
const META_KEYS = ["state", "status", "kind", "domain", "role", "category", "type"] as const;
const HREF_KEYS = ["html_url", "url", "href", "web_url", "link"] as const;
const ID_KEYS = ["id", "number", "entityId", "key", "seq"] as const;
/** Keys that name a result's main collection, in preference order. */
const COLLECTION_KEYS = [
  "results", "items", "entities", "handles", "memories", "sessions", "agents", "messages", "observations",
  "events", "files", "issues", "pulls", "repositories", "tasks", "tools", "projects", "entries", "rows", "records",
] as const;
const TOTAL_KEYS = ["total", "count", "totalCount", "total_count", "returned"] as const;
/** Bookkeeping fields that say nothing to a person. */
const NOISE_KEY = /^(?:operationId|generation|digest|revision|etag|cursor|nextCursor|nextAfterSeq|latestSeq|createdAt|updatedAt|generatedAt|truncated|provider|projectId|parentId|parentSessionId|spaceId|requestId|traceId)$/i;

const pickString = (row: JsonObject, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = scalar(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const isHref = (value: string | undefined): value is string => value !== undefined && /^https?:\/\//i.test(value);

function hostOf(href: string): string | undefined {
  try {
    return new URL(href).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function listItem(value: JsonValue, index: number): McpListItem {
  const row = record(value);
  if (!row) {
    const text = scalar(value) ?? (Array.isArray(value) ? count(value.length, "item") : "");
    return { title: oneLine(text, 140) || tr("toolcall.itemNumber", { number: index + 1 }), ...(isHref(text) ? { href: text } : {}) };
  }
  const href = HREF_KEYS.map((key) => str(row[key])).find(isHref);
  const titleText = pickString(row, TITLE_KEYS);
  const detailText = pickString(row, DETAIL_KEYS);
  const role = str(row.role);
  // A message row reads as its text; its role is the meta.
  const title = titleText
    ?? (detailText && (role || !pickString(row, ID_KEYS)) ? firstLine(detailText, 140) : undefined)
    ?? pickString(row, ID_KEYS)
    ?? (href ? hostOf(href) ?? href : undefined)
    ?? tr("toolcall.itemNumber", { number: index + 1 });
  const detail = detailText && titleText ? oneLine(detailText, 220) : undefined;
  const metaParts = [
    ...META_KEYS.map((key) => scalar(row[key])).filter((part): part is string => part !== undefined).slice(0, 2),
    ...(href && !META_KEYS.some((key) => row[key] !== undefined) ? [hostOf(href)].filter((part): part is string => !!part) : []),
  ];
  return {
    title: oneLine(title, 140),
    ...(href ? { href } : {}),
    ...(detail && detail !== oneLine(title, 140) ? { detail } : {}),
    ...(metaParts.length ? { meta: metaParts.map((part) => humanizeValue(part)).join(" · ") } : {}),
  };
}

/** "in_progress" → "In progress"; numbers and prose pass through. */
function humanizeValue(value: string): string {
  return /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(value) ? humanizeName(value) : value;
}

function fieldValue(value: JsonValue): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "boolean") return value ? tr("toolcall.yes") : tr("toolcall.no");
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim() ? oneLine(value, 180) : undefined;
  if (Array.isArray(value)) return value.length === 0 ? tr("common.none") : count(value.length, "item");
  const named = pickString(value, [...TITLE_KEYS, ...ID_KEYS]);
  if (named) return oneLine(named, 180);
  const keys = Object.keys(value).filter((key) => !NOISE_KEY.test(key));
  return keys.length ? count(keys.length, "field") : undefined;
}

function fieldsOf(row: JsonObject, skip: ReadonlySet<string> = new Set(), limit = 8): McpField[] {
  const fields: McpField[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (skip.has(key) || NOISE_KEY.test(key) || value === undefined) continue;
    const display = fieldValue(value);
    if (display === undefined) continue;
    const href = typeof value === "string" && isHref(value.trim()) ? value.trim() : undefined;
    // Only enum-like fields ("in_progress") read better humanized; names stay as written.
    const enumLike = (META_KEYS as readonly string[]).includes(key) && typeof value === "string";
    fields.push({ label: humanizeName(key), value: enumLike ? humanizeValue(display) : display, ...(href ? { href } : {}) });
    if (fields.length >= limit) break;
  }
  return fields;
}

function sessionBody(row: JsonObject): Extract<McpBody, { kind: "session" }> | undefined {
  const title = str(row.title);
  const id = str(row.id);
  if (!title && !id) return undefined;
  const model = record(row.model);
  const harness = str(row.resolvedHarnessId) ?? str(record(row.harness)?.harnessId);
  const modelId = str(model?.modelID);
  return {
    kind: "session",
    title: title ?? tr("toolcall.untitledSession"),
    ...(str(row.status) ? { status: humanizeValue(str(row.status)!) } : {}),
    ...(harness || modelId ? { detail: [harness && serviceName(harness), modelId].filter(Boolean).join(" · ") } : {}),
    ...(id ? { sessionId: id } : {}),
  };
}

const LIST_LIMIT = 6;

function listBody(label: string, values: JsonValue[], total?: number): McpBody {
  return {
    kind: "list",
    label,
    items: values.slice(0, LIST_LIMIT).map(listItem),
    total: Math.max(total ?? values.length, values.length),
  };
}

/** Readable result blocks for any MCP result. */
export function mcpResultBodies(value: JsonValue | undefined, emptyText = tr("toolcall.noResult")): McpBody[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() ? [{ kind: "text", text: value.trim() }] : [];
  if (typeof value !== "object") return [{ kind: "fields", fields: [{ label: tr("toolcall.result"), value: String(value) }] }];
  if (Array.isArray(value)) return value.length ? [listBody(tr("execution.results"), value)] : [{ kind: "empty", text: emptyText }];
  const bodies: McpBody[] = [];
  const used = new Set<string>();
  const session = record(value.session);
  const sessionCard = session ? sessionBody(session) : undefined;
  if (sessionCard) {
    bodies.push(sessionCard);
    used.add("session");
  }
  const collectionKey = COLLECTION_KEYS.find((key) => Array.isArray(value[key]))
    ?? Object.keys(value).find((key) => Array.isArray(value[key])
      && (value[key] as JsonValue[]).some((item) => record(item) !== undefined));
  if (collectionKey) {
    const values = value[collectionKey] as JsonValue[];
    const total = TOTAL_KEYS.map((key) => value[key]).find((candidate): candidate is number => typeof candidate === "number");
    bodies.push(values.length ? listBody(humanizeName(collectionKey), values, total) : { kind: "empty", text: emptyText });
    used.add(collectionKey);
    for (const key of TOTAL_KEYS) used.add(key);
  }
  for (const key of ["project", "host", "query", "debug", "policy"]) {
    if (collectionKey || sessionCard) used.add(key);
  }
  const rest = fieldsOf(value, used);
  if (rest.length) bodies.push({ kind: "fields", fields: rest });
  if (!bodies.length) bodies.push({ kind: "empty", text: emptyText });
  return bodies;
}

const resultTotal = (value: JsonValue | undefined): number | undefined => {
  if (Array.isArray(value)) return value.length;
  const row = record(value);
  if (!row) return undefined;
  const total = TOTAL_KEYS.map((key) => row[key]).find((candidate): candidate is number => typeof candidate === "number");
  if (total !== undefined) return total;
  const key = COLLECTION_KEYS.find((candidate) => Array.isArray(row[candidate]));
  return key ? (row[key] as JsonValue[]).length : undefined;
};

// ---- todo ----------------------------------------------------------------------

const TODO_MARK: Readonly<Record<string, TodoItem["status"]>> = { x: "done", ">": "active", "-": "failed", " ": "pending" };

/** The full list `polyth_todo` reports back ("[x] id: text" lines). */
export function todoItemsFromOutput(output: string | undefined): TodoItem[] | undefined {
  const value = mcpResultValue(output);
  if (typeof value !== "string") return undefined;
  if (/^todo list is empty\.?$/i.test(value)) return [];
  if (!/^Todos \(\d+\/\d+ completed\):/i.test(value)) return undefined;
  const items: TodoItem[] = [];
  for (const line of value.split(/\r?\n/).slice(1)) {
    const match = line.match(/^\[([x >-])\]\s+(.+?):\s(.*)$/);
    if (match) items.push({ id: match[2]!, text: match[3]!.trim(), status: TODO_MARK[match[1]!]! });
  }
  return items;
}

/** A native full-list todo/plan tool (TodoWrite, todo_write, update_plan, …). */
export const isNativeTodoTool = (tool: string): boolean => isTodoToolName(tool);

/** A native todo/plan tool's replacement list (TodoWrite, update_plan, …). */
export function nativeTodoItems(tool: string, input: JsonObject): TodoItem[] | undefined {
  return todoItemsFromToolInput(tool, input);
}

export interface TodoProgressSummary {
  done: number;
  total: number;
  current?: TodoItem;
}

export function todoSummary(items: readonly TodoItem[]): TodoProgressSummary {
  const done = items.filter((item) => item.status === "done").length;
  const current = items.find((item) => item.status === "active") ?? items.find((item) => item.status === "pending");
  return { done, total: items.length, ...(current ? { current } : {}) };
}

const TODO_VERB: Readonly<Record<TodoItem["status"], TranslationKey>> = {
  done: "toolcall.todoDone",
  active: "toolcall.todoStarted",
  failed: "toolcall.todoCancelled",
  pending: "toolcall.todoAdded",
};

function describeTodo(call: McpCall, output: string | undefined): Pick<McpCallView, "title" | "preview" | "icon" | "result"> {
  const sent = Array.isArray(call.args.todos) ? call.args.todos : undefined;
  const merge = call.args.merge === true;
  const reported = todoItemsFromOutput(output);
  const proposed = sent ? normalizeTodoItems(sent) ?? [] : undefined;
  const items = reported ?? (merge ? undefined : proposed) ?? [];
  const changed = merge && sent
    ? sent.map((row) => scalar(record(row)?.id)).filter((id): id is string => id !== undefined)
    : [];
  const summary = todoSummary(items);
  const progress = summary.total ? tr("toolcall.todoProgress", { done: summary.done, total: summary.total }) : "";
  let preview: string;
  if (sent === undefined) {
    preview = summary.total ? progress : tr("toolcall.todoEmpty");
  } else if (sent.length === 0) {
    preview = tr("toolcall.todoCleared");
  } else if (merge && changed.length === 1) {
    const item = items.find((candidate) => candidate.id === changed[0])
      ?? proposed?.find((candidate) => candidate.id === changed[0]);
    preview = item ? `${tr(TODO_VERB[item.status])} · ${oneLine(item.text, 72)}` : progress;
  } else if (summary.total && summary.done === summary.total) {
    preview = tr("toolcall.todoAllDone", { count: summary.total });
  } else {
    preview = [progress, summary.current && oneLine(summary.current.text, 64)].filter(Boolean).join(" · ");
  }
  return {
    title: merge && sent !== undefined ? tr("toolcall.planUpdated") : tr("timeline.plan2"),
    preview: preview || tr("timeline.plan2"),
    icon: "plan",
    result: items.length
      ? [{ kind: "todo", items, changed }]
      : sent?.length === 0 || reported?.length === 0 ? [{ kind: "empty", text: tr("toolcall.noSteps") }] : [],
  };
}

// ---- Polyth tool descriptions --------------------------------------------------------

const CONTROL_TITLES: Readonly<Record<string, TranslationKey>> = {
  "session.send": "toolcall.control.sessionSend",
  "session.messages": "toolcall.control.sessionMessages",
  "session.events": "toolcall.control.sessionEvents",
  "session.debug": "toolcall.control.sessionDebug",
  "session.get": "toolcall.control.sessionGet",
  "session.inspect": "toolcall.control.sessionInspect",
  "session.list": "toolcall.control.sessionList",
  "session.archive": "toolcall.control.sessionArchive",
  "session.restore": "toolcall.control.sessionRestore",
  "session.delete": "toolcall.control.sessionDelete",
  "session.create": "toolcall.control.sessionCreate",
  "session.update": "toolcall.control.sessionUpdate",
  "session.fork": "toolcall.control.sessionFork",
  "session.cancel": "toolcall.control.sessionCancel",
  "session.watch": "toolcall.control.sessionWatch",
  "session.watches": "toolcall.control.sessionWatches",
  "session.current": "toolcall.control.sessionCurrent",
  "session.switchHarness": "toolcall.control.sessionSwitchHarness",
  "agent.list": "toolcall.control.agentList",
  "agent.models": "toolcall.control.agentModels",
  "api.request": "toolcall.control.apiRequest",
  "project.list": "toolcall.control.projectList",
  "space.list": "toolcall.control.spaceList",
  "package.list": "toolcall.control.packageList",
  "backend.list": "toolcall.control.backendList",
  "catalog.models": "toolcall.control.catalogModels",
  "catalog.agents": "toolcall.control.catalogAgents",
  "catalog.providers": "toolcall.control.catalogProviders",
  "model.favorites": "toolcall.control.modelFavorites",
  "permission.reply": "toolcall.control.permissionReply",
  "queue.list": "toolcall.control.queueList",
  "queue.remove": "toolcall.control.queueRemove",
  "system.discover": "toolcall.control.systemDiscover",
  "system.health": "toolcall.control.systemHealth",
  "system.runtime": "toolcall.control.systemRuntime",
  capabilities: "toolcall.control.capabilities",
  help: "toolcall.control.help",
};

function sessionLabel(id: string | undefined, context: McpDescribeContext): string | undefined {
  if (!id) return undefined;
  return context.sessionTitle?.(id);
}

function describeControl(call: McpCall, value: JsonValue | undefined, context: McpDescribeContext): Partial<McpCallView> {
  const action = str(call.args.action) ?? "";
  const parameters = record(call.args.parameters) ?? {};
  const resultSession = record(record(value)?.session);
  const targetId = str(parameters.sessionId) ?? str(parameters.targetSessionId) ?? str(resultSession?.id);
  const target = sessionLabel(targetId, context) ?? str(resultSession?.title) ?? str(parameters.title);
  const titleKey = CONTROL_TITLES[action];
  const title = titleKey ? tr(titleKey) : action ? humanizeName(action) : "Polyth";
  const text = str(parameters.text) ?? str(parameters.prompt) ?? str(parameters.message);
  let preview = target ?? "";
  if (action === "api.request") {
    preview = [str(parameters.method)?.toUpperCase(), str(parameters.path)].filter(Boolean).join(" ");
  } else if (action === "session.list" || action === "agent.list" || action === "project.list") {
    const total = resultTotal(value);
    preview = total === undefined ? "" : count(total, action === "project.list" ? "project" : action === "agent.list" ? "subagent" : "session");
  } else if (!preview && text) {
    preview = firstLine(text, 80);
  }
  const skip = new Set(["sessionId", "targetSessionId", "text", "prompt", "message", "title", "method", "path", "delivery"]);
  return {
    title,
    preview,
    icon: "session",
    ...(text && action !== "api.request" ? { message: { label: action === "session.send" ? tr("composer.message") : tr("settings.pages.prompt"), text } } : {}),
    request: fieldsOf(parameters, skip, 6),
    // A send only acknowledges delivery; the message above is the content.
    result: action === "session.send" ? [] : mcpResultBodies(value),
  };
}

function describePeer(call: McpCall, value: JsonValue | undefined, context: McpDescribeContext): Partial<McpCallView> {
  const action = str(call.args.action) ?? "";
  const parameters = record(call.args.parameters) ?? call.args;
  const target = sessionLabel(str(parameters.sessionId), context);
  if (action === "session.observe") {
    const content = str(parameters.content) ?? "";
    const kind = str(parameters.kind);
    return {
      title: kind ? tr("toolcall.sharedKind", { kind: humanizeName(kind).toLowerCase() }) : tr("toolcall.sharedUpdate"),
      preview: firstLine(content, 84) || target || "",
      icon: "chat",
      ...(content ? { message: { label: target ? tr("toolcall.toTarget", { target }) : tr("toolcall.update"), text: content } } : {}),
      request: [],
      result: [],
    };
  }
  const total = resultTotal(value);
  return {
    title: action === "session.observations" ? tr("toolcall.readUpdates") : humanizeName(action || "peer"),
    preview: [target, total === undefined ? undefined : total === 0 ? tr("toolcall.noNewUpdates") : count(total, "update")].filter(Boolean).join(" · "),
    icon: "chat",
    request: [],
    result: mcpResultBodies(value, tr("toolcall.noNewUpdates")),
  };
}

function describeMemory(tool: string, call: McpCall, value: JsonValue | undefined): Partial<McpCallView> {
  const verb = tool.slice("memory_".length);
  if (verb === "search") {
    const query = str(call.args.query) ?? "";
    const total = resultTotal(value);
    return {
      title: tr("toolcall.memorySearch"),
      preview: [query && quoted(query), total === undefined ? undefined : count(total, "result")].filter(Boolean).join(" · "),
      icon: "brain",
      request: fieldsOf(call.args, new Set(["query"]), 4),
      result: mcpResultBodies(value, tr("toolcall.nothingRemembered")),
    };
  }
  if (verb === "remember") {
    const title = str(call.args.title) ?? "";
    const body = str(call.args.body) ?? str(call.args.content) ?? "";
    return {
      title: tr("toolcall.savedToMemory"),
      preview: title ? oneLine(title, 84) : firstLine(body, 84),
      icon: "brain",
      ...(body ? { message: { label: title || tr("toolcall.memory"), text: body } } : {}),
      request: fieldsOf(call.args, new Set(["title", "body", "content"]), 3),
      result: [],
    };
  }
  const titled = record(value) ? str(record(value)!.title) ?? str(record(record(value)!.memory)?.title) : undefined;
  return {
    title: verb === "get" ? tr("toolcall.openedMemory") : verb === "feedback" ? tr("toolcall.memoryFeedback") : humanizeName(`memory ${verb}`),
    preview: titled ? oneLine(titled, 84) : str(call.args.rating) ?? "",
    icon: "brain",
    request: fieldsOf(call.args, new Set(["id", "memoryId"]), 4),
    result: mcpResultBodies(value),
  };
}

const GOOGLE_SERVICE: Readonly<Record<string, string>> = { gmail: "Gmail", calendar: "Google Calendar", drive: "Google Drive" };
const HOME_TITLES: Readonly<Record<string, TranslationKey>> = {
  search: "toolcall.home.findDevices",
  timeline: "toolcall.home.activity",
  state: "toolcall.home.deviceState",
  states: "toolcall.home.deviceStates",
  history: "toolcall.home.deviceHistory",
  areas: "toolcall.home.rooms",
  services: "toolcall.home.services",
  call: "toolcall.home.controlDevice",
};

function describePolyth(call: McpCall, value: JsonValue | undefined, context: McpDescribeContext): Partial<McpCallView> {
  const tool = call.tool;
  if (tool === "polyth" || tool === "polyth_control" || tool === "control") return describeControl(call, value, context);
  if (tool === "polyth_peer") return describePeer(call, value, context);
  if (tool.startsWith("memory_")) return describeMemory(tool, call, value);
  if (tool === "web_search") {
    const query = str(call.args.query) ?? "";
    const total = resultTotal(value);
    return {
      title: tr("toolcall.webSearch"),
      preview: [query && quoted(query), total === undefined ? undefined : count(total, "result")].filter(Boolean).join(" · "),
      icon: "globe",
      request: [],
      result: mcpResultBodies(value, tr("toolcall.noResults")),
    };
  }
  if (tool === "web_fetch") {
    // Plain-text output: "Key: value" header lines, a blank line, then the page.
    const text = typeof value === "string" ? value : undefined;
    const split = text?.indexOf("\n\n") ?? -1;
    const header = text && split >= 0 ? text.slice(0, split) : "";
    const page = header.match(/^URL: (\S+)$/m)?.[1] ?? str(call.args.url) ?? "";
    const pageTitle = header.match(/^Title: (.+)$/m)?.[1];
    const host = isHref(page) ? hostOf(page) : undefined;
    const body = text !== undefined && split >= 0 ? text.slice(split).trim() : undefined;
    return {
      title: tr("toolcall.readWebPage"),
      preview: [pageTitle ? oneLine(pageTitle, 72) : undefined, host].filter(Boolean).join(" · "),
      icon: "globe",
      request: page ? [{ label: tr("toolcall.page"), value: page, ...(isHref(page) ? { href: page } : {}) }] : [],
      result: body !== undefined
        ? body ? [{ kind: "text", text: body }] : [{ kind: "empty", text: tr("toolcall.noReadableText") }]
        : mcpResultBodies(value, tr("toolcall.noReadableText")),
    };
  }
  if (tool === "read_file") {
    const path = str(call.args.path) ?? "";
    const cached = path.startsWith("polyth://cache/");
    const text = typeof value === "string" ? value.replace(/^polyth:\/\/\S+ lines \d+-\d+ of \d+\s*/, "") : undefined;
    return {
      title: cached ? tr("toolcall.readSavedResult") : tr("toolcall.readFile"),
      preview: cached ? tr("toolcall.earlierToolOutput") : path,
      icon: "file",
      request: [],
      result: text !== undefined ? mcpResultBodies(mcpResultValue(text)) : mcpResultBodies(value),
    };
  }
  if (tool === "polyth_credential_vault_list") {
    const total = resultTotal(value);
    return {
      title: "Credential Vault",
      preview: total === undefined ? tr("toolcall.savedCredentials") : count(total, "savedCredential"),
      icon: "shield",
      request: [],
      result: mcpResultBodies(value, tr("toolcall.noSavedCredentials")),
    };
  }
  if (tool === "monitoring_read") {
    const action = str(call.args.action) ?? "read";
    return {
      title: tr("toolcall.monitoring"),
      preview: humanizeName(action),
      icon: "usage",
      request: fieldsOf(call.args, new Set(["action"]), 4),
      result: mcpResultBodies(value),
    };
  }
  if (tool === "polyth_mcp") {
    const action = str(call.args.action) ?? "";
    const inner = str(call.args.toolName);
    return {
      title: inner ? humanizeName(inner) : action === "list" ? tr("toolcall.mcpTools") : humanizeName(action || "MCP"),
      preview: inner ? tr("toolcall.mcpTool") : "",
      icon: "plug",
      request: fieldsOf(record(call.args.arguments) ?? {}, new Set(), 6),
      result: mcpResultBodies(value),
    };
  }
  if (tool.startsWith("polyth_home")) {
    const action = str(call.args.action) ?? "";
    const target = str(call.args.query) ?? str(call.args.entityId) ?? str(call.args.entity_id) ?? str(call.args.domain) ?? str(call.args.area);
    const total = resultTotal(value);
    const homeKey = HOME_TITLES[action];
    const title = tool === "polyth_home_assistant_control" ? tr("toolcall.home.controlDevice")
      : tool === "polyth_home_dashboard" ? tr("toolcall.home.dashboard")
        : tool === "polyth_home_watch" ? tr("toolcall.home.watch")
          : homeKey ? tr(homeKey) : action ? humanizeName(action) : "Home Assistant";
    return {
      title,
      preview: [target, total === undefined ? undefined : count(total, "result")].filter(Boolean).join(" · "),
      icon: "home",
      request: fieldsOf(call.args, new Set(["action", "query", "entityId", "entity_id", "domain", "area"]), 4),
      result: mcpResultBodies(value),
    };
  }
  const google = tool.match(/^google_(gmail|calendar|drive)_(\w+)$/);
  if (google) {
    const action = str(call.args.action);
    const target = str(call.args.query) ?? str(call.args.subject) ?? str(call.args.title) ?? str(call.args.name) ?? str(call.args.to);
    return {
      title: `${GOOGLE_SERVICE[google[1]!]} · ${humanizeName(action ?? google[2]!)}`,
      preview: target ? oneLine(target, 80) : "",
      icon: google[1] === "gmail" ? "chat" : google[1] === "calendar" ? "events" : "file",
      request: fieldsOf(call.args, new Set(["action", "query", "subject", "title", "name", "to", "body"]), 5),
      ...(str(call.args.body) ? { message: { label: tr("toolcall.body"), text: str(call.args.body)! } } : {}),
      result: mcpResultBodies(value),
    };
  }
  if (tool === "polyth_tasks" || tool === "polyth_task_update") {
    return {
      title: tool === "polyth_tasks" ? tr("toolcall.linkedTask") : tr("toolcall.updateLinkedTask"),
      preview: str(call.args.status) ?? str(call.args.comment)?.slice(0, 80) ?? "",
      icon: "check",
      ...(str(call.args.comment) ? { message: { label: tr("toolcall.comment"), text: str(call.args.comment)! } } : {}),
      request: fieldsOf(call.args, new Set(["comment", "status"]), 4),
      result: mcpResultBodies(value),
    };
  }
  // Package tools: `<package>_<tool>[-<hash>]`.
  const packageTool = tool.match(/^([a-z0-9]+(?:-[a-z0-9]+)+)_(.+?)(?:-[0-9a-f]{12,})?$/);
  return {
    title: humanizeName(packageTool ? packageTool[2]! : tool.replace(/^polyth_/, "")),
    preview: packageTool ? humanizeName(packageTool[1]!) : primaryArgument(call.args),
    icon: "plug",
    request: fieldsOf(call.args, new Set(), 6),
    result: mcpResultBodies(value),
  };
}

/** The argument a person would name the call by. */
function primaryArgument(args: JsonObject): string {
  const description = str(args.description);
  if (description) return oneLine(description, 82);
  const query = str(args.query) ?? str(args.q) ?? str(args.search);
  if (query) return quoted(query);
  const named = pickString(args, ["title", "name", "subject", "path", "url", "repo", "repository", "entityId", "id", "number"]);
  return named ? oneLine(named, 72) : "";
}

export function describeMcpCall(
  call: McpCall,
  output: string | undefined,
  context: McpDescribeContext = {},
): McpCallView {
  const value = mcpResultValue(output);
  const polyth = isPolythMcpCall(call);
  const service = polyth ? "Polyth" : serviceName(call.server);
  if (polyth && call.tool === "polyth_todo") {
    return { service, polyth, request: [], ...describeTodo(call, output) };
  }
  if (polyth) {
    const described = describePolyth(call, value, context);
    return {
      service,
      polyth,
      title: described.title ?? humanizeName(call.tool),
      preview: described.preview ?? "",
      icon: described.icon ?? "plug",
      ...(described.message ? { message: described.message } : {}),
      request: described.request ?? [],
      result: described.result ?? mcpResultBodies(value),
    };
  }
  // Another server: its name is the news; the action and target follow.
  const serverWords = (call.server ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const bareTool = serverWords && call.tool.toLowerCase().startsWith(`${serverWords}_`)
    ? call.tool.slice(serverWords.length + 1)
    : call.tool;
  const description = str(call.args.description);
  const action = description
    ? oneLine(description, 82).replace(/\b(pr|pull request)\s*#?(\d+)/i, "pull request #$2")
    : humanizeName(bareTool);
  const target = description ? "" : primaryArgument(call.args);
  const total = resultTotal(value);
  return {
    service,
    polyth,
    title: service,
    preview: [sentence(action), target, total === undefined || target === "" ? undefined : count(total, "result")]
      .filter(Boolean).join(" · "),
    icon: call.server?.toLowerCase() === "github" ? "github" : /search|find|query/i.test(bareTool) ? "search" : "plug",
    request: fieldsOf(call.args, new Set(["description"]), 6),
    result: mcpResultBodies(value),
  };
}
