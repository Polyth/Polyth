// Terminal emulator core (DOM-free, testable under node --test): a VT100/
// xterm-style escape-sequence parser feeding a cell-grid screen model with
// scrollback. The renderer (TermPane) only reads snapshots — all mutation
// happens here, and every mutated line bumps a monotonic `rev` so React rows
// can memoize on (line, rev) identity.
//
// Coverage: C0 controls, ESC (DECSC/DECRC/IND/NEL/RI/HTS/RIS/DECALN/charsets),
// CSI (cursor movement, ED/EL/ICH/DCH/ECH/IL/DL/SU/SD/REP, DECSTBM regions,
// SM/RM incl. alternate screen 47/1047/1049, DECAWM, DECOM, DECCKM, DECTCEM,
// bracketed paste 2004, mouse tracking modes, focus reporting, SGR with 16/
// 256/truecolor), OSC (title, OSC 8 hyperlinks, color queries), DSR/DA
// responses, DEC special graphics, wide chars (CJK), and combining marks.

export const ATTR_BOLD = 1;
export const ATTR_DIM = 2;
export const ATTR_ITALIC = 4;
export const ATTR_UNDERLINE = 8;
export const ATTR_BLINK = 16;
export const ATTR_INVERSE = 32;
export const ATTR_HIDDEN = 64;
export const ATTR_STRIKE = 128;
export const ATTR_OVERLINE = 256;

/** Color encoding: -1 default, 0..255 palette index, >=0x1000000 → 24-bit RGB. */
export const COLOR_DEFAULT = -1;
export const isRgbColor = (c: number): boolean => c >= 0x1000000;
export const rgbOf = (c: number): number => c & 0xffffff;
export const packRgb = (r: number, g: number, b: number): number =>
  0x1000000 | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);

