// Canonical textual-hunk parsing shared by review comments and Git mutations.
// Keep the FNV digest stable: persisted review anchors already use it. Strong
// mutation freshness is supplied separately by a SHA-256 digest of the entire
// exact diff snapshot.
export interface DiffHunk {
  /** Raw @@ header line. */
  header: string;
  /** Hunk body lines (context, +, -, metadata) excluding the header. */
  body: string[];
  /** New-file start line parsed from the header (for jump links). */
  startNew: number;
}

export function splitHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of diff.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { header: line, body: [], startNew: Number(m[1]) };
      continue;
    }
    if (cur && (
      line.startsWith("+")
      || line.startsWith("-")
      || line.startsWith(" ")
      || line.startsWith("\\")
      || line === ""
    )) {
      // File headers (+++/---) never appear inside a hunk body.
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Stable review identity: FNV-1a 32-bit over changed/context content. The
 * newline marker was not part of the historical parser, so omit it here too. */
export function hunkDigest(h: DiffHunk): string {
  let hash = 0x811c9dc5;
  const text = h.body
    .filter((line) => !line.startsWith("\\ No newline at end of file"))
    .join("\n");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
