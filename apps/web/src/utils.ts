// DOM-free pure helpers extracted from components for testability.
import type { SlashCommand, SnippetDef } from "@polyth/session/web-api";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import type { AssistantMsg, RenderMessage, TaskActivityMsg, ToolMsg, UserMsg } from "./reduce.ts";
import { tr } from "./i18n/index.ts";
import { isNativeMobile } from "@polyth/mobile/runtime";
import { writeNativeClipboard } from "@polyth/mobile/native";

/** Text of the first user message in a session's event log, if any. */
export function firstUserText(events: readonly SessionEvent[] | undefined): string | undefined {
  const ev = events?.find((e) => e.type === "user/message");
  const t = ev ? (ev.data as JsonObject).text : undefined;
  return typeof t === "string" && t.trim() ? t : undefined;
}

// Event arrays are replaced (never mutated) on change, so the derived title is
// cached per array identity. Hot render paths (sidebar rows, store selectors)
// call this once per store notification per session; without the cache each
// call re-scanned the log.
const firstUserTextCache = new WeakMap<readonly SessionEvent[], string | undefined>();

export function firstUserTextCached(events: readonly SessionEvent[] | undefined): string | undefined {
  if (events === undefined) return undefined;
  if (firstUserTextCache.has(events)) return firstUserTextCache.get(events);
  const text = firstUserText(events);
  firstUserTextCache.set(events, text);
  return text;
}

/** Text of the latest non-empty user message in a session's event log, if any. */
export function lastUserText(events: readonly SessionEvent[] | undefined): string | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type !== "user/message") continue;
    const t = (events[i]!.data as JsonObject).text;
    if (typeof t === "string" && t.trim()) return t;
  }
}

const lastUserTextCache = new WeakMap<readonly SessionEvent[], string | undefined>();

export function lastUserTextCached(events: readonly SessionEvent[] | undefined): string | undefined {
  if (events === undefined) return undefined;
  if (lastUserTextCache.has(events)) return lastUserTextCache.get(events);
  const text = lastUserText(events);
  lastUserTextCache.set(events, text);
  return text;
}

export interface AutocompleteItem {
  label: string;
  detail: string;
  value: string;
}

export function commandDescription(command: SlashCommand): string {
  if (command.scope !== "builtin") return command.description;
  const descriptions: Readonly<Record<string, string>> = {
    init: tr("commands.initDescription"),
    review: tr("commands.reviewDescription"),
    compact: tr("commands.compactDescription"),
    summary: tr("commands.summaryDescription"),
  };
  return descriptions[command.name] ?? command.description;
}

export function filterCommands(cmds: SlashCommand[], prefix: string): AutocompleteItem[] {
  const q = prefix.toLowerCase();
  return cmds
    .filter((c) =>
      c.name.toLowerCase().includes(q) || commandDescription(c).toLowerCase().includes(q))
    .map((c) => ({
      label: `/${c.name}`,
      detail: commandDescription(c),
      value: `/${c.name} `,
    }));
}

export function filterSnippets(snips: SnippetDef[], prefix: string): AutocompleteItem[] {
  const q = prefix.toLowerCase();
  return snips
    .filter((s) => s.alias.toLowerCase().includes(q))
    .map((s) => ({
      label: `#${s.alias}`,
      detail: s.text.length > 60 ? s.text.slice(0, 57) + "…" : s.text,
      value: `#${s.alias} `,
    }));
}

/** Parse a unified diff string into structured lines for rendering. */
export function parseDiffLines(diff: string): Array<{ text: string; kind: "add" | "del" | "hunk" | "ctx" }> {
  if (!diff) return [];
  return diff.split("\n").map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return { text: line, kind: "add" as const };
    if (line.startsWith("-") && !line.startsWith("---")) return { text: line, kind: "del" as const };
    if (line.startsWith("@@")) return { text: line, kind: "hunk" as const };
    return { text: line, kind: "ctx" as const };
  });
}

/** Added/removed line counts of a unified diff. */
export function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of parseDiffLines(diff)) {
    if (l.kind === "add") add += 1;
    else if (l.kind === "del") del += 1;
  }
  return { add, del };
}

const SUMMARY_KEYS = ["command", "filePath", "path", "file", "pattern", "query", "url"];

/** One-line echo of a tool call's most telling argument, for the card header. */
export function toolSummary(input: JsonObject): string {
  for (const k of SUMMARY_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.length > 160 ? `${v.slice(0, 157)}…` : v;
  }
  return "";
}

