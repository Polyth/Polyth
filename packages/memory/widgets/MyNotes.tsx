// A person's own notes: what only they and their private chats can see, the line
// that offers one for sharing, and old shared notes from their private chats.
// Everything here reads and writes the signed-in person's notes; no request can
// name anyone else's (Spaces §14.6).
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import type { Project } from "@polyth/contracts";
import type { MemoryReceiptDto } from "@polyth/knowledge/memory-contracts";
import type { WebNotificationInput } from "@polyth/web-sdk";
import { memoryError, personalMemoryApi, type MemoryDto, type PersonalMemoryPage } from "../src/client.ts";
import type { Translate } from "./i18n.ts";

export type Notify = (input: WebNotificationInput) => unknown;

/** Shares at once: the text was on screen and Undo is right there, so nothing asks again. */
async function shareNote(projectId: string, note: MemoryDto, translate: Translate, notify: Notify | undefined, changed: () => void): Promise<boolean> {
  try {
    const shared = await personalMemoryApi.publish(projectId, note.id, note.revision);
    changed();
    notify?.({
      kind: "success",
      title: translate("memory.share.done"),
      duration: 8000,
      actions: [{
        label: translate("memory.share.undo"),
        run: async () => {
          try { await personalMemoryApi.unpublish(projectId, note.id, shared.memoryId ?? ""); changed(); }
          catch { notify({ kind: "error", title: translate("memory.mine.failed") }); }
        },
      }],
    });
    return true;
  } catch {
    notify?.({ kind: "error", title: translate("memory.share.failed") });
    return false;
  }
}

/** The exact text and who will see it, right before the one act. */
function ShareText({ note, translate }: { note: MemoryDto; translate: Translate }) {
  return (
    <>
      <p className="memory-share-text">{note.body}</p>
      <p className="memory-share-who">{translate("memory.share.who")}</p>
    </>
  );
}

function NoteList({ title, hint, notes, translate, onShare, under, onEdit, onRemove, busy }: {
  title: string;
  hint: string;
  notes: PersonalMemoryPage["here"];
  translate: Translate;
  onShare?: ((note: PersonalMemoryPage["here"][number]) => void) | undefined;
  /** What opens in place under a note. */
  under?: ((id: string) => ReactNode) | undefined;
  onEdit(note: PersonalMemoryPage["here"][number]): void;
  onRemove(note: PersonalMemoryPage["here"][number]): void;
  busy: boolean;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="memory-mine-group">
      <h4>{title}</h4>
      <p className="memory-help">{hint}</p>
      {notes.map((note) => {
        const opened = under?.(note.id);
        return <Fragment key={note.id}>
          <div className="memory-mine-note">
            <div className="memory-mine-note-copy">
              <strong>{note.title}</strong>
              {!opened && <span>{note.snippet}</span>}
              {note.about && <small>{translate("memory.mine.about", { name: note.about })}</small>}
            </div>
            <div className="memory-actions">
              {onShare && <button type="button" className="memory-button" disabled={busy} onClick={() => onShare(note)}>{translate("memory.share.action")}</button>}
              <button type="button" className="memory-button" disabled={busy} onClick={() => onEdit(note)}>{translate("memory.mine.edit")}</button>
              <button type="button" className="memory-button" disabled={busy} onClick={() => onRemove(note)}>{translate("memory.mine.delete")}</button>
            </div>
          </div>
          {opened}
        </Fragment>;
      })}
    </div>
  );
}