export interface TermLine {
  /** One entry per column; "" marks the trailing half of a wide glyph. */
  chars: string[];
  fg: number[];
  bg: number[];
  attrs: number[];
  /** Per-cell OSC-8 link id (0 = none); null when the line has no links. */
  links: number[] | null;
  /** Monotonic revision — bumped on every mutation (render memo key). */
  rev: number;
  /** Soft-wrapped: continues on the following line (copy joins without \n). */
  wrapped: boolean;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface TermCursorState {
  x: number;
  y: number;
  visible: boolean;
  style: CursorStyle;
  blink: boolean;
}

export interface TermModes {
  appCursorKeys: boolean;
  bracketedPaste: boolean;
  altScreen: boolean;
  /** 0 off, 9 X10, 1000 click, 1002 button-drag, 1003 any-motion. */
  mouseTracking: number;
  mouseSgr: boolean;
  focusReporting: boolean;
  reverseVideo: boolean;
}

export interface RowInfo {
  text: string;
  /** map[textIndex] → column; null when identity (no wide glyphs). */
  map: number[] | null;
}

export interface TermPoint { row: number; col: number }

export interface EmuDisposable { dispose(): void }

export interface TerminalEmulator {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Full reset including scrollback (used when a replay frame replaces state). */
  reset(): void;
  /** UI "clear": drop scrollback and blank the screen, cursor home. */
  clearBuffer(): void;
  cols(): number;
  rows(): number;
  /** Total addressable rows: scrollback + screen (alt screen: screen only). */
  bufferLength(): number;
  scrollbackLength(): number;
  /** Absolute row index into [scrollback..., screen...]. */
  line(index: number): TermLine | undefined;
  rowInfo(index: number): RowInfo;
  cursor(): TermCursorState;
  modes(): TermModes;
  title(): string;
  linkUrl(id: number): string | undefined;
  /** Extract text between two absolute points (inclusive start, exclusive end col). */
  getText(a: TermPoint, b: TermPoint): string;
  onUpdate(cb: () => void): EmuDisposable;
  onBell(cb: () => void): EmuDisposable;
  /** Terminal → host replies (DSR/DA/CPR…); wire to the PTY input. */
  onResponse(cb: (data: string) => void): EmuDisposable;
}

// ------------------------------------------------------------- char widths

// Compact wcwidth: combining marks & zero-width → 0, East-Asian wide → 2.
const ZERO_RANGES: ReadonlyArray<[number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x06d6, 0x06dc], [0x0730, 0x074a], [0x07a6, 0x07b0],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x20d0, 0x20ff], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
];
const WIDE_RANGES: ReadonlyArray<[number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: ReadonlyArray<[number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Terminal cell width of a code point: 0 (combining/zero-width), 1, or 2. */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

// -------------------------------------------------------- DEC special charset

const DEC_GRAPHICS: Record<string, string> = {
  "`": "◆", "a": "▒", "b": "␉", "c": "␌", "d": "␍", "e": "␊", "f": "°",
  "g": "±", "h": "␤", "i": "␋", "j": "┘", "k": "┐", "l": "┌", "m": "└",
  "n": "┼", "o": "⎺", "p": "⎻", "q": "─", "r": "⎼", "s": "⎽", "t": "├",
  "u": "┤", "v": "┴", "w": "┬", "x": "│", "y": "≤", "z": "≥", "{": "π",
  "|": "≠", "}": "£", "~": "·",
};

// ------------------------------------------------------------------ factory

export interface EmulatorOptions {
  cols?: number;
  rows?: number;
  /** Scrollback line cap for the primary screen (default 5000). */
  scrollback?: number;
  /** RGB hex for OSC 10/11 color queries (theme fg/bg); optional. */
  queryFg?: string;
  queryBg?: string;
}

const MAX_PARAM = 65535;
const MAX_OSC = 4096;

interface SavedCursor {
  x: number; y: number;
  fg: number; bg: number; attrs: number;
  charset: number; g0: string; g1: string;
  autowrap: boolean; origin: boolean;
}

export function createTerminalEmulator(opts: EmulatorOptions = {}): TerminalEmulator {
  let cols = Math.max(2, Math.min(opts.cols ?? 80, 1000));
  let rows = Math.max(2, Math.min(opts.rows ?? 24, 500));
  const scrollbackCap = Math.max(0, opts.scrollback ?? 5000);

  let revCounter = 0;
  const blankLine = (bg: number): TermLine => {
    const line: TermLine = {
      chars: new Array<string>(cols).fill(" "),
      fg: new Array<number>(cols).fill(COLOR_DEFAULT),
      bg: new Array<number>(cols).fill(bg),
      attrs: new Array<number>(cols).fill(0),
      links: null,
      rev: ++revCounter,
      wrapped: false,
    };
    return line;
  };

  // ---- state ----
  let scrollback: TermLine[] = [];
  let primary: TermLine[] = [];
  let alternate: TermLine[] = [];
  let altActive = false;
  let x = 0;
  let y = 0;
  let pendingWrap = false;
  let scrollTop = 0;
  let scrollBottom = rows - 1;

  // current SGR state
  let curFg = COLOR_DEFAULT;
  let curBg = COLOR_DEFAULT;
  let curAttrs = 0;
  let curLink = 0;

  // modes
  let autowrap = true;
  let originMode = false;
  let insertMode = false;
  let appCursorKeys = false;
  let cursorVisible = true;
  let cursorStyle: CursorStyle = "block";
  let cursorBlink = true;
  let bracketedPaste = false;
  let reverseVideo = false;
  let mouseTracking = 0;
  let mouseSgr = false;
  let focusReporting = false;
  let lineFeedMode = false;

  // charsets
  let g0 = "B";
  let g1 = "B";
  let activeCharset = 0;

  let tabStops = new Set<number>();
  let title = "";
  let lastGraphic = "";
  const linkTable: string[] = [];
  let savedPrimary: SavedCursor | null = null;
  let savedAlt: SavedCursor | null = null;

  const updateCbs = new Set<() => void>();
  const bellCbs = new Set<() => void>();
  const responseCbs = new Set<(data: string) => void>();
  let dirty = false;

  const markDirty = () => { dirty = true; };
  const touch = (line: TermLine) => { line.rev = ++revCounter; markDirty(); };

  const screen = (): TermLine[] => (altActive ? alternate : primary);

  const resetTabs = () => {
    tabStops = new Set();
    for (let i = 8; i < cols; i += 8) tabStops.add(i);
  };

  const initScreens = () => {
    primary = [];
    alternate = [];
    for (let i = 0; i < rows; i++) {
      primary.push(blankLine(COLOR_DEFAULT));
      alternate.push(blankLine(COLOR_DEFAULT));
    }
  };
  initScreens();
  resetTabs();

  const respond = (data: string) => { for (const cb of responseCbs) cb(data); };

  // ---- line/cell helpers ----

  const eraseCells = (line: TermLine, from: number, to: number) => {
    for (let i = from; i < to && i < line.chars.length; i++) {
      line.chars[i] = " ";
      line.fg[i] = COLOR_DEFAULT;
      line.bg[i] = curBg; // BCE: erase uses the current background
      line.attrs[i] = 0;
      if (line.links) line.links[i] = 0;
    }
    touch(line);
  };

  /** Clear the tail half if `col` lands on a wide glyph's head or tail. */
  const clearWideAt = (line: TermLine, col: number) => {
    if (col < 0 || col >= cols) return;
    if (line.chars[col] === "" && col > 0) {
      line.chars[col - 1] = " ";
      line.chars[col] = " ";
    } else if (col + 1 < cols && line.chars[col + 1] === "") {
      line.chars[col + 1] = " ";
    }
  };

  const setCell = (line: TermLine, col: number, ch: string) => {
    clearWideAt(line, col);
    line.chars[col] = ch;
    line.fg[col] = curFg;
    line.bg[col] = curBg;
    line.attrs[col] = curAttrs;
    if (curLink !== 0) {
      if (!line.links) line.links = new Array<number>(cols).fill(0);
      line.links[col] = curLink;
    } else if (line.links) {
      line.links[col] = 0;
    }
  };

  const trimScrollback = () => {
    if (scrollback.length > scrollbackCap + 256) {
      scrollback.splice(0, scrollback.length - scrollbackCap);
      markDirty();
    }
  };

  const scrollUp = (n: number) => {
    const lines = screen();
    const count = Math.min(n, scrollBottom - scrollTop + 1);
    for (let i = 0; i < count; i++) {
      const removed = lines.splice(scrollTop, 1)[0]!;
      if (!altActive && scrollTop === 0 && scrollbackCap > 0) {
        scrollback.push(removed);
      }
      lines.splice(scrollBottom, 0, blankLine(curBg));
    }
    trimScrollback();
    markDirty();
  };

  const scrollDown = (n: number) => {
    const lines = screen();
    const count = Math.min(n, scrollBottom - scrollTop + 1);
    for (let i = 0; i < count; i++) {
      lines.splice(scrollBottom, 1);
      lines.splice(scrollTop, 0, blankLine(curBg));
    }
    markDirty();
  };

  const lineFeed = () => {
    if (y === scrollBottom) scrollUp(1);
    else if (y < rows - 1) y++;
    if (lineFeedMode) x = 0;
    pendingWrap = false;
  };

  const reverseLineFeed = () => {
    if (y === scrollTop) scrollDown(1);
    else if (y > 0) y--;
    pendingWrap = false;
  };

  const clampCursor = () => {
    x = Math.max(0, Math.min(x, cols - 1));
    y = Math.max(0, Math.min(y, rows - 1));
  };

  const moveTo = (row: number, col: number) => {
    if (originMode) {
      y = Math.max(scrollTop, Math.min(scrollTop + row, scrollBottom));
    } else {
      y = Math.max(0, Math.min(row, rows - 1));
    }
    x = Math.max(0, Math.min(col, cols - 1));
    pendingWrap = false;
  };

  const saveCursor = () => {
    const saved: SavedCursor = {
      x, y, fg: curFg, bg: curBg, attrs: curAttrs,
      charset: activeCharset, g0, g1, autowrap, origin: originMode,
    };
    if (altActive) savedAlt = saved; else savedPrimary = saved;
  };

  const restoreCursor = () => {
    const saved = altActive ? savedAlt : savedPrimary;
    if (!saved) { moveTo(0, 0); return; }
    x = Math.min(saved.x, cols - 1);
    y = Math.min(saved.y, rows - 1);
    curFg = saved.fg;
    curBg = saved.bg;
    curAttrs = saved.attrs;
    activeCharset = saved.charset;
    g0 = saved.g0;
    g1 = saved.g1;
    autowrap = saved.autowrap;
    originMode = saved.origin;
    pendingWrap = false;
  };

  const enterAlt = (clear: boolean) => {
    if (altActive) return;
    altActive = true;
    if (clear) {
      alternate = [];
      for (let i = 0; i < rows; i++) alternate.push(blankLine(COLOR_DEFAULT));
    }
    markDirty();
  };

  const leaveAlt = () => {
    if (!altActive) return;
    altActive = false;
    markDirty();
  };

  const softReset = () => {
    autowrap = true;
    originMode = false;
    insertMode = false;
    appCursorKeys = false;
    cursorVisible = true;
    scrollTop = 0;
    scrollBottom = rows - 1;
    curFg = COLOR_DEFAULT;
    curBg = COLOR_DEFAULT;
    curAttrs = 0;
    curLink = 0;
    g0 = "B";
    g1 = "B";
    activeCharset = 0;
    pendingWrap = false;
  };

  const fullReset = () => {
    softReset();
    scrollback = [];
    altActive = false;
    initScreens();
    resetTabs();
    x = 0;
    y = 0;
    bracketedPaste = false;
    reverseVideo = false;
    mouseTracking = 0;
    mouseSgr = false;
    focusReporting = false;
    lineFeedMode = false;
    cursorStyle = "block";
    cursorBlink = true;
    title = "";
    savedPrimary = null;
    savedAlt = null;
    markDirty();
  };

  // ---- printing ----

  const printChar = (ch: string, cp: number) => {
    let out = ch;
    const charset = activeCharset === 0 ? g0 : g1;
    if (charset === "0") {
      const mapped = DEC_GRAPHICS[ch];
      if (mapped) out = mapped;
    }
    const width = charWidth(cp);
    const lines = screen();

    if (width === 0) {
      // combining mark: attach to the previous cell
      const line = lines[y];
      if (!line) return;
      const col = pendingWrap ? cols - 1 : Math.max(0, x - 1);
      const target = line.chars[col] === "" && col > 0 ? col - 1 : col;
      if (line.chars[target] && line.chars[target] !== " ") {
        line.chars[target] += out;
        touch(line);
      }
      return;
    }

    if (pendingWrap && autowrap) {
      const line = lines[y];
      if (line) { line.wrapped = true; touch(line); }
      x = 0;
      lineFeed();
    }
    pendingWrap = false;

    let line = lines[y];
    if (!line) return;

    if (width === 2 && x >= cols - 1) {
      if (autowrap) {
        line.wrapped = true;
        touch(line);
        x = 0;
        lineFeed();
        line = lines[y];
        if (!line) return;
      } else {
        x = Math.max(0, cols - 2);
      }
    }

    if (insertMode) {
      for (let i = 0; i < width; i++) {
        line.chars.splice(x, 0, " ");
        line.fg.splice(x, 0, COLOR_DEFAULT);
        line.bg.splice(x, 0, curBg);
        line.attrs.splice(x, 0, 0);
        if (line.links) line.links.splice(x, 0, 0);
        line.chars.length = cols;
        line.fg.length = cols;
        line.bg.length = cols;
        line.attrs.length = cols;
        if (line.links) line.links.length = cols;
      }
    }

    setCell(line, x, out);
    if (width === 2) {
      if (x + 1 < cols) {
        setCell(line, x + 1, "");
      }
    }
    touch(line);
    lastGraphic = out;

    x += width;
    if (x >= cols) {
      x = cols - 1;
      pendingWrap = autowrap;
    }
  };

  // ---- CSI handlers ----

  interface Param { value: number; sub: number[] }

  const parseParams = (raw: string): Param[] => {
    if (!raw) return [];
    return raw.split(";").map((part) => {
      const bits = part.split(":");
      const value = bits[0] === "" ? 0 : Math.min(parseInt(bits[0]!, 10) || 0, MAX_PARAM);
      const sub = bits.slice(1).map((s) => (s === "" ? -1 : Math.min(parseInt(s, 10) || 0, MAX_PARAM)));
      return { value, sub };
    });
  };

  const applySgr = (params: Param[]) => {
    if (params.length === 0) params = [{ value: 0, sub: [] }];
    let i = 0;
    while (i < params.length) {
      const p = params[i]!;
      const v = p.value;
      switch (v) {
        case 0: curFg = COLOR_DEFAULT; curBg = COLOR_DEFAULT; curAttrs = 0; break;
        case 1: curAttrs |= ATTR_BOLD; break;
        case 2: curAttrs |= ATTR_DIM; break;
        case 3: curAttrs |= ATTR_ITALIC; break;
        case 4:
          if (p.sub.length > 0 && p.sub[0] === 0) curAttrs &= ~ATTR_UNDERLINE;
          else curAttrs |= ATTR_UNDERLINE;
          break;
        case 5: case 6: curAttrs |= ATTR_BLINK; break;
        case 7: curAttrs |= ATTR_INVERSE; break;
        case 8: curAttrs |= ATTR_HIDDEN; break;
        case 9: curAttrs |= ATTR_STRIKE; break;
        case 21: curAttrs |= ATTR_UNDERLINE; break;
        case 22: curAttrs &= ~(ATTR_BOLD | ATTR_DIM); break;
        case 23: curAttrs &= ~ATTR_ITALIC; break;
        case 24: curAttrs &= ~ATTR_UNDERLINE; break;
        case 25: curAttrs &= ~ATTR_BLINK; break;
        case 27: curAttrs &= ~ATTR_INVERSE; break;
        case 28: curAttrs &= ~ATTR_HIDDEN; break;
        case 29: curAttrs &= ~ATTR_STRIKE; break;
        case 39: curFg = COLOR_DEFAULT; break;
        case 49: curBg = COLOR_DEFAULT; break;
        case 53: curAttrs |= ATTR_OVERLINE; break;
        case 55: curAttrs &= ~ATTR_OVERLINE; break;
        case 38: case 48: case 58: {
          let mode = -1;
          let colorParams: number[] = [];
          if (p.sub.length > 0) {
            // colon form: 38:5:n or 38:2[:cs]:r:g:b
            mode = p.sub[0]!;
            colorParams = p.sub.slice(1).map((s) => (s < 0 ? 0 : s));
          } else {
            // semicolon form: consume following params
            mode = params[i + 1]?.value ?? -1;
            if (mode === 5) { colorParams = [params[i + 2]?.value ?? 0]; i += 2; }
            else if (mode === 2) {
              colorParams = [params[i + 2]?.value ?? 0, params[i + 3]?.value ?? 0, params[i + 4]?.value ?? 0];
              i += 4;
            } else { i += 1; }
          }
          let color: number | null = null;
          if (mode === 5) color = Math.max(0, Math.min(colorParams[0] ?? 0, 255));
          else if (mode === 2) {
            const tail = colorParams.slice(-3);
            color = packRgb(tail[0] ?? 0, tail[1] ?? 0, tail[2] ?? 0);
          }
          if (color !== null) {
            if (v === 38) curFg = color;
            else if (v === 48) curBg = color;
            // 58 (underline color) parsed but not stored
          }
          break;
        }
        default:
          if (v >= 30 && v <= 37) curFg = v - 30;
          else if (v >= 40 && v <= 47) curBg = v - 40;
          else if (v >= 90 && v <= 97) curFg = v - 90 + 8;
          else if (v >= 100 && v <= 107) curBg = v - 100 + 8;
          break;
      }
      i++;
    }
  };

  const setMode = (privateMode: boolean, value: number, on: boolean) => {
    if (privateMode) {
      switch (value) {
        case 1: appCursorKeys = on; break;
        case 3: break; // DECCOLM ignored (fixed width)
        case 5: reverseVideo = on; markDirty(); break;
        case 6:
          originMode = on;
          moveTo(0, 0);
          break;
        case 7: autowrap = on; if (!on) pendingWrap = false; break;
        case 12: cursorBlink = on; markDirty(); break;
        case 25: cursorVisible = on; markDirty(); break;
        case 9: mouseTracking = on ? 9 : 0; break;
        case 1000: mouseTracking = on ? 1000 : 0; break;
        case 1002: mouseTracking = on ? 1002 : 0; break;
        case 1003: mouseTracking = on ? 1003 : 0; break;
        case 1004: focusReporting = on; break;
        case 1005: break; // UTF-8 mouse coords: unsupported encoding, ignore
        case 1006: mouseSgr = on; break;
        case 1015: break; // urxvt mouse: ignore
        case 47: if (on) enterAlt(false); else leaveAlt(); break;
        case 1047:
          if (on) enterAlt(true);
          else { leaveAlt(); }
          break;
        case 1048: if (on) saveCursor(); else restoreCursor(); break;
        case 1049:
          if (on) { saveCursor(); enterAlt(true); moveTo(0, 0); }
          else { leaveAlt(); restoreCursor(); }
          break;
        case 2004: bracketedPaste = on; break;
        default: break;
      }
    } else {
      switch (value) {
        case 4: insertMode = on; break;
        case 20: lineFeedMode = on; break;
        default: break;
      }
    }
  };

  const csiDispatch = (prefix: string, paramsRaw: string, intermediate: string, final: string) => {
    const params = parseParams(paramsRaw);
    const p = (idx: number, def: number): number => {
      const v = params[idx]?.value;
      return v === undefined || v === 0 ? def : v;
    };
    const lines = screen();
    const line = lines[y];

    switch (final) {
      case "A": y = Math.max(y >= scrollTop ? scrollTop : 0, y - p(0, 1)); pendingWrap = false; break;
      case "B": case "e": y = Math.min(y <= scrollBottom ? scrollBottom : rows - 1, y + p(0, 1)); pendingWrap = false; break;
      case "C": case "a": x = Math.min(cols - 1, x + p(0, 1)); pendingWrap = false; break;
      case "D": x = Math.max(0, x - p(0, 1)); pendingWrap = false; break;
      case "E": y = Math.min(y <= scrollBottom ? scrollBottom : rows - 1, y + p(0, 1)); x = 0; pendingWrap = false; break;
      case "F": y = Math.max(y >= scrollTop ? scrollTop : 0, y - p(0, 1)); x = 0; pendingWrap = false; break;
      case "G": case "`": x = Math.max(0, Math.min(p(0, 1) - 1, cols - 1)); pendingWrap = false; break;
      case "H": case "f": moveTo(p(0, 1) - 1, p(1, 1) - 1); break;
      case "d": {
        const row = p(0, 1) - 1;
        y = originMode
          ? Math.max(scrollTop, Math.min(scrollTop + row, scrollBottom))
          : Math.max(0, Math.min(row, rows - 1));
        pendingWrap = false;
        break;
      }
      case "I": { // CHT — forward tab stops
        let n = p(0, 1);
        while (n-- > 0) {
          let next = x + 1;
          while (next < cols - 1 && !tabStops.has(next)) next++;
          x = Math.min(next, cols - 1);
        }
        pendingWrap = false;
        break;
      }
      case "Z": { // CBT — backward tab stops
        let n = p(0, 1);
        while (n-- > 0) {
          let prev = x - 1;
          while (prev > 0 && !tabStops.has(prev)) prev--;
          x = Math.max(prev, 0);
        }
        pendingWrap = false;
        break;
      }
      case "J": { // ED
        const mode = params[0]?.value ?? 0;
        if (mode === 0) {
          if (line) eraseCells(line, x, cols);
          for (let i = y + 1; i < rows; i++) eraseCells(lines[i]!, 0, cols);
        } else if (mode === 1) {
          for (let i = 0; i < y; i++) eraseCells(lines[i]!, 0, cols);
          if (line) eraseCells(line, 0, x + 1);
        } else if (mode === 2) {
          for (let i = 0; i < rows; i++) eraseCells(lines[i]!, 0, cols);
        } else if (mode === 3) {
          scrollback = [];
          markDirty();
        }
        pendingWrap = false;
        break;
      }
      case "K": { // EL
        const mode = params[0]?.value ?? 0;
        if (!line) break;
        if (mode === 0) eraseCells(line, x, cols);
        else if (mode === 1) eraseCells(line, 0, x + 1);
        else if (mode === 2) eraseCells(line, 0, cols);
        pendingWrap = false;
        break;
      }
      case "L": { // IL — insert lines at cursor (within region)
        if (y < scrollTop || y > scrollBottom) break;
        const n = Math.min(p(0, 1), scrollBottom - y + 1);
        for (let i = 0; i < n; i++) {
          lines.splice(scrollBottom, 1);
          lines.splice(y, 0, blankLine(curBg));
        }
        x = 0;
        pendingWrap = false;
        markDirty();
        break;
      }
      case "M": { // DL — delete lines at cursor
        if (y < scrollTop || y > scrollBottom) break;
        const n = Math.min(p(0, 1), scrollBottom - y + 1);
        for (let i = 0; i < n; i++) {
          lines.splice(y, 1);
          lines.splice(scrollBottom, 0, blankLine(curBg));
        }
        x = 0;
        pendingWrap = false;
        markDirty();
        break;
      }
      case "P": { // DCH — delete chars
        if (!line) break;
        const n = Math.min(p(0, 1), cols - x);
        clearWideAt(line, x);
        line.chars.splice(x, n);
        line.fg.splice(x, n);
        line.bg.splice(x, n);
        line.attrs.splice(x, n);
        if (line.links) line.links.splice(x, n);
        for (let i = 0; i < n; i++) {
          line.chars.push(" ");
          line.fg.push(COLOR_DEFAULT);
          line.bg.push(curBg);
          line.attrs.push(0);
          if (line.links) line.links.push(0);
        }
        touch(line);
        pendingWrap = false;
        break;
      }
      case "@": { // ICH — insert blanks
        if (!line) break;
        const n = Math.min(p(0, 1), cols - x);
        clearWideAt(line, x);
        for (let i = 0; i < n; i++) {
          line.chars.splice(x, 0, " ");
          line.fg.splice(x, 0, COLOR_DEFAULT);
          line.bg.splice(x, 0, curBg);
          line.attrs.splice(x, 0, 0);
          if (line.links) line.links.splice(x, 0, 0);
        }
        line.chars.length = cols;
        line.fg.length = cols;
        line.bg.length = cols;
        line.attrs.length = cols;
        if (line.links) line.links.length = cols;
        touch(line);
        pendingWrap = false;
        break;
      }
      case "X": { // ECH — erase chars in place
        if (!line) break;
        eraseCells(line, x, Math.min(x + p(0, 1), cols));
        pendingWrap = false;
        break;
      }
      case "S": scrollUp(p(0, 1)); break;
      case "T": scrollDown(p(0, 1)); break;
      case "b": { // REP — repeat last graphic char
        if (!lastGraphic) break;
        const cp = lastGraphic.codePointAt(0) ?? 32;
        let n = Math.min(p(0, 1), cols * rows);
        while (n-- > 0) printChar(lastGraphic, cp);
        break;
      }
      case "g": { // TBC
        const mode = params[0]?.value ?? 0;
        if (mode === 0) tabStops.delete(x);
        else if (mode === 3) tabStops.clear();
        break;
      }
      case "h": for (const prm of params) setMode(prefix === "?", prm.value, true); break;
      case "l": for (const prm of params) setMode(prefix === "?", prm.value, false); break;
      case "m": if (prefix === "") applySgr(params); break;
      case "n": { // DSR
        if (prefix !== "") break;
        const mode = params[0]?.value ?? 0;
        if (mode === 5) respond("\x1b[0n");
        else if (mode === 6) {
          const row = originMode ? y - scrollTop + 1 : y + 1;
          respond(`\x1b[${row};${x + 1}R`);
        }
        break;
      }
      case "c": { // DA
        if (prefix === "") respond("\x1b[?62;22c");
        else if (prefix === ">") respond("\x1b[>0;276;0c");
        break;
      }
      case "r": { // DECSTBM
        if (prefix !== "") break;
        const top = p(0, 1) - 1;
        const bottom = p(1, rows) - 1;
        if (top < bottom && bottom < rows) {
          scrollTop = top;
          scrollBottom = bottom;
          moveTo(0, 0);
        }
        break;
      }
      case "s": if (prefix === "") saveCursor(); break;
      case "u": if (prefix === "") restoreCursor(); break;
      case "q": { // DECSCUSR (space intermediate)
        if (intermediate !== " ") break;
        const v = params[0]?.value ?? 0;
        cursorBlink = v === 0 || v === 1 || v === 3 || v === 5;
        cursorStyle = v <= 2 ? "block" : v <= 4 ? "underline" : "bar";
        markDirty();
        break;
      }
      case "t": break; // XTWINOPS — ignored
      case "p": break; // DECSTR (!p) and friends — soft reset
      default: break;
    }
    if (final === "p" && intermediate === "!") softReset();
    clampCursor();
  };

  // ---- OSC ----

  const oscDispatch = (payload: string) => {
    const sep = payload.indexOf(";");
    const code = sep < 0 ? payload : payload.slice(0, sep);
    const rest = sep < 0 ? "" : payload.slice(sep + 1);
    switch (code) {
      case "0": case "2":
        title = rest.slice(0, 256);
        markDirty();
        break;
      case "8": {
        // OSC 8 ; params ; URI — empty URI ends the hyperlink
        const semi = rest.indexOf(";");
        const uri = semi < 0 ? "" : rest.slice(semi + 1);
        if (!uri) { curLink = 0; break; }
        if (uri.length > 2048) { curLink = 0; break; }
        let id = linkTable.indexOf(uri) + 1;
        if (id === 0) { linkTable.push(uri); id = linkTable.length; }
        curLink = id;
        break;
      }
      case "10": case "11": {
        // color query: reply with the theme's fg/bg so apps detect dark/light
        if (rest === "?") {
          const hex = code === "10" ? (opts.queryFg ?? "#e6e6e6") : (opts.queryBg ?? "#101010");
          const to4 = (s: string) => `${s}${s}`;
          const r = to4(hex.slice(1, 3));
          const g = to4(hex.slice(3, 5));
          const b = to4(hex.slice(5, 7));
          respond(`\x1b]${code};rgb:${r}/${g}/${b}\x07`);
        }
        break;
      }
      default: break;
    }
  };

  // ---- parser ----

  const GROUND = 0, ESC = 1, CSI = 2, OSC = 3, STR = 4, CHARSET = 5, ESC_HASH = 6;
  let state = GROUND;
  let csiPrefix = "";
  let csiParams = "";
  let csiIntermediate = "";
  let oscBuf = "";
  let oscEsc = false;
  let strEsc = false;
  let charsetTarget = 0;

  const executeC0 = (code: number) => {
    switch (code) {
      case 0x07: for (const cb of bellCbs) cb(); break;
      case 0x08: if (x > 0) x--; pendingWrap = false; break;
      case 0x09: {
        let next = x + 1;
        while (next < cols - 1 && !tabStops.has(next)) next++;
        x = Math.min(next, cols - 1);
        pendingWrap = false;
        break;
      }
      case 0x0a: case 0x0b: case 0x0c: lineFeed(); break;
      case 0x0d: x = 0; pendingWrap = false; break;
      case 0x0e: activeCharset = 1; break;
      case 0x0f: activeCharset = 0; break;
      default: break;
    }
  };

  const write = (data: string) => {
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      const ch = data[i]!;

      if (state === GROUND) {
        if (code === 0x1b) { state = ESC; continue; }
        if (code < 0x20) { executeC0(code); markDirty(); continue; }
        if (code === 0x7f) continue;
        // printable — handle surrogate pairs as one code point
        let cp = code;
        let glyph = ch;
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < data.length) {
          const lo = data.charCodeAt(i + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cp = (code - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
            glyph = ch + data[i + 1]!;
            i++;
          }
        }
        printChar(glyph, cp);
        continue;
      }

      if (state === ESC) {
        switch (ch) {
          case "[": state = CSI; csiPrefix = ""; csiParams = ""; csiIntermediate = ""; break;
          case "]": state = OSC; oscBuf = ""; oscEsc = false; break;
          case "P": case "X": case "^": case "_": state = STR; strEsc = false; break;
          case "(": state = CHARSET; charsetTarget = 0; break;
          case ")": state = CHARSET; charsetTarget = 1; break;
          case "*": case "+": state = CHARSET; charsetTarget = -1; break;
          case "#": state = ESC_HASH; break;
          case "7": saveCursor(); state = GROUND; break;
          case "8": restoreCursor(); state = GROUND; markDirty(); break;
          case "D": lineFeed(); state = GROUND; markDirty(); break;
          case "E": lineFeed(); x = 0; state = GROUND; markDirty(); break;
          case "H": tabStops.add(x); state = GROUND; break;
          case "M": reverseLineFeed(); state = GROUND; markDirty(); break;
          case "c": fullReset(); state = GROUND; break;
          case "=": case ">": state = GROUND; break; // keypad modes
          case "\\": state = GROUND; break; // stray ST
          default: state = GROUND; break;
        }
        continue;
      }

      if (state === ESC_HASH) {
        if (ch === "8") { // DECALN
          const lines = screen();
          for (const l of lines) {
            for (let c = 0; c < cols; c++) {
              l.chars[c] = "E";
              l.fg[c] = COLOR_DEFAULT;
              l.bg[c] = COLOR_DEFAULT;
              l.attrs[c] = 0;
            }
            touch(l);
          }
          scrollTop = 0;
          scrollBottom = rows - 1;
          moveTo(0, 0);
        }
        state = GROUND;
        continue;
      }

      if (state === CHARSET) {
        if (charsetTarget === 0) g0 = ch;
        else if (charsetTarget === 1) g1 = ch;
        state = GROUND;
        continue;
      }

      if (state === CSI) {
        if (code >= 0x30 && code <= 0x3b) {
          if (csiParams.length < 64) csiParams += ch;
        } else if (ch === "?" || ch === ">" || ch === "<" || ch === "=") {
          csiPrefix = ch;
        } else if (code >= 0x20 && code <= 0x2f) {
          csiIntermediate += ch;
        } else if (code >= 0x40 && code <= 0x7e) {
          csiDispatch(csiPrefix, csiParams, csiIntermediate, ch);
          markDirty();
          state = GROUND;
        } else if (code === 0x1b) {
          state = ESC;
        } else if (code < 0x20) {
          executeC0(code); // C0 inside CSI executes immediately (vt100 behavior)
        } else {
          state = GROUND;
        }
        continue;
      }

      if (state === OSC) {
        if (code === 0x07) { oscDispatch(oscBuf); state = GROUND; continue; }
        if (oscEsc) {
          oscEsc = false;
          if (ch === "\\") { oscDispatch(oscBuf); state = GROUND; continue; }
          state = GROUND;
          continue;
        }
        if (code === 0x1b) { oscEsc = true; continue; }
        if (oscBuf.length < MAX_OSC) oscBuf += ch;
        continue;
      }

      if (state === STR) {
        // DCS/SOS/PM/APC — swallow until ST (ESC \) or BEL
        if (code === 0x07) { state = GROUND; continue; }
        if (strEsc) {
          strEsc = false;
          if (ch === "\\") { state = GROUND; }
          continue;
        }
        if (code === 0x1b) strEsc = true;
        continue;
      }
    }

    if (dirty) {
      dirty = false;
      for (const cb of updateCbs) cb();
    }
  };

  // ---- resize ----

  const resizeLine = (line: TermLine, width: number) => {
    if (line.chars.length === width) return;
    if (line.chars.length > width) {
      line.chars.length = width;
      line.fg.length = width;
      line.bg.length = width;
      line.attrs.length = width;
      if (line.links) line.links.length = width;
      // never leave a dangling wide head at the edge
      if (width > 0 && line.chars[width - 1] !== "" && charWidth(line.chars[width - 1]!.codePointAt(0) ?? 32) === 2) {
        line.chars[width - 1] = " ";
      }
    } else {
      while (line.chars.length < width) {
        line.chars.push(" ");
        line.fg.push(COLOR_DEFAULT);
        line.bg.push(COLOR_DEFAULT);
        line.attrs.push(0);
        if (line.links) line.links.push(0);
      }
    }
    touch(line);
  };

  const resize = (nextCols: number, nextRows: number) => {
    const c = Math.max(2, Math.min(Math.floor(nextCols), 1000));
    const r = Math.max(2, Math.min(Math.floor(nextRows), 500));
    if (c === cols && r === rows) return;

    const oldRows = rows;
    cols = c;
    rows = r;

    for (const line of primary) resizeLine(line, cols);
    for (const line of alternate) resizeLine(line, cols);

    if (r > oldRows) {
      // grow: pull lines back from scrollback first (primary only)
      let need = r - oldRows;
      while (need > 0 && scrollback.length > 0) {
        primary.unshift(scrollback.pop()!);
        resizeLine(primary[0]!, cols);
        y = Math.min(y + 1, r - 1);
        need--;
      }
      while (primary.length < r) primary.push(blankLine(COLOR_DEFAULT));
      while (alternate.length < r) alternate.push(blankLine(COLOR_DEFAULT));
    } else if (r < oldRows) {
      // shrink: prefer trimming blank tail lines, else push top into scrollback
      while (primary.length > r) {
        const tail = primary[primary.length - 1]!;
        const tailBlank = y < primary.length - 1 && tail.chars.every((chr) => chr === " " || chr === "");
        if (tailBlank) {
          primary.pop();
        } else {
          const head = primary.shift()!;
          if (scrollbackCap > 0) scrollback.push(head);
          y = Math.max(0, y - 1);
        }
      }
      while (alternate.length > r) alternate.pop();
      trimScrollback();
    }

    scrollTop = 0;
    scrollBottom = rows - 1;
    // tab stops: extend the default grid into new columns
    for (let i = 8; i < cols; i += 8) if (!tabStops.has(i)) tabStops.add(i);
    clampCursor();
    pendingWrap = false;
    markDirty();
    for (const cb of updateCbs) cb();
    dirty = false;
  };

  // ---- snapshot / selection ----

  const bufferLength = () => (altActive ? rows : scrollback.length + rows);
  const scrollbackLength = () => (altActive ? 0 : scrollback.length);

  const lineAt = (index: number): TermLine | undefined => {
    if (altActive) return alternate[index];
    if (index < scrollback.length) return scrollback[index];
    return primary[index - scrollback.length];
  };

  const rowInfo = (index: number): RowInfo => {
    const line = lineAt(index);
    if (!line) return { text: "", map: null };
    let hasWide = false;
    for (let i = 0; i < line.chars.length; i++) {
      if (line.chars[i] === "") { hasWide = true; break; }
    }
    if (!hasWide) {
      return { text: line.chars.join("").replace(/\s+$/, ""), map: null };
    }
    let text = "";
    const map: number[] = [];
    for (let col = 0; col < line.chars.length; col++) {
      const chr = line.chars[col]!;
      if (chr === "") continue;
      for (let k = 0; k < chr.length; k++) map.push(col);
      text += chr;
    }
    map.push(line.chars.length);
    return { text: text.replace(/\s+$/, ""), map };
  };

  const getText = (a: TermPoint, b: TermPoint): string => {
    let start = a;
    let end = b;
    if (end.row < start.row || (end.row === start.row && end.col < start.col)) {
      start = b;
      end = a;
    }
    const parts: string[] = [];
    for (let r = start.row; r <= end.row; r++) {
      const line = lineAt(r);
      if (!line) continue;
      const from = r === start.row ? start.col : 0;
      const to = r === end.row ? end.col : line.chars.length;
      let text = line.chars.slice(from, to).join("");
      const takesTail = r < end.row || to >= line.chars.length;
      if (takesTail && !line.wrapped) text = text.replace(/\s+$/, "");
      parts.push(text);
      if (r < end.row && !line.wrapped) parts.push("\n");
    }
    return parts.join("");
  };

  return {
    write,
    resize,
    reset: fullReset,
    clearBuffer() {
      scrollback = [];
      const lines = screen();
      for (const l of lines) eraseCells(l, 0, cols);
      x = 0;
      y = 0;
      pendingWrap = false;
      markDirty();
      for (const cb of updateCbs) cb();
      dirty = false;
    },
    cols: () => cols,
    rows: () => rows,
    bufferLength,
    scrollbackLength,
    line: lineAt,
    rowInfo,
    cursor: () => ({ x, y, visible: cursorVisible, style: cursorStyle, blink: cursorBlink }),
    modes: () => ({
      appCursorKeys, bracketedPaste, altScreen: altActive,
      mouseTracking, mouseSgr, focusReporting, reverseVideo,
    }),
    title: () => title,
    linkUrl: (id: number) => (id > 0 ? linkTable[id - 1] : undefined),
    getText,
    onUpdate(cb) { updateCbs.add(cb); return { dispose: () => updateCbs.delete(cb) }; },
    onBell(cb) { bellCbs.add(cb); return { dispose: () => bellCbs.delete(cb) }; },
    onResponse(cb) { responseCbs.add(cb); return { dispose: () => responseCbs.delete(cb) }; },
  };
}
