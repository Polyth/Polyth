import { useSyncExternalStore } from "react";

export interface GitPrefs {
  layout: "unified" | "split";
  ignoreWhitespace: boolean;
  wrap: boolean;
  changesView: "flat" | "tree";
}

export interface SplitDiffRow {
  left: string;
  right: string;
  kind: "context" | "change" | "hunk";
}

export const GIT_PREFS_KEY = "polyth.gitPrefs";
export const GIT_PREFS_DEFAULTS: GitPrefs = {
  layout: "unified",
  ignoreWhitespace: false,
  wrap: false,
  changesView: "tree",
};

export function parseGitPrefs(raw: string | null): GitPrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<GitPrefs>;
    return {
      layout: data.layout === "split" ? "split" : "unified",
      ignoreWhitespace: data.ignoreWhitespace === true,
      wrap: data.wrap === true,
      changesView: data.changesView === "flat" ? "flat" : "tree",
    };
  } catch {
    return { ...GIT_PREFS_DEFAULTS };
  }
}

const read = (): string | null => {
  try { return localStorage.getItem(GIT_PREFS_KEY); } catch { return null; }
};
let prefs = parseGitPrefs(read());
const listeners = new Set<() => void>();

export function getGitPrefs(): GitPrefs {
  return prefs;
}

export function setGitPrefs(patch: Partial<GitPrefs>): void {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(GIT_PREFS_KEY, JSON.stringify(prefs)); } catch { /* best effort */ }
  for (const listener of [...listeners]) listener();
}

export function useGitPrefs(): GitPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getGitPrefs,
  );
}

/** Align adjacent delete/add runs for a compact side-by-side renderer. */
export function splitDiffRows(diff: string): SplitDiffRow[] {
  const lines = diff.split("\n");
  const rows: SplitDiffRow[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? "";
    if (line.startsWith("@@")) {
      rows.push({ left: line, right: line, kind: "hunk" });
      i += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("-") && !lines[i]!.startsWith("---")) removed.push(lines[i++]!);
      while (i < lines.length && lines[i]!.startsWith("+") && !lines[i]!.startsWith("+++")) added.push(lines[i++]!);
      const count = Math.max(removed.length, added.length);
      for (let j = 0; j < count; j++) rows.push({ left: removed[j] ?? "", right: added[j] ?? "", kind: "change" });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ left: "", right: line, kind: "change" });
    } else {
      rows.push({ left: line, right: line, kind: "context" });
    }
    i += 1;
  }
  return rows;
}
