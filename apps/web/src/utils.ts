// DOM-free pure helpers extracted from components for testability.
import type { SlashCommand, SnippetDef } from "./api.ts";

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