export interface WorkGroup {
  kind: "work";
  id: string;
  items: Array<ToolMsg | TaskActivityMsg>;
  tools: ToolMsg[];
  tasks: TaskActivityMsg[];
  ms: number;
}

export type ActivityItem = AssistantMsg | ToolMsg | TaskActivityMsg;

export interface ActivityGroup {
  kind: "activity";
  id: string;
  items: ActivityItem[];
  tools: ToolMsg[];
  tasks: TaskActivityMsg[];
  thoughts: AssistantMsg[];
  ms: number;
  settled: boolean;
}

/** Merge runs of reasoning-only assistant parts into the next answer part so
 *  one message shows a single Thinking block (WP4 merged thinking). A run cut
 *  off by a tool call (or end of log) keeps its own block. */
export function mergeThinking(messages: RenderMessage[]): RenderMessage[] {
  const out: RenderMessage[] = [];
  // `rev` accumulates every source message's mutation counter plus a +1 per
  // merged source, so a merged row's rev changes whenever any of its sources
  // mutates OR a new source joins the run (row memoization contract).
  let pending: {
    texts: string[];
    time: number;
    id: string;
    eventSeq: number;
    finalized: boolean;
    rev: number;
    startedAt?: number;
    endedAt?: number;
  } | null = null;
  const spanOf = (p: NonNullable<typeof pending>): { reasoningStartedAt?: number; reasoningEndedAt?: number } => ({
    ...(p.startedAt !== undefined ? { reasoningStartedAt: p.startedAt } : {}),
    ...(p.endedAt !== undefined ? { reasoningEndedAt: p.endedAt } : {}),
  });
  const flush = (midLog: boolean) => {
    if (!pending) return;
    out.push({
      kind: "assistant",
      id: pending.id,
      partId: pending.id,
      eventSeq: pending.eventSeq,
      text: "",
      reasoning: pending.texts.join("\n\n"),
      ...spanOf(pending),
      // A later message proves this thinking finished even without a part-final.
      finalized: midLog ? true : pending.finalized,
      time: pending.time,
      rev: pending.rev + (midLog ? 1 : 0),
    });
    pending = null;
  };
  for (const m of messages) {
    if (m.kind === "assistant" && m.text === "" && m.reasoning !== "") {
      if (pending) {
        pending.texts.push(m.reasoning);
        pending.finalized = m.finalized;
        pending.rev += (m.rev ?? 0) + 1;
        if (m.reasoningStartedAt !== undefined && (pending.startedAt === undefined || m.reasoningStartedAt < pending.startedAt)) {
          pending.startedAt = m.reasoningStartedAt;
        }
        if (m.reasoningEndedAt !== undefined && (pending.endedAt === undefined || m.reasoningEndedAt > pending.endedAt)) {
          pending.endedAt = m.reasoningEndedAt;
        }
      } else {
        pending = {
          texts: [m.reasoning],
          time: m.time,
          id: m.id,
          eventSeq: m.eventSeq,
          finalized: m.finalized,
          rev: (m.rev ?? 0) + 1,
          ...(m.reasoningStartedAt !== undefined ? { startedAt: m.reasoningStartedAt } : {}),
          ...(m.reasoningEndedAt !== undefined ? { endedAt: m.reasoningEndedAt } : {}),
        };
      }
      continue;
    }
    if (m.kind === "assistant" && pending) {
      const merged = [...pending.texts, m.reasoning].filter(Boolean).join("\n\n");
      const startedAt = [pending.startedAt, m.reasoningStartedAt].filter((v): v is number => v !== undefined);
      const endedAt = [pending.endedAt, m.reasoningEndedAt].filter((v): v is number => v !== undefined);
      out.push({
        ...m,
        reasoning: merged,
        ...(startedAt.length > 0 ? { reasoningStartedAt: Math.min(...startedAt) } : {}),
        ...(endedAt.length > 0 ? { reasoningEndedAt: Math.max(...endedAt) } : {}),
        rev: (m.rev ?? 0) + pending.rev,
      });
      pending = null;
      continue;
    }
    flush(true);
    out.push(m);
  }
  flush(false);
  return out;
}

