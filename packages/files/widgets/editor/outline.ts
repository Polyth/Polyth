// "Go to symbol" for one file: a line-based outline of the declarations a
// reader navigates by (headings, classes, functions, types, selectors, keys).
// Deliberately lexical: it works for any checkout (SSH included), costs one
// pass over the buffer, and never claims what a language server would know.

export type SymbolKind = "heading" | "class" | "interface" | "type" | "enum" | "function" | "method" | "variable" | "module" | "selector" | "key";

export interface FileSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line. */
  line: number;
  /** Nesting for indentation (heading level − 1, indentation for code). */
  depth: number;
}

export const MAX_SYMBOLS = 2_000;
const MAX_SCAN_CHARS = 4 * 1024 * 1024;

type Family = "markdown" | "script" | "python" | "go" | "rust" | "css" | "yaml" | "shell" | "sql" | "clike";

const FAMILY_BY_EXT: Record<string, Family> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  ts: "script", tsx: "script", js: "script", jsx: "script", mjs: "script", cjs: "script", mts: "script", cts: "script",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  css: "css", scss: "css", less: "css", sass: "css",
  yml: "yaml", yaml: "yaml",
  sh: "shell", bash: "shell", zsh: "shell",
  sql: "sql",
  java: "clike", kt: "clike", kts: "clike", cs: "clike", swift: "clike", php: "clike", scala: "clike",
  c: "clike", h: "clike", cc: "clike", cpp: "clike", hpp: "clike", dart: "clike", rb: "clike",
};

const familyOf = (path: string): Family | null =>
  FAMILY_BY_EXT[path.toLowerCase().match(/\.([^./]+)$/)?.[1] ?? ""] ?? null;

/** Whether this file type has an outline at all (shows the action). */
export const hasOutline = (path: string): boolean => familyOf(path) !== null;

/** Words a keyword-less rule (a call-shaped method line) must not take for a name. */
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with", "new", "typeof", "await", "super", "sizeof", "elif", "using", "lock", "foreach"]);

const depthOf = (indent: string, unit: number): number =>
  Math.min(4, Math.floor(indent.replace(/\t/g, " ".repeat(unit)).length / unit));

/** `loose`: the line has no declaring keyword, so control words are refused. */
type Rule = { re: RegExp; kind: SymbolKind | ((match: RegExpExecArray) => SymbolKind); name: number; indent?: number; unit?: number; loose?: boolean };

