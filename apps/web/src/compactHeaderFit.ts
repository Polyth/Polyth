// Tablet (compact shell) header budget. The header is one row: drawer trigger,
// session title, the user's pinned shortcuts and an always-present More menu.
// The title keeps a guaranteed share and the shortcuts get whole slots of the
// remainder; everything that does not fit moves into More. The count depends
// only on the header's own width and its fixed controls — never on how many
// shortcuts are currently rendered — so it cannot oscillate, clip an icon, or
// leave a half-empty strip behind.

/** Settings → Appearance section that edits the pinned tablet shortcuts. */
export const COMPACT_SHORTCUTS_SETTINGS_ITEM = "appearance.compactShortcuts";

/** The session title never shrinks below this share of the header. */
export function compactTitleMin(headerInline: number): number {
  return Math.round(Math.min(420, Math.max(200, headerInline * 0.5)));
}

export interface CompactShortcutFitInput {
  /** Content-box inline size of the header row. */
  headerInline: number;
  /** Fixed controls and gaps outside the title and the shortcut rail. */
  reserved: number;
  /** Guaranteed title width; 0 when the header has no title. */
  titleMin: number;
  /** One shortcut plus the gap before the next. */
  pitch: number;
  /** The More trigger plus its leading gap. */
  moreInline: number;
  count: number;
}

/** Number of pinned shortcuts that fit whole beside the title and More. */
export function compactShortcutFit(input: CompactShortcutFitInput): number {
  if (input.headerInline <= 0 || input.pitch <= 0) return input.count;
  const room = input.headerInline - input.reserved - input.titleMin - input.moreInline;
  return Math.max(0, Math.min(input.count, Math.floor(room / input.pitch)));
}
