// Terminal render surface: virtualized row rendering over the emulator's
// cell grid, custom selection, search-in-terminal, link detection, cursor
// overlay, scroll-follow UX, keyboard/mouse/paste encoding, and resize.
// The emulator instance lives outside React (owned by TerminalView); this
// component only subscribes to its update events and reads snapshots.
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type ClipboardEvent as ReactClipboardEvent, type CompositionEvent as ReactCompositionEvent,
  type CSSProperties,
} from "react";
import {
  ATTR_BLINK, ATTR_BOLD, ATTR_DIM, ATTR_HIDDEN, ATTR_INVERSE, ATTR_ITALIC,
  ATTR_OVERLINE, ATTR_STRIKE, ATTR_UNDERLINE, lineInfo,
  type TermLine, type TermPoint, type TerminalEmulator,
} from "./terminal/emulator.ts";
import { cellColorCss } from "./terminal/palette.ts";
import { encodeMouseEvent, encodePaste, keyEventToBytes } from "./terminal/keymap.ts";
import { detectLinks } from "./terminal/linkify.ts";
import { searchBuffer, type TermMatch } from "./terminal/search.ts";
import { copyText } from "../../../apps/web/src/utils.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyIcon,
  IconButton,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";

const raf: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;
const caf: (id: number) => void =
  typeof cancelAnimationFrame === "function"
    ? (id) => cancelAnimationFrame(id)
    : (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

const FALLBACK_CELL = { w: 7.2, h: 17.5 };
const OVERSCAN = 12;
const WORD_RE = /[\w./~:@#%+=-]/;

interface CellSize { w: number; h: number }

interface Range { start: number; end: number }

interface Selection { anchor: TermPoint; focus: TermPoint }

interface ContextMenuPosition { x: number; y: number }

/** Normalized selection column range for one absolute row, or null. */
function selRangeForRow(sel: Selection | null, row: number, cols: number): Range | null {
  if (!sel) return null;
  let a = sel.anchor;
  let b = sel.focus;
  if (b.row < a.row || (b.row === a.row && b.col < a.col)) { const t = a; a = b; b = t; }
  if (row < a.row || row > b.row) return null;
  const start = row === a.row ? a.col : 0;
  const end = row === b.row ? b.col : cols;
  if (end <= start) return null;
  return { start, end };
}

// ------------------------------------------------------------------ row view

interface RowMatch { startCol: number; endCol: number; index: number }

interface TermRowProps {
  line: TermLine;
  rev: number;
  top: number;
  cellW: number;
  cellH: number;
  sel: Range | null;
  matches: RowMatch[] | undefined;
  currentMatch: number;
}

/** Group the line's cells into style runs and render spans + overlays. */
function renderRow(line: TermLine, cellW: number): React.ReactNode {
  const cells = line.chars;
  const n = cells.length;
  // trailing default-blank cells render as nothing
  let last = n - 1;
  while (last >= 0 && (cells[last] === " " || cells[last] === "")
    && line.bg[last]! < 0 && line.attrs[last] === 0 && (!line.links || line.links[last] === 0)) last--;
  if (last < 0) return null;

  const info = lineInfo(line);
  const detected = detectLinks(info.text);
  // per-cell implicit link index (-1 none), from text ranges via the col map
  let linkCol: Int16Array | null = null;
  if (detected.length > 0) {
    linkCol = new Int16Array(n).fill(-1);
    for (let d = 0; d < detected.length; d++) {
      const range = detected[d]!;
      const c0 = info.map ? info.map[range.start]! : range.start;
      const c1 = info.map ? (info.map[range.end] ?? n) : range.end;
      for (let c = c0; c < c1 && c < n; c++) linkCol[c] = d;
    }
  }

  const out: React.ReactNode[] = [];
  let runStart = 0;
  const keyOf = (i: number): string =>
    `${line.fg[i]}|${line.bg[i]}|${line.attrs[i]}|${line.links ? line.links[i] : 0}|${linkCol ? linkCol[i] : -1}`;
  let runKey = keyOf(0);

  const flush = (endIdx: number) => {
    const i = runStart;
    let text = "";
    for (let c = i; c < endIdx; c++) text += cells[c]!;
    if (!text) return;
    let fg = line.fg[i]!;
    let bg = line.bg[i]!;
    const attrs = line.attrs[i]!;
    // classic "bold is bright" for the base 8 palette colors
    if ((attrs & ATTR_BOLD) !== 0 && fg >= 0 && fg < 8) fg += 8;
    if ((attrs & ATTR_INVERSE) !== 0) { const t = fg; fg = bg; bg = t; }
    const fgCss = cellColorCss(fg);
    const bgCss = cellColorCss(bg);
    const style: CSSProperties = {};
    if ((attrs & ATTR_INVERSE) !== 0) {
      style.color = fgCss ?? "var(--term-bg)";
      style.backgroundColor = bgCss ?? "var(--term-fg)";
    } else {
      if (fgCss) style.color = fgCss;
      if (bgCss) style.backgroundColor = bgCss;
    }
    let cls = "";
    if (attrs & ATTR_BOLD) cls += " tb";
    if (attrs & ATTR_DIM) cls += " td";
    if (attrs & ATTR_ITALIC) cls += " ti";
    if (attrs & ATTR_UNDERLINE) cls += " tu";
    if (attrs & ATTR_BLINK) cls += " tk";
    if (attrs & ATTR_HIDDEN) cls += " th";
    if (attrs & ATTR_STRIKE) cls += " ts";
    if (attrs & ATTR_OVERLINE) cls += " to";
    const oscLink = line.links ? line.links[i]! : 0;
    const implicit = linkCol ? linkCol[i]! : -1;
    let url: string | undefined;
    if (oscLink > 0) url = undefined; // resolved by TermPane via emulator table
    if (implicit >= 0) url = detected[implicit]!.url;
    const isLink = oscLink > 0 || implicit >= 0;
    if (isLink) cls += " tlink";
    const hasStyle = style.color !== undefined || style.backgroundColor !== undefined;
    if (!cls && !hasStyle && !isLink) {
      out.push(text);
    } else {
      out.push(
        <span
          key={i}
          className={cls ? cls.slice(1) : undefined}
          style={hasStyle ? style : undefined}
          data-url={url}
          data-osc-link={oscLink > 0 ? oscLink : undefined}
          title={url ? tr("terminalview.openLinkShortcut", { url }) : undefined}
        >{text}</span>,
      );
    }
  };

  for (let i = 1; i <= last; i++) {
    const k = keyOf(i);
    if (k !== runKey) {
      flush(i);
      runStart = i;
      runKey = k;
    }
  }
  flush(last + 1);
  void cellW;
  return out;
}

const TermRow = memo(function TermRow(props: TermRowProps) {
  const { line, top, cellW, cellH, sel, matches, currentMatch } = props;
  const content = useMemo(() => renderRow(line, cellW), [line, props.rev, cellW]);
  return (
    <div className="term-row" style={{ top, height: cellH }}>
      {sel && (
        <span
          className="term-row-sel"
          style={{ left: sel.start * cellW, width: (sel.end - sel.start) * cellW }}
        />
      )}
      {matches?.map((m) => (
        <span
          key={m.index}
          className={`term-row-find${m.index === currentMatch ? " cur" : ""}`}
          style={{ left: m.startCol * cellW, width: Math.max(cellW, (m.endCol - m.startCol) * cellW) }}
        />
      ))}
      {content}
    </div>
  );
}, (a, b) =>
  a.line === b.line && a.rev === b.rev && a.top === b.top
  && a.cellW === b.cellW && a.cellH === b.cellH
  && a.sel?.start === b.sel?.start && a.sel?.end === b.sel?.end
  && a.matches === b.matches && a.currentMatch === b.currentMatch,
);

// ------------------------------------------------------------------- pane

export interface TermPaneProps {
  emu: TerminalEmulator;
  label: string;
  running: boolean;
  exitCode?: number | null;
  send: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Increment to open the search bar from outside (toolbar button). */
  searchSignal?: number;
}

export default function TermPane(props: TermPaneProps) {
  const { emu, label, running, send, onResize } = props;
  const bodyRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // A focusable div receives hardware keys, but mobile browsers do not open
  // their software keyboard for it. Keep a visually inert native input solely
  // as the mobile IME bridge; terminal output and selection remain in bodyRef.
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const composedMobileInputRef = useRef<string | null>(null);

  const [, setTick] = useState(0);
  const [searchEpoch, setSearchEpoch] = useState(0);
  const [cell, setCell] = useState<CellSize>(FALLBACK_CELL);
  const [viewportH, setViewportH] = useState(400);
  const [firstRow, setFirstRow] = useState(0);
  const [focused, setFocused] = useState(false);
  const [bell, setBell] = useState(false);
  const [behind, setBehind] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [current, setCurrent] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);

  const followRef = useRef(true);
  const selectingRef = useRef(false);
  const dragButtonRef = useRef(-1);
  const lastMouseCellRef = useRef("");
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const cellRef = useRef(cell);
  cellRef.current = cell;

  // focus the surface whenever a tab pane mounts (tab switch / first open)
  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  // ---- emulator subscription: coalesce updates to one paint per frame ----
  useEffect(() => {
    let pending = 0;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    const sub = emu.onUpdate(() => {
      if (!followRef.current) setBehind(true);
      // Search needs to observe in-place cursor rewrites (progress bars, TUIs),
      // not just appended rows. Throttle rescans so high-output sessions keep
      // painting smoothly while an active query remains accurate.
      if (searchOpenRef.current && !searchTimer) {
        searchTimer = setTimeout(() => {
          searchTimer = undefined;
          setSearchEpoch((value) => value + 1);
        }, 120);
      }
      if (pending) return;
      pending = raf(() => { pending = 0; setTick((t) => t + 1); });
    });
    const bellSub = emu.onBell(() => {
      setBell(true);
      setTimeout(() => setBell(false), 220);
    });
    return () => {
      sub.dispose();
      bellSub.dispose();
      if (pending) caf(pending);
      if (searchTimer) clearTimeout(searchTimer);
    };
  }, [emu]);

  // ---- measurement + resize ----
  const measure = useCallback((): CellSize => {
    const body = bodyRef.current;
    if (!body) return cellRef.current;
    const probe = document.createElement("span");
    probe.className = "term-row";
    probe.style.position = "absolute";
    // `.term-row` normally stretches from left to right for virtualized
    // output. That makes its bounding rect equal the pane width, which was
    // then divided by 20 and reported a 20px-wide "character" on phones.
    // The measurement probe must instead shrink to its twenty glyphs.
    probe.style.right = "auto";
    probe.style.width = "max-content";
    probe.style.visibility = "hidden";
    probe.textContent = "W".repeat(20);
    body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    body.removeChild(probe);
    if (rect.width > 0 && rect.height > 0) {
      const next = { w: rect.width / 20, h: rect.height };
      // ResizeObserver's callback uses this value in the same turn. Updating
      // the ref avoids sending the PTY an old fallback grid for one resize.
      cellRef.current = next;
      setCell((prev) => (Math.abs(prev.w - next.w) > 0.01 || Math.abs(prev.h - next.h) > 0.01 ? next : prev));
      return next;
    }
    return cellRef.current;
  }, []);

  useLayoutEffect(() => {
    measure();
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const measuredCell = measure();
        const el = bodyRef.current;
        if (!el) return;
        setViewportH(el.clientHeight);
        const c = measuredCell;
        const cols = Math.max(2, Math.floor((el.clientWidth - 16) / c.w));
        const rows = Math.max(2, Math.floor((el.clientHeight - 16) / c.h));
        if (cols !== emu.cols() || rows !== emu.rows()) {
          emu.resize(cols, rows);
          onResize(cols, rows);
        }
      }, 80);
    });
    ro.observe(body);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [measure, emu, onResize]);

  // ---- follow / scroll ----
  const scrollToBottom = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    followRef.current = true;
    setBehind(false);
  }, []);

  useLayoutEffect(() => {
    if (followRef.current) {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    }
  });

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - cell.h / 2;
    followRef.current = atBottom;
    if (atBottom) setBehind(false);
    const first = Math.max(0, Math.floor(body.scrollTop / cell.h));
    setFirstRow((prev) => (prev === first ? prev : first));
  };

  // ---- search ----
  useEffect(() => {
    if ((props.searchSignal ?? 0) > 0) {
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.select(), 0);
    }
  }, [props.searchSignal]);

  const total = emu.bufferLength();
  const matches: TermMatch[] = useMemo(() => {
    if (!searchOpen || !query) return [];
    return searchBuffer(emu.rowInfo, emu.bufferLength(), query, { caseSensitive, regex: useRegex });
  }, [searchOpen, query, caseSensitive, useRegex, total, searchEpoch, emu]);

  const matchesByRow = useMemo(() => {
    const map = new Map<number, RowMatch[]>();
    matches.forEach((m, index) => {
      const list = map.get(m.row);
      const entry = { startCol: m.startCol, endCol: m.endCol, index };
      if (list) list.push(entry);
      else map.set(m.row, [entry]);
    });
    return map;
  }, [matches]);

  const gotoMatch = useCallback((index: number) => {
    const m = matches[index];
    if (!m) return;
    setCurrent(index);
    const body = bodyRef.current;
    if (!body) return;
    followRef.current = false;
    body.scrollTop = Math.max(0, m.row * cellRef.current.h - body.clientHeight / 2);
    onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  // on new query results jump to the match closest to the bottom
  const lastQueryRef = useRef("");
  useEffect(() => {
    const key = `${query}\u0000${caseSensitive}\u0000${useRegex}`;
    if (key !== lastQueryRef.current) {
      lastQueryRef.current = key;
      if (matches.length > 0) gotoMatch(matches.length - 1);
      else setCurrent(0);
    } else if (current >= matches.length && matches.length > 0) {
      setCurrent(matches.length - 1);
    }
  }, [query, caseSensitive, useRegex, matches, current, gotoMatch]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    bodyRef.current?.focus();
  };

  // ---- clipboard ----
  const copySelection = useCallback(async (): Promise<boolean> => {
    if (!selection) return false;
    const a = selection.anchor;
    const b = selection.focus;
    if (a.row === b.row && a.col === b.col) return false;
    const text = emu.getText(a, b);
    if (!text) return false;
    return copyText(text);
  }, [selection, emu]);

  // Touch selection is inconsistent across mobile browsers, especially while
  // a terminal is keeping the software keyboard open. The mobile Copy action
  // still copies an explicit selection when there is one, and otherwise gives
  // users a reliable way to copy the complete visible terminal buffer.
  const copyTerminalText = useCallback(async (): Promise<boolean> => {
    if (await copySelection()) return true;
    const lastRow = emu.bufferLength() - 1;
    if (lastRow < 0) return false;
    const text = emu.getText(
      { row: 0, col: 0 },
      { row: lastRow, col: emu.cols() },
    );
    return text ? copyText(text) : false;
  }, [copySelection, emu]);

  const pasteFromClipboard = useCallback(() => {
    try {
      void navigator.clipboard.readText().then((text) => {
        if (text) send(encodePaste(text, emu.modes().bracketedPaste));
        scrollToBottom();
      }).catch(() => {});
    } catch { /* clipboard unavailable */ }
  }, [send, emu, scrollToBottom]);

  const onPaste = (e: ReactClipboardEvent<HTMLElement>) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text) {
      send(encodePaste(text, emu.modes().bracketedPaste));
      scrollToBottom();
    }
  };

  const onCompositionEnd = (e: ReactCompositionEvent<HTMLElement>) => {
    if (!running || !e.data) return;
    send(e.data);
    scrollToBottom();
    // Browsers may follow compositionend with an input event. The composition
    // data has already reached the PTY, so suppress that duplicate commit.
    if (e.currentTarget instanceof HTMLInputElement) {
      composedMobileInputRef.current = e.data;
      e.currentTarget.value = "";
    }
  };

  const onMobileInput = (e: React.FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if ((e.nativeEvent as InputEvent).isComposing) return;
    const text = input.value;
    input.value = "";
    if (composedMobileInputRef.current !== null) {
      composedMobileInputRef.current = null;
      return;
    }
    if (!running || !text) return;
    send(text);
    scrollToBottom();
  };

  // ---- keyboard ----
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
    if (contextMenu) setContextMenu(null);
    const ctrl = e.ctrlKey;
    const shift = e.shiftKey;
    const meta = e.metaKey;

    // find
    if ((ctrl || meta) && shift && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.select(), 0);
      return;
    }
    // Clear the local terminal buffer without sending control bytes to the
    // process (the shell keeps running, matching modern terminal panes).
    if ((ctrl || meta) && shift && e.key.toLowerCase() === "k") {
      e.preventDefault();
      emu.clearBuffer();
      setSelection(null);
      scrollToBottom();
      return;
    }
    // copy: Ctrl+Shift+C / Ctrl+Insert / Cmd+C, plus Ctrl+C when text is selected
    if ((ctrl && shift && e.key.toLowerCase() === "c")
      || (ctrl && !shift && e.key === "Insert")
      || (meta && !ctrl && e.key.toLowerCase() === "c")) {
      e.preventDefault();
      void copySelection();
      return;
    }
    if (ctrl && !shift && !meta && e.key.toLowerCase() === "c" && selection
      && (selection.anchor.row !== selection.focus.row || selection.anchor.col !== selection.focus.col)) {
      e.preventDefault();
      void copySelection();
      return;
    }
    // paste: Ctrl+V / Ctrl+Shift+V / Cmd+V / Shift+Insert (browser paste event covers some)
    if (((ctrl || meta) && e.key.toLowerCase() === "v") || (shift && e.key === "Insert")) {
      // let the native paste event deliver the text; fall back to clipboard API
      if (typeof ClipboardEvent === "undefined" || (ctrl && shift) || (shift && e.key === "Insert")) {
        e.preventDefault();
        pasteFromClipboard();
      }
      return;
    }
    // local scrolling
    if (shift && (e.key === "PageUp" || e.key === "PageDown")) {
      e.preventDefault();
      const body = bodyRef.current;
      if (body) {
        followRef.current = false;
        body.scrollTop += (e.key === "PageUp" ? -1 : 1) * (body.clientHeight - cell.h);
        onScroll();
      }
      return;
    }
    if (ctrl && shift && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      const body = bodyRef.current;
      if (body) {
        if (e.key === "Home") { followRef.current = false; body.scrollTop = 0; }
        else scrollToBottom();
        onScroll();
      }
      return;
    }
    if (e.key === "Escape" && selection) {
      setSelection(null);
      e.preventDefault();
      return;
    }
    const bytes = keyEventToBytes(e, { appCursorKeys: emu.modes().appCursorKeys });
    if (bytes !== null) {
      e.preventDefault();
      if (selection) setSelection(null);
      send(bytes);
      scrollToBottom();
    }
  };

  // ---- mouse ----
  const pointFromEvent = (e: { clientX: number; clientY: number }): TermPoint => {
    const sizer = sizerRef.current;
    const c = cellRef.current;
    if (!sizer) return { row: 0, col: 0 };
    const rect = sizer.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const row = Math.max(0, Math.min(Math.floor(py / c.h), emu.bufferLength() - 1));
    const col = Math.max(0, Math.min(Math.round(px / c.w - 0.3), emu.cols()));
    return { row, col };
  };

  const mouseButton = (button: number): number => button === 1 ? 1 : button === 2 ? 2 : 0;

  const reportMouse = (e: ReactMouseEvent, kind: "down" | "up"): boolean => {
    const modes = emu.modes();
    if (modes.mouseTracking === 0 || e.shiftKey || !running) return false;
    const pt = pointFromEvent(e);
    const screenRow = pt.row - emu.scrollbackLength();
    if (screenRow < 0) return false;
    const encoded = encodeMouseEvent({
      button: mouseButton(e.button),
      col: Math.min(pt.col + 1, emu.cols()),
      row: Math.min(screenRow + 1, emu.rows()),
      kind,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey,
    }, { mouseTracking: modes.mouseTracking, mouseSgr: modes.mouseSgr });
    if (encoded) send(encoded);
    return encoded !== null;
  };

  const reportMouseMove = (e: {
    clientX: number; clientY: number;
    shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean;
  }): boolean => {
    const modes = emu.modes();
    if (!running || e.shiftKey || (modes.mouseTracking !== 1002 && modes.mouseTracking !== 1003)) return false;
    const pressed = dragButtonRef.current;
    if (modes.mouseTracking === 1002 && pressed < 0) return false;
    const pt = pointFromEvent(e);
    const screenRow = pt.row - emu.scrollbackLength();
    if (screenRow < 0 || screenRow >= emu.rows()) return false;
    const col = Math.min(pt.col + 1, emu.cols());
    const row = Math.min(screenRow + 1, emu.rows());
    const key = `${pressed}:${col}:${row}`;
    if (key === lastMouseCellRef.current) return true;
    lastMouseCellRef.current = key;
    const encoded = encodeMouseEvent({
      // Button 3 means "no button" for DECSET 1003 any-motion reporting.
      button: pressed >= 0 ? mouseButton(pressed) : 3,
      col,
      row,
      kind: "move",
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey,
    }, { mouseTracking: modes.mouseTracking, mouseSgr: modes.mouseSgr });
    if (encoded) send(encoded);
    return encoded !== null;
  };

  const selectWordAt = (pt: TermPoint) => {
    const info = emu.rowInfo(pt.row);
    const line = emu.line(pt.row);
    if (!line) return;
    // column → text index
    let idx = pt.col;
    if (info.map) {
      idx = 0;
      while (idx < info.map.length - 1 && info.map[idx]! < pt.col) idx++;
    }
    idx = Math.min(idx, Math.max(0, info.text.length - 1));
    if (!WORD_RE.test(info.text[idx] ?? "")) return;
    let s = idx;
    let e = idx;
    while (s > 0 && WORD_RE.test(info.text[s - 1]!)) s--;
    while (e < info.text.length - 1 && WORD_RE.test(info.text[e + 1]!)) e++;
    const colOf = (i: number) => (info.map ? info.map[i]! : i);
    setSelection({
      anchor: { row: pt.row, col: colOf(s) },
      focus: { row: pt.row, col: info.map ? (info.map[e + 1] ?? emu.cols()) : e + 1 },
    });
  };

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (contextMenu) setContextMenu(null);
    const mobile = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    (mobile ? mobileInputRef.current : bodyRef.current)?.focus({ preventScroll: true });
    // links: ctrl/cmd+click opens
    const target = e.target as HTMLElement;
    const linkEl = target.closest?.("[data-url],[data-osc-link]") as HTMLElement | null;
    if (e.button === 0 && linkEl && (e.ctrlKey || e.metaKey)) {
      const osc = linkEl.dataset.oscLink;
      const url = osc ? emu.linkUrl(Number(osc)) : linkEl.dataset.url;
      if (url && /^(https?|file|ftp|mailto):/i.test(url)) {
        e.preventDefault();
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
    }
    if (reportMouse(e, "down")) {
      dragButtonRef.current = e.button;
      lastMouseCellRef.current = "";
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const pt = pointFromEvent(e);
    if (e.detail === 2) { selectWordAt(pt); return; }
    if (e.detail >= 3) {
      setSelection({ anchor: { row: pt.row, col: 0 }, focus: { row: pt.row, col: emu.cols() } });
      return;
    }
    selectingRef.current = true;
    setSelection({ anchor: pt, focus: pt });
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragButtonRef.current >= 0 && reportMouseMove(e)) return;
      if (!selectingRef.current) return;
      const body = bodyRef.current;
      if (body) {
        const rect = body.getBoundingClientRect();
        if (e.clientY < rect.top) body.scrollTop -= Math.min(40, rect.top - e.clientY);
        else if (e.clientY > rect.bottom) body.scrollTop += Math.min(40, e.clientY - rect.bottom);
      }
      const pt = pointFromEvent(e);
      setSelection((prev) => (prev ? { anchor: prev.anchor, focus: pt } : prev));
    };
    const onUp = (e: MouseEvent) => {
      if (dragButtonRef.current >= 0) {
        const pressed = dragButtonRef.current;
        dragButtonRef.current = -1;
        lastMouseCellRef.current = "";
        const modes = emu.modes();
        if (modes.mouseTracking !== 0 && running) {
          const pt = pointFromEvent(e);
          const screenRow = Math.max(0, pt.row - emu.scrollbackLength());
          const encoded = encodeMouseEvent({
            button: mouseButton(pressed), col: pt.col + 1, row: screenRow + 1, kind: "up",
          }, { mouseTracking: modes.mouseTracking, mouseSgr: modes.mouseSgr });
          if (encoded) send(encoded);
        }
      }
      if (!selectingRef.current) return;
      selectingRef.current = false;
      setSelection((prev) => {
        if (!prev) return prev;
        if (prev.anchor.row === prev.focus.row && prev.anchor.col === prev.focus.col) return null;
        return prev;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emu, running, send]);

  const onWheel = (e: React.WheelEvent) => {
    const modes = emu.modes();
    // wheel → mouse report when the app tracks the mouse
    if (modes.mouseTracking !== 0 && running && !e.shiftKey) {
      const pt = pointFromEvent(e);
      const screenRow = Math.max(0, pt.row - emu.scrollbackLength());
      const encoded = encodeMouseEvent({
        button: e.deltaY < 0 ? 64 : 65,
        col: pt.col + 1, row: screenRow + 1, kind: "wheel",
      }, { mouseTracking: modes.mouseTracking, mouseSgr: modes.mouseSgr });
      if (encoded) { send(encoded); e.preventDefault(); }
      return;
    }
    // alt screen without scrollback: convert wheel to arrow keys (less/vim)
    if (modes.altScreen && running) {
      e.preventDefault();
      const lines = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40)));
      const seq = e.deltaY < 0
        ? (modes.appCursorKeys ? "\x1bOA" : "\x1b[A")
        : (modes.appCursorKeys ? "\x1bOB" : "\x1b[B");
      send(seq.repeat(lines));
    }
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const tracking = emu.modes().mouseTracking !== 0;
    if (tracking && !e.shiftKey) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    setContextMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 152)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 126)),
    });
  };

  // ---- focus reporting ----
  const onFocus = () => {
    setFocused(true);
    if (emu.modes().focusReporting && running) send("\x1b[I");
  };
  const onBlur = () => {
    setFocused(false);
    if (emu.modes().focusReporting && running) send("\x1b[O");
  };

  const focusMobileKeyboard = (pointerType: string) => {
    if (pointerType !== "touch") return;
    mobileInputRef.current?.focus({ preventScroll: true });
  };

  const sendMobileKey = (key: "ArrowUp" | "ArrowDown") => {
    if (!running) return;
    const bytes = keyEventToBytes({
      key,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
    }, { appCursorKeys: emu.modes().appCursorKeys });
    if (!bytes) return;
    send(bytes);
    scrollToBottom();
    mobileInputRef.current?.focus({ preventScroll: true });
  };

  // ---- render ----
  const cursor = emu.cursor();
  const modes = emu.modes();
  const sbLen = emu.scrollbackLength();
  const totalRows = emu.bufferLength();
  const totalHeight = totalRows * cell.h;
  const visibleCount = Math.ceil(viewportH / cell.h);
  const start = Math.max(0, firstRow - OVERSCAN);
  const end = Math.min(totalRows, firstRow + visibleCount + OVERSCAN);

  const rowsOut: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const line = emu.line(i);
    if (!line) continue;
    rowsOut.push(
      <TermRow
        key={i}
        line={line}
        rev={line.rev}
        top={i * cell.h}
        cellW={cell.w}
        cellH={cell.h}
        sel={selRangeForRow(selection, i, emu.cols())}
        matches={matchesByRow.get(i)}
        currentMatch={current}
      />,
    );
  }

  const cursorRow = sbLen + cursor.y;
  const showCursor = cursor.visible && running && cursorRow >= start && cursorRow < end;

  return (
    <div className={`term-pane${bell ? " bell" : ""}`}>
      {searchOpen && (
        <div className="term-search" onKeyDown={(e) => e.stopPropagation()}>
          <TextInput
            uiSize="sm"
            ref={searchInputRef}
            value={query}
            autoFocus
            placeholder={tr("terminalview.find")}
            aria-label={tr("terminalview.findInTerminal")}
            className={query && matches.length === 0 ? "no-match" : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length > 0) {
                e.preventDefault();
                gotoMatch(e.shiftKey
                  ? (current - 1 + matches.length) % matches.length
                  : (current + 1) % matches.length);
              }
              if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
            }}
          />
          <span className="term-search-count">
            {query ? (matches.length > 0 ? `${current + 1}/${matches.length}` : "0") : ""}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={caseSensitive}
            title={tr("terminalview.matchCase")}
            aria-label={tr("terminalview.matchCase")}
            onClick={() => setCaseSensitive((v) => !v)}
          >Aa</Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={useRegex}
            title={tr("terminalview.useRegularExpression")}
            aria-label={tr("terminalview.useRegularExpression")}
            onClick={() => setUseRegex((v) => !v)}
          >.*</Button>
          <IconButton
            icon={ChevronUpIcon}
            size="sm"
            variant="ghost"
            title={tr("terminalview.previousMatchShortcut")}
            label={tr("terminalview.previousMatch")}
            disabled={matches.length === 0}
            onClick={() => gotoMatch((current - 1 + matches.length) % matches.length)}
          />
          <IconButton
            icon={ChevronDownIcon}
            size="sm"
            variant="ghost"
            title={tr("terminalview.nextMatchShortcut")}
            label={tr("terminalview.nextMatch")}
            disabled={matches.length === 0}
            onClick={() => gotoMatch((current + 1) % matches.length)}
          />
          <IconButton
            icon={CloseIcon}
            size="sm"
            variant="ghost"
            title={tr("terminalview.closeSearchShortcut")}
            label={tr("terminalview.closeSearch")}
            onClick={closeSearch}
          />
        </div>
      )}

      <div
        ref={bodyRef}
        className={`term-body${modes.reverseVideo ? " reverse" : ""}`}
        tabIndex={0}
        role="application"
        aria-label={tr("terminalview.terminalValue", { title: label })}
        onPointerDown={(e) => focusMobileKeyboard(e.pointerType)}
        onKeyDown={onKeyDown}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
        onScroll={onScroll}
        onMouseDown={onMouseDown}
        onMouseMove={(e) => {
          if (reportMouseMove(e)) e.preventDefault();
        }}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <div ref={sizerRef} className="term-sizer" style={{ height: totalHeight }}>
          {rowsOut}
          {showCursor && (
            <div
              className={[
                "term-cursor",
                cursor.style === "bar" ? "style-bar" : cursor.style === "underline" ? "style-underline" : "",
                cursor.blink && focused ? "blink" : "",
                focused ? "" : "unfocused",
              ].filter(Boolean).join(" ")}
              style={{
                top: cursorRow * cell.h,
                left: cursor.x * cell.w,
                width: cell.w,
                height: cell.h,
              }}
            />
          )}
        </div>
      </div>

      <input
        ref={mobileInputRef}
        className="term-mobile-input"
        aria-label={tr("terminalview.terminalValue", { title: label })}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        inputMode="text"
        spellCheck={false}
        tabIndex={-1}
        onInput={onMobileInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionEnd={onCompositionEnd}
        onFocus={onFocus}
        onBlur={onBlur}
      />

      <div className="term-mobile-controls" role="toolbar" aria-label={tr("terminalview.terminalValue", { title: label })}>
        <IconButton
          icon={CopyIcon}
          size="sm"
          variant="ghost"
          label={tr("terminalview.copy")}
          title={tr("terminalview.copy")}
          onClick={() => { void copyTerminalText(); }}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            pasteFromClipboard();
            mobileInputRef.current?.focus({ preventScroll: true });
          }}
        >{tr("terminalview.paste")}</Button>
        <IconButton
          icon={ChevronUpIcon}
          size="sm"
          variant="ghost"
          label={tr("terminalview.previousMatch")}
          title={tr("terminalview.previousMatch")}
          disabled={!running}
          onClick={() => sendMobileKey("ArrowUp")}
        />
        <IconButton
          icon={ChevronDownIcon}
          size="sm"
          variant="ghost"
          label={tr("terminalview.nextMatch")}
          title={tr("terminalview.nextMatch")}
          disabled={!running}
          onClick={() => sendMobileKey("ArrowDown")}
        />
      </div>

      {contextMenu && (
        <div
          className="term-context"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            disabled={!selection}
            onClick={() => {
              void copySelection();
              setContextMenu(null);
              bodyRef.current?.focus();
            }}
          >{tr("terminalview.copy")} <kbd>Ctrl+Shift+C</kbd></button>
          <button
            role="menuitem"
            onClick={() => {
              pasteFromClipboard();
              setContextMenu(null);
              bodyRef.current?.focus();
            }}
          >{tr("terminalview.paste")} <kbd>Ctrl+Shift+V</kbd></button>
          <button
            role="menuitem"
            onClick={() => {
              setSelection({
                anchor: { row: 0, col: 0 },
                focus: { row: Math.max(0, emu.bufferLength() - 1), col: emu.cols() },
              });
              setContextMenu(null);
              bodyRef.current?.focus();
            }}
          >{tr("terminalview.selectAll")}</button>
        </div>
      )}

      {behind && !followRef.current && (
        <Button
          size="sm"
          iconStart={ChevronDownIcon}
          className="term-follow"
          onClick={scrollToBottom}
          title={tr("terminalview.scrollToBottomShortcut")}
        >
          {tr("terminalview.newOutput")}
        </Button>
      )}
      {!running && (
        <span className="term-exit-note">
          {props.exitCode !== undefined && props.exitCode !== null
            ? tr("terminalview.processExitedCodeValue", { code: props.exitCode })
            : tr("terminalview.processExited")}
        </span>
      )}
    </div>
  );
}
