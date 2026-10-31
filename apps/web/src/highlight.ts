// Tiny regex tokenizer for read-only code preview. One pass, five token
// classes (kw/str/cmt/num/punc) — deliberately not a parser.

const TS_KW =
  "abstract as async await break case catch class const continue default delete do else enum export extends " +
  "false finally for from function if implements import in instanceof interface let new null of return satisfies " +
  "static super switch this throw true try type typeof undefined var void while yield";

const KW: Record<string, string> = {
  ts: TS_KW,
  py: "and as assert async await break class continue def del elif else except False finally for from global if " +
    "import in is lambda None nonlocal not or pass raise return True try while with yield",
  rs: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod " +
    "move mut pub ref return self Self static struct super trait true type unsafe use where while",
  go: "break case chan const continue default defer else fallthrough false for func go goto if import interface " +
    "iota map nil package range return select struct switch true type var",
  sh: "case do done echo elif else esac exit export fi for function if in local return set then until while",
  json: "true false null",
  yaml: "true false null yes no on off",
  css: "important inherit initial unset auto none",
  html: "",
  md: "",
};

const ALIAS: Record<string, string> = {
  tsx: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  yml: "yaml", htm: "html", markdown: "md", bash: "sh", zsh: "sh",
};

// Which comment style a language family uses.
const HASH_CMT = new Set(["py", "sh", "yaml"]);
const HTML_CMT = new Set(["html", "md"]);

/** A shell line's most legible role after strings: the flags it passes. Without
 *  it an ordinary command ("git diff --check") renders entirely uncoloured. */
const SH_FLAG = String.raw`(?<![\w-])--?[A-Za-z][\w-]*`;
const STR = `"(?:\\\\.|[^"\\\\\\n])*"?|'(?:\\\\.|[^'\\\\\\n])*'?|\`(?:\\\\.|[^\`\\\\])*\`?`;
const NUM = String.raw`0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;
const PUNC = String.raw`[{}()[\];,]`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Map a file path to a tokenizer language key (its lowercased extension). */
export function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ALIAS[ext] ?? ext;
}

/** Render code to escaped HTML with <span class="tok-*"> wrappers. */
export function highlight(code: string, lang: string): string {
  const fam = ALIAS[lang] ?? lang;
  const kw = new Set((KW[fam] ?? "").split(" ").filter(Boolean));
  const cmt = HTML_CMT.has(fam) ? "<!--[\\s\\S]*?-->"
    : HASH_CMT.has(fam) ? "#[^\\n]*"
    : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  const flag = fam === "sh" ? SH_FLAG : "(?!)";
  const re = new RegExp(`(${cmt})|(${STR})|(${flag})|(${NUM})|(${WORD})|(${PUNC})`, "g");
  let out = "";
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(code)); ) {
    out += esc(code.slice(last, m.index));
    last = m.index + m[0].length;
    const type = m[1] !== undefined ? "cmt"
      : m[2] !== undefined ? "str"
      : m[3] !== undefined ? "punc"
      : m[4] !== undefined ? "num"
      : m[5] !== undefined ? (kw.has(m[5]) ? "kw" : "")
      : "punc";
    out += type ? `<span class="tok-${type}">${esc(m[0])}</span>` : esc(m[0]);
  }
  return out + esc(code.slice(last));
}

/**
 * Highlight code and split it into per-line HTML strings so callers can render
 * a line-numbered gutter. Tokens spanning newlines (block comments, template
 * strings) are closed at each break and reopened on the next line — safe
 * because highlight() emits flat, single-level spans and escapes raw "<".
 */
export function highlightLines(code: string, lang: string): string[] {
  const html = highlight(code, lang);
  const lines: string[] = [];
  let cur = "";
  let openTag: string | null = null;
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end + 1);
      openTag = tag.startsWith("</") ? null : tag;
      cur += tag;
      i = end + 1;
    } else if (ch === "\n") {
      if (openTag) cur += "</span>";
      lines.push(cur);
      cur = openTag ?? "";
      i += 1;
    } else {
      cur += ch;
      i += 1;
    }
  }
  lines.push(openTag ? `${cur}</span>` : cur);
  return lines;
}
