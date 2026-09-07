import type { Extension } from "@codemirror/state";

export interface EditorLanguage {
  id: string;
  label: string;
  load: () => Promise<Extension>;
}

type LanguageLoader = (id: string) => Promise<Extension>;

const loaders: Record<string, () => Promise<Extension>> = {
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false })),
  javascriptJsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  typescript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: false })),
  typescriptTsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
};

const cache = new Map<string, Promise<Extension>>();

let loadLanguage: LanguageLoader = (id) => {
  const hit = cache.get(id);
  if (hit) return hit;
  const loader = loaders[id];
  if (!loader) return Promise.resolve([]);
  const pending = loader();
  cache.set(id, pending);
  return pending;
};

/** Test seam: force a grammar import to fail. */
export function setLanguageLoaderForTest(loader: LanguageLoader | null): void {
  loadLanguage = loader ?? ((id) => {
    const loaderFn = loaders[id];
    return loaderFn ? loaderFn() : Promise.resolve([]);
  });
  cache.clear();
}

const LANGUAGES: Record<string, Omit<EditorLanguage, "load"> & { loaderId: string }> = {
  javascript: { id: "javascript", label: "JavaScript", loaderId: "javascript" },
  javascriptJsx: { id: "javascriptJsx", label: "JavaScript (JSX)", loaderId: "javascriptJsx" },
  typescript: { id: "typescript", label: "TypeScript", loaderId: "typescript" },
  typescriptTsx: { id: "typescriptTsx", label: "TypeScript (TSX)", loaderId: "typescriptTsx" },
  json: { id: "json", label: "JSON", loaderId: "json" },
  yaml: { id: "yaml", label: "YAML", loaderId: "yaml" },
  markdown: { id: "markdown", label: "Markdown", loaderId: "markdown" },
};

const BY_EXTENSION: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "javascriptJsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "typescriptTsx",
  json: "json",
  yaml: "yaml", yml: "yaml",
  md: "markdown", markdown: "markdown",
};

export const PLAIN_TEXT_LABEL = "Plain text";

export function languageOf(path: string): EditorLanguage | null {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const id = BY_EXTENSION[base.slice(dot + 1)];
  const spec = id ? LANGUAGES[id] : undefined;
  if (!spec) return null;
  return {
    id: spec.id,
    label: spec.label,
    load: () => loadLanguage(spec.loaderId),
  };
}

export function languageLabelOf(path: string): string {
  return languageOf(path)?.label ?? PLAIN_TEXT_LABEL;
}

export function detectIndentUnit(text: string, sampleLines = 400): string {
  let tabs = 0;
  let spaced = 0;
  let notFour = 0;
  let seen = 0;
  for (let start = 0; start < text.length && seen < sampleLines; seen++) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end < 0 ? text.length : end);
    start = end < 0 ? text.length : end + 1;
    if (line[0] === "\t") tabs++;
    else if (line[0] === " ") {
      let n = 0;
      while (line[n] === " ") n++;
      if (n === line.length) continue;
      spaced++;
      if (n % 4 !== 0) notFour++;
    }
  }
  if (tabs > 0 && tabs >= spaced) return "\t";
  if (spaced === 0 || notFour > 0) return "  ";
  return "    ";
}

/** [start, end) offsets → 1-based inclusive line range. A selection ending
 *  on a newline does not cover the next line. */
export function lineRangeFromOffsets(
  lineAt: (offset: number) => number,
  charAt: (offset: number) => string,
  from: number,
  to: number,
  length: number,
): { startLine: number; endLine: number } {
  const s = Math.max(0, Math.min(from, to, length));
  const e = Math.max(s, Math.min(Math.max(from, to), length));
  const startLine = lineAt(s);
  let endLine = lineAt(e);
  if (e > s && charAt(e - 1) === "\n") endLine -= 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
}