export default function MyNotes({ projectId, project, translate, notify }: { projectId: string; project: Readonly<Project>; translate: Translate; notify?: Notify | undefined }) {
  const [page, setPage] = useState<PersonalMemoryPage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<"here" | "about-me" | null>(null);
  const [editing, setEditing] = useState<{ id: string; revision: number } | null>(null);
  const [sharing, setSharing] = useState<MemoryDto | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const load = useCallback(async () => {
    try { setPage(await personalMemoryApi.page(projectId)); setFailed(null); }
    catch (cause) { setPage(null); setFailed(memoryError(cause, translate).kind === "forbidden" ? null : translate("memory.mine.failed")); }
  }, [projectId, translate]);
  useEffect(() => { void load(); }, [load]);
  const run = async (work: () => Promise<MemoryReceiptDto>): Promise<boolean> => {
    setBusy(true);
    try { await work(); await load(); return true; }
    catch { setFailed(translate("memory.mine.failed")); return false; }
    finally { setBusy(false); }
  };
  if (!page && !failed) return null;
  // Someone working alone has nobody to keep notes from, so nothing new appears
  // for them; what they already have stays reachable.
  const withOthers = project.othersHere === true;
  const hasNotes = !!page && (page.here.length > 0 || page.aboutMe.length > 0);
  if (!withOthers && !hasNotes) return null;
  const closeEditor = () => { setAdding(null); setEditing(null); setSharing(null); setTitle(""); setBody(""); };
  const startAdding = (where: "here" | "about-me") => { closeEditor(); setAdding(where); };
  // What's typed stays on screen when a save fails, so it can be tried again.
  const save = () => {
    const work = editing
      ? () => personalMemoryApi.update(projectId, editing.id, editing.revision, { title: title.trim(), body })
      : adding
        ? () => personalMemoryApi.create(projectId, adding, title.trim(), body)
        : undefined;
    if (work) void run(work).then((saved) => { if (saved) closeEditor(); });
  };
  // The list carries a snippet; editing and sharing need the whole note.
  const withWholeNote = (id: string, use: (note: MemoryDto) => void) => {
    setBusy(true);
    void personalMemoryApi.get(projectId, id)
      .then((note) => { closeEditor(); use(note); })
      .catch(() => setFailed(translate("memory.mine.failed")))
      .finally(() => setBusy(false));
  };
  const startEditing = (id: string) => withWholeNote(id, (note) => { setEditing({ id: note.id, revision: note.revision }); setTitle(note.title); setBody(note.body); });
  const share = (note: MemoryDto) => {
    setBusy(true);
    void shareNote(projectId, note, translate, notify, () => void load()).then((shared) => { setBusy(false); if (shared) closeEditor(); });
  };
  return (
    <section className="memory-section memory-mine" aria-labelledby="memory-mine-heading">
      <div className="memory-section-head">
        <div>
          <h3 id="memory-mine-heading">{translate("memory.mine.title")}</h3>
          <p>{translate("memory.mine.hint")}</p>
        </div>
        <div className="memory-actions">
          <button type="button" className="memory-button" disabled={busy} onClick={() => startAdding("here")}>{translate("memory.mine.add")}</button>
          <button type="button" className="memory-button" disabled={busy} onClick={() => startAdding("about-me")}>{translate("memory.mine.addAboutMe")}</button>
        </div>
      </div>
      {failed && <p className="memory-help" role="alert">{failed}</p>}
      {(adding || editing) && (
        <div className="memory-mine-editor">
          <label className="memory-field">{translate("memory.field.title")}<input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label>
          <label className="memory-field">{translate("memory.field.body")}<textarea value={body} rows={3} onChange={(event) => setBody(event.target.value)} /></label>
          <div className="memory-actions">
            <button type="button" className="memory-button memory-button-primary" disabled={busy || !title.trim() || !body.trim()} onClick={save}>{translate("memory.save")}</button>
            <button type="button" className="memory-button" disabled={busy} onClick={closeEditor}>{translate("memory.cancel")}</button>
          </div>
        </div>
      )}
      {page && withOthers && page.review.length > 0 && (
        <div className="memory-mine-group">
          <h4>{translate("memory.mine.review")}</h4>
          <p className="memory-help">{translate("memory.mine.reviewHint")}</p>
          {page.review.map((note) => (
            <div key={note.id} className="memory-mine-note" data-memory-review={note.id}>
              <div className="memory-mine-note-copy"><strong>{note.title}</strong><span>{note.body}</span></div>
              <button type="button" className="memory-button" disabled={busy} onClick={() => void run(() => personalMemoryApi.makePersonal(projectId, note.id, note.revision))}>{translate("memory.mine.makePersonal")}</button>
            </div>
          ))}
        </div>
      )}
      {page && (
        <>
          <NoteList
            title={translate("memory.mine.here")}
            hint={translate("memory.mine.hereHint")}
            notes={page.here}
            translate={translate}
            busy={busy}
            onShare={withOthers ? (note) => withWholeNote(note.id, setSharing) : undefined}
            under={(id) => sharing?.id === id && (
              <div className="memory-mine-sharing">
                <ShareText note={sharing} translate={translate} />
                <div className="memory-actions">
                  <button type="button" className="memory-button memory-button-primary" disabled={busy} onClick={() => share(sharing)}>{translate("memory.share.confirm")}</button>
                  <button type="button" className="memory-button" disabled={busy} onClick={closeEditor}>{translate("memory.cancel")}</button>
                </div>
              </div>
            )}
            onEdit={(note) => startEditing(note.id)}
            onRemove={(note) => void run(() => personalMemoryApi.remove(projectId, note.id, note.revision))}
          />
          <NoteList
            title={translate("memory.mine.aboutMe")}
            hint={translate("memory.mine.aboutMeHint")}
            notes={page.aboutMe}
            translate={translate}
            busy={busy}
            onEdit={(note) => startEditing(note.id)}
            onRemove={(note) => void run(() => personalMemoryApi.remove(projectId, note.id, note.revision))}
          />
        </>
      )}
    </section>
  );
}