/** Message as Markdown for the copy action. */
export function messageMarkdown(m: RenderMessage): string {
  if (m.kind === "github-conflict") {
    return `### Fixing merge conflicts for pull request #${m.prNumber}\n\n${m.title}\n\n\`${m.baseRefName} ← ${m.headRefName}\`\n\n${m.url}`;
  }
  if (m.kind === "task") {
    return tr("utils.taskValueValue", { action: m.action, text: m.text });
  }
  if (m.kind === "tool") {
    const parts = [`### ${m.title || m.tool}`, "```json", JSON.stringify(m.input, null, 2), "```"];
    if (m.output) parts.push("", m.output);
    if (m.error) parts.push("", tr("utils.errorValue", { error: m.error }));
    return parts.join("\n");
  }
  return m.text;
}

/** Message as structured JSON for the copy action. */
export function messageJson(m: RenderMessage): string {
  if (m.kind === "user") return JSON.stringify({ role: "user", text: m.text, time: m.time }, null, 2);
  if (m.kind === "assistant") {
    return JSON.stringify(
      { role: "assistant", text: m.text, reasoning: m.reasoning || undefined, finalized: m.finalized, time: m.time },
      null,
      2,
    );
  }
  if (m.kind === "tool") {
    return JSON.stringify(
      { role: "tool", tool: m.tool, input: m.input, output: m.output, error: m.error, status: m.status, time: m.time },
      null,
      2,
    );
  }
  if (m.kind === "github-conflict") {
    return JSON.stringify(
      {
        role: "github-conflict",
        prNumber: m.prNumber,
        title: m.title,
        url: m.url,
        baseRefName: m.baseRefName,
        headRefName: m.headRefName,
        time: m.time,
      },
      null,
      2,
    );
  }
  return JSON.stringify({ role: "task", taskId: m.taskId, action: m.action, text: m.text, time: m.time }, null, 2);
}

/** User prompts with previews for the prompt navigator (WP4). `text` is the
 *  bounded full prompt for the L13 hover-preview card. */
export function promptIndex(messages: RenderMessage[]): Array<{ id: string; preview: string; text: string }> {
  return messages
    .filter((m): m is UserMsg => m.kind === "user")
    .map((m) => {
      const first = m.text.split("\n").find((l) => l.trim()) ?? "";
      return {
        id: m.id,
        preview: first.length > 64 ? `${first.slice(0, 61)}…` : first,
        text: m.text.length > 1200 ? `${m.text.slice(0, 1200)}…` : m.text,
      };
    });
}

/** Collapse tool calls and semantic task deltas into one "Worked for …" group. */
export function groupWork(messages: RenderMessage[]): Array<RenderMessage | WorkGroup> {
  const out: Array<RenderMessage | WorkGroup> = [];
  let run: Array<ToolMsg | TaskActivityMsg> = [];
  const flush = () => {
    const tools = run.filter((item): item is ToolMsg => item.kind === "tool");
    const tasks = run.filter((item): item is TaskActivityMsg => item.kind === "task");
    if (run.length >= 2 || tasks.length > 0) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const end = last.kind === "tool" ? (last.finishTime ?? last.time) : last.time;
      out.push({ kind: "work", id: `work-${first.id}`, items: run, tools, tasks, ms: Math.max(0, end - first.time) });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const m of messages) {
    if (m.kind === "tool" || m.kind === "task") run.push(m);
    else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

/** Project one turn into an activity stream followed by its final reading
 * surface. Interim assistant prose, reasoning, tools, and task deltas become
 * one expandable group; the last textual assistant message remains the final
 * response. This is display-only derivation over already-recorded events. */
export function groupActivity(messages: RenderMessage[]): Array<RenderMessage | ActivityGroup> {
  const out: Array<RenderMessage | ActivityGroup> = [];
  let segment: ActivityItem[] = [];

  const flush = () => {
    if (segment.length === 0) return;
    const last = segment.at(-1)!;
    const finalIndex = last.kind === "assistant" && last.text.trim() !== "" ? segment.length - 1 : -1;
    const final = finalIndex >= 0 ? segment[finalIndex] as AssistantMsg : undefined;
    const activity: ActivityItem[] = [];
    for (let index = 0; index < segment.length; index++) {
      const item = segment[index]!;
      if (index !== finalIndex) {
        activity.push(item);
        continue;
      }
      if (item.kind === "assistant" && item.reasoning.trim() !== "") {
        activity.push({ ...item, text: "" });
      }
    }
    if (activity.length > 0) {
      const first = activity[0]!;
      const end = Math.max(...activity.map((item) => item.kind === "tool"
        ? item.finishTime ?? item.time
        : item.kind === "assistant" ? item.completedAt ?? item.time : item.time));
      const latestTasks = new Map(
        activity.filter((item): item is TaskActivityMsg => item.kind === "task")
          .map((task) => [task.taskId, task]),
      );
      out.push({
        kind: "activity",
        id: `activity-${first.id}`,
        items: activity,
        tools: activity.filter((item): item is ToolMsg => item.kind === "tool"),
        tasks: activity.filter((item): item is TaskActivityMsg => item.kind === "task"),
        thoughts: activity.filter((item): item is AssistantMsg => item.kind === "assistant"),
        ms: Math.max(0, end - first.time),
        settled: final?.finalized === true || (
          activity.every((item) => item.kind !== "tool" || (item.status !== "pending" && item.status !== "running")) &&
          activity.every((item) => item.kind !== "assistant" || item.finalized) &&
          [...latestTasks.values()].every((task) => task.action !== "started")
        ),
      });
    }
    if (final) out.push(final.reasoning ? { ...final, reasoning: "" } : final);
    segment = [];
  };

  for (const message of messages) {
    if (message.kind === "user" || message.kind === "github-conflict") {
      flush();
      out.push(message);
    } else {
      segment.push(message);
    }
  }
  flush();
  return out;
}

// ---- per-session composer drafts (localStorage: polyth.draft.<sessionId>) ----

const DRAFT = "polyth.draft.";

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(DRAFT + sessionId) ?? "";
  } catch {
    return "";
  }
}

