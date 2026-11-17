// Line comments on a diff: a quiet gutter button per row, a small editor under
// the row (shift+click a second row to cover a range) and "Add to message",
// which hands a `path:line` + diff snippet + comment block to the composer
// through `host.conversation.insert`. The hunk note editor is the same editor.
import { Fragment, createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { commentLineNumber, commentable, commentTarget, lineCommentMarkdown } from "./diffComment.ts";
import type { DiffLine } from "./diffLines.ts";

/** Present only where a composer can take the block (a host and a session). */
const DiffCommentsContext = createContext<WebPackageHost | null>(null);
export const DiffCommentsProvider = DiffCommentsContext.Provider;
export const useDiffCommentsHost = (): WebPackageHost | null => useContext(DiffCommentsContext);

type Translate = (key: string, values?: Record<string, string | number>) => string;
const translator = (host: WebPackageHost): Translate => (key, values) => host.ui.locale.translate(key, values);

/** The one comment editor: line comments and hunk notes both use it. */
export function LineCommentEditor({ host, label, placeholder, hint, submitLabel, onSubmit, onCancel, restoreFocus }: {
  host: WebPackageHost;
  label: string;
  /** One quiet line under the field (how to widen the range). */
  hint?: string;
  placeholder?: string;
  submitLabel: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /** Called after Esc/Cancel so focus returns to where the editor opened. */
  restoreFocus?: () => void;
}) {
  const { Button, Textarea } = host.ui.components;
  const t = translator(host);
  const [text, setText] = useState("");
  const empty = !text.trim();
  const cancel = () => { onCancel(); restoreFocus?.(); };
  const submit = () => { if (!empty) onSubmit(text.trim()); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
  };
  return (
    <div className="review-draft git-diff-comment-editor" role="group" aria-label={label} onKeyDown={onKeyDown}>
      <Textarea autoFocus rows={3} aria-label={label} {...(placeholder ? { placeholder } : {})} value={text} onChange={(event) => setText(event.target.value)} />
      {hint && <p className="git-diff-comment-hint muted">{hint}</p>}
      <div className="commit-row">
        <Button size="sm" variant="ghost" onClick={cancel}>{t("common.cancel")}</Button>
        <Button size="sm" variant="primary" disabled={empty} onClick={submit}>{submitLabel}</Button>
      </div>
    </div>
  );
}

/** Fallback when a host has no icon set: the speech bubble at icon size. */
const CommentGlyph = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M3 3.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H8l-3 2.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
);

const coarsePointer = (): boolean => {
  try { return typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches); } catch { return false; }
};

export interface CommentRowExtras {
  /** The gutter slot: a Comment button (fine pointers) shown on hover/focus. */
  slot: ReactNode;
  inRange: boolean;
  /** Coarse pointers: tapping the row arms its action strip. */
  onTap: () => void;
}