/** Which memory the agent has in the chat on screen, beside who can read it. */
export function ChatMemoryScope({ privateChat, translate, onOpenNotes }: { privateChat: boolean; translate: Translate; onOpenNotes?: (() => void) | undefined }) {
  return (
    <div className="memory-chat-scope">
      <span>{translate(privateChat ? "memory.scope.personal" : "memory.scope.shared")}</span>
      {privateChat && onOpenNotes && <button type="button" className="memory-chat-scope-notes" onClick={onOpenNotes}>{translate("memory.mine.title")}</button>}
    </div>
  );
}

/** One line under the reply that saved a note: it already works, and it can be
 *  shared from here. Nothing waits on an answer: the next message lets it go. */
export function ShareOffer({ projectId, sessionId, settled, latestPromptAt, translate, notify }: {
  projectId: string;
  sessionId: string;
  /** No turn is running: an offer is made during one, and shows once it ends. */
  settled: boolean;
  latestPromptAt: number;
  translate: Translate;
  notify?: Notify | undefined;
}) {
  const [note, setNote] = useState<MemoryDto | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const page = await personalMemoryApi.page(projectId);
      setNote(page.proposals.find((offer) => offer.sources.some((source) => source.sessionId === sessionId)) ?? null);
    } catch {
      setNote(null);
    }
  }, [projectId, sessionId]);
  useEffect(() => { if (settled) void load(); }, [load, settled]);
  if (!settled || !note || (note.shareProposedAt ?? 0) < latestPromptAt) return null;
  const share = () => {
    setBusy(true);
    void shareNote(projectId, note, translate, notify, () => void load()).finally(() => setBusy(false));
  };
  return (
    <details key={note.id} className="memory-share-offer" data-memory-share-offer={note.id}>
      <summary>
        <span className="memory-share-saved">{translate("memory.share.saved", { title: note.title })}</span>
        <span className="memory-share-action">{translate("memory.share.action")}</span>
      </summary>
      <ShareText note={note} translate={translate} />
      <button type="button" className="memory-share-confirm" disabled={busy} onClick={share}>{translate("memory.share.confirm")}</button>
    </details>
  );
}

/** Before someone joins: what they'll be able to read from day one. */
export function InvitationNotice({ translate }: { translate: Translate }) {
  const [notes, setNotes] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void personalMemoryApi.sharedCount().then((value) => { if (live) setNotes(value.notes); }).catch(() => { if (live) setNotes(null); });
    return () => { live = false; };
  }, []);
  if (!notes) return null;
  return <p className="memory-help" data-memory-invitation-notice="">{translate("memory.invite.notice", { count: notes })}</p>;
}
