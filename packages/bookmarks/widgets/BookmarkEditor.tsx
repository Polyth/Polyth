// Changing a bookmark in place, and writing a new note. A save names the revision
// the edit started from: if another device saved first, its text is not silently
// overwritten, and the person chooses which version stays.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, type WebPackageHost } from "@polyth/web-sdk";
import { Button, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { BookmarkPatch, BookmarkView } from "../src/bookmarks.ts";
import { getBookmark, readBookmarkBody, refreshBookmarks, updateBookmark, type SaveBookmarkInput } from "./client.ts";
import { reportFailure, saveWithUndo } from "./commands.ts";

/** Escape belongs to the pane, which would close and hide unsaved words. */
function formKeys(onCancel: () => void, onSave: () => void, dirty: boolean) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!dirty) onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave();
    }
  };
}

export function BookmarkEditor({ host, bookmark, onDone }: {
  host: WebPackageHost;
  bookmark: BookmarkView;
  onDone: () => void;
}) {
  const base = useRef(bookmark);
  const original = useRef<string | null>(null);
  const [title, setTitle] = useState(bookmark.title);
  const [body, setBody] = useState<string | null>(null);
  const [note, setNote] = useState(bookmark.note ?? "");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const choice = useRef<HTMLDivElement>(null);

  // On a phone the choice opens below the fold, under a long text.
  useEffect(() => { if (conflict) choice.current?.scrollIntoView({ block: "nearest" }); }, [conflict]);

  useEffect(() => {
    let current = true;
    void readBookmarkBody(base.current).then(
      (text) => {
        if (!current) return;
        original.current = text;
        setBody(text);
      },
      (cause: unknown) => {
        if (!current) return;
        reportFailure(host, tr("bookmarks.failed.text"), cause);
        onDone();
      },
    );
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (): BookmarkPatch => ({
    ...(title.trim() !== base.current.title ? { title: title.trim() } : {}),
    ...(body !== null && body !== original.current ? { body } : {}),
    ...(note !== (base.current.note ?? "") ? { note } : {}),
  });
  const dirty = Object.keys(patch()).length > 0;
  const canSave = title.trim() !== "" && body !== null && !busy;

  const save = async (over: BookmarkView = base.current) => {
    if (!canSave) return;
    const change = patch();
    if (Object.keys(change).length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    try {
      await updateBookmark(over, change);
      onDone();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        await refreshBookmarks(over.projectId);
      } else {
        reportFailure(host, tr("bookmarks.edit.failed"), cause);
      }
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = formKeys(onDone, () => void save(), dirty);
  if (body === null) return <p className="bm-status" role="status">{tr("bookmarks.loading")}</p>;
  return (
    <div className="bm-form" onKeyDown={onKeyDown}>
      <label className="bm-field">
        <span className="bm-field-name">{tr("bookmarks.edit.title")}</span>
        <TextInput value={title} invalid={title.trim() === ""} onChange={(event) => setTitle(event.currentTarget.value)} />
      </label>
      <label className="bm-field">
        <span className="bm-field-name">{tr("bookmarks.edit.text")}</span>
        <Textarea autoGrow minRows={4} maxRows={10} dir="auto" className="bm-field-text" value={body} onChange={(event) => setBody(event.currentTarget.value)} />
      </label>
      <label className="bm-field">
        <span className="bm-field-name">{tr("bookmarks.edit.note")}</span>
        <Textarea autoGrow minRows={2} maxRows={8} dir="auto" value={note} onChange={(event) => setNote(event.currentTarget.value)} />
      </label>
      {conflict ? (
        <div ref={choice} className="bm-conflict" role="alert">
          <p className="bm-conflict-text">{tr("bookmarks.conflict.body")}</p>
          <div className="bm-form-actions">
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              onClick={() => {
                const latest = getBookmark(bookmark.id);
                if (!latest) {
                  reportFailure(host, tr("bookmarks.edit.failed"), new Error(tr("bookmarks.conflict.gone")));
                  onDone();
                  return;
                }
                void save(latest);
              }}
            >
              {tr("bookmarks.conflict.keepMine")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>{tr("bookmarks.conflict.useNewer")}</Button>
          </div>
        </div>
      ) : (
        <div className="bm-form-actions">
          <Button size="sm" variant="primary" busy={busy} disabled={!canSave} onClick={() => void save()}>{tr("bookmarks.edit.save")}</Button>
          <Button size="sm" variant="ghost" onClick={onDone}>{tr("bookmarks.edit.cancel")}</Button>
        </div>
      )}
    </div>
  );
}

export function NoteComposer({ host, place, onDone }: {
  host: WebPackageHost;
  /** A chat keeps the note in its list; a project keeps it beside its chats. */
  place: Pick<SaveBookmarkInput, "sessionId" | "projectId">;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const empty = !title.trim() && !body.trim();

  const save = async () => {
    if (empty || busy) return;
    setBusy(true);
    const saved = await saveWithUndo(host, { kind: "note", ...place, ...(title.trim() ? { title: title.trim() } : {}), body });
    setBusy(false);
    if (saved) onDone();
  };

  return (
    <div className="bm-form bm-form--new" onKeyDown={formKeys(onDone, () => void save(), !empty)}>
      <TextInput value={title} placeholder={tr("bookmarks.note.title")} aria-label={tr("bookmarks.note.title")} onChange={(event) => setTitle(event.currentTarget.value)} />
      <Textarea autoGrow minRows={4} maxRows={10} dir="auto" className="bm-field-text" value={body} placeholder={tr("bookmarks.note.text")} aria-label={tr("bookmarks.note.text")} onChange={(event) => setBody(event.currentTarget.value)} />
      <div className="bm-form-actions">
        <Button size="sm" variant="primary" busy={busy} disabled={empty} onClick={() => void save()}>{tr("bookmarks.edit.save")}</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>{tr("bookmarks.edit.cancel")}</Button>
      </div>
    </div>
  );
}
