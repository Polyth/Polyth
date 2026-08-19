// DOM-free pure helpers extracted from components for testability.
import type { SlashCommand, SnippetDef } from "./api.ts";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import type { RenderMessage, ToolMsg } from "./reduce.ts";

/** Text of the first user message in a session's event log, if any. */
export function firstUserText(events: readonly SessionEvent[] | undefined): string | undefined {
  const ev = events?.find((e) => e.type === "user/message");
  const t = ev ? (ev.data as JsonObject).text : undefined;
  return typeof t === "string" && t.trim() ? t : undefined;
}

export interface AutocompleteItem {
  label: string;
  detail: string;
  value: string;
}

export function filterCommands(cmds: SlashCommand[], prefix: string): AutocompleteItem[] {
  const q = prefix.toLowerCase();
  return cmds
    .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    .map((c) => ({
      label: `/${c.name}`,
      detail: c.description,
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
  tools: ToolMsg[];
  ms: number;
}

/** Collapse runs of ≥2 consecutive tool calls into one "Worked for …" group. */
export function groupWork(messages: RenderMessage[]): Array<RenderMessage | WorkGroup> {
  const out: Array<RenderMessage | WorkGroup> = [];
  let run: ToolMsg[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const end = last.finishTime ?? last.time;
      out.push({ kind: "work", id: `work-${first.id}`, tools: run, ms: Math.max(0, end - first.time) });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const m of messages) {
    if (m.kind === "tool") run.push(m);
    else {
      flush();
      out.push(m);
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

/** Copy text to the clipboard; injectable for tests. Returns success. */
export async function copyText(
  text: string,
  clip?: { writeText(t: string): Promise<void> },
): Promise<boolean> {
  try {
    await (clip ?? navigator.clipboard).writeText(text);
    return true;
  } catch {
    return false;
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

/** Apply a PTY chunk to a terminal buffer: strip CSI, honour CR/BS, cap size. */
export function applyTerminalChunk(prev: string, chunk: string): string {
  const cleaned = chunk
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  let out = prev;
  for (const ch of cleaned) {
    if (ch === "\r") {
      const nl = out.lastIndexOf("\n");
      out = out.slice(0, nl + 1);
    } else if (ch === "\b") {
      if (out.length > 0 && !out.endsWith("\n")) out = out.slice(0, -1);
    } else {
      out += ch;
    }
  }
  return out.length > 200_000 ? out.slice(-150_000) : out;
}
