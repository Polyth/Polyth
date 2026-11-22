// One memory record, open for editing: the page the list hands over to when a
// row is tapped or "New memory" is pressed. Phone first: the title wraps and
// grows, the body grows with its text, short lists are chips, and the rarely
// used fields wait behind one disclosure.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { isImeComposing } from "@polyth/web-sdk";
import type { MemoryCategory } from "../src/client.ts";
import type { Translate } from "./i18n.ts";
import { ListField } from "./fields.tsx";
import { ActionMenu, Btn, Chips, TextArea, type MenuItem } from "./ui.tsx";

export type EditorDraft = {
  id: string | null;
  revision: number;
  title: string;
  body: string;
  category: MemoryCategory;
  tags: string[];
  aliases: string[];
  applicability: string[];
  sources: string[];
};

/** The store's limits (packages/memory/src/store.ts `MAX`). */
export const LIMITS = { title: 160, bodyBytes: 8 * 1024, list: 12, sources: 8, tag: 80, path: 512 } as const;
export const CATEGORIES: readonly MemoryCategory[] = ["decision", "convention", "gotcha", "procedure", "observation"];

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;
const kib = (bytes: number, format: Intl.NumberFormat): string => format.format(Math.round((bytes / 1024) * 10) / 10);

/** Ctrl+Enter, or ⌘ Enter on Apple keyboards. */
const appleKeys = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function MemoryEditor({
  draft, onChange, loading, dirty, busy, writesBlocked, facts, menu, notices, number, onSave, onBack, t,
}: {
  draft: EditorDraft;
  onChange(next: EditorDraft): void;
  /** The full record is still on its way: fields stay read-only. */
  loading: boolean;
  dirty: boolean;
  busy: boolean;
  writesBlocked: boolean;
  /** What sets the record apart, as the list row says it, plus its age. */
  facts: ReadonlyArray<{ key: string; text: string; strong?: boolean }>;
  menu: ReadonlyArray<MenuItem | "separator"> | null;
  /** Errors and their recovery actions, shown under the head. */
  notices: ReactNode;
  number: Intl.NumberFormat;
  onSave(): void;
  onBack(): void;
  t: Translate;
}) {
  const ids = useId();
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const bytes = byteLength(draft.body);
  const tooLong = bytes > LIMITS.bodyBytes;
  const canSave = !busy && !loading && !writesBlocked && dirty && !!draft.title.trim() && !!draft.body.trim() && !tooLong;
  const keys = appleKeys() ? "⌘↵" : "Ctrl+Enter";
  const latest = useRef({ canSave, onSave, onBack });
  latest.current = { canSave, onSave, onBack };
  const set = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) => onChange({ ...draft, [key]: value });
  const extras = [draft.aliases, draft.applicability, draft.sources].reduce((sum, list) => sum + list.length, 0);

  // A new record starts at its title; an opened one lets the page be read
  // first (on a phone, focusing a field would raise the keyboard over it).
  useEffect(() => {
    if (draft.id === null) title.current?.focus();
    else root.current?.focus({ preventScroll: true });
  }, []);

  // Keys on the editor itself, before the dialog around it sees them: Escape
  // steps back to the list (the draft is guarded there) instead of closing
  // the whole dialog, and Ctrl/⌘+Enter saves from any field.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key === "Escape") {
        // An open menu or list inside owns its own Escape.
        const target = event.target as { closest?(selector: string): unknown } | null;
        if (target?.closest?.('[role="menu"], [role="listbox"]')) return;
        event.stopPropagation();
        event.preventDefault();
        latest.current.onBack();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (latest.current.canSave) latest.current.onSave();
      }
    };
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, []);

  const removeLabel = (value: string) => t("memory.editor.remove", { value });
  return (
    <div ref={root} className="memory-editor" tabIndex={-1} aria-labelledby={`${ids}-title-label`} aria-busy={loading || undefined} data-memory-editor="">
      <div className="memory-page-head memory-editor-head">
        <Btn variant="ghost" icon="back" onClick={onBack} disabled={busy}>{t("memory.back")}</Btn>
        <span className="memory-editor-head-end">
          {dirty && <span className="memory-unsaved" role="status"><span>{t("memory.editor.unsaved")}</span></span>}
          {/* An action changes the record's revision: save or drop a draft first. */}
          {menu && <ActionMenu label={t("memory.action.more")} entries={menu} disabled={busy || loading || dirty} />}
          <Btn variant="primary" onClick={onSave} disabled={!busy && !canSave} busy={busy} title={`${t("memory.save")} (${keys})`} aria-keyshortcuts="Control+Enter Meta+Enter">{t("memory.save")}</Btn>
        </span>
      </div>
      {notices}

      <div className="memory-editor-title">
        <label className="memory-sr" id={`${ids}-title-label`} htmlFor={`${ids}-title`}>{draft.id ? t("memory.field.title") : t("memory.new")}</label>
        <TextArea
          id={`${ids}-title`}
          textareaRef={title}
          className="memory-title-input"
          value={draft.title}
          onChange={(value) => set("title", value.replace(/\s*\n\s*/g, " "))}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.metaKey || event.ctrlKey || isImeComposing(event)) return;
            event.preventDefault();
            body.current?.focus();
          }}
          placeholder={t("memory.editor.titlePlaceholder")}
          maxLength={LIMITS.title}
          autoGrow
          minRows={1}
          maxRows={4}
          disabled={loading || writesBlocked}
        />
        {facts.length > 0 && (
          <p className="memory-meta memory-editor-facts">
            {facts.map((fact) => <span key={fact.key} className={fact.strong ? "memory-meta-strong" : undefined}>{fact.text}</span>)}
          </p>
        )}
      </div>

      <div className="memory-field">
        <span className="memory-field-label" id={`${ids}-category`}>{t("memory.field.category")}</span>
        <Chips
          label={t("memory.field.category")}
          value={draft.category}
          onChange={(value) => set("category", value as MemoryCategory)}
          options={CATEGORIES.map((value) => ({ value, label: t(`memory.category.${value}`) }))}
          disabled={loading || writesBlocked}
        />
      </div>

      <div className="memory-field">
        <span className="memory-field-head">
          <label className="memory-field-label" htmlFor={`${ids}-body`}>{t("memory.field.body")}</label>
          {bytes > LIMITS.bodyBytes / 2 && (
            <span className={tooLong ? "memory-size memory-size--over" : "memory-size"} id={`${ids}-size`} aria-live="polite">
              {t("memory.editor.size", { used: kib(bytes, number), max: kib(LIMITS.bodyBytes, number) })}
            </span>
          )}
        </span>
        <TextArea
          id={`${ids}-body`}
          textareaRef={body}
          className="memory-body-input"
          value={draft.body}
          onChange={(value) => set("body", value)}
          placeholder={t("memory.editor.bodyPlaceholder")}
          autoGrow
          minRows={5}
          maxRows={16}
          disabled={loading || writesBlocked}
          aria-invalid={tooLong || undefined}
          {...(bytes > LIMITS.bodyBytes / 2 ? { "aria-describedby": `${ids}-size` } : {})}
        />
      </div>

      <div className="memory-field">
        <label className="memory-field-label" htmlFor={`${ids}-tags`}>{t("memory.field.tags")}</label>
        <ListField id={`${ids}-tags`} values={draft.tags} onChange={(tags) => set("tags", tags)} placeholder={t("memory.editor.tagsPlaceholder")} removeLabel={removeLabel} max={LIMITS.list} maxLength={LIMITS.tag} disabled={loading || writesBlocked} />
      </div>

      <details className="memory-editor-more">
        <summary>
          <svg className="memory-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5" /></svg>
          <span>{t("memory.editor.more")}</span>
          {extras > 0 && <span className="memory-count">{number.format(extras)}</span>}
        </summary>
        <div className="memory-editor-more-body">
          <div className="memory-field">
            <label className="memory-field-label" htmlFor={`${ids}-aliases`}>{t("memory.field.aliases")}</label>
            <ListField id={`${ids}-aliases`} values={draft.aliases} onChange={(aliases) => set("aliases", aliases)} placeholder={t("memory.editor.aliasesPlaceholder")} removeLabel={removeLabel} max={LIMITS.list} maxLength={LIMITS.tag} disabled={loading || writesBlocked} />
          </div>
          <div className="memory-field">
            <label className="memory-field-label" htmlFor={`${ids}-applies`}>{t("memory.field.appliesTo")}</label>
            <ListField id={`${ids}-applies`} values={draft.applicability} onChange={(applicability) => set("applicability", applicability)} placeholder={t("memory.field.pathsOrContexts")} removeLabel={removeLabel} max={LIMITS.list} maxLength={LIMITS.path} disabled={loading || writesBlocked} />
          </div>
          <div className="memory-field">
            <label className="memory-field-label" htmlFor={`${ids}-sources`}>{t("memory.field.sources")}</label>
            <ListField id={`${ids}-sources`} values={draft.sources} onChange={(sources) => set("sources", sources)} placeholder={t("memory.editor.sourcesPlaceholder")} removeLabel={removeLabel} max={LIMITS.sources} maxLength={LIMITS.path} disabled={loading || writesBlocked} />
          </div>
        </div>
      </details>

      <p className="memory-help memory-editor-help">{t("memory.editor.help")}</p>
    </div>
  );
}