/** Wraps a list of parsed rows with comment behaviour; `renderRow` draws one. */
export function CommentableRows({ lines, path, renderRow }: {
  lines: readonly DiffLine[];
  path: string;
  renderRow: (line: DiffLine, index: number, extras: CommentRowExtras | null) => ReactNode;
}) {
  const host = useDiffCommentsHost();
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const buttons = useRef(new Map<number, HTMLElement>());
  // One tab stop for the whole diff: the last comment button used (else the
  // first). Up/Down/Home/End move between rows' buttons from there.
  const [rover, setRover] = useState<number | null>(null);
  const coarse = useRef(false);
  useEffect(() => { coarse.current = coarsePointer(); });
  if (!host) return <>{lines.map((line, index) => <Fragment key={index}>{renderRow(line, index, null)}</Fragment>)}</>;
  const t = translator(host);
  const { Button, IconButton } = host.ui.components;
  const commentIcon = host.ui.iconSet?.ChatIcon ?? CommentGlyph;
  const commentableRows = lines.flatMap((line, index) => commentable(line) ? [index] : []);
  const tabStop = rover !== null && commentableRows.includes(rover) ? rover : commentableRows[0];
  const moveFocus = (from: number, key: string): boolean => {
    const at = commentableRows.indexOf(from);
    const to = key === "ArrowDown" ? commentableRows[at + 1]
      : key === "ArrowUp" ? commentableRows[at - 1]
      : key === "Home" ? commentableRows[0]
      : key === "End" ? commentableRows[commentableRows.length - 1]
      : undefined;
    if (to === undefined || to === from) return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
    setRover(to);
    buttons.current.get(to)?.focus();
    return true;
  };

  const open = (index: number, extend: boolean) => {
    setSent(null);
    setRange((current) => extend && current ? { from: current.from, to: index } : { from: index, to: index });
  };
  const covered = range ? lines.slice(Math.min(range.from, range.to), Math.max(range.from, range.to) + 1).filter(commentable) : [];
  const lastRow = range ? Math.max(range.from, range.to) : -1;
  const firstRow = range ? Math.min(range.from, range.to) : -1;
  const close = () => setRange(null);
  const focusButton = (index: number) => () => { setTimeout(() => buttons.current.get(index)?.focus(), 0); };

  return <>{lines.map((line, index) => {
    const can = commentable(line);
    const number = commentLineNumber(line);
    const slot = can ? (
      <span className="git-diff-comment-slot">
        <IconButton
          type="button"
          className="git-diff-comment-btn"
          icon={commentIcon}
          size="sm"
          variant="ghost"
          tabIndex={index === tabStop ? 0 : -1}
          ref={(node: HTMLButtonElement | null) => { if (node) buttons.current.set(index, node); else buttons.current.delete(index); }}
          label={t("diffcomment.buttonLabel", { path, line: number ?? "" })}
          title={t("diffcomment.buttonHint")}
          onFocus={() => setRover(index)}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => { if (moveFocus(index, event.key)) event.preventDefault(); }}
          onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); open(index, event.shiftKey && range !== null); }}
        />
      </span>
    ) : null;
    const inRange = range !== null && index >= firstRow && index <= lastRow;
    const extras: CommentRowExtras | null = can ? { slot, inRange, onTap: () => { if (coarse.current) setArmed((current) => current === index ? null : index); } } : null;
    return (
      <Fragment key={index}>
        {renderRow(line, index, extras)}
        {can && armed === index && !(range !== null && index >= firstRow && index <= lastRow) && (
          <div className="git-diff-comment-strip">
            {/* With a comment already open, a tap widens it instead of starting another. */}
            <button type="button" className="git-diff-comment-tap" onClick={() => { setArmed(null); open(index, range !== null); }}>
              {t(range !== null ? "diffcomment.extend" : "diffcomment.button")} <span className="mono">{commentTarget(path, [line])}</span>
            </button>
          </div>
        )}
        {index === lastRow && (
          <LineCommentEditor
            key={`${firstRow}-${lastRow}`}
            host={host}
            label={t("diffcomment.editorLabel", { target: commentTarget(path, covered) })}
            placeholder={t("diffcomment.placeholder")}
            hint={t(coarse.current ? "diffcomment.rangeHintTouch" : "diffcomment.rangeHint")}
            submitLabel={t("diffcomment.add")}
            restoreFocus={focusButton(index)}
            onCancel={close}
            onSubmit={(text) => {
              host.conversation.insert(`${lineCommentMarkdown({ path, lines: covered, text })}\n\n`);
              setSent(lastRow);
              close();
            }}
          />
        )}
        {sent === index && range === null && (
          // The message box can be out of sight (a phone layer covers it):
          // the confirmation offers the way there, the host decides what closes.
          <div className="git-diff-comment-sent form-success">
            <span role="status">{t("diffcomment.added")}</span>
            {host.conversation.revealComposer && (
              <Button size="sm" variant="ghost" onClick={() => host.conversation.revealComposer?.()}>{t("diffcomment.goToMessage")}</Button>
            )}
          </div>
        )}
      </Fragment>
    );
  })}</>;
}
