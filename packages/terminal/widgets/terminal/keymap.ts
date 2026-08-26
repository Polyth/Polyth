// Keyboard → PTY byte encoding (pure, DOM-free). Mirrors xterm behavior:
// application cursor keys, modifyOtherKeys-style CSI 1;<mod> encodings for
// navigation/function keys, Ctrl+letter C0 codes, and Alt as an ESC prefix.

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface KeymapState {
  appCursorKeys: boolean;
}

const modOf = (ev: KeyLike): number =>
  1 + (ev.shiftKey ? 1 : 0) + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0) + (ev.metaKey ? 8 : 0);

/** CSI-encoded cursor/nav key with optional modifier parameter. */
const cursorKey = (final: string, ev: KeyLike, app: boolean): string => {
  const mod = modOf(ev);
  if (mod > 1) return `\x1b[1;${mod}${final}`;
  return app ? `\x1bO${final}` : `\x1b[${final}`;
};

const tildeKey = (num: number, ev: KeyLike): string => {
  const mod = modOf(ev);
  return mod > 1 ? `\x1b[${num};${mod}~` : `\x1b[${num}~`;
};

const FKEYS: Record<string, number> = {
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
};
const FKEY_SS3: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/**
 * Translate a keydown event to the byte sequence a terminal sends, or null
 * when the key is not terminal input (the view handles copy/paste/scroll).
 */
export function keyEventToBytes(ev: KeyLike, state: KeymapState): string | null {
  const app = state.appCursorKeys;

  switch (ev.key) {
    case "Enter": return ev.altKey ? "\x1b\r" : "\r";
    case "Backspace": {
      if (ev.ctrlKey) return "\x08";
      return ev.altKey ? "\x1b\x7f" : "\x7f";
    }
    case "Tab": return ev.shiftKey ? "\x1b[Z" : "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return cursorKey("A", ev, app);
    case "ArrowDown": return cursorKey("B", ev, app);
    case "ArrowRight": return cursorKey("C", ev, app);
    case "ArrowLeft": return cursorKey("D", ev, app);
    case "Home": return cursorKey("H", ev, app);
    case "End": return cursorKey("F", ev, app);
    case "Insert": return tildeKey(2, ev);
    case "Delete": return tildeKey(3, ev);
    case "PageUp": return tildeKey(5, ev);
    case "PageDown": return tildeKey(6, ev);
    default: break;
  }

  const ss3 = FKEY_SS3[ev.key];
  if (ss3) {
    const mod = modOf(ev);
    return mod > 1 ? `\x1b[1;${mod}${ss3}` : `\x1bO${ss3}`;
  }
  const fnum = FKEYS[ev.key];
  if (fnum) return tildeKey(fnum, ev);

  if (ev.key.length !== 1) return null;

  // Ctrl+letter and Ctrl+symbol C0 controls
  if (ev.ctrlKey && !ev.metaKey) {
    const ch = ev.key;
    const lower = ch.toLowerCase();
    let byte: string | null = null;
    if (lower >= "a" && lower <= "z") {
      byte = String.fromCharCode(lower.charCodeAt(0) - 96);
    } else {
      const map: Record<string, string> = {
        " ": "\x00", "@": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d",
        "^": "\x1e", "_": "\x1f", "/": "\x1f", "?": "\x7f",
      };
      byte = map[ch] ?? null;
    }
    if (byte !== null) return ev.altKey ? `\x1b${byte}` : byte;
    return null;
  }

  if (ev.metaKey) return null; // Cmd shortcuts stay with the browser

  // Alt+printable → ESC prefix
  if (ev.altKey) return `\x1b${ev.key}`;
  return ev.key;
}

// ------------------------------------------------------------ mouse encoding

export interface MouseReport {
  /** 0 left, 1 middle, 2 right, 64 wheel-up, 65 wheel-down. */
  button: number;
  /** 1-based cell coordinates. */
  col: number;
  row: number;
  kind: "down" | "up" | "move" | "wheel";
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/**
 * Encode a mouse event for the active tracking mode; null when it should not
 * be reported (mode off, or motion without button-drag tracking).
 */
export function encodeMouseEvent(report: MouseReport, modes: { mouseTracking: number; mouseSgr: boolean }): string | null {
  const { mouseTracking, mouseSgr } = modes;
  if (mouseTracking === 0) return null;
  if (report.kind === "move" && mouseTracking !== 1002 && mouseTracking !== 1003) return null;
  if (mouseTracking === 9 && report.kind !== "down") return null;

  let code = report.button;
  if (report.kind === "move") code += 32;
  if (report.shift) code += 4;
  if (report.alt) code += 8;
  if (report.ctrl) code += 16;

  if (mouseSgr) {
    const suffix = report.kind === "up" ? "m" : "M";
    return `\x1b[<${code};${report.col};${report.row}${suffix}`;
  }
  const legacy = report.kind === "up" ? 3 + (code & ~3) : code;
  const clamp = (v: number) => Math.max(1, Math.min(v, 223));
  return `\x1b[M${String.fromCharCode(32 + legacy)}${String.fromCharCode(32 + clamp(report.col))}${String.fromCharCode(32 + clamp(report.row))}`;
}

/** Wrap pasted text per bracketed-paste mode; normalizes newlines to CR. */
export function encodePaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  if (!bracketed) return normalized;
  // strip any embedded bracket-end so pasted content cannot break out
  const safe = normalized.replaceAll("\x1b[201~", "");
  return `\x1b[200~${safe}\x1b[201~`;
}