/** Empty text removes the key, so a sent message leaves no stale draft behind. */
export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT + sessionId, text);
    else localStorage.removeItem(DRAFT + sessionId);
  } catch {
    // private mode / quota — drafts are best-effort
  }
}

// ---- server-side draft sync (debounced, fire-and-forget) -------------------

const serverDraftTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced server sync: 800ms after the last local edit, push the draft to
 *  the server so other clients see it. Fire-and-forget — localStorage is the
 *  fast local truth; the server projection catches up. */
export function syncDraftToServer(sessionId: string, text: string): void {
  const existing = serverDraftTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  serverDraftTimers.set(sessionId, setTimeout(() => {
    serverDraftTimers.delete(sessionId);
    // Dynamic import to avoid circular deps; api is a singleton.
    import("@polyth/session/web-api").then(({ api }) =>
      api.saveDraft(sessionId, text).catch(() => { /* best-effort */ }),
    );
  }, 800));
}

/** Flush any pending server draft sync for a session (e.g. before session switch). */
export function flushDraftToServer(sessionId: string): void {
  const t = serverDraftTimers.get(sessionId);
  if (!t) return;
  clearTimeout(t);
  serverDraftTimers.delete(sessionId);
  const text = loadDraft(sessionId);
  import("@polyth/session/web-api").then(({ api }) =>
    api.saveDraft(sessionId, text).catch(() => { /* best-effort */ }),
  );
}

function copyTextFallback(text: string): boolean {
  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/** Copy text to the clipboard; injectable for tests. Returns success. */
export function copyText(
  text: string,
  clip?: { writeText(t: string): Promise<void> },
): Promise<boolean> {
  if (!clip && isNativeMobile()) return writeNativeClipboard(text);
  const clipboard = clip ?? (
    typeof navigator !== "undefined"
      && globalThis.isSecureContext === true
      && typeof navigator.clipboard?.writeText === "function"
      ? navigator.clipboard
      : undefined
  );
  if (!clipboard) {
    // Keep the legacy operation in the original user-gesture call stack.
    return Promise.resolve(copyTextFallback(text));
  }
  try {
    return clipboard.writeText(text).then(
      () => true,
      () => copyTextFallback(text),
    );
  } catch {
    return Promise.resolve(copyTextFallback(text));
  }
}

/** Split a goal objective into checklist rows. Completed goals strike every item. */
export function goalChecklist(objective: string, status: string): Array<{ text: string; done: boolean }> {
  const lines = objective.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = lines.map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, "")).filter(Boolean);
  const rows = items.length ? items : (objective.trim() ? [objective.trim()] : []);
  const done = status === "completed";
  return rows.map((text) => ({ text, done }));
}

/** Terminal WS reconnect backoff (F12): 500 ms doubling to a 5 s ceiling. */
export function nextTermBackoff(prev: number | undefined): number {
  if (!prev || prev < 500) return 500;
  return Math.min(prev * 2, 5000);
}
