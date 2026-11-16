// Previous prompts: a searchable list of what this person sent in this project,
// newest first. Choosing one puts it (and its attachments) into the composer
// without sending. Same shell as the command palette: a dialog on desktop, a
// sheet with its own search on a phone (ResponsiveOverlay).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PromptHistoryEntryDto } from "@polyth/contracts";
import { PROMPT_HISTORY_MAX_LIMIT } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { filterPromptHistory, paletteEntries } from "../composer/history.ts";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { Icon, IconButton, ResponsiveOverlay, SearchIcon, CloseIcon, Spinner, TextInput } from "./ui/index.ts";
import { isImeComposing } from "./input/editorCore.ts";

/** `onPick` gets the chosen entry; the composer recalls it (text plus
 *  `attachmentsForRecall`) the same way Up-arrow browsing does. */
export default function PromptHistoryPalette({ projectId, onPick, onClose }: {
  projectId: string | null;
  onPick: (entry: PromptHistoryEntryDto) => void;
  onClose: () => void;
}) {
  const phone = useShellMode() === "phone";
  const [q, setQ] = useState("");
  const [items, setItems] = useState<readonly PromptHistoryEntryDto[] | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // The server answers with this signed-in person's prompts only.
  useEffect(() => {
    let live = true;
    void api.promptHistory({ scope: "space", limit: PROMPT_HISTORY_MAX_LIMIT })
      .then((dto) => { if (live) setItems(dto.entries); })
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, []);

  const entries = useMemo(
    () => filterPromptHistory(paletteEntries(items ?? [], projectId), q),
    [items, projectId, q],
  );
  const index = Math.min(active, Math.max(entries.length - 1, 0));
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`#prompt-history-opt-${index}`)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  const choose = (entry: PromptHistoryEntryDto | undefined) => {
    if (entry) onPick(entry);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    const count = Math.max(entries.length, 1);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((index + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((index - 1 + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(entries[index]);
    }
  };
  // Escape clears a typed query first, then closes (the dialog listens later).
  const onKeyCapture = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape" || !q || isImeComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setQ("");
  };

  const loading = items === null;
  const label = tr("composer.historyPalette.search");
  const activeId = entries[index] ? `prompt-history-opt-${index}` : undefined;

  return (
    <ResponsiveOverlay
      open
      onClose={onClose}
      title={tr("composer.historyPalette.title")}
      desktop="dialog"
      phone="sheet"
      dialogSize="lg"
      className="palette prompt-history-palette"
      initialFocus=".palette-input"
      sheetSize="tall"
      {...(phone
        ? {
            sheetSearch: {
              value: q,
              onChange: setQ,
              placeholder: label,
              ariaLabel: label,
              role: "combobox" as const,
              ariaExpanded: entries.length > 0,
              ariaControls: "prompt-history-listbox",
              ...(activeId ? { ariaActiveDescendant: activeId } : {}),
              onKeyDown: onKey,
            },
          }
        : {})}
      dialogHideHeader
    >
      {!phone && (
        <div className="palette-field">
          <Icon icon={SearchIcon} className="palette-field-icon" />
          <TextInput
            className="palette-input"
            value={q}
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-controls="prompt-history-listbox"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={label}
            placeholder={label}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            onKeyDownCapture={onKeyCapture}
          />
          <span className="palette-field-trail">
            {loading && <Spinner size="sm" />}
            {!loading && q && (
              <IconButton icon={CloseIcon} size="sm" label={tr("sessionsearch.clear")} onClick={() => setQ("")} />
            )}
          </span>
        </div>
      )}
      <div
        className="palette-list"
        role="listbox"
        id="prompt-history-listbox"
        ref={listRef}
        aria-label={tr("composer.historyPalette.title")}
        aria-busy={loading}
      >
        {entries.length === 0 && (
          <div className="palette-empty">
            {loading
              ? tr("commandpalette.searching")
              : q ? tr("commandpalette.noMatches") : tr("composer.historyPalette.empty")}
          </div>
        )}
        {entries.map((entry, n) => (
          <button
            key={entry.id}
            type="button"
            id={`prompt-history-opt-${n}`}
            role="option"
            aria-selected={n === index}
            tabIndex={-1}
            className={`palette-item${n === index ? " active" : ""}`}
            onPointerMove={() => setActive(n)}
            onClick={() => choose(entry)}
          >
            <span className="palette-col">
              <span className="palette-label prompt-history-text">{entry.text || tr("composer.historyPalette.attachmentsOnly")}</span>
            </span>
            {entry.attachments.length > 0 && (
              <span className="palette-meta">{tr("composer.historyPalette.attached", { count: entry.attachments.length })}</span>
            )}
          </button>
        ))}
      </div>
    </ResponsiveOverlay>
  );
}
