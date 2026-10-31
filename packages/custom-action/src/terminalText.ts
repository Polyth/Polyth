// Turn captured terminal output into lines a person (or an agent) can read.
//
// Background runs execute on a pseudo-terminal, so their output carries what a
// terminal would interpret: colors, carriage-return progress bars, erased and
// rewritten lines. This is a deliberately small line emulator — enough for
// build, test and deploy logs — not a full-screen terminal. Pure and
// browser-safe: the server uses the plain text for chat hand-offs, the web
// renders the styled segments.

export interface AnsiStyle {
  /** 0-15 palette slot, or a literal `rgb()` from 256-color/true-color output. */
  fg?: number | string;
  bg?: number | string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSegment extends AnsiStyle {
  text: string;
}

export type AnsiLine = AnsiSegment[];

interface Cell {
  ch: string;
  style: AnsiStyle;
}

const NO_STYLE: AnsiStyle = Object.freeze({});
const MAX_LINES = 5_000;
const MAX_COLUMNS = 4_000;

const XTERM_LEVELS = [0, 95, 135, 175, 215, 255];

function color256(index: number): number | string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return index;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const value = index - 16;
  const r = XTERM_LEVELS[Math.floor(value / 36)]!;
  const g = XTERM_LEVELS[Math.floor(value / 6) % 6]!;
  const b = XTERM_LEVELS[value % 6]!;
  return `rgb(${r}, ${g}, ${b})`;
}

const sameStyle = (a: AnsiStyle, b: AnsiStyle): boolean =>
  a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim
  && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.inverse === !!b.inverse;

/** Apply one SGR (`ESC[…m`) parameter list to a style. */
function applySgr(current: AnsiStyle, params: number[]): AnsiStyle {
  if (params.length === 0) return NO_STYLE;
  let next: AnsiStyle = { ...current };
  for (let i = 0; i < params.length; i++) {
    const code = params[i]!;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code === 49) delete next.bg;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const mode = params[i + 1];
      let value: number | string | undefined;
      if (mode === 5) {
        value = color256(params[i + 2] ?? -1);
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        if ([r, g, b].every((part) => typeof part === "number" && part >= 0 && part <= 255)) {
          value = `rgb(${r}, ${g}, ${b})`;
        }
        i += 4;
      }
      if (value !== undefined) {
        if (code === 38) next.fg = value;
        else next.bg = value;
      }
    }
  }
  return next;
}

/**
 * Emulate the line-oriented subset of a terminal: printable text, newlines,
 * carriage returns, backspace, tabs, SGR styling, cursor movement within and
 * between lines, and line erasure. Screen clears, alternate screens and
 * absolute cursor positioning are ignored rather than guessed at.
 */
export function terminalLines(raw: string): AnsiLine[] {
  const lines: Cell[][] = [[]];
  let row = 0;
  let col = 0;
  let style: AnsiStyle = NO_STYLE;
  const line = (): Cell[] => {
    while (lines.length <= row) lines.push([]);
    return lines[row]!;
  };
  const put = (ch: string) => {
    if (col >= MAX_COLUMNS) return;
    const cells = line();
    while (cells.length < col) cells.push({ ch: " ", style: NO_STYLE });
    cells[col] = { ch, style };
    col += 1;
  };
  const newline = () => {
    row += 1;
    col = 0;
    line();
    if (lines.length > MAX_LINES * 2) {
      const drop = lines.length - MAX_LINES;
      lines.splice(0, drop);
      row -= drop;
    }
  };

  const text = raw.replace(/\r\n/g, "\n");
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === "[") {
        // CSI: parameter bytes, intermediate bytes, one final byte.
        let j = i + 2;
        while (j < text.length && /[0-9;:?<=>!]/.test(text[j]!)) j += 1;
        while (j < text.length && /[ -/]/.test(text[j]!)) j += 1;
        if (j >= text.length) break; // an unfinished sequence at the end of a chunk
        const final = text[j]!;
        const rawParams = text.slice(i + 2, j);
        const params = rawParams.startsWith("?") ? [] : rawParams.split(/[;:]/).map((part) => part === "" ? 0 : Number(part)).filter((part) => Number.isFinite(part));
        const n = Math.max(1, params[0] ?? 1);
        if (final === "m" && !rawParams.startsWith("?")) style = applySgr(style, rawParams === "" ? [] : params);
        else if (final === "K") {
          const cells = line();
          const mode = params[0] ?? 0;
          if (mode === 2) cells.length = 0;
          else if (mode === 1) for (let k = 0; k <= col && k < cells.length; k++) cells[k] = { ch: " ", style: NO_STYLE };
          else cells.length = Math.min(cells.length, col);
        } else if (final === "A") row = Math.max(0, row - n);
        else if (final === "B" || final === "E") { row += n; line(); if (final === "E") col = 0; }
        else if (final === "F") { row = Math.max(0, row - n); col = 0; }
        else if (final === "C") col = Math.min(MAX_COLUMNS, col + n);
        else if (final === "D") col = Math.max(0, col - n);
        else if (final === "G") col = Math.max(0, Math.min(MAX_COLUMNS, n - 1));
        i = j + 1;
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^") {
        // OSC/DCS/APC/PM strings end with BEL or ST (ESC \).
        let j = i + 2;
        while (j < text.length && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j += 1;
        if (j >= text.length) break;
        i = text[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      // Two- and three-byte escapes (charset selection, keypad modes, …).
      i += next === "(" || next === ")" || next === "#" || next === "%" ? 3 : 2;
      continue;
    }
    if (ch === "\n") newline();
    else if (ch === "\r") col = 0;
    else if (ch === "\b") col = Math.max(0, col - 1);
    else if (ch === "\t") {
      const stop = Math.min(MAX_COLUMNS, (Math.floor(col / 8) + 1) * 8);
      while (col < stop) put(" ");
    } else if (code >= 0x20 && code !== 0x7f) put(ch);
    i += 1;
  }

  const kept = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
  // A trailing empty line is the newline that ended the last real line.
  if (kept.length > 1 && kept[kept.length - 1]!.length === 0) kept.pop();
  return kept.map((cells) => {
    const segments: AnsiSegment[] = [];
    for (const cell of cells) {
      const last = segments[segments.length - 1];
      if (last && sameStyle(last, cell.style)) last.text += cell.ch;
      else segments.push({ ...cell.style, text: cell.ch });
    }
    // Trailing blanks carry no information and confuse wrapping.
    const tail = segments[segments.length - 1];
    if (tail && !tail.bg && !tail.inverse) {
      tail.text = tail.text.replace(/\s+$/u, "");
      if (!tail.text) segments.pop();
    }
    return segments;
  });
}

/** Plain readable text of terminal output: what a person saw, without styling. */
export function terminalPlainText(raw: string): string {
  return terminalLines(raw).map((segments) => segments.map((segment) => segment.text).join("")).join("\n");
}