const SCRIPT: Rule[] = [
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", name: 2, indent: 1 },
  { re: /^(\s*)(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", name: 2, indent: 1 },
  { re: /^(\s*)(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: "type", name: 2, indent: 1 },
  { re: /^(\s*)(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum", name: 2, indent: 1 },
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function", name: 2, indent: 1 },
  { re: /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, kind: "function", name: 2, indent: 1 },
  { re: /^(\s*)export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable", name: 2, indent: 1 },
  { re: /^(\s+)(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*\*?([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{=;]+)?\{\s*$/, kind: "method", name: 2, indent: 1, loose: true },
];

const PYTHON: Rule[] = [
  { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class", name: 2, indent: 1, unit: 4 },
  { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: (match) => match[1] ? "method" : "function", name: 2, indent: 1, unit: 4 },
];

const GO: Rule[] = [
  { re: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: "method", name: 1 },
  { re: /^func\s+([A-Za-z_]\w*)/, kind: "function", name: 1 },
  { re: /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/, kind: (match) => match[2] === "interface" ? "interface" : "class", name: 1 },
  { re: /^type\s+([A-Za-z_]\w*)/, kind: "type", name: 1 },
];

const RUST: Rule[] = [
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, kind: (match) => match[1] ? "method" : "function", name: 2, indent: 1, unit: 4 },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "class", name: 2, indent: 1, unit: 4 },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum", name: 2, indent: 1, unit: 4 },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "interface", name: 2, indent: 1, unit: 4 },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: "type", name: 2, indent: 1, unit: 4 },
  { re: /^(\s*)impl(?:<[^>]*>)?\s+([^{]+?)\s*\{/, kind: "module", name: 2, indent: 1, unit: 4 },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: "module", name: 2, indent: 1, unit: 4 },
];

const SHELL: Rule[] = [
  { re: /^\s*(?:function\s+)?([A-Za-z_][\w:-]*)\s*\(\)\s*\{?/, kind: "function", name: 1 },
  { re: /^\s*function\s+([A-Za-z_][\w:-]*)/, kind: "function", name: 1 },
];

const SQL: Rule[] = [
  { re: /^\s*create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+)?(table|view|materialized\s+view|function|procedure|index|unique\s+index|trigger|type)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, kind: (match) => /function|procedure|trigger/i.test(match[1]!) ? "function" : /type/i.test(match[1]!) ? "type" : "class", name: 2 },
];

const CLIKE: Rule[] = [
  { re: /^(\s*)(?:[\w@]+\s+)*(class|interface|struct|enum|record|protocol|object|trait|module)\s+([A-Za-z_]\w*)/, kind: (match) => match[2] === "interface" || match[2] === "protocol" || match[2] === "trait" ? "interface" : match[2] === "enum" ? "enum" : match[2] === "module" ? "module" : "class", name: 3, indent: 1 },
  { re: /^(\s*)(?:[\w@]+\s+)*(?:fun|func|def|function)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*[?!]?)/, kind: (match) => match[1] ? "method" : "function", name: 2, indent: 1 },
  { re: /^(\s*)(?:(?:public|private|protected|internal|static|final|virtual|override|abstract|async|inline|const|unsafe|extern)\s+)+[\w<>,.?[\]\s*&]+?\s+([A-Za-z_]\w*)\s*\([^;]*$/, kind: (match) => match[1] ? "method" : "function", name: 2, indent: 1, loose: true },
];

/** `hashComments`: `#` starts a comment (Python, shell, Ruby…), not a name. */
function applyRules(lines: readonly string[], rules: readonly Rule[], hashComments = false): FileSymbol[] {
  const out: FileSymbol[] = [];
  let blockComment = false;
  for (let index = 0; index < lines.length && out.length < MAX_SYMBOLS; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trimStart();
    if (blockComment) { if (trimmed.includes("*/")) blockComment = false; continue; }
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) { blockComment = true; continue; }
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || (hashComments && trimmed.startsWith("#"))) continue;
    for (const rule of rules) {
      const match = rule.re.exec(line);
      if (!match) continue;
      const name = match[rule.name]?.trim();
      if (!name || (rule.loose && CONTROL.has(name))) break;
      out.push({
        name,
        kind: typeof rule.kind === "function" ? rule.kind(match) : rule.kind,
        line: index + 1,
        depth: rule.indent ? depthOf(match[rule.indent] ?? "", rule.unit ?? 2) : 0,
      });
      break;
    }
  }
  return out;
}

function markdownSymbols(lines: readonly string[]): FileSymbol[] {
  const out: FileSymbol[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length && out.length < MAX_SYMBOLS; index += 1) {
    const line = lines[index]!;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]![0]!;
      else if (fenceMatch[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push({ name: heading[2]!, kind: "heading", line: index + 1, depth: heading[1]!.length - 1 });
      continue;
    }
    // Setext headings: a text line underlined with === or ---.
    const next = lines[index + 1];
    if (line.trim() && next !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*[-*+>]/.test(line)) {
      out.push({ name: line.trim(), kind: "heading", line: index + 1, depth: next.trim().startsWith("=") ? 0 : 1 });
      index += 1;
    }
  }
  return out;
}

function cssSymbols(lines: readonly string[]): FileSymbol[] {
  const out: FileSymbol[] = [];
  let depth = 0;
  let comment = false;
  for (let index = 0; index < lines.length && out.length < MAX_SYMBOLS; index += 1) {
    let line = lines[index]!;
    if (comment) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = line.slice(end + 2);
      comment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open >= 0) { comment = true; line = line.slice(0, open); }
    const brace = line.indexOf("{");
    if (brace > 0) {
      const name = line.slice(0, brace).trim();
      if (name && !name.includes(";")) {
        out.push({ name: name.replace(/\s+/g, " "), kind: "selector", line: index + 1, depth: Math.min(depth, 4) });
      }
    }
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

function yamlSymbols(lines: readonly string[]): FileSymbol[] {
  const out: FileSymbol[] = [];
  for (let index = 0; index < lines.length && out.length < MAX_SYMBOLS; index += 1) {
    const match = /^( {0,4})([A-Za-z_][\w.-]*|"[^"]+"|'[^']+'):(?:\s|$)/.exec(lines[index]!);
    if (match) out.push({ name: match[2]!.replace(/^["']|["']$/g, ""), kind: "key", line: index + 1, depth: Math.floor(match[1]!.length / 2) });
  }
  return out;
}

export function extractSymbols(text: string, path: string): FileSymbol[] {
  const family = familyOf(path);
  if (!family) return [];
  const lines = text.slice(0, MAX_SCAN_CHARS).split(/\r?\n/);
  switch (family) {
    case "markdown": return markdownSymbols(lines);
    case "css": return cssSymbols(lines);
    case "yaml": return yamlSymbols(lines);
    case "script": return applyRules(lines, SCRIPT);
    case "python": return applyRules(lines, PYTHON, true);
    case "go": return applyRules(lines, GO);
    case "rust": return applyRules(lines, RUST);
    case "shell": return applyRules(lines, SHELL, true);
    case "sql": return applyRules(lines, SQL);
    case "clike": return applyRules(lines, CLIKE, /\.(rb|php)$/i.test(path));
  }
}

/** Case-insensitive subsequence filter, best (contiguous, earlier) first. */
export function filterSymbols(symbols: readonly FileSymbol[], query: string): FileSymbol[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...symbols];
  const scored: Array<{ symbol: FileSymbol; score: number }> = [];
  for (const symbol of symbols) {
    const name = symbol.name.toLowerCase();
    const at = name.indexOf(needle);
    if (at >= 0) { scored.push({ symbol, score: at === 0 ? 0 : 1 }); continue; }
    let cursor = 0;
    for (const char of name) if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) scored.push({ symbol, score: 2 });
  }
  return scored.sort((left, right) => left.score - right.score || left.symbol.line - right.symbol.line).map((entry) => entry.symbol);
}
