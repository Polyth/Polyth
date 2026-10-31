// Touch-terminal secondary surfaces: the extra-keys layout editor (Termux
// `extra-keys` syntax) and the URL picker (Termux "Select URL").
import { useMemo, useState } from "react";
import { parseExtraKeys, TERMUX_DEFAULT_EXTRA_KEYS } from "./terminal/extraKeys.ts";
import { copyText } from "../../../apps/web/src/utils.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  CopyIcon,
  Dialog,
  ExternalLinkIcon,
  IconButton,
  ResponsiveOverlay,
  Textarea,
} from "../../../apps/web/src/components/ui/index.ts";

export interface ExtraKeysEditorProps {
  value: string | null;
  onSave: (value: string | null) => void;
  onClose: () => void;
}

export function ExtraKeysEditor({ value, onSave, onClose }: ExtraKeysEditorProps) {
  const [draft, setDraft] = useState(value ?? TERMUX_DEFAULT_EXTRA_KEYS);
  const parsed = useMemo(() => parseExtraKeys(draft), [draft]);
  const save = () => {
    if (!parsed.ok) return;
    const normalized = draft.trim();
    onSave(normalized === TERMUX_DEFAULT_EXTRA_KEYS ? null : normalized);
    onClose();
  };
  return (
    <Dialog
      title={tr("terminalview.extraKeys")}
      onClose={onClose}
      className="term-extra-keys-editor"
      footer={
        <>
          <Button onClick={() => setDraft(TERMUX_DEFAULT_EXTRA_KEYS)}>{tr("terminalview.extraKeysDefault")}</Button>
          <span className="header-spacer" />
          <Button onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" disabled={!parsed.ok} onClick={save}>{tr("common.save")}</Button>
        </>
      }
    >
      <p className="term-dialog-note">{tr("terminalview.extraKeysHelp")}</p>
      <Textarea
        className="term-extra-keys-source"
        value={draft}
        invalid={!parsed.ok}
        aria-label={tr("terminalview.extraKeys")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        minRows={4}
        maxRows={10}
        autoGrow
        onChange={(event) => setDraft(event.target.value)}
      />
      {parsed.ok ? (
        <p className="term-dialog-note" role="status">
          {tr("terminalview.extraKeysSummary", { rows: parsed.layout.length, keys: parsed.layout.reduce((n, row) => n + row.length, 0) })}
        </p>
      ) : (
        <div className="term-dialog-error" role="alert">
          <p>{tr("terminalview.extraKeysInvalid")}</p>
          <code>{parsed.error}</code>
        </div>
      )}
    </Dialog>
  );
}

export interface UrlSheetProps {
  urls: readonly string[];
  onClose: () => void;
}

export function UrlSheet({ urls, onClose }: UrlSheetProps) {
  return (
    <ResponsiveOverlay open onClose={onClose} title={tr("terminalview.selectUrl")} phone="sheet" desktop="dialog" className="term-url-sheet">
      {urls.length === 0 ? (
        <p className="term-dialog-note">{tr("terminalview.noUrls")}</p>
      ) : (
        <ul className="term-url-list">
          {urls.map((url) => (
            <li key={url} className="term-url-row">
              <span className="term-url-text">{url}</span>
              <IconButton
                icon={CopyIcon}
                size="sm"
                variant="ghost"
                label={tr("terminalview.copyValue", { value: url })}
                onClick={() => { void copyText(url); onClose(); }}
              />
              <IconButton
                icon={ExternalLinkIcon}
                size="sm"
                variant="ghost"
                label={tr("terminalview.openValue", { value: url })}
                onClick={() => { window.open(url, "_blank", "noopener,noreferrer"); onClose(); }}
              />
            </li>
          ))}
        </ul>
      )}
    </ResponsiveOverlay>
  );
}
