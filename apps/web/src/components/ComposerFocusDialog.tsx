// Expanded focus editor (WP2): the same draft in a large dialog. Close commits
// the text back to the inline editor; IME safety comes from AdaptiveTextInput.
import { useRef } from "react";
import Dialog from "./a11y/Dialog.tsx";
import AdaptiveTextInput, { type TextInputHandle } from "./input/AdaptiveTextInput.tsx";
import { tr } from "../i18n/index.ts";

export default function ComposerFocusDialog({
  initialText,
  onCommit,
  onClose,
  onSend,
}: {
  initialText: string;
  onCommit: (text: string) => void;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const inputRef = useRef<TextInputHandle>(null);

  const close = () => {
    onCommit(inputRef.current?.getText() ?? initialText);
    onClose();
  };

  return (
    <Dialog title={tr("composerfocusdialog.focusedEditor")} size="lg" onClose={close} className="composer-focus-dialog" initialFocus="textarea">
      <div className="dialog-head">
        <span>{tr("composerfocusdialog.focusedEditor")}</span>
        <button className="icon-btn" aria-label={tr("composerfocusdialog.closeFocusedEditor")} onClick={close}>✕</button>
      </div>
      <AdaptiveTextInput
        ref={inputRef}
        initialText={initialText}
        rows={16}
        className="composer-focus-editor"
        ariaLabel={tr("composerfocusdialog.messageDraft")}
        onTextChange={onCommit}
        onKeyIntercept={(e, composing) => {
          if (composing) return false;
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            const t = inputRef.current?.getText() ?? "";
            if (t.trim()) {
              onSend(t);
              onClose();
            }
            return true;
          }
          return false;
        }}
      />
      <div className="dialog-foot muted">
        <span><kbd>{tr("composerfocusdialog.esc")}</kbd> {tr("composerfocusdialog.backToComposer")}</span>
        <span><kbd>{tr("composerfocusdialog.mod")}</kbd> {tr("composerfocusdialog.send")}</span>
      </div>
    </Dialog>
  );
}
