// A person's own notes: what only they and their private chats can see, what the
// agent suggests sharing, and old shared notes that came from their private chats.
// Everything here reads and writes the signed-in person's notes; no request can
// name anyone else's (Spaces §14.6).
import { useCallback, useEffect, useState } from "react";
import type { Project } from "@polyth/contracts";
import type { MemoryReceiptDto } from "@polyth/knowledge/memory-contracts";
import { memoryError, personalMemoryApi, type MemoryDto, type PersonalMemoryPage } from "../src/client.ts";
import type { Translate } from "./i18n.ts";

function NoteList({ title, hint, notes, translate, onEdit, onRemove, busy }: {
  title: string;
  hint: string;
  notes: PersonalMemoryPage["here"];
  translate: Translate;
  onEdit(note: PersonalMemoryPage["here"][number]): void;
  onRemove(note: PersonalMemoryPage["here"][number]): void;
  busy: boolean;
}) {
  return (
    <div className="memory-mine-group">
      <h4>{title}</h4>
      <p className="memory-help">{hint}</p>
      {notes.length === 0
        ? <p className="memory-mine-empty">{translate("memory.mine.empty")}</p>
        : notes.map((note) => (
          <div key={note.id} className="memory-mine-note">
            <div className="memory-mine-note-copy">
              <strong>{note.title}</strong>
              <span>{note.snippet}</span>
              {note.about && <small>{translate("memory.mine.about", { name: note.about })}</small>}
            </div>
            <div className="memory-actions">
              <button type="button" className="memory-button" disabled={busy} onClick={() => onEdit(note)}>{translate("memory.mine.edit")}</button>
              <button type="button" className="memory-button" disabled={busy} onClick={() => onRemove(note)}>{translate("memory.mine.delete")}</button>
            </div>
          </div>
        ))}
    </div>
  );
}

export function ShareProposalRow({ note, translate, busy, onPublish, onKeep }: {
  note: MemoryDto;
  translate: Translate;
  busy: boolean;
  onPublish(): void;
  onKeep(): void;
}) {
  return (
    <div className="memory-proposal" data-memory-proposal={note.id}>
      <div className="memory-proposal-copy">
        <strong>{note.title}</strong>
        <span>{note.body}</span>
      </div>
      <div className="memory-actions">
        <button type="button" className="memory-button memory-button-primary" disabled={busy} onClick={onPublish}>{translate("memory.mine.publish")}</button>
        <button type="button" className="memory-button" disabled={busy} onClick={onKeep}>{translate("memory.mine.keep")}</button>
      </div>
    </div>
  );
}

export default function MyNotes({ projectId, project, translate }: { projectId: string; project: Readonly<Project>; translate: Translate }) {
  const [page, setPage] = useState<PersonalMemoryPage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<"here" | "about-me" | null>(null);
  const [editing, setEditing] = useState<{ id: string; revision: number } | null>(null);
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
  const withOthers = (project.sharedWith ?? 0) > 0 || project.parentProjectId !== undefined;
  const hasNotes = !!page && (page.here.length > 0 || page.aboutMe.length > 0 || page.proposals.length > 0);
  if (!withOthers && !hasNotes) return null;
  const closeEditor = () => { setAdding(null); setEditing(null); setTitle(""); setBody(""); };
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
  const startEditing = (id: string) => {
    setBusy(true);
    // The list carries a snippet; editing needs the whole note.
    void personalMemoryApi.get(projectId, id)
      .then((note) => { closeEditor(); setEditing({ id: note.id, revision: note.revision }); setTitle(note.title); setBody(note.body); })
      .catch(() => setFailed(translate("memory.mine.failed")))
      .finally(() => setBusy(false));
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
      {page && page.proposals.length > 0 && (
        <div className="memory-mine-group">
          <h4>{translate("memory.mine.proposals")}</h4>
          <p className="memory-help">{translate("memory.mine.proposalsHint")}</p>
          {page.proposals.map((note) => (
            <ShareProposalRow
              key={note.id}
              note={note}
              translate={translate}
              busy={busy}
              onPublish={() => void run(() => personalMemoryApi.publish(projectId, note.id, note.revision))}
              onKeep={() => void run(() => personalMemoryApi.keep(projectId, note.id, note.revision))}
            />
          ))}
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
export function ChatMemoryScope({ privateChat, translate }: { privateChat: boolean; translate: Translate }) {
  return <span className="memory-chat-scope">{translate(privateChat ? "memory.scope.personal" : "memory.scope.shared")}</span>;
}

/** The agent's suggestion, above the composer of the private chat it came from:
 *  the exact text, and the person's own choice. Nothing else can publish it. */
export function ShareProposalCard({ projectId, sessionId, working, translate }: { projectId: string | null; sessionId: string | null; working: boolean; translate: Translate }) {
  const [proposals, setProposals] = useState<MemoryDto[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!projectId || !sessionId) { setProposals([]); return; }
    try {
      const page = await personalMemoryApi.page(projectId);
      setProposals(page.proposals.filter((note) => note.sources.some((source) => source.sessionId === sessionId)));
    } catch {
      setProposals([]);
    }
  }, [projectId, sessionId]);
  // A proposal is made during a turn, so one can only be new when a turn starts or ends.
  useEffect(() => { void load(); }, [load, working]);
  if (!projectId || proposals.length === 0) return null;
  const settle = async (work: Promise<MemoryReceiptDto>) => {
    setBusy(true);
    try { await work; } catch { /* the reload shows what is true */ }
    await load();
    setBusy(false);
  };
  return (
    <div className="memory-proposal-card" role="group" aria-label={translate("memory.mine.proposals")}>
      <span className="memory-proposal-from">{translate("memory.mine.proposals")}</span>
      {proposals.map((note) => (
        <ShareProposalRow
          key={note.id}
          note={note}
          translate={translate}
          busy={busy}
          onPublish={() => void settle(personalMemoryApi.publish(projectId, note.id, note.revision))}
          onKeep={() => void settle(personalMemoryApi.keep(projectId, note.id, note.revision))}
        />
      ))}
    </div>
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
