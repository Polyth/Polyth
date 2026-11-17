// Python for the editor as a small CodeMirror stream parser: owned code on the
// existing @codemirror/language instead of another grammar dependency. It
// colours what a reader scans for (keywords, strings with their prefixes and
// triple quotes across lines, comments, numbers, decorators, the names a
// `def`/`class` introduces, attribute access) and indents after a block colon
// or inside open brackets. It is a highlighter, not a parser: nothing here
// decides anything beyond colour and indentation.
import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

const KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
  "with", "yield",
]);

/** A string still open at the end of a line (triple quotes, or a `\` continuation). */
interface OpenString {
  quote: string;
  triple: boolean;
}

interface PythonState {
  string: OpenString | null;
  /** Open brackets: inside them a newline does not end the statement. */
  depth: number;
  /** The previous physical line ended with a `\` continuation. */
  joined: boolean;
  /** The next significant token starts a logical line. */
  fresh: boolean;
  /** Indentation of the logical line being read. */
  lineIndent: number;
  /** Text of the last significant token on that logical line. */
  last: string | null;
  /** What the next name is: introduced by `def`/`class`, or read after a `.`. */
  expect: "def" | "class" | "property" | null;
}

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*/u;
const STRING_START = /^(?:[rRbBuUfFtT]{1,2})?(?:'''|"""|'|")/;
const OPERATOR = /^(?:\*\*=?|\/\/=?|<<=?|>>=?|->|:=|[-+*/%@&|^~<>!=]=?)/;
const NUMBER = [
  /^0[xX](?:_?[0-9a-fA-F])+/,
  /^0[oO](?:_?[0-7])+/,
  /^0[bB](?:_?[01])+/,
  /^(?:\d(?:_?\d)*\.(?:\d(?:_?\d)*)?|\.\d(?:_?\d)*|\d(?:_?\d)*)(?:[eE][-+]?\d(?:_?\d)*)?[jJ]?/,
];
/** `match`/`case` are keywords only as a statement head ending in a colon. */
const SOFT_BLOCK = /^\s+(?![=.:,)\]}]|[-+*/%&|^<>!]=)\S.*:\s*(?:#.*)?$/u;
/** `type X[T] = …` declares an alias; `type = 3` or `type(x)` is a name. */
const SOFT_TYPE = /^\s+[\p{L}_][\p{L}\p{N}_]*\s*(?:\[[^\]]*\])?\s*=(?!=)/u;
const DEDENT_HEAD = /^(?:else|elif|except|finally)\b/;

function readString(stream: StringStream, state: PythonState): string {
  const open = state.string!;
  while (!stream.eol()) {
    if (stream.eat("\\")) {
      // A backslash escapes the next character for termination in raw strings
      // too (r"\"" is one string); at the line end it continues the string.
      if (stream.eol()) return "string";
      stream.next();
      continue;
    }
    if (open.triple ? stream.match(open.quote.repeat(3)) : stream.eat(open.quote)) {
      state.string = null;
      return "string";
    }
    stream.next();
  }
  // A one-quote string ends with its line (a trailing `\` returned above).
  if (!open.triple) state.string = null;
  return "string";
}

function startOfLogicalLine(stream: StringStream, state: PythonState): boolean {
  if (!state.fresh) return false;
  state.fresh = false;
  state.lineIndent = stream.indentation();
  state.last = null;
  state.expect = null;
  return true;
}

function readToken(stream: StringStream, state: PythonState, first: boolean): string | null {
  const quoted = stream.match(STRING_START);
  if (quoted) {
    const text = (quoted as RegExpMatchArray)[0];
    const quote = text[text.length - 1]!;
    const triple = text.endsWith(quote.repeat(3));
    state.string = { quote, triple };
    state.expect = null;
    return readString(stream, state);
  }

  const ch = stream.peek()!;
  if (/\d/.test(ch) || (ch === "." && /\d/.test(stream.string.charAt(stream.pos + 1)))) {
    for (const pattern of NUMBER) if (stream.match(pattern)) return "number";
  }

  if (first && ch === "@" && stream.match(/^@\s*[\p{L}_][\p{L}\p{N}_.]*/u)) return "meta";

  const name = stream.match(IDENTIFIER) as RegExpMatchArray | null;
  if (name) {
    const word = name[0];
    const expect = state.expect;
    state.expect = null;
    if (expect === "property") return "propertyName";
    if (expect === "def") return "variableName.function.definition";
    if (expect === "class") return "className.definition";
    if (word === "True" || word === "False") return "bool";
    if (word === "None") return "null";
    if (KEYWORDS.has(word)) {
      if (word === "def" || word === "class") state.expect = word;
      return "keyword";
    }
    const rest = stream.string.slice(stream.pos);
    if (first && (word === "match" || word === "case") && SOFT_BLOCK.test(rest)) return "keyword";
    if (first && word === "type" && SOFT_TYPE.test(rest)) return "keyword";
    return "variableName";
  }

  state.expect = null;
  if (stream.match("...")) return "punctuation";
  if (ch === ".") {
    stream.next();
    state.expect = "property";
    return "punctuation";
  }
  if ("([{".includes(ch)) {
    stream.next();
    state.depth += 1;
    return "bracket";
  }
  if (")]}".includes(ch)) {
    stream.next();
    state.depth = Math.max(0, state.depth - 1);
    return "bracket";
  }
  if (ch === "," || ch === ";") {
    stream.next();
    return "separator";
  }
  if (stream.match(OPERATOR)) return "operator";
  if (ch === ":") {
    stream.next();
    return "punctuation";
  }
  if (ch === "\\" && stream.match(/^\\\s*$/)) {
    state.joined = true;
    return null;
  }
  stream.next();
  return null;
}

export const pythonParser: StreamParser<PythonState> = {
  name: "python",
  startState: () => ({ string: null, depth: 0, joined: false, fresh: true, lineIndent: 0, last: null, expect: null }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (stream.sol()) {
      if (!state.string && state.depth === 0 && !state.joined) state.fresh = true;
      state.joined = false;
    }
    if (state.string) return readString(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    const first = startOfLogicalLine(stream, state);
    const style = readToken(stream, state, first);
    if (!state.joined) state.last = stream.current();
    return style;
  },
  indent(state, textAfter, context) {
    if (state.string) return null;
    const base = state.lineIndent;
    if (state.depth > 0) return /^[\])}]/.test(textAfter) ? base : base + context.unit;
    const indent = state.last === ":" ? base + context.unit : base;
    return DEDENT_HEAD.test(textAfter) ? Math.max(0, indent - context.unit) : indent;
  },
  languageData: {
    commentTokens: { line: "#" },
    closeBrackets: { brackets: ["(", "[", "{", "'", "\"", "'''", "\"\"\""] },
    indentOnInput: /^\s*(?:[\])}]|else:|elif |except |except:|finally:)$/,
  },
};

export function python() {
  return StreamLanguage.define(pythonParser);
}
