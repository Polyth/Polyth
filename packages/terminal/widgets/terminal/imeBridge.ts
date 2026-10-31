// Software-keyboard bridge (pure, DOM-free). Mobile keyboards type into a
// hidden native input. Gboard and similar IMEs compose whole words, so waiting
// for compositionend would echo nothing until Space. Instead every input event
// is diffed against what the PTY already received and turned into DELs plus
// the new suffix: live echo while composing, and autocorrect or suggestion
// replacements arrive as the edit the keyboard actually made.
//
// The input always holds a one-character sentinel ahead of the composed text.
// With an empty field, Android keyboards have nothing to delete and send no
// key event for Backspace; the sentinel gives them something to delete, and
// its disappearance is the Backspace.

export const IME_SENTINEL = " ";

export interface ImeEdit {
  /** Characters (code points) to erase with DEL before inserting. */
  deletes: number;
  insert: string;
  /** Restore the input to the bare sentinel (no composition is pending). */
  reset: boolean;
}

/** Code-point diff: how much of `previous` to erase and what to append. */
export function diffImeText(previous: string, next: string): { deletes: number; insert: string } {
  const a = Array.from(previous);
  const b = Array.from(next);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return { deletes: a.length - same, insert: b.slice(same).join("") };
}

export interface ImeBridge {
  /** An input event (or compositionend) produced `value`. */
  update(value: string, composing: boolean): ImeEdit;
  /** The input was reset to the sentinel outside an update. */
  reset(): void;
}

export function createImeBridge(): ImeBridge {
  // Text after the sentinel the PTY has already received for the current
  // composition window.
  let delivered = "";
  return {
    update(value, composing) {
      const hasSentinel = value.startsWith(IME_SENTINEL);
      const body = hasSentinel ? value.slice(IME_SENTINEL.length) : value;
      const edit = diffImeText(delivered, body);
      // The sentinel itself was deleted: one Backspace beyond the composed
      // text. A keyboard that rewrote the whole field (auto-capitalization of
      // the "word" " x") keeps its text and is treated as a plain diff.
      const deletes = edit.deletes + (!hasSentinel && body === "" ? 1 : 0);
      const reset = !composing || !hasSentinel;
      delivered = reset ? "" : body;
      return { deletes, insert: edit.insert, reset };
    },
    reset() {
      delivered = "";
    },
  };
}
