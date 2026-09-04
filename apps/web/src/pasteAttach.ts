/** Large-paste detection and filename helpers for composer / selection attach. */

export const LARGE_PASTE_CHAR_THRESHOLD = 2000;
export const LARGE_PASTE_LINE_THRESHOLD = 25;

/** True when pasted/selected text exceeds the char or line threshold. */
export function isLargeTextPaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      lines += 1;
      if (lines >= LARGE_PASTE_LINE_THRESHOLD) return true;
    }
  }
  return false;
}

/**
 * Suggest a `_inbox` filename for pasted context. Extension inference is
 * intentionally conservative — only high-confidence shapes get a typed suffix.
 */
export function suggestPasteFilename(text: string, index: number): string {
  const n = Number.isFinite(index) && index >= 1 ? Math.floor(index) : 1;
  return `pasted-context-${n}${detectPasteExtension(text)}`;
}

/** Human-readable size for the ask banner (bytes → B / KB). */
export function formatPasteSize(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 10) return `${(Math.round(kb * 10) / 10).toFixed(1)} KB`;
  return `${Math.round(kb)} KB`;
}

/** UTF-8 byte length of a string (for size labels). */
export function pasteByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}

function detectPasteExtension(text: string): string {
  const head = text.trimStart().slice(0, 4000);
  if (!head) return ".txt";

  // JSON object/array with quoted keys.
  if (
    (head.startsWith("{") || head.startsWith("["))
    && /"[^"\\]*(?:\\.[^"\\]*)*"\s*:/.test(head)
  ) {
    return ".json";
  }

  // YAML: front matter or several `key: value` lines without code punctuation.
  const yamlKeys = head.match(/^[\w.-]+:\s+\S+/gm);
  if (
    /^---(?:\r?\n|$)/.test(head)
    || ((yamlKeys?.length ?? 0) >= 4 && !/[;{}]/.test(head.slice(0, 800)))
  ) {
    return ".yaml";
  }

  // TypeScript / TSX markers.
  if (
    /\b(?:export\s+)?(?:interface|type)\s+[A-Za-z_]\w*/.test(head)
    || /\bfrom\s+["'][^"']+["']\s*;/.test(head)
    || /:\s*(?:string|number|boolean|Promise<|React\.)/.test(head)
  ) {
    return ".ts";
  }

  // Python.
  if (
    /^(?:#!.*\bpython\b|from\s+\w[\w.]*\s+import\b|import\s+\w[\w.]*(?:\s*,\s*\w[\w.]*)*\s*$|def\s+\w+\(|class\s+\w+[:(])/m
      .test(head)
  ) {
    return ".py";
  }

  // Markdown: headings or fenced code + a link.
  if (
    /^#{1,6}\s+\S+/m.test(head)
    || (/^\s*```/m.test(head) && /\[[^\]]+\]\([^)]+\)/.test(head))
  ) {
    return ".md";
  }

  return ".txt";
}

/** MIME type for a suggested paste filename (best-effort). */
export function mimeForPasteFilename(name: string): string {
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  switch (ext) {
    case ".json": return "application/json";
    case ".yaml":
    case ".yml": return "text/yaml";
    case ".md": return "text/markdown";
    case ".py": return "text/x-python";
    case ".ts":
    case ".tsx": return "text/typescript";
    default: return "text/plain";
  }
}
