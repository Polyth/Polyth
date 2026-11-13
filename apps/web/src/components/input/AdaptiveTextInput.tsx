// IME-safe uncontrolled text input. Public props deliberately omit
// `value`/`defaultValue` bindings per keystroke: the DOM owns live text, React
// observes committed edits, and programmatic changes flow through the handle.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import {
  admitCommand,
  beginComposition,
  commitEdit,
  createGate,
  endComposition,
  insertAt,
  isCompositionKey,
  replaceAll,
  type EditorCommand,
  type TextSelection,
} from "./editorCore.ts";

export interface TextInputHandle {
  /** Replace all text. Deferred while an IME composition is active.
   *  `silent` skips onTextChange so programmatic history recall is not a user edit. */
  replaceText(text: string, selection?: TextSelection, opts?: { silent?: boolean }): void;
  /** Insert at the caret (or over the selection). Deferred while composing. */
  insertText(text: string): void;
  focus(): void;
  getText(): string;
  getSelection(): { start: number; end: number };
  isComposing(): boolean;
  /** Commit an active IME composition now (a Send tap while a phone keyboard
   *  still holds the last word). No-op when nothing is being composed. */
  finishComposition(): void;
  /** Have the platform redraw the caret where the text now is, after the
   *  layout around the focused field changed without a selection change.
   *  iOS draws the caret above the page and re-measures it only when the
   *  selection moves, so a row that opened beside the field left the caret
   *  over that row until the next tap or keystroke. No-op on other engines,
   *  unfocused, or while composing. */
  refreshCaret(): void;
  element(): HTMLTextAreaElement | null;
}

// iOS WebKit (Safari and the app's WebView) is the engine that supports
// -webkit-touch-callout, and the one whose caret is drawn outside the page.
let caretOutsidePage: boolean | null = null;
function caretDrawnOutsidePage(): boolean {
  caretOutsidePage ??= typeof CSS !== "undefined" && typeof CSS.supports === "function"
    && CSS.supports("-webkit-touch-callout", "none");
  return caretOutsidePage;
}

