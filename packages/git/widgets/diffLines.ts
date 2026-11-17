// Pure diff line parsing shared by the viewer, line comments and find.
export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// File-level headers already have a home in the section title; repeating them
// as diff rows only pushes the code down.
const FILE_HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to )/;

export function parseDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const raw = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  for (const text of raw) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text });
      continue;
    }
    if (!inHunk || FILE_HEADER.test(text)) {
      if (FILE_HEADER.test(text)) { inHunk = false; continue; }
      lines.push({ kind: "meta", text });
      continue;
    }
    if (text.startsWith("+")) lines.push({ kind: "add", text: text.slice(1), newLine: newLine++ });
    else if (text.startsWith("-")) lines.push({ kind: "del", text: text.slice(1), oldLine: oldLine++ });
    else if (text.startsWith("\\")) lines.push({ kind: "meta", text });
    else lines.push({ kind: "ctx", text: text.startsWith(" ") ? text.slice(1) : text, oldLine: oldLine++, newLine: newLine++ });
  }
  return lines;
}
