// DOM-free pure helpers extracted from components for testability.
import type { SlashCommand, SnippetDef } from "@polyth/session/web-api";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import type { AssistantMsg, RenderMessage, TaskActivityMsg, ToolMsg, UserMsg } from "./reduce.ts";
import { tr } from "./i18n/index.ts";
import { isNativeMobile } from "@polyth/mobile/runtime";
import { writeNativeClipboard } from "@polyth/mobile/native";
import { acknowledgeDraftRevision, loadScopedDraftRecord, recordLocalDraftEdit, scopedDraftCacheKey, trackOutboundDraftWrite } from "./draftRecord.ts";
import { clientPersistenceScope } from "./reliabilityContext.ts";
import type { PersistenceScope } from "./clientPersistence.ts";
import type { ActionGrouping, ThinkingDisplayMode } from "./uiPrefs.ts";
import { stripRecoveryContextBlocks } from "./recoveryDisplay.ts";
import { normalizeQuestions, questionsToMarkdown, type AnswerMap } from "./questionSerializers.ts";

/** Text of the first user message in a session's event log, if any. */
export function firstUserText(events: readonly SessionEvent[] | undefined): string | undefined {
  // A hidden message (e.g. a delegated-permission wake) is not the person's
  // request and must never title the session.
  const ev = events?.find((e) => e.type === "user/message" && (e.data as JsonObject).hiddenUserMessage !== true);
  const t = ev ? (ev.data as JsonObject).text : undefined;
  const visible = typeof t === "string" ? stripRecoveryContextBlocks(t) : undefined;
  return visible && visible.trim() ? visible : undefined;
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
    const visible = typeof t === "string" ? stripRecoveryContextBlocks(t) : undefined;
    if (visible && visible.trim()) return visible;
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

/** Build one activity group from its ordered items. Used both when projecting
 *  a turn and when an interleaved timeline fact (harness switch, compaction,
 *  rewind marker) lands inside a group's seq range: the group splits around
 *  the fact instead of collecting below it. `index` keeps the derived id
 *  unique and stable (0 is the original group). */
export function activityGroup(id: string, items: ActivityItem[], index = 0): ActivityGroup {
  const first = items[0]!;
  const end = Math.max(...items.map(activityEnd));
  const latestTasks = new Map(
    items.filter((item): item is TaskActivityMsg => item.kind === "task")
      .map((task) => [task.taskId, task]),
  );
  return {
    kind: "activity",
    id: index === 0 ? id : `${id}-split-${index}`,
    items,
    tools: items.filter((item): item is ToolMsg => item.kind === "tool"),
    tasks: items.filter((item): item is TaskActivityMsg => item.kind === "task"),
    thoughts: items.filter((item): item is AssistantMsg => item.kind === "assistant"),
    ms: Math.max(0, end - first.time),
    settled: items.every((item) => item.kind !== "tool" || (item.status !== "pending" && item.status !== "running"))
      && items.every((item) => item.kind !== "assistant" || item.finalized)
      && [...latestTasks.values()].every((task) => task.action !== "started"),
  };
}

/** Merge runs of reasoning-only assistant parts into the next answer part so
 *  one message shows a single Thinking block (merged thinking). A run cut
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
  if (m.kind === "notice") {
    return m.topic === "isolation-merged"
      ? tr("timeline.mergedIntoValue", { branch: m.branch ?? "", commit: m.commit ?? "" })
      : m.topic === "isolation-started"
        ? tr("timeline.isolatedFromBranch", { branch: m.branch ?? "" })
        : tr("timeline.isolatedWorkspaceDiscarded");
  }
  if (m.kind === "task") {
    return tr("utils.taskValueValue", { action: m.action, text: m.text });
  }
  if (m.kind === "person-message") {
    return `${m.author?.name || tr("timeline.anotherPerson")}: ${m.text}`;
  }
  if (m.kind === "conversation-started") {
    return tr("timeline.sessionStartedBy", { name: m.startedBy?.name || tr("timeline.anotherPerson"), title: m.title });
  }
  if (m.kind === "question") {
    return questionsToMarkdown(normalizeQuestions(m.questions), (m.answers ?? {}) as AnswerMap);
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
  if (m.kind === "notice") {
    return JSON.stringify(
      { role: "notice", topic: m.topic, branch: m.branch, commit: m.commit, time: m.time },
      null,
      2,
    );
  }
  if (m.kind === "question") {
    return JSON.stringify(
      { role: "question", questions: m.questions, status: m.status, answers: m.answers, time: m.time },
      null,
      2,
    );
  }
  if (m.kind === "person-message") {
    return JSON.stringify(
      { role: "person-message", text: m.text, author: m.author, mentions: m.mentions, carryToAgent: m.carryToAgent, replyToSeq: m.replyToSeq, time: m.time },
      null,
      2,
    );
  }
  if (m.kind === "conversation-started") {
    return JSON.stringify(
      { role: "conversation-started", sessionId: m.sessionId, title: m.title, sourceSeqs: m.sourceSeqs, startedBy: m.startedBy, time: m.time },
      null,
      2,
    );
  }
  return JSON.stringify({ role: "task", taskId: m.taskId, action: m.action, text: m.text, time: m.time }, null, 2);
}

/** User prompts with previews for the prompt navigator. `text` is the
 *  bounded full prompt for the hover-preview card. */
export function promptIndex(messages: RenderMessage[]): Array<{ id: string; preview: string; text: string }> {
  return messages
    .filter((m): m is UserMsg => m.kind === "user")
    .map((m) => {
      // A code fence opener is not a summary of the prompt; the server-side
      // prompt history caps previews at the same 128 characters.
      const first = m.text.split("\n").find((l) => l.trim() && !/^\s*(?:```|~~~)/.test(l)) ?? "";
      return {
        id: m.id,
        preview: first.length > 128 ? `${first.slice(0, 127)}…` : first,
        text: m.text.length > 1200 ? `${m.text.slice(0, 1200)}…` : m.text,
      };
    });
}

function activityEnd(item: ActivityItem): number {
  return item.kind === "tool"
    ? item.finishTime ?? item.time
    : item.kind === "assistant"
      ? item.completedAt ?? item.time
      : item.time;
}

/** Any textual assistant part that is already visible is a reading surface.
 * The runtime can emit assistant chunks before the final assistant/message
 * event, so waiting for `finalized` would leave a later tool in the same
 * activity block and render its live copy above the visible prose. */
function isVisibleTextAnswer(item: ActivityItem): item is AssistantMsg {
  return item.kind === "assistant" && item.text.trim() !== "";
}

/** Project one turn into activity groups separated by standalone reasoning
 * rows. Tools and task deltas stay together; reasoning becomes a quiet divider
 * and visible text followed by later activity remains a reading surface in its
 * own right. In activity mode, reasoning stays inside the technical block and
 * is omitted when there is no technical work. Ungrouped mode returns the
 * display rows unchanged. This is display-only derivation over already-recorded
 * events. */
export function groupActivity(
  messages: RenderMessage[],
  thinkingDisplayMode: ThinkingDisplayMode = "collapsed",
  actionGrouping: ActionGrouping = "grouped",
): Array<RenderMessage | ActivityGroup> {
  if (actionGrouping === "ungrouped") return messages;
  const out: Array<RenderMessage | ActivityGroup> = [];
  let segment: ActivityItem[] = [];

  const pushActivity = (items: ActivityItem[]) => {
    if (items.length === 0) return;
    if (thinkingDisplayMode === "activity" && !items.some((item) => item.kind === "tool" || item.kind === "task")) return;
    out.push(activityGroup(`activity-${items[0]!.id}`, items));
  };

  const flush = () => {
    if (segment.length === 0) return;
    const last = segment.at(-1)!;
    let finalIndex = last.kind === "assistant" && last.text.trim() !== "" ? segment.length - 1 : -1;
    if (finalIndex < 0) {
      // Older ACP turns used one part for prose both before and after tools.
      // The reducer keeps that part at its first-chunk position, but its
      // assistant/message completion is later than the tools it ultimately
      // answered. Recover that terminal answer without rewriting history.
      finalIndex = segment.findLastIndex((candidate, candidateIndex) => {
        if (candidate.kind !== "assistant" || !candidate.finalized
          || candidate.text.trim() === "" || candidate.completedAt === undefined) return false;
        return segment.every((item, itemIndex) => {
          if (itemIndex === candidateIndex) return true;
          const endedAt = activityEnd(item);
          return candidate.completedAt! > endedAt;
        });
      });
    }
    const answerIndexes = new Set<number>();
    for (let index = 0; index < segment.length; index += 1) {
      const item = segment[index]!;
      if (index === finalIndex || !isVisibleTextAnswer(item)) continue;
      // Text that is already visible before a later item is a real reading
      // surface in the middle of the turn, even while it is still streaming.
      // The reducer preserves event order in this segment; timestamps and
      // eventSeq can differ for copied/reconciled provider history.
      if (index < segment.length - 1) {
        answerIndexes.add(index);
      }
    }
    if (finalIndex >= 0) answerIndexes.add(finalIndex);

    // A legacy part can be stored at its first-chunk position even though its
    // completion happened after the tools that follow it. Keep that answer at
    // the end, as the old projection did, while normal mid-turn answers stay
    // in event order.
    const finalCandidate = finalIndex >= 0 ? segment[finalIndex] : undefined;
    const deferredFinal = finalIndex >= 0
      && finalIndex < segment.length - 1
      && finalCandidate?.kind === "assistant"
      && finalCandidate.completedAt !== undefined
      && !segment.slice(finalIndex + 1).some((later) => later.time >= finalCandidate.completedAt!);
    let activity: ActivityItem[] = [];
    const flushActivity = () => {
      pushActivity(activity);
      activity = [];
    };
    const emitThinking = (item: AssistantMsg) => {
      // In activity mode the thought belongs to the surrounding tool/task
      // block; it must not become a second standalone timeline row.
      if (thinkingDisplayMode === "activity") {
        activity.push({
          ...item,
          id: `${item.id}-thinking`,
          partId: `${item.partId}-thinking`,
          text: "",
        });
        return;
      }
      flushActivity();
      // A synthetic presentation id keeps the separator and its answer from
      // sharing a React key when both came from one canonical assistant part.
      out.push({
        ...item,
        id: `${item.id}-thinking`,
        partId: `${item.partId}-thinking`,
        text: "",
      });
    };
    const emitAnswer = (item: AssistantMsg) => {
      if (item.reasoning.trim() !== "") emitThinking(item);
      flushActivity();
      out.push(item.reasoning.trim() !== "" ? { ...item, reasoning: "" } : item);
    };
    for (let index = 0; index < segment.length; index += 1) {
      const item = segment[index]!;
      if (deferredFinal && index === finalIndex) continue;
      if (item.kind === "assistant" && item.text.trim() === "" && item.reasoning.trim() !== "") {
        emitThinking(item);
        continue;
      }
      if (!answerIndexes.has(index)) {
        activity.push(item);
        continue;
      }
      emitAnswer(item as AssistantMsg);
    }
    flushActivity();
    if (deferredFinal && finalCandidate?.kind === "assistant") {
      if (finalCandidate.reasoning.trim() !== "") emitThinking(finalCandidate);
      flushActivity();
      out.push(finalCandidate.reasoning.trim() !== "" ? { ...finalCandidate, reasoning: "" } : finalCandidate);
    }
    segment = [];
  };

  for (const message of messages) {
    // A person's own `!` command is a turn of its own, like a prompt; so is
    // their answer to the agent's question, which stays in the conversation.
    if (message.kind === "user" || message.kind === "github-conflict" || message.kind === "notice"
      || message.kind === "question" || message.kind === "person-message"
      || message.kind === "conversation-started" || (message.kind === "tool" && message.composerShell)) {
      flush();
      out.push(message);
    } else {
      segment.push(message);
    }
  }
  flush();
  return out;
}

// ---- per-session composer drafts ------------------------------------------------
// Scope is trusted connection + authenticated account + Space + active project
// + session. Legacy unscoped keys are intentionally left untouched: no caller
// can prove which server/account owned them.

export function loadDraft(sessionId: string): string {
  return loadScopedDraftRecord(sessionId).text;
}

/** Empty text removes the key, so a sent message leaves no stale draft behind. */
export function saveDraft(sessionId: string, text: string): void {
  recordLocalDraftEdit(sessionId, text);
}

// ---- server-side draft sync (debounced, serialized per scoped session) ------

const serverDraftTimers = new Map<string, ReturnType<typeof setTimeout>>();
type DraftSyncOutcome = "sent" | "skipped" | "conflict" | "failed";
type DraftSyncRequest = {
  sessionId: string;
  text: string;
  scope: PersistenceScope;
  conflictGeneration: number;
};
type DraftSyncState = {
  running: boolean;
  /** The drain in progress, so an explicit save can await its own write. */
  flight?: Promise<void>;
  pending?: DraftSyncRequest;
  conflictGeneration: number;
  conflictRevision?: number;
};
const serverDraftSync = new Map<string, DraftSyncState>();

/** Debounced server sync: 2.5s after the last local edit, push the draft to
 *  the server so other clients see it. localStorage is the fast local truth;
 *  the server projection catches up. Requests are serialized per scoped
 *  session so a slow ACK cannot make a newer local revision reuse its stale
 *  CAS witness. */
export function syncDraftToServer(sessionId: string, text: string, scopeOverride?: PersistenceScope): void {
  const capturedScope = scopeOverride ?? clientPersistenceScope({ sessionId });
  const key = scopedDraftCacheKey(sessionId, capturedScope);
  const record = loadScopedDraftRecord(sessionId, capturedScope);
  if (!record.dirty || record.text !== text) return;
  const existing = serverDraftTimers.get(key);
  if (existing) clearTimeout(existing);
  serverDraftTimers.set(key, setTimeout(() => {
    serverDraftTimers.delete(key);
    enqueueDraftRevision(sessionId, text, capturedScope);
  }, 2_500));
}

/** Cancel a pending autosave when a send takes ownership of the draft. */
export function cancelDraftSync(sessionId: string, scopeOverride?: PersistenceScope): void {
  const capturedScope = scopeOverride ?? clientPersistenceScope({ sessionId });
  const key = scopedDraftCacheKey(sessionId, capturedScope);
  const timer = serverDraftTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  serverDraftTimers.delete(key);
}

/** Flush any pending server draft sync for a session (e.g. before session switch). */
export function flushDraftToServer(sessionId: string): void {
  const capturedScope = clientPersistenceScope({ sessionId });
  const key = scopedDraftCacheKey(sessionId, capturedScope);
  const timer = serverDraftTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  serverDraftTimers.delete(key);
  enqueueDraftRevision(sessionId, loadDraft(sessionId), capturedScope);
}

function enqueueDraftRevision(sessionId: string, text: string, scope: PersistenceScope): void {
  const key = scopedDraftCacheKey(sessionId, scope);
  const record = loadScopedDraftRecord(sessionId, scope);
  const state = serverDraftSync.get(key) ?? {
    running: false,
    conflictGeneration: 0,
  };
  // A real cross-client conflict is preserved for explicit recovery. Repeated
  // blur/pagehide events for the same local revision must not keep replaying a
  // request that is known to be stale.
  if (state.conflictRevision === record.revision) return;
  if (state.conflictRevision !== undefined) state.conflictRevision = undefined;
  state.pending = {
    sessionId,
    text,
    scope,
    conflictGeneration: state.conflictGeneration,
  };
  serverDraftSync.set(key, state);
  if (!state.running) state.flight = drainDraftSync(key, state);
}

/** Save a draft to the server now instead of after the autosave debounce
 *  (Send held to keep the message as a draft). Resolves true once the server
 *  acknowledged this local revision. The write goes through the same serialized
 *  CAS queue as autosave, so it cannot race a slower one. */
export async function saveDraftToServerNow(sessionId: string, scopeOverride?: PersistenceScope): Promise<boolean> {
  const capturedScope = scopeOverride ?? clientPersistenceScope({ sessionId });
  const key = scopedDraftCacheKey(sessionId, capturedScope);
  const timer = serverDraftTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    serverDraftTimers.delete(key);
  }
  const record = loadScopedDraftRecord(sessionId, capturedScope);
  if (!record.dirty) return true;
  enqueueDraftRevision(sessionId, record.text, capturedScope);
  await serverDraftSync.get(key)?.flight;
  // The acknowledgement itself advances the local revision and stamps the
  // server's write time; a newer local edit may still be pending after it.
  const after = loadScopedDraftRecord(sessionId, capturedScope);
  return !after.dirty || (after.serverUpdatedAt !== undefined && after.serverUpdatedAt !== record.serverUpdatedAt);
}

async function drainDraftSync(key: string, state: DraftSyncState): Promise<void> {
  state.running = true;
  try {
    while (state.pending) {
      const request = state.pending;
      state.pending = undefined;
      // A conflict detected by the previous request invalidates every request
      // already queued behind it. A later local edit schedules a fresh one.
      if (request.conflictGeneration !== state.conflictGeneration) continue;
      const outcome = await sendDraftRevision(request.sessionId, request.text, request.scope);
      if (outcome === "conflict") {
        state.conflictRevision = loadScopedDraftRecord(request.sessionId, request.scope).revision;
        state.conflictGeneration++;
      } else if (outcome === "sent") {
        state.conflictRevision = undefined;
      }
    }
  } finally {
    state.running = false;
    state.flight = undefined;
    if (!state.pending && state.conflictRevision === undefined) serverDraftSync.delete(key);
  }
}

async function sendDraftRevision(
  sessionId: string,
  text: string,
  capturedScope: PersistenceScope,
): Promise<DraftSyncOutcome> {
  if (scopedDraftCacheKey(sessionId) !== scopedDraftCacheKey(sessionId, capturedScope)) return "skipped";
  const record = loadScopedDraftRecord(sessionId, capturedScope);
  // A newer edit replaced this timer's payload before it ran.
  if (record.text !== text || !record.dirty) return "skipped";
  const settleOutbound = trackOutboundDraftWrite(sessionId, text, capturedScope);
  let definitive = false;
  try {
    const { api } = await import("@polyth/session/web-api");
    const result = await api.saveDraft(sessionId, text, record.serverUpdatedAt ?? null);
    acknowledgeDraftRevision(sessionId, record.revision, result.draftUpdatedAt, capturedScope);
    definitive = true;
    return "sent";
  } catch (error) {
    // Keep dirty local text. A typed conflict is authoritative evidence that
    // this CAS witness is stale; other failures remain retryable on the next
    // explicit edit/lifecycle flush.
    definitive = (error as { code?: unknown }).code === "draft-conflict";
    return definitive ? "conflict" : "failed";
  } finally {
    settleOutbound(definitive);
  }
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

/** Terminal WS reconnect backoff: 500 ms doubling to a 5 s ceiling. */
export function nextTermBackoff(prev: number | undefined): number {
  if (!prev || prev < 500) return 500;
  return Math.min(prev * 2, 5000);
}
