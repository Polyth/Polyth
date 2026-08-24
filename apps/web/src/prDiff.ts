export interface PrDiffFile {
  path: string;
  previousPath?: string;
  diff: string;
}

const decodePath = (raw: string): string => {
  const value = raw.replace(/^"|"$/g, "");
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value;
  }
};

const pathAfterPrefix = (raw: string): string | null => {
  if (raw === "/dev/null") return null;
  return decodePath(raw.replace(/^[ab]\//, ""));
};

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
    const match = /^diff --git (.+) (.+)$/.exec(header);
    const oldHeader = slice.find((line) => line.startsWith("--- "))?.slice(4).trim();
    const newHeader = slice.find((line) => line.startsWith("+++ "))?.slice(4).trim();
    const oldPath = oldHeader ? pathAfterPrefix(oldHeader) : match ? pathAfterPrefix(match[1]!) : null;
    const newPath = newHeader ? pathAfterPrefix(newHeader) : match ? pathAfterPrefix(match[2]!) : null;
    const path = newPath ?? oldPath ?? `File ${index + 1}`;
    return {
      path,
      ...(oldPath && newPath && oldPath !== newPath ? { previousPath: oldPath } : {}),
      diff: slice.join("\n"),
    };
  });
}
