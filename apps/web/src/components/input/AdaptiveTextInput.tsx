// IME-safe uncontrolled text input (WP2). Public props deliberately omit
// `value`/`defaultValue` bindings per keystroke: the DOM owns live text, React
// observes committed edits, and programmatic changes flow through the handle.
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
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
  /** Replace all text. Deferred while an IME composition is active. */
  replaceText(text: string, selection?: TextSelection): void;
  /** Insert at the caret (or over the selection). Deferred while composing. */
  insertText(text: string): void;
  focus(): void;
  getText(): string;
  getSelection(): { start: number; end: number };
  isComposing(): boolean;
  element(): HTMLTextAreaElement | null;
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
  /** Optional combobox relationship (UX-COMPOSER-DISC): the host sets these
   *  only while a discovery token drives an autocomplete popup. The textarea
   *  stays uncontrolled and IME admission is untouched. */
  role?: string;
  ariaAutocomplete?: "list" | "none" | "inline" | "both";
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaActiveDescendant?: string;
  /** Fires on committed edits only — never mid-composition. */
  onTextChange?: (text: string) => void;
  /** Raw keydown with a composition flag; return true to consume the event. */
  onKeyIntercept?: (e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => boolean;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onFocusChange?: (focused: boolean) => void;
}

const AdaptiveTextInput = forwardRef<TextInputHandle, AdaptiveTextInputProps>(function AdaptiveTextInput(
  {
    initialText = "", placeholder, rows = 3, className, disabled, ariaLabel,
    "data-composer-input": dataComposerInput,
    role, ariaAutocomplete, ariaExpanded, ariaControls, ariaActiveDescendant,
    onTextChange, onKeyIntercept, onPaste, onFocusChange,
  },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gate = useRef(createGate());
  const committed = useRef(initialText);

  const applyCommand = (cmd: EditorCommand) => {
    const el = taRef.current;
    if (!el) return;
    if (cmd.kind === "replace") {
      const r = replaceAll(cmd.text, cmd.selection);
      el.value = r.value;
      el.setSelectionRange(r.caret, r.selEnd);
    } else {
      const r = insertAt(el.value, cmd.text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
      el.value = r.value;
      el.setSelectionRange(r.caret, r.caret);
    }
    committed.current = el.value;
    onTextChange?.(el.value);
  };

  const runOrDefer = (cmd: EditorCommand) => {
    if (admitCommand(gate.current, cmd) === "apply") applyCommand(cmd);
  };

  useImperativeHandle(ref, () => ({
    replaceText(text, selection) {
      runOrDefer({ kind: "replace", text, ...(selection ? { selection } : {}), generation: gate.current.generation });
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

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (gate.current.composing) return; // committed on compositionend
    commitEdit(gate.current);
    committed.current = el.value;
    onTextChange?.(el.value);
  };

  const onCompositionStart = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    beginComposition(gate.current);
    taRef.current?.classList.add("is-composing");
  };

  const onCompositionEnd = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    const el = taRef.current;
    el?.classList.remove("is-composing");
    commitEdit(gate.current);
    const deferred = endComposition(gate.current);
    if (el) {
      committed.current = el.value;
      onTextChange?.(el.value);
    }
    for (const cmd of deferred) applyCommand(cmd);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isCompositionKey(
      { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode },
      gate.current.composing,
    );
    if (onKeyIntercept?.(e, composing)) {
      e.preventDefault();
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
      defaultValue={initialText}
      onInput={onInput}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
    />
  );
});

export default AdaptiveTextInput;