export interface AdaptiveTextInputProps {
  initialText?: string;
  placeholder?: string;
  rows?: number;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Stable DOM hook for the shared composer focus command. */
  "data-composer-input"?: "";
  /** Optional combobox relationship: the host sets these
   *  only while a discovery token drives an autocomplete popup. The textarea
   *  stays uncontrolled and IME admission is untouched. */
  role?: string;
  ariaAutocomplete?: "list" | "none" | "inline" | "both";
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaActiveDescendant?: string;
  /** Fires on committed edits only — never mid-composition. */
  onTextChange?: (text: string) => void;
  /** Live text while an IME composition is open, then `null` once it ends.
   *  Phone keyboards compose whole words, so the committed text can be empty
   *  while the field visibly holds one; use this for display state such as
   *  whether Send is enabled, never for edits. */
  onComposingText?: (text: string | null) => void;
  /** Raw keydown with a composition flag; return true to consume the event. */
  onKeyIntercept?: (e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => boolean;
  /** Fires after native ArrowUp/Down when the caret did not move. */
  onUnmovedArrow?: (key: "ArrowUp" | "ArrowDown") => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onFocusChange?: (focused: boolean) => void;
}

const AdaptiveTextInput = forwardRef<TextInputHandle, AdaptiveTextInputProps>(function AdaptiveTextInput(
  {
    initialText = "", placeholder, rows = 3, className, disabled, ariaLabel,
    "data-composer-input": dataComposerInput,
    role, ariaAutocomplete, ariaExpanded, ariaControls, ariaActiveDescendant,
    onTextChange, onComposingText, onKeyIntercept, onUnmovedArrow, onPaste, onFocusChange,
  },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The mount-time text only. A host that passes its live draft here would
  // otherwise have React rewrite `defaultValue` (the textarea's child text)
  // on every keystroke: an O(draft) DOM mutation that also re-runs `:has()`
  // invalidation up the whole shell.
  const [mountText] = useState(initialText);
  const gate = useRef(createGate());
  const committed = useRef(initialText);
  const arrowGen = useRef(0);
  const historyTick = useRef(0);
  // A blur/focus round trip that only commits the IME is not a focus change.
  const refocusing = useRef(false);
  // The imperative handle is built once; it must still reach current callbacks.
  const latest = useRef({ onTextChange, onComposingText });
  latest.current = { onTextChange, onComposingText };

  const applyCommand = (cmd: EditorCommand) => {
    const el = taRef.current;
    if (!el) return;
    if (cmd.kind === "replace") {
      const r = replaceAll(cmd.text, cmd.selection);
      el.value = r.value;
      el.setSelectionRange(r.caret, r.selEnd);
      if (cmd.silent) historyTick.current++;
      else arrowGen.current++;
    } else {
      const r = insertAt(el.value, cmd.text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
      el.value = r.value;
      el.setSelectionRange(r.caret, r.caret);
    }
    committed.current = el.value;
    if (cmd.kind !== "replace" || !cmd.silent) onTextChange?.(el.value);
  };

  const runOrDefer = (cmd: EditorCommand) => {
    if (admitCommand(gate.current, cmd) === "apply") applyCommand(cmd);
  };

  // Close the composition gate and commit what the field holds. Runs on
  // compositionend, and also when the browser dropped a composition without
  // one: Chromium cancels it silently when script writes `value`, and some
  // phone keyboards lose it. A gate left open would ignore every later input,
  // leaving Send disabled until another composition happened to end.
  const closeComposition = () => {
    const el = taRef.current;
    el?.classList.remove("is-composing");
    commitEdit(gate.current);
    const deferred = endComposition(gate.current);
    latest.current.onComposingText?.(null);
    if (el) {
      committed.current = el.value;
      latest.current.onTextChange?.(el.value);
    }
    for (const cmd of deferred) applyCommand(cmd);
  };

  useImperativeHandle(ref, () => ({
    replaceText(text, selection, opts) {
      runOrDefer({
        kind: "replace",
        text,
        ...(selection ? { selection } : {}),
        generation: gate.current.generation,
        ...(opts?.silent ? { silent: true } : {}),
      });
    },
    insertText(text) {
      runOrDefer({ kind: "insert", text, generation: gate.current.generation });
    },
    focus() {
      taRef.current?.focus();
    },
    getText() {
      return taRef.current?.value ?? committed.current;
    },
    getSelection() {
      const el = taRef.current;
      return { start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? 0 };
    },
    isComposing() {
      return gate.current.composing;
    },
    finishComposition() {
      if (!gate.current.composing) return;
      const el = taRef.current;
      // Moving focus is the portable way to make the platform IME commit:
      // browsers end the composition (compositionend) before blur, and the
      // keyboard learns the word is final. Refocusing in the same task keeps
      // the caret and, inside a tap, the phone keyboard.
      if (el && el.ownerDocument.activeElement === el) {
        refocusing.current = true;
        try {
          el.blur();
          el.focus({ preventScroll: true });
        } finally {
          refocusing.current = false;
        }
      }
      if (gate.current.composing) closeComposition();
    },
    refreshCaret() {
      const el = taRef.current;
      if (!el || el.ownerDocument.activeElement !== el || gate.current.composing || !caretDrawnOutsidePage()) return;
      const { selectionStart: start, selectionEnd: end, selectionDirection: direction, scrollTop } = el;
      // Step the selection away and back in one task: the platform sees a
      // change and measures the caret again, the page never paints the step.
      // An empty field has no other caret place, so its value steps instead.
      if (el.value) {
        const away = start > 0 ? start - 1 : 1;
        el.setSelectionRange(away, away);
      } else {
        el.value = " ";
        el.value = "";
      }
      el.setSelectionRange(start, end, direction);
      el.scrollTop = scrollTop;
    },
    element() {
      return taRef.current;
    },
  }), []);

  // Uncontrolled: seed the DOM once on mount. Session switches use the handle.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (el && el.value !== initialText) el.value = initialText;
    // intentionally mount-only: rerenders must never clobber live text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The platform can change the field without an `input` event (dictation and
  // some phone keyboards have). The host would go on holding the old text and
  // keep Send disabled over a visible draft, so the next sign of life in the
  // field (a caret move, a lifted key, focus) commits what it holds. A no-op
  // whenever the last edit was observed, and never during a composition.
  const reconcile = () => {
    const el = taRef.current;
    if (!el || gate.current.composing || el.value === committed.current) return;
    commitEdit(gate.current);
    committed.current = el.value;
    latest.current.onTextChange?.(el.value);
  };
  useEffect(() => {
    const doc = taRef.current?.ownerDocument;
    if (!doc) return;
    const onSelectionChange = () => { if (doc.activeElement === taRef.current) reconcile(); };
    doc.addEventListener("selectionchange", onSelectionChange);
    return () => doc.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // A field removed mid-composition must not leave its live text behind.
  useEffect(() => () => {
    if (gate.current.composing) latest.current.onComposingText?.(null);
  }, []);

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (gate.current.composing) {
      const native = e.nativeEvent as Partial<InputEvent>;
      // An input that is not part of any composition proves the composition
      // ended without compositionend; commit instead of ignoring it forever.
      if (native.isComposing === false && !native.inputType?.includes("Composition")) {
        closeComposition();
        return;
      }
      onComposingText?.(el.value); // committed on compositionend
      return;
    }
    commitEdit(gate.current);
    committed.current = el.value;
    onTextChange?.(el.value);
  };

  const onCompositionStart = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    beginComposition(gate.current);
    taRef.current?.classList.add("is-composing");
  };

  const onCompositionEnd = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    closeComposition();
  };

  // Browsers commit a composition before blur; one still open here was lost.
  const onBlur = () => {
    if (gate.current.composing) closeComposition();
    if (!refocusing.current) onFocusChange?.(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isCompositionKey(
      { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode },
      gate.current.composing,
    );
    if (onKeyIntercept?.(e, composing)) {
      e.preventDefault();
      return;
    }
    if (
      onUnmovedArrow
      && (e.key === "ArrowUp" || e.key === "ArrowDown")
      && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      && !composing
    ) {
      const ta = taRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const key = e.key;
      const gen = arrowGen.current;
      const tick = historyTick.current;
      // Chrome applies the textarea caret default action after the keydown
      // microtask checkpoint. Wait a macrotask so native wrap movement is
      // visible before we decide whether history may run. Silent history
      // replacement changes the caret; stacked key-repeat timeouts must still
      // step. Non-silent session switches bump arrowGen so stale timeouts die.
      setTimeout(() => {
        if (taRef.current !== ta) return;
        if (arrowGen.current !== gen) return;
        const unmoved = ta.selectionStart === start && ta.selectionEnd === end;
        if (unmoved || historyTick.current !== tick) onUnmovedArrow(key);
      }, 0);
    }
  };

  return (
    <textarea
      ref={taRef}
      className={className}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      data-composer-input={dataComposerInput}
      {...(role ? { role } : {})}
      {...(ariaAutocomplete ? { "aria-autocomplete": ariaAutocomplete } : {})}
      {...(ariaExpanded !== undefined ? { "aria-expanded": ariaExpanded } : {})}
      {...(ariaControls ? { "aria-controls": ariaControls } : {})}
      {...(ariaActiveDescendant ? { "aria-activedescendant": ariaActiveDescendant } : {})}
      defaultValue={mountText}
      onInput={onInput}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onKeyDown={onKeyDown}
      onKeyUp={reconcile}
      onPaste={onPaste}
      onFocus={() => {
        reconcile();
        if (!refocusing.current) onFocusChange?.(true);
      }}
      onBlur={onBlur}
    />
  );
});

export default AdaptiveTextInput;
