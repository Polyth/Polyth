// Terminal render surface: virtualized row rendering over the emulator's
// cell grid, custom selection, search-in-terminal, link detection, cursor
// overlay, scroll-follow UX, keyboard/mouse/paste encoding, and resize.
// The emulator instance lives outside React (owned by TerminalView); this
// component only subscribes to its update events and reads snapshots.
//
// Touch devices get a Termux-style terminal: sticky-modifier extra keys,
// live software-keyboard echo, long-press selection with handles, pinch zoom,
// swipe-to-scroll in full-screen apps, a text-input row and a session/actions
// menu.
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type ClipboardEvent as ReactClipboardEvent, type CompositionEvent as ReactCompositionEvent,
  type PointerEvent as ReactPointerEvent, type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import {
  ATTR_BLINK, ATTR_BOLD, ATTR_DIM, ATTR_HIDDEN, ATTR_INVERSE, ATTR_ITALIC,
  ATTR_OVERLINE, ATTR_STRIKE, ATTR_UNDERLINE, lineInfo,
  type TermLine, type TermPoint, type TerminalEmulator,
} from "./terminal/emulator.ts";
import { cellColorCss } from "./terminal/palette.ts";
import { encodeMouseEvent, encodePaste, keyEventToBytes } from "./terminal/keymap.ts";
import { collectUrls, detectLinks } from "./terminal/linkify.ts";
import { searchBuffer, type TermMatch } from "./terminal/search.ts";
import { measureTerminalGrid } from "./terminal/measurement.ts";
import {
  consumeModifiers, encodeExtraKey, encodeTypedText, fnLayerAction, hasModifiers, layoutFor,
  NO_MODIFIERS, toggleModifier, withModifiers,
  type ExtraKeyAction, type ModifierName, type Modifiers, type SpokenKey, type TouchCommand,
} from "./terminal/extraKeys.ts";
import { createImeBridge, IME_SENTINEL } from "./terminal/imeBridge.ts";
import { loadKeyboardLayoutMap, macOptionPlatform } from "./terminal/keyboardLayout.ts";
import { clampFontSize, updateTouchPrefs, useTouchPrefs } from "./terminal/touchPrefs.ts";
import {
  extendFromWord, LONG_PRESS_MS, moveSelectionEdge, orderedSelection, PRESS_SLOP_PX,
  type OrderedSelection, type TermSelection,
} from "./terminal/touchSelection.ts";
import ExtraKeysBar from "./ExtraKeysBar.tsx";
import { ExtraKeysEditor, UrlSheet } from "./TouchTerminalDialogs.tsx";
import { copyText } from "../../../apps/web/src/utils.ts";
import { getDragResource, resourceShellPath, RESOURCE_MIME } from "../../../apps/web/src/dnd.ts";
import { hapticFeedback } from "../../../apps/web/src/haptics.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  IconButton,
  KeyboardIcon,
  Menu,
  MoreIcon,
  SendIcon,
  TextInput,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";

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

type Selection = TermSelection;

/** Room above the start handle and below the end handle for the knob (styles.css matches). */
const HANDLE_KNOB_PX = 18;
/** How long the selection bar says "Copied" before the selection clears. */
const COPY_FLASH_MS = 700;
/** Quiet time after scrolling before the selection bar comes back. */
const BAR_SETTLE_MS = 180;

/** Touch selection chrome (handles, action bar) handles its own input. */
const selectionUiTarget = (target: EventTarget | null): boolean => {
  const element = target as Element | null;
  return typeof element?.closest === "function" && element.closest("[data-term-select-ui]") !== null;
};

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
  /** Hidden package windows keep ingesting output without resizing the PTY. */
  visible?: boolean;
  /** Increment to open the search bar from outside (toolbar button). */
  searchSignal?: number;
  /** Sibling terminals for the touch menu (Termux's session drawer). */
  sessions?: readonly TouchSession[];
  activeSessionId?: string;
  onSelectSession?: (id: string) => void;
  onNewSession?: () => void;
  onCloseSession?: () => void;
}

export interface TouchSession { id: string; title: string; running: boolean }

const SPOKEN_KEYS: Record<SpokenKey, Parameters<typeof tr>[0]> = {
  up: "terminalview.keyUp",
  down: "terminalview.keyDown",
  left: "terminalview.keyLeft",
  right: "terminalview.keyRight",
  backspace: "terminalview.keyBackspace",
  delete: "terminalview.keyDelete",
  enter: "terminalview.keyEnter",
  space: "terminalview.keySpace",
  keyboard: "terminalview.toggleKeyboard",
  drawer: "terminalview.sessionsAndActions",
  paste: "terminalview.paste",
  textInput: "terminalview.textInput",
};

/** A program that owns the screen gets touch drags as scroll input. */
const appOwnsTouchScroll = (modes: { altScreen: boolean; mouseTracking: number }): boolean =>
  modes.altScreen || modes.mouseTracking !== 0;

const BELL_VIBRATE_INTERVAL_MS = 1000;
const MAX_SCROLL_STEPS = 10;

interface WakeLockHandle { release(): Promise<void> }
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockHandle> } };

