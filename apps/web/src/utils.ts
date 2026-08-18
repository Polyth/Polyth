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
