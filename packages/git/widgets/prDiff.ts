export interface PrDiffFile {
  path: string;
  previousPath?: string;
  diff: string;
}

export interface PrDiffLine {
  text: string;
  kind: "meta" | "hunk" | "add" | "delete" | "context" | "sentinel";
  oldLine?: number;
  newLine?: number;
}

const decodePath = (raw: string): string => {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
};

const pathAfterPrefix = (raw: string): string | null => {
  const value = decodePath(raw);
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
};

const headerPaths = (header: string): [string, string] | null => {
  const tokens = header.slice("diff --git ".length).match(/"(?:\\.|[^"])*"|\S+/g);
  return tokens?.length === 2 ? [tokens[0]!, tokens[1]!] : null;
};

/** Parse display rows without assigning source line numbers to patch metadata or sentinels. */
export function parsePrDiffLines(diff: string): PrDiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return diff.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { text, kind: "hunk" };
    }
    if (text === "\\ No newline at end of file") return { text, kind: "sentinel" };
    if (!inHunk) return { text, kind: "meta" };
    if (text.startsWith("+")) return { text, kind: "add", newLine: newLine++ };
    if (text.startsWith("-")) return { text, kind: "delete", oldLine: oldLine++ };
    if (text.startsWith(" ")) {
      const row = { text, kind: "context" as const, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return row;
    }
    return { text, kind: "meta" };
  });
}

/** Split a GitHub unified diff into reviewable file patches. */
export function splitPrDiff(diff: string): PrDiffFile[] {
  if (!diff.trim()) return [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });
  if (starts.length === 0) return [{ path: "Pull request diff", diff }];

  return starts.map((start, index) => {
    const slice = lines.slice(start, starts[index + 1] ?? lines.length);
    const header = slice[0] ?? "";
    const paths = headerPaths(header);
    const oldHeader = slice.find((line) => line.startsWith("--- "))?.slice(4).trim();
    const newHeader = slice.find((line) => line.startsWith("+++ "))?.slice(4).trim();
    const renameFrom = slice.find((line) => line.startsWith("rename from "))?.slice("rename from ".length);
    const renameTo = slice.find((line) => line.startsWith("rename to "))?.slice("rename to ".length);
    const copyFrom = slice.find((line) => line.startsWith("copy from "))?.slice("copy from ".length);
    const copyTo = slice.find((line) => line.startsWith("copy to "))?.slice("copy to ".length);
    const oldPath = renameFrom !== undefined
      ? decodePath(renameFrom)
      : copyFrom !== undefined
        ? decodePath(copyFrom)
        : oldHeader ? pathAfterPrefix(oldHeader) : paths ? pathAfterPrefix(paths[0]) : null;
    const newPath = renameTo !== undefined
      ? decodePath(renameTo)
      : copyTo !== undefined
        ? decodePath(copyTo)
        : newHeader ? pathAfterPrefix(newHeader) : paths ? pathAfterPrefix(paths[1]) : null;
    const path = newPath ?? oldPath ?? `File ${index + 1}`;
    return {
      path,
      ...(oldPath && newPath && oldPath !== newPath ? { previousPath: oldPath } : {}),
      diff: slice.join("\n"),
    };
  });
}