export default function TermPane(props: TermPaneProps) {
  const { emu, label, running, send, onResize, visible = true } = props;
  const bodyRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // A focusable div receives hardware keys, but mobile browsers do not open
  // their software keyboard for it. Keep a visually inert native input solely
  // as the mobile IME bridge; terminal output and selection remain in bodyRef.
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const touchInputRef = useRef(false);
  const [touchInput, setTouchInput] = useState(false);

  const [, setTick] = useState(0);
  const [searchEpoch, setSearchEpoch] = useState(0);
  const [cell, setCell] = useState<CellSize>(FALLBACK_CELL);
  const [viewportH, setViewportH] = useState(400);
  const [firstRow, setFirstRow] = useState(0);
  const [focused, setFocused] = useState(false);
  const [bell, setBell] = useState(false);
  const [behind, setBehind] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  // A selection made by touch shows handles and the action bar: "adjusting"
  // while a finger extends it or drags a handle, "settled" once it lifts.
  const [touchSelection, setTouchSelection] = useState<"adjusting" | "settled" | null>(null);
  const [selectionBarSettled, setSelectionBarSettled] = useState(true);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const selectBarRef = useRef<HTMLDivElement>(null);
  const selectBarTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyFlashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleDragRef = useRef<{ edge: "start" | "end"; pointerId: number; dx: number; dy: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [current, setCurrent] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);

  // ---- touch terminal state ----
  const prefs = useTouchPrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const layout = useMemo(() => layoutFor(prefs.extraKeys), [prefs.extraKeys]);
  const [mods, setModsState] = useState<Modifiers>(NO_MODIFIERS);
  const modsRef = useRef(mods);
  const setMods = useCallback((next: Modifiers) => { modsRef.current = next; setModsState(next); }, []);
  const imeRef = useRef(createImeBridge());
  const [textInputOpen, setTextInputOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const textInputRef = useRef<HTMLInputElement>(null);
  const [touchMenuOpen, setTouchMenuOpen] = useState(false);
  // Latched when the menu opens (see openTouchMenu) and not re-derived while
  // it is open, so the surface never swaps under a finger.
  const [touchMenuPresentation, setTouchMenuPresentation] = useState<"sheet" | "popover">("sheet");
  const touchMenuReturnRef = useRef<HTMLElement | null>(null);
  // Captured when the menu opens, so its Copy label and action agree.
  const [menuSelection, setMenuSelection] = useState("");
  const [urls, setUrls] = useState<string[] | null>(null);
  const [editingKeys, setEditingKeys] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const runningRef = useRef(running);
  runningRef.current = running;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const suppressTapRef = useRef(false);
  const lastBellVibrateRef = useRef(0);
  // The active keyboard layout, for the macOS Option rule: Option that composed
  // a symbol the key does not type on its own is a consumed modifier, not Meta.
  const layoutMapRef = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadKeyboardLayoutMap().then((map) => { if (alive) layoutMapRef.current = map; });
    return () => { alive = false; };
  }, []);

  const followRef = useRef(true);
  // The parent counter survives tab/session changes. Its current value at
  // mount is old history, not a request to reopen search in this pane.
  const lastSearchSignal = useRef(props.searchSignal ?? 0);
  const selectingRef = useRef(false);
  const dragButtonRef = useRef(-1);
  const lastMouseCellRef = useRef("");
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const cellRef = useRef(cell);
  cellRef.current = cell;

  // focus the surface whenever a tab pane mounts (tab switch / first open)
  useEffect(() => {
    if (visible) bodyRef.current?.focus();
  }, [visible]);

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
      // Termux vibrates on BEL. Throttled: a program can ring in a loop.
      const now = Date.now();
      if (touchInputRef.current && visibleRef.current && prefsRef.current.bellVibrate
        && now - lastBellVibrateRef.current >= BELL_VIBRATE_INTERVAL_MS) {
        lastBellVibrateRef.current = now;
        hapticFeedback("warning");
      }
    });
    return () => {
      sub.dispose();
      bellSub.dispose();
      if (pending) caf(pending);
      if (searchTimer) clearTimeout(searchTimer);
    };
  }, [emu]);

  // ---- measurement + resize ----
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const resizeTerminal = () => {
      // A kept-alive workspace pane is briefly 0×0 while opening. Resizing
      // during that frame permanently wraps shell output at two columns.
      const measurement = measureTerminalGrid(bodyRef.current, measureRef.current);
      if (!measurement) return;
      const { w, h, cols, rows, viewportHeight } = measurement;
      const next = { w, h };
      cellRef.current = next;
      setCell((prev) => (Math.abs(prev.w - w) > 0.01 || Math.abs(prev.h - h) > 0.01 ? next : prev));
      setViewportH(viewportHeight);
      if (cols !== emu.cols() || rows !== emu.rows()) {
        emu.resize(cols, rows);
        onResize(cols, rows);
      }
    };
    const scheduleResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(resizeTerminal, 80);
    };
    // A pane can mount while its parent is transitioning from hidden to
    // visible. Retry after layout even when ResizeObserver has only observed
    // the hidden 0×0 box.
    resizeTerminal();
    frame = raf(resizeTerminal);
    const ro = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleResize);
    ro?.observe(body);
    // Font loading and terminal font preferences can change glyph dimensions
    // without changing the pane's box. Observe the actual measurement too.
    if (measureRef.current) ro?.observe(measureRef.current);
    window.addEventListener("resize", scheduleResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", scheduleResize);
      if (frame) caf(frame);
      if (timer) clearTimeout(timer);
    };
  }, [emu, onResize, visible]);

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
    // The selection bar steps aside while the output scrolls and returns
    // beside the selection once it settles, like a platform edit menu.
    if (touchSelection) {
      setSelectionBarSettled(false);
      clearTimeout(selectBarTimerRef.current);
      selectBarTimerRef.current = setTimeout(() => setSelectionBarSettled(true), BAR_SETTLE_MS);
    }
  };

  // ---- search ----
  useEffect(() => {
    const signal = props.searchSignal ?? 0;
    const requested = signal > lastSearchSignal.current;
    lastSearchSignal.current = signal;
    if (!requested) return;
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.select(), 0);
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
  // Mouse and touch both select through the terminal's own cell selection,
  // never the browser's: the copied text follows the grid (wrapped rows join).
  const selectedText = useCallback((): string => {
    if (!selection) return "";
    return emu.getText(selection.anchor, selection.focus);
  }, [selection, emu]);

  const copySelection = useCallback((): Promise<boolean> => {
    const text = selectedText();
    return text ? copyText(text) : Promise.resolve(false);
  }, [selectedText]);

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
  };

  // ---- touch input pipeline ----
  const deliver = useCallback((bytes: string) => {
    if (!bytes || !runningRef.current) return;
    send(bytes);
    scrollToBottom();
  }, [send, scrollToBottom]);

  const resetMobileInput = (input: HTMLInputElement) => {
    input.value = IME_SENTINEL;
    try { input.setSelectionRange(IME_SENTINEL.length, IME_SENTINEL.length); } catch { /* detached */ }
    imeRef.current.reset();
  };

  const keymapState = () => ({
    appCursorKeys: emu.modes().appCursorKeys,
    macOption: macOptionPlatform(),
    layoutMap: layoutMapRef.current,
  });

  const focusMobileInput = useCallback(() => {
    const input = mobileInputRef.current;
    if (!input) return;
    if (!input.value.startsWith(IME_SENTINEL)) resetMobileInput(input);
    input.focus({ preventScroll: true });
  }, []);

  const toggleKeyboard = () => {
    const input = mobileInputRef.current;
    if (input && document.activeElement === input) {
      input.blur();
      bodyRef.current?.focus({ preventScroll: true });
    } else {
      focusMobileInput();
    }
  };

  const extraKeysShown = (): boolean => prefsRef.current.extraKeysVisible === "on"
    || (prefsRef.current.extraKeysVisible === "auto"
      && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);

  /** The pane's own input that currently holds the software keyboard, if any. */
  const keyboardInput = (): HTMLElement | null => {
    const active = document.activeElement;
    return active !== null && (active === mobileInputRef.current || active === textInputRef.current)
      ? active as HTMLElement
      : null;
  };

  const openTextInput = (open: boolean) => {
    if (!open) {
      // Hand the keyboard to the terminal input before the row's own field is
      // unmounted, so it is never left without an input to attach to.
      focusMobileInput();
      flushSync(() => setTextInputOpen(false));
      return;
    }
    // Focus inside the same gesture so iOS raises the keyboard for the row.
    flushSync(() => setTextInputOpen(true));
    textInputRef.current?.focus({ preventScroll: true });
  };

  const openTouchMenu = () => {
    setMenuSelection(selectedText());
    // A phone sheet is modal and claims focus, which takes the software
    // keyboard down. Over a live keyboard the menu is an anchored popover
    // instead: focus stays on the input and returns to it when the menu closes.
    const typing = keyboardInput();
    touchMenuReturnRef.current = typing ?? bodyRef.current;
    setTouchMenuPresentation(typing ? "popover" : "sheet");
    setTouchMenuOpen(true);
  };

  const runCommands = (commands: readonly TouchCommand[]) => {
    for (const command of commands) {
      if (command === "keyboard") toggleKeyboard();
      else if (command === "drawer") openTouchMenu();
      else if (command === "paste") pasteFromClipboard();
      else if (command === "text-input") openTextInput(!textInputOpen);
      else if (command === "toggle-extra-keys") updateTouchPrefs({ extraKeysVisible: extraKeysShown() ? "off" : "on" });
    }
  };

  const onExtraKey = (action: ExtraKeyAction) => {
    const encoded = encodeExtraKey(action, modsRef.current, keymapState());
    if (selection) setSelection(null);
    deliver(encoded.bytes);
    if (action.kind !== "command") setMods(consumeModifiers(modsRef.current));
    runCommands(encoded.commands);
  };

  const onModifier = (modifier: ModifierName, lock: boolean) => {
    setMods(toggleModifier(modsRef.current, modifier, lock));
  };

  /** Apply one value change of the hidden input to the PTY. */
  const applyMobileInput = (input: HTMLInputElement, composing: boolean) => {
    const edit = imeRef.current.update(input.value, composing);
    let bytes = "\x7f".repeat(edit.deletes);
    let forceReset = false;
    if (edit.insert) {
      const sticky = modsRef.current;
      const typed = encodeTypedText(edit.insert.replace(/\r?\n/g, "\r"), sticky, keymapState());
      bytes += typed.bytes;
      if (hasModifiers(sticky)) {
        setMods(consumeModifiers(sticky));
        // The keyboard still believes it typed a plain letter; restart it so
        // a later Backspace does not erase a character the shell never got.
        forceReset = true;
      }
      if (typed.commands.length > 0) runCommands(typed.commands);
    }
    if (selection && bytes) setSelection(null);
    deliver(bytes);
    if (edit.reset || forceReset) resetMobileInput(input);
  };

  const onMobileInput = (e: React.FormEvent<HTMLInputElement>) => {
    applyMobileInput(e.currentTarget, Boolean((e.nativeEvent as InputEvent).isComposing));
  };

  const onMobileCompositionEnd = (e: ReactCompositionEvent<HTMLInputElement>) => {
    applyMobileInput(e.currentTarget, false);
  };

  const submitTextInput = () => {
    deliver(`${textDraft}\r`);
    setTextDraft("");
  };

  const bufferText = (): string => {
    const lastRow = emu.bufferLength() - 1;
    return lastRow < 0 ? "" : emu.getText({ row: 0, col: 0 }, { row: lastRow, col: emu.cols() });
  };

  const shareTranscript = () => {
    const text = bufferText().trimEnd();
    if (!text) return;
    const share = (navigator as Navigator & { share?: (data: { title?: string; text: string }) => Promise<void> }).share;
    if (typeof share === "function") {
      void share.call(navigator, { title: label, text }).catch(() => {});
      return;
    }
    void copyText(text);
  };

  const showUrls = () => {
    setUrls(collectUrls(
      (row) => emu.rowInfo(row).text,
      (row) => emu.line(row)?.wrapped ?? false,
      emu.bufferLength(),
    ));
  };

  const currentFontSize = (): number => {
    if (prefsRef.current.fontSize) return prefsRef.current.fontSize;
    const body = bodyRef.current;
    const px = body ? parseFloat(getComputedStyle(body).fontSize) : NaN;
    return Number.isFinite(px) && px > 0 ? px : 14;
  };

  const zoom = (delta: number) => updateTouchPrefs({ fontSize: clampFontSize(currentFontSize() + delta) });

  const resetTerminal = () => {
    emu.reset();
    setSelection(null);
    setMods(NO_MODIFIERS);
    // Ask the foreground program to redraw (readline, vim and most TUIs).
    deliver("\x0c");
  };

  // ---- keyboard ----
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
    if (contextMenu) setContextMenu(null);
    const ctrl = e.ctrlKey;
    const shift = e.shiftKey;
    const meta = e.metaKey;

    // find
    if ((ctrl || meta) && !shift && e.key.toLowerCase() === "f") {
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
    if (ctrl && !shift && !meta && e.key.toLowerCase() === "c" && selectedText()) {
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
    // Sticky extra-key modifiers apply to the next hardware or iOS soft key.
    const sticky = modsRef.current;
    if (hasModifiers(sticky) && !["Control", "Alt", "Shift", "Meta", "Unidentified", "Process", "Dead"].includes(e.key)) {
      const fn = sticky.fn !== 0 ? fnLayerAction(e.key) : null;
      const encoded = fn
        ? encodeExtraKey(fn, { ...sticky, fn: 0 }, keymapState())
        : e.key.length === 1
          ? encodeTypedText(e.key, sticky, keymapState())
          : { bytes: keyEventToBytes(withModifiers(e, sticky), keymapState()) ?? "", commands: [] };
      if (encoded.bytes || encoded.commands.length > 0) {
        e.preventDefault();
        if (selection) setSelection(null);
        setMods(consumeModifiers(sticky));
        deliver(encoded.bytes);
        runCommands(encoded.commands);
        return;
      }
    }
    const bytes = keyEventToBytes(e, keymapState());
    if (bytes !== null) {
      e.preventDefault();
      if (selection) setSelection(null);
      send(bytes);
      scrollToBottom();
    }
  };

  // ---- mouse ----
  /**
   * The grid point under a pointer. `mouse` keeps the desktop drag's bias,
   * `cell` is the cell under a finger and `edge` the nearest cell boundary
   * (where a dragged selection end lands).
   */
  const pointFromEvent = (
    e: { clientX: number; clientY: number },
    kind: "mouse" | "cell" | "edge" = "mouse",
  ): TermPoint => {
    const sizer = sizerRef.current;
    const c = cellRef.current;
    if (!sizer) return { row: 0, col: 0 };
    const rect = sizer.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const row = Math.max(0, Math.min(Math.floor(py / c.h), emu.bufferLength() - 1));
    const col = kind === "cell"
      ? Math.max(0, Math.min(Math.floor(px / c.w), emu.cols() - 1))
      : Math.max(0, Math.min(Math.round(kind === "edge" ? px / c.w : px / c.w - 0.3), emu.cols()));
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

  const wordRangeAt = (pt: TermPoint): OrderedSelection | null => {
    const info = emu.rowInfo(pt.row);
    const line = emu.line(pt.row);
    if (!line) return null;
    // column → text index
    let idx = pt.col;
    if (info.map) {
      idx = 0;
      while (idx < info.map.length - 1 && info.map[idx]! < pt.col) idx++;
    }
    idx = Math.min(idx, Math.max(0, info.text.length - 1));
    if (!WORD_RE.test(info.text[idx] ?? "")) return null;
    let s = idx;
    let e = idx;
    while (s > 0 && WORD_RE.test(info.text[s - 1]!)) s--;
    while (e < info.text.length - 1 && WORD_RE.test(info.text[e + 1]!)) e++;
    const colOf = (i: number) => (info.map ? info.map[i]! : i);
    return {
      start: { row: pt.row, col: colOf(s) },
      end: { row: pt.row, col: info.map ? (info.map[e + 1] ?? emu.cols()) : e + 1 },
    };
  };

  const selectWordAt = (pt: TermPoint) => {
    const word = wordRangeAt(pt);
    if (word) setSelection({ anchor: word.start, focus: word.end });
  };

  /** What a long press selects: the word under the finger, else that one character. */
  const touchRangeAt = (pt: TermPoint): OrderedSelection | null => {
    const word = wordRangeAt(pt);
    if (word) return word;
    const chars = emu.line(pt.row)?.chars;
    if (!chars) return null;
    let col = Math.min(pt.col, chars.length - 1);
    while (col > 0 && chars[col] === "") col--; // a wide character's head
    if (!chars[col] || chars[col] === " ") return null;
    let end = col + 1;
    while (end < chars.length && chars[end] === "") end++;
    return { start: { row: pt.row, col }, end: { row: pt.row, col: end } };
  };

  /** Scroll the output while a selection end is dragged past its top or bottom edge. */
  const autoScrollSelection = (clientY: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const h = cellRef.current.h;
    const step = (distance: number) => Math.max(h / 2, Math.min(h * 2, distance));
    if (clientY < rect.top) {
      followRef.current = false;
      body.scrollTop -= step(rect.top - clientY);
    } else if (clientY > rect.bottom) {
      body.scrollTop += step(clientY - rect.bottom);
    }
  };

  // Long press, extend and settle, called from the native touch listeners.
  const touchSelectionActions = {
    begin: (at: { clientX: number; clientY: number }): OrderedSelection | null => {
      const word = touchRangeAt(pointFromEvent(at, "cell"));
      if (!word) return null;
      setContextMenu(null);
      setCopiedFlash(false);
      setSelection({ anchor: word.start, focus: word.end });
      setTouchSelection("adjusting");
      hapticFeedback("selection");
      return word;
    },
    extend: (word: OrderedSelection, at: { clientX: number; clientY: number }) => {
      autoScrollSelection(at.clientY);
      setSelection(extendFromWord(word, pointFromEvent(at, "edge")));
    },
    settle: () => setTouchSelection((phase) => (phase ? "settled" : phase)),
  };
  const touchSelectionRef = useRef(touchSelectionActions);
  touchSelectionRef.current = touchSelectionActions;

  // Typing, a tap or Escape clears the selection; its touch chrome goes too.
  useEffect(() => {
    if (!selection) setTouchSelection(null);
  }, [selection]);

  useEffect(() => () => {
    clearTimeout(selectBarTimerRef.current);
    clearTimeout(copyFlashTimerRef.current);
  }, []);

  const startHandleDrag = (edge: "start" | "end") => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const sizer = sizerRef.current;
    if (!selection || !sizer) return;
    const point = orderedSelection(selection)[edge];
    const rect = sizer.getBoundingClientRect();
    const c = cellRef.current;
    // Keep the finger's offset from the line it holds, so the end follows the
    // line under the knob rather than the row under the fingertip.
    handleDragRef.current = {
      edge,
      pointerId: event.pointerId,
      dx: event.clientX - (rect.left + point.col * c.w),
      dy: event.clientY - (rect.top + (point.row + 0.5) * c.h),
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    setTouchSelection("adjusting");
  };

  const moveHandle = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = handleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !selection) return;
    event.preventDefault();
    autoScrollSelection(event.clientY);
    const point = pointFromEvent({ clientX: event.clientX - drag.dx, clientY: event.clientY - drag.dy }, "edge");
    const next = moveSelectionEdge(orderedSelection(selection), drag.edge, point, emu.cols());
    setSelection({ anchor: next.start, focus: next.end });
  };

  const endHandleDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (handleDragRef.current?.pointerId !== event.pointerId) return;
    handleDragRef.current = null;
    setTouchSelection("settled");
  };

  const copyTouchSelection = () => {
    const copied = selection;
    const text = selectedText();
    if (!copied || !text) return;
    void copyText(text).then((ok) => {
      hapticFeedback(ok ? "success" : "error");
      if (!ok) return;
      setCopiedFlash(true);
      clearTimeout(copyFlashTimerRef.current);
      copyFlashTimerRef.current = setTimeout(() => {
        setCopiedFlash(false);
        // Only the selection that was copied; a newer one stays.
        setSelection((current) => (current === copied ? null : current));
      }, COPY_FLASH_MS);
    });
  };

  const selectAllTouch = () => {
    setCopiedFlash(false);
    setSelection({
      anchor: { row: 0, col: 0 },
      focus: { row: Math.max(0, emu.bufferLength() - 1), col: emu.cols() },
    });
    setTouchSelection("settled");
  };

  const pasteFromSelectionBar = () => {
    setSelection(null);
    pasteFromClipboard();
  };

  // The selection bar sits above the selection, else below it, else at the
  // top of the visible output; centred over a one-row selection and kept
  // inside the output's width.
  useLayoutEffect(() => {
    const bar = selectBarRef.current;
    const body = bodyRef.current;
    const sizer = sizerRef.current;
    if (!bar || !body || !sizer || !selection) return;
    const { start, end } = orderedSelection(selection);
    const c = cellRef.current;
    const viewTop = body.getBoundingClientRect().top - sizer.getBoundingClientRect().top;
    const viewBottom = viewTop + body.clientHeight;
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const gap = HANDLE_KNOB_PX + 6;
    const above = start.row * c.h - gap - height;
    const below = (end.row + 1) * c.h + gap;
    const y = above >= viewTop + 4 ? above
      : below + height <= viewBottom - 4 ? below
        : viewTop + 8;
    const center = start.row === end.row ? ((start.col + end.col) / 2) * c.w : sizer.clientWidth / 2;
    const x = Math.max(0, Math.min(center - width / 2, sizer.clientWidth - width));
    const top = Math.max(0, Math.min(y, sizer.offsetHeight - height));
    bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(top)}px)`;
  });

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (selectionUiTarget(e.target)) return;
    // Touch generates compatibility mouse events. Touch selection is the long
    // press, never a mouse drag, and the tap's click decides focus itself, so
    // a touch never moves focus off the keyboard's input here.
    if (touchInputRef.current) {
      e.preventDefault();
      return;
    }
    if (contextMenu) setContextMenu(null);
    setTouchSelection(null);
    bodyRef.current?.focus({ preventScroll: true });
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

  /** Scroll a screen-owning program: `lines` < 0 is up (earlier content). */
  const scrollApp = (lines: number, at: { clientX: number; clientY: number }) => {
    const modes = emu.modes();
    if (!runningRef.current || lines === 0) return;
    const count = Math.min(MAX_SCROLL_STEPS, Math.abs(lines));
    if (modes.mouseTracking !== 0) {
      const pt = pointFromEvent(at);
      const screenRow = Math.max(0, pt.row - emu.scrollbackLength());
      const encoded = encodeMouseEvent({
        button: lines < 0 ? 64 : 65,
        col: Math.min(pt.col + 1, emu.cols()), row: Math.min(screenRow + 1, emu.rows()), kind: "wheel",
      }, { mouseTracking: modes.mouseTracking, mouseSgr: modes.mouseSgr });
      if (encoded) send(encoded.repeat(count));
      return;
    }
    const seq = lines < 0
      ? (modes.appCursorKeys ? "\x1bOA" : "\x1b[A")
      : (modes.appCursorKeys ? "\x1bOB" : "\x1b[B");
    send(seq.repeat(count));
  };
  const scrollAppRef = useRef(scrollApp);
  scrollAppRef.current = scrollApp;

  // ---- touch gestures: long-press selection, pinch zoom, and drag-scroll
  // for screen-owning apps ----
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let pinch: { distance: number; size: number; last: number; view: HTMLElement } | null = null;
    let drag: { y: number; x: number; carry: number; moved: boolean } | null = null;
    // A still finger: it becomes a selection after LONG_PRESS_MS unless it
    // moves (a scroll or drag), lifts (a tap) or a second finger lands.
    let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
    // The long-pressed word while that finger stays down and extends it.
    let hold: OrderedSelection | null = null;
    const cancelPress = () => {
      if (!press) return;
      clearTimeout(press.timer);
      press = null;
    };
    const settleHold = () => {
      if (!hold) return;
      hold = null;
      touchSelectionRef.current.settle();
    };
    const spread = (touches: TouchList): number => {
      const a = touches[0]!;
      const b = touches[1]!;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onStart = (event: TouchEvent) => {
      cancelPress();
      settleHold();
      if (selectionUiTarget(event.target)) return;
      suppressTapRef.current = false;
      if (event.touches.length === 2) {
        drag = null;
        const size = parseFloat(getComputedStyle(body).fontSize) || 14;
        const view = (body.closest(".term-view") as HTMLElement | null) ?? (body.parentElement as HTMLElement);
        pinch = { distance: Math.max(1, spread(event.touches)), size, last: size, view };
        return;
      }
      if (event.touches.length === 1 && !pinch) {
        const touch = event.touches[0]!;
        drag = appOwnsTouchScroll(emu.modes()) && runningRef.current
          ? { y: touch.clientY, x: touch.clientX, carry: 0, moved: false }
          : null;
        const at = { clientX: touch.clientX, clientY: touch.clientY };
        press = {
          x: at.clientX,
          y: at.clientY,
          timer: setTimeout(() => {
            press = null;
            const word = touchSelectionRef.current.begin(at);
            if (!word) return;
            // The rest of this touch belongs to the selection: no tap, no
            // scroll report to a full-screen program.
            hold = word;
            drag = null;
            suppressTapRef.current = true;
          }, LONG_PRESS_MS),
        };
      }
    };
    const onMove = (event: TouchEvent) => {
      if (hold) {
        if (event.touches.length !== 1) return;
        if (event.cancelable) event.preventDefault();
        const touch = event.touches[0]!;
        touchSelectionRef.current.extend(hold, { clientX: touch.clientX, clientY: touch.clientY });
        return;
      }
      if (press && event.touches.length === 1) {
        const touch = event.touches[0]!;
        if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > PRESS_SLOP_PX) cancelPress();
      }
      if (pinch && event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        const next = clampFontSize(pinch.size * spread(event.touches) / pinch.distance);
        if (next !== pinch.last) {
          pinch.last = next;
          // Live preview; the preference commits once on release.
          pinch.view.style.setProperty("--terminal-font-size", `${next}px`);
        }
        return;
      }
      if (!drag || event.touches.length !== 1) return;
      if (event.cancelable) event.preventDefault();
      const touch = event.touches[0]!;
      drag.carry += touch.clientY - drag.y;
      drag.y = touch.clientY;
      drag.x = touch.clientX;
      const h = cellRef.current.h;
      const steps = Math.trunc(drag.carry / h);
      if (steps === 0) return;
      drag.carry -= steps * h;
      drag.moved = true;
      // Natural scrolling: dragging down reveals earlier content.
      scrollAppRef.current(-steps, { clientX: drag.x, clientY: drag.y });
    };
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length === 0) {
        cancelPress();
        settleHold();
      }
      if (pinch && event.touches.length < 2) {
        const { last, size, view } = pinch;
        pinch = null;
        suppressTapRef.current = true;
        if (last !== size) updateTouchPrefs({ fontSize: last });
        // A pinch that ends where it began drops its preview; a stale inline
        // size would shadow later Appearance changes.
        else if (prefsRef.current.fontSize === null) view.style.removeProperty("--terminal-font-size");
      }
      if (drag && event.touches.length === 0) {
        if (drag.moved) suppressTapRef.current = true;
        drag = null;
      }
    };
    body.addEventListener("touchstart", onStart, { passive: true });
    body.addEventListener("touchmove", onMove, { passive: false });
    body.addEventListener("touchend", onEnd);
    body.addEventListener("touchcancel", onEnd);
    return () => {
      cancelPress();
      body.removeEventListener("touchstart", onStart);
      body.removeEventListener("touchmove", onMove);
      body.removeEventListener("touchend", onEnd);
      body.removeEventListener("touchcancel", onEnd);
    };
  }, [emu]);

  // ---- keep screen on (Termux "Keep screen on") ----
  useEffect(() => {
    // Like Termux, the lock holds while the terminal is on screen.
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!keepAwake || !visible || !wakeLock) return;
    let handle: WakeLockHandle | null = null;
    let disposed = false;
    const acquire = (first: boolean) => {
      void wakeLock.request("screen").then((next) => {
        if (disposed) void next.release().catch(() => {});
        else handle = next;
      }).catch(() => {
        // Refused (battery saver, policy): do not show the option as on.
        if (first && !disposed) setKeepAwake(false);
      });
    };
    // The platform drops the lock whenever the page is hidden.
    const onVisibility = () => { if (document.visibilityState === "visible") acquire(false); };
    acquire(true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void handle?.release().catch(() => {});
    };
  }, [keepAwake, visible]);

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    // A long press selects through the terminal's own selection; the
    // platform's long-press callout would only compete with it.
    if (touchInputRef.current || selectionUiTarget(e.target)) {
      e.preventDefault();
      return;
    }
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
  const touchRange = touchSelection && selection ? orderedSelection(selection) : null;

  const sessions = props.sessions ?? [];
  const wakeLockSupported = typeof navigator !== "undefined" && Boolean((navigator as WakeLockNavigator).wakeLock);
  const fontSizeDetail = prefs.fontSize ? `${prefs.fontSize}px` : undefined;
  const touchMenuEntries: MenuEntry[] = [
    ...(sessions.length > 0 ? [
      { heading: tr("terminalview.sessions") },
      ...sessions.map((session): MenuEntry => ({
        id: `session:${session.id}`,
        label: session.title,
        kind: "radio",
        checked: session.id === props.activeSessionId,
        ...(session.running ? {} : { detail: tr("terminalview.exited") }),
        onSelect: () => props.onSelectSession?.(session.id),
      })),
    ] : []),
    ...(props.onNewSession ? [{ id: "new", label: tr("terminalview.newTerminal"), onSelect: () => props.onNewSession?.() }] : []),
    "separator",
    {
      id: "copy",
      label: menuSelection ? tr("terminalview.copy") : tr("terminalview.copyAll"),
      onSelect: () => { void copyText(menuSelection || bufferText()); },
    },
    { id: "paste", label: tr("terminalview.paste"), disabled: !running, onSelect: () => { pasteFromClipboard(); focusMobileInput(); } },
    { id: "urls", label: tr("terminalview.selectUrl"), onSelect: showUrls },
    { id: "share", label: tr("terminalview.shareTranscript"), onSelect: shareTranscript },
    { id: "find", label: tr("terminalview.findInTerminal"), onSelect: () => { setSearchOpen(true); } },
    "separator",
    { id: "text-input", label: tr("terminalview.textInput"), kind: "checkbox", checked: textInputOpen, onSelect: () => setTextInputOpen((open) => !open) },
    {
      id: "extra-keys",
      label: tr("terminalview.extraKeys"),
      kind: "checkbox",
      checked: prefs.extraKeysVisible !== "off",
      onSelect: () => updateTouchPrefs({ extraKeysVisible: prefs.extraKeysVisible === "off" ? "auto" : "off" }),
    },
    {
      id: "keep-awake",
      label: tr("terminalview.keepScreenOn"),
      kind: "checkbox",
      checked: keepAwake,
      disabled: !wakeLockSupported,
      onSelect: () => setKeepAwake((on) => !on),
    },
    {
      id: "bell",
      label: tr("terminalview.vibrateOnBell"),
      kind: "checkbox",
      checked: prefs.bellVibrate,
      onSelect: () => updateTouchPrefs({ bellVibrate: !prefs.bellVibrate }),
    },
    "separator",
    { id: "zoom-in", label: tr("terminalview.zoomIn"), ...(fontSizeDetail ? { detail: fontSizeDetail } : {}), onSelect: () => zoom(1) },
    { id: "zoom-out", label: tr("terminalview.zoomOut"), onSelect: () => zoom(-1) },
    { id: "zoom-reset", label: tr("terminalview.zoomReset"), disabled: prefs.fontSize === null, onSelect: () => updateTouchPrefs({ fontSize: null }) },
    "separator",
    { id: "edit-keys", label: tr("terminalview.editExtraKeys"), onSelect: () => setEditingKeys(true) },
    { id: "reset", label: tr("terminalview.resetTerminal"), onSelect: resetTerminal },
    ...(props.onCloseSession ? [{ id: "close", label: tr("terminalview.closeSession"), danger: true, onSelect: () => props.onCloseSession?.() }] : []),
  ];

  return (
    <div className={`term-pane${bell ? " bell" : ""}`} data-extra-keys={prefs.extraKeysVisible}>
      {searchOpen && (
        <div className="term-search ui-field-frame" onKeyDown={(e) => e.stopPropagation()}>
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
              if (isImeComposing(e)) return;
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
        className={`term-body${modes.reverseVideo ? " reverse" : ""}${touchInput ? " touch-input" : ""}${appOwnsTouchScroll(modes) && running ? " app-scroll" : ""}`}
        tabIndex={0}
        role="application"
        aria-label={tr("terminalview.terminalValue", { title: label })}
        onPointerDown={(e) => {
          if (selectionUiTarget(e.target)) return;
          const touch = e.pointerType === "touch";
          touchInputRef.current = touch;
          setTouchInput(touch);
          if (touch) setContextMenu(null);
        }}
        onClick={(e) => {
          if (selectionUiTarget(e.target)) return;
          // A long press, a pinch or an app-scroll drag ends without being a tap.
          if (suppressTapRef.current) { suppressTapRef.current = false; return; }
          if (!touchInputRef.current) return;
          // As on any selectable text, a tap first dismisses the selection.
          if (selection) { setSelection(null); return; }
          // A completed tap opens the keyboard, and still reaches a
          // mouse-tracking application as a click.
          if (running) {
            if (reportMouse(e, "down")) reportMouse(e, "up");
            focusMobileInput();
          } else if (!keyboardInput()) {
            bodyRef.current?.focus({ preventScroll: true });
          }
        }}
        onKeyDown={onKeyDown}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
        onDragOver={(event) => { if (running && event.dataTransfer.types.includes(RESOURCE_MIME)) event.preventDefault(); }}
        onDrop={(event) => {
          if (!running || !event.dataTransfer.types.includes(RESOURCE_MIME)) return;
          event.preventDefault();
          const ref = getDragResource(event.dataTransfer);
          const path = ref && resourceShellPath(ref);
          if (path) send(encodePaste(`${path} `, emu.modes().bracketedPaste));
        }}
        onScroll={onScroll}
        onMouseDown={onMouseDown}
        onMouseMove={(e) => {
          if (touchInputRef.current) return;
          if (reportMouseMove(e)) e.preventDefault();
        }}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <span ref={measureRef} className="term-measure" aria-hidden="true">{"W".repeat(100)}</span>
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
          {touchRange && (
            // Handles scroll with the rows. The layer reaches into the
            // output's padding and clips there, so a knob at the edge of the
            // buffer never grows the scrollable area.
            <div className="term-select-layer" data-term-select-ui="" data-keep-keyboard="" aria-hidden="true">
              <div className="term-select-origin">
                {(["start", "end"] as const).map((edge) => {
                  const point = touchRange[edge];
                  return (
                    <span
                      key={edge}
                      className={`term-select-handle ${edge}`}
                      style={{
                        left: point.col * cell.w,
                        top: point.row * cell.h - (edge === "start" ? HANDLE_KNOB_PX : 0),
                        height: cell.h + HANDLE_KNOB_PX,
                      }}
                      onPointerDown={startHandleDrag(edge)}
                      onPointerMove={moveHandle}
                      onPointerUp={endHandleDrag}
                      onPointerCancel={endHandleDrag}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {touchRange && (
            <div
              ref={selectBarRef}
              className="term-select-bar"
              role="toolbar"
              aria-label={tr("terminalview.selectionActions")}
              data-term-select-ui=""
              data-keep-keyboard=""
              data-hidden={touchSelection !== "settled" || !selectionBarSettled ? "" : undefined}
              // Keep the software keyboard (and its input's focus) where it is.
              onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            >
              <Button size="md" variant="ghost" onClick={copyTouchSelection}>
                {copiedFlash ? tr("terminalview.copied") : tr("terminalview.copy")}
              </Button>
              <Button size="md" variant="ghost" onClick={selectAllTouch}>{tr("terminalview.selectAll")}</Button>
              {running && (
                <Button size="md" variant="ghost" onClick={pasteFromSelectionBar}>{tr("terminalview.paste")}</Button>
              )}
            </div>
          )}
        </div>
      </div>

      <input
        ref={mobileInputRef}
        className="term-mobile-input"
        data-keep-keyboard=""
        aria-label={tr("terminalview.terminalValue", { title: label })}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        inputMode="text"
        spellCheck={false}
        enterKeyHint="enter"
        defaultValue={IME_SENTINEL}
        tabIndex={-1}
        onInput={onMobileInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionEnd={onMobileCompositionEnd}
        onFocus={onFocus}
        onBlur={onBlur}
      />

      {behind && !followRef.current && (
        // A zero-height anchor on the output's bottom edge, above the touch
        // chrome: the pill floats over the output, not over the bottom keys.
        // Like the chrome it is a keep-keyboard surface, so a tap on it
        // scrolls without taking the software keyboard down.
        <div className="term-follow-anchor" data-keep-keyboard="">
          <Button
            size="sm"
            iconStart={ChevronDownIcon}
            className="term-follow"
            onClick={scrollToBottom}
            onPointerDown={(event) => event.preventDefault()}
            title={tr("terminalview.scrollToBottomShortcut")}
          >
            {tr("terminalview.newOutput")}
          </Button>
        </div>
      )}

      <div className="term-touch-chrome" data-keep-keyboard="" data-text-input={textInputOpen || undefined}>
        {textInputOpen && (
          <form
            className="term-text-input"
            onSubmit={(event) => { event.preventDefault(); submitTextInput(); }}
          >
            <TextInput
              ref={textInputRef}
              uiSize="sm"
              value={textDraft}
              enterKeyHint="send"
              autoCapitalize="none"
              aria-label={tr("terminalview.textInput")}
              placeholder={tr("terminalview.textInputPlaceholder")}
              onChange={(event) => setTextDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return;
                if (event.key === "Escape") { event.preventDefault(); openTextInput(false); }
              }}
            />
            <IconButton
              icon={SendIcon}
              size="sm"
              variant="ghost"
              type="submit"
              label={tr("terminalview.sendLine")}
              disabled={!running}
              onPointerDown={(event) => event.preventDefault()}
            />
            <IconButton
              icon={CloseIcon}
              size="sm"
              variant="ghost"
              label={tr("terminalview.closeTextInput")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => openTextInput(false)}
            />
          </form>
        )}
        <ExtraKeysBar
          layout={layout}
          modifiers={mods}
          label={tr("terminalview.extraKeys")}
          onKey={onExtraKey}
          onModifier={onModifier}
          onSwipe={() => openTextInput(!textInputOpen)}
          spoken={(key) => tr(SPOKEN_KEYS[key])}
          popupHint={(value) => tr("terminalview.swipeUpFor", { key: value })}
          lockedHint={(value) => tr("terminalview.keyLocked", { key: value })}
          trailing={(
            <>
              <Menu
                label={tr("terminalview.sessionsAndActions")}
                title={tr("terminalview.terminalValue", { title: label })}
                phonePresentation={touchMenuPresentation}
                align="end"
                open={touchMenuOpen}
                onOpenChange={setTouchMenuOpen}
                returnFocusRef={touchMenuReturnRef}
                entries={touchMenuEntries}
              >
                {(trigger) => (
                  <IconButton
                    {...trigger}
                    onClick={() => { if (touchMenuOpen) setTouchMenuOpen(false); else openTouchMenu(); }}
                    icon={MoreIcon}
                    size="sm"
                    variant="ghost"
                    className="term-touch-menu"
                    label={tr("terminalview.sessionsAndActions")}
                    // The keyboard's input keeps focus while the menu opens.
                    onPointerDown={(event) => event.preventDefault()}
                  />
                )}
              </Menu>
              <IconButton
                icon={KeyboardIcon}
                size="sm"
                variant="ghost"
                className="term-touch-keyboard"
                label={tr("terminalview.toggleKeyboard")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={toggleKeyboard}
              />
            </>
          )}
        />
      </div>

      {urls && <UrlSheet urls={urls} onClose={() => setUrls(null)} />}
      {editingKeys && (
        <ExtraKeysEditor
          value={prefs.extraKeys}
          onSave={(value) => updateTouchPrefs({ extraKeys: value })}
          onClose={() => setEditingKeys(false)}
        />
      )}

      <Menu
        key={contextMenu ? `${contextMenu.x}:${contextMenu.y}` : "closed"}
        label={tr("terminalview.terminalValue", { title: label })}
        open={contextMenu !== null}
        onOpenChange={(open) => { if (!open) setContextMenu(null); }}
        entries={[
          {
            id: "copy",
            label: tr("terminalview.copy"),
            detail: "Ctrl+Shift+C",
            disabled: !selection,
            onSelect: () => {
              void copySelection();
              bodyRef.current?.focus();
            },
          },
          {
            id: "paste",
            label: tr("terminalview.paste"),
            detail: "Ctrl+Shift+V",
            onSelect: () => {
              pasteFromClipboard();
              bodyRef.current?.focus();
            },
          },
          {
            id: "select-all",
            label: tr("terminalview.selectAll"),
            onSelect: () => {
              setSelection({
                anchor: { row: 0, col: 0 },
                focus: { row: Math.max(0, emu.bufferLength() - 1), col: emu.cols() },
              });
              bodyRef.current?.focus();
            },
          },
          "separator",
          {
            id: "extra-keys",
            label: tr("terminalview.extraKeys"),
            kind: "checkbox",
            checked: prefs.extraKeysVisible === "on",
            onSelect: () => updateTouchPrefs({ extraKeysVisible: prefs.extraKeysVisible === "on" ? "auto" : "on" }),
          },
        ]}
      >
        {(trigger) => (
          <button
            {...trigger}
            type="button"
            className="term-ctx-anchor"
            tabIndex={-1}
            aria-hidden="true"
            style={{
              position: "fixed",
              left: contextMenu?.x ?? 0,
              top: contextMenu?.y ?? 0,
              width: 1,
              height: 1,
              padding: 0,
              margin: 0,
              overflow: "hidden",
              opacity: 0,
              pointerEvents: "none",
            }}
          />
        )}
      </Menu>

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
