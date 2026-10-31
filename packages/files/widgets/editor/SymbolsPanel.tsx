// "Go to symbol" popover of a file pane: the outline (outline.ts) with a
// filter, arrow-key selection and Enter to jump.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { Popover, TextInput } from "../../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";
import { filterSymbols, type FileSymbol, type SymbolKind } from "./outline.ts";

/** One-letter kind marks, as in an editor's outline. */
const KIND_MARK: Record<SymbolKind, string> = {
  heading: "#", class: "C", interface: "I", type: "T", enum: "E", function: "ƒ",
  method: "m", variable: "v", module: "M", selector: "{}", key: "k",
};

export interface SymbolsPanelProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  symbols: readonly FileSymbol[];
  onPick: (symbol: FileSymbol) => void;
  onClose: () => void;
}

export default function SymbolsPanel({ open, anchorRef, symbols, onPick, onClose }: SymbolsPanelProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => filterSymbols(symbols, query), [symbols, query]);
  const filtering = query.trim().length > 0;
  useEffect(() => { if (open) { setQuery(""); setCursor(0); } }, [open]);
  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      align="end"
      className="files-symbols"
      ariaLabel={tr("editor.filepane.symbols")}
      initialFocus="input"
    >
      <div className="files-symbols-head">
        <TextInput
          uiSize="sm"
          value={query}
          placeholder={tr("editor.filepane.symbolsFilter")}
          aria-label={tr("editor.filepane.symbolsFilter")}
          aria-controls="files-symbols-list"
          aria-activedescendant={shown[cursor] ? `files-symbol-${cursor}` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setCursor((current) => shown.length ? (current + step + shown.length) % shown.length : 0);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const symbol = shown[cursor];
              if (symbol) onPick(symbol);
            }
          }}
        />
        <span className="files-symbols-count">{shown.length}</span>
      </div>
      <div ref={listRef} id="files-symbols-list" className="files-symbols-list" role="listbox" aria-label={tr("editor.filepane.symbols")}>
        {shown.length === 0 && <div className="files-symbols-empty">{symbols.length ? tr("editorview.noMatches") : tr("editor.filepane.symbolsNone")}</div>}
        {shown.map((symbol, index) => (
          <button
            key={`${symbol.line}:${symbol.name}`}
            id={`files-symbol-${index}`}
            type="button"
            role="option"
            aria-selected={index === cursor}
            data-index={index}
            className={`files-symbol${index === cursor ? " active" : ""}`}
            style={{ paddingInlineStart: `calc(var(--space-2) + ${filtering ? 0 : symbol.depth} * var(--space-3))` }}
            onMouseMove={() => { if (index !== cursor) setCursor(index); }}
            onClick={() => onPick(symbol)}
          >
            <span className="files-symbol-kind" data-kind={symbol.kind} aria-hidden>{KIND_MARK[symbol.kind]}</span>
            <span className="files-symbol-name" dir="auto">{symbol.name}</span>
            <span className="files-symbol-line">{symbol.line}</span>
          </button>
        ))}
      </div>
    </Popover>
  );
}
